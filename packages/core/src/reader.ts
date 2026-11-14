import { ApiError, createSendoApi, type SendoApi } from "./api/client";
import type { Database, Executor } from "./db/database";
import {
  type ArticleQuery,
  countUnread,
  getArticle,
  listArticles,
  listFeeds,
  listFolders,
} from "./db/queries";
import { migrate } from "./db/schema";
import { getSetting, setSetting } from "./db/settings";
import type { Article, Feed, Folder, Table, UnreadCounts } from "./models";
import { type PullResult, pull } from "./sync/pull";

const TOKEN_KEY = "auth.token";

export interface ReaderCoreOptions {
  db: Database;
  /** API の入口。画面では "/api/v1" */
  baseUrl: string;
  fetch?: typeof fetch;
  now?: () => number;
  /** 1 つのリクエストを待つ上限（ミリ秒） */
  requestTimeoutMs?: number;
}

export type ChangeListener = (tables: ReadonlySet<Table>) => void;

/**
 * sendo-reader の中核。手元の DB の読み書きと、sendo との同期をまとめる。
 *
 * 画面は、このオブジェクトの読み出しだけを使い、ネットワークを待たない。同期は裏で回し、
 * 変わった表を onChange で知らせる。Web では代表のタブのワーカーの中で 1 つだけ作る
 * （docs/decisions/local-first.md）。
 */
export class ReaderCore {
  readonly #db: Database;
  readonly #api: SendoApi;
  readonly #now: () => number;
  readonly #listeners = new Set<ChangeListener>();
  /** 手元にあるトークン。毎回 DB を読まずに済むように持っておく */
  #token: string | null = null;
  /**
   * 今のログインの中断の合図。ログアウトやログインのし直しで中断し、送っている途中の
   * リクエストを止め、その同期が手元の DB に書き戻さないようにする
   */
  #session = new AbortController();
  #syncing: Promise<PullResult> | null = null;

  private constructor(options: ReaderCoreOptions) {
    this.#db = options.db;
    this.#now = options.now ?? Date.now;
    this.#api = createSendoApi({
      baseUrl: options.baseUrl,
      token: () => this.#token,
      ...(options.fetch === undefined ? {} : { fetch: options.fetch }),
      ...(options.requestTimeoutMs === undefined ? {} : { timeoutMs: options.requestTimeoutMs }),
    });
  }

  /** DB のマイグレーションを当ててから使い始める */
  static async open(options: ReaderCoreOptions): Promise<ReaderCore> {
    await migrate(options.db);
    const core = new ReaderCore(options);
    core.#token = await getSetting(options.db, TOKEN_KEY);
    return core;
  }

  // --- ログイン ---

  isSignedIn(): boolean {
    return this.#token !== null;
  }

  /**
   * sendo で発行したアクセストークンを確かめてから、手元に置く。使えないトークンなら
   * ApiError（unauthorized）を投げ、何も変えない。
   *
   * 手元のデータは、どのアカウントのものか分からないので、いったん消して最初から同期し直す
   * （別のアカウントのトークンに替えたときに、前のアカウントの記事を見せない）。
   */
  async signIn(token: string): Promise<void> {
    const trimmed = token.trim();
    if (trimmed === "") throw new ApiError("unauthorized", "トークンが空");
    // 新しいログインを始める（前のログインの同期は中断する）。確かめている間にログアウトや
    // 別のログインが始まったら、このログインは中断され、トークンを置かない
    const session = this.#beginSession();
    await this.#api.verifyToken(trimmed, session);

    await this.#db.transaction(async (tx) => {
      session.throwIfAborted();
      // 確かめている間に始まった同期は、前のトークンで動いている。ここで中断して、
      // 前のアカウントの応答を、消したあとの手元に書き戻させない
      this.#beginSession();
      await clearAll(tx);
      await setSetting(tx, TOKEN_KEY, trimmed);
      // DB の呼び出しは 1 列に並ぶので、手元のトークンもトランザクションの中で替える
      // （あとに並んだログアウトが、確実に消す）
      this.#token = trimmed;
    });
    this.#emit(new Set<Table>(["folders", "feeds", "articles"]));
  }

  /**
   * トークンと、同期で届いた手元のデータをまとめて消す。送っている途中の同期や、確かめている
   * 途中のログインは待たずに中断する（通信が止まっていても、すぐに終わる）。
   */
  async signOut(): Promise<void> {
    this.#beginSession();
    this.#token = null;
    await this.#db.transaction(async (tx) => {
      await clearAll(tx);
      this.#token = null;
    });
    this.#emit(new Set<Table>(["folders", "feeds", "articles"]));
  }

  /** 今のログインで動いている処理を中断し、新しいログインの中断の合図を返す */
  #beginSession(): AbortSignal {
    this.#session.abort();
    this.#session = new AbortController();
    this.#syncing = null;
    return this.#session.signal;
  }

  // --- 同期 ---

  /**
   * sendo から差分を取り込む。すでに同期中なら、その結果を待つ（同時に 2 つは走らせない）。
   * ログインしていなければ ApiError（unauthorized）を投げる。
   */
  sync(): Promise<PullResult> {
    if (this.#syncing !== null) return this.#syncing;
    const running: Promise<PullResult> = this.#runSync(this.#session.signal).finally(() => {
      if (this.#syncing === running) this.#syncing = null;
    });
    this.#syncing = running;
    return running;
  }

  async #runSync(signal: AbortSignal): Promise<PullResult> {
    if (this.#token === null) throw new ApiError("unauthorized", "ログインしていない");
    return pull(this.#db, this.#api, {
      now: this.#now,
      signal,
      onPage: (changed) => this.#emit(changed),
    });
  }

  // --- 読み出し（手元の DB だけ） ---

  listFolders(): Promise<Folder[]> {
    return listFolders(this.#db);
  }

  listFeeds(): Promise<Feed[]> {
    return listFeeds(this.#db);
  }

  listArticles(query?: ArticleQuery): Promise<Article[]> {
    return listArticles(this.#db, query);
  }

  getArticle(id: string): Promise<Article | null> {
    return getArticle(this.#db, id);
  }

  countUnread(): Promise<UnreadCounts> {
    return countUnread(this.#db);
  }

  // --- 変更の通知 ---

  /** 手元の表が変わったら呼ぶ。やめるときは返した関数を呼ぶ */
  onChange(listener: ChangeListener): () => void {
    this.#listeners.add(listener);
    return () => this.#listeners.delete(listener);
  }

  #emit(tables: ReadonlySet<Table>): void {
    for (const listener of this.#listeners) {
      try {
        listener(tables);
      } catch (error) {
        console.error("変更の通知で失敗した", error);
      }
    }
  }
}

/** 手元のデータ（同期で届いた行、カーソル、トークンなどの設定）をすべて消す */
async function clearAll(tx: Executor): Promise<void> {
  await tx.run("delete from articles");
  await tx.run("delete from feeds");
  await tx.run("delete from folders");
  await tx.run("delete from settings");
}
