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
import { LOCAL_ID_PREFIX, type MarkReadScope, type Operation } from "./sync/ops";
import { getArticleSeq, getCursor, type PullResult, pull } from "./sync/pull";
import { countPending, enqueue, type PushResult, push } from "./sync/queue";

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

/** 1 回の同期の結果 */
export interface SyncResult {
  push: PushResult;
  pull: PullResult;
}

/** フォルダ名の長さの上限（sendo と同じ） */
export const MAX_FOLDER_NAME_LENGTH = 200;

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
  #syncing: Promise<SyncResult> | null = null;

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
   * 手元の操作を sendo に送り（操作キュー）、そのあと差分を取り込む。すでに同期中なら、
   * その結果を待つ（同時に 2 つは走らせない）。ログインしていなければ ApiError（unauthorized）。
   * 操作を送れなかったら（届かない、など）、取り込まずに ApiError を投げる。操作は残る。
   */
  sync(): Promise<SyncResult> {
    if (this.#syncing !== null) return this.#syncing;
    const running: Promise<SyncResult> = this.#runSync(this.#session.signal).finally(() => {
      if (this.#syncing === running) this.#syncing = null;
    });
    this.#syncing = running;
    return running;
  }

  async #runSync(signal: AbortSignal): Promise<SyncResult> {
    if (this.#token === null) throw new ApiError("unauthorized", "ログインしていない");
    const pushed = await push(this.#db, this.#api, signal);
    if (pushed.rejected.length > 0) {
      this.#emit(new Set<Table>(["folders", "feeds", "articles"]));
    }
    const pulled = await pull(this.#db, this.#api, {
      now: this.#now,
      signal,
      onPage: (changed) => this.#emit(changed),
    });
    return { push: pushed, pull: pulled };
  }

  /** まだ sendo に送り終えていない操作の数 */
  countPending(): Promise<number> {
    return countPending(this.#db);
  }

  // --- 書き込み（手元にすぐ反映し、操作キューに積む。送るのは sync()） ---

  /** 記事を既読（true）／未読（false）にする */
  setRead(articleId: string, read: boolean): Promise<void> {
    return this.#write({ kind: "setArticleState", articleId, read, at: this.#now() }, ["articles"]);
  }

  /** 記事にスターを付ける（true）／外す（false） */
  setStarred(articleId: string, starred: boolean): Promise<void> {
    return this.#write({ kind: "setArticleState", articleId, starred, at: this.#now() }, [
      "articles",
    ]);
  }

  /**
   * まとめて既読にする。押した時点で手元にあった記事だけを既読にし、sendo にも同期済みの範囲
   * （カーソル）までだけを頼む（sync.md の 6）。まだ一度も同期していなければ何もしない。
   */
  async markAllRead(scope: MarkReadScope): Promise<void> {
    const op = await this.#db.transaction(async (tx) => {
      const cursor = await getCursor(tx);
      if (cursor === null) return null;
      const op: Operation = {
        kind: "markRead",
        scope,
        upTo: await getArticleSeq(tx),
        cursor,
        at: this.#now(),
      };
      await enqueue(tx, op, this.#now());
      return op;
    });
    if (op !== null) this.#emit(new Set<Table>(["articles"]));
  }

  /** フォルダを作る。sendo が ID を付けるまでは仮の ID で、作ったフォルダの ID を返す */
  async createFolder(name: string): Promise<string> {
    const folderId = `${LOCAL_ID_PREFIX}${crypto.randomUUID()}`;
    await this.#write(
      { kind: "createFolder", folderId, name: normalizeFolderName(name), at: this.#now() },
      ["folders"],
    );
    return folderId;
  }

  renameFolder(folderId: string, name: string): Promise<void> {
    return this.#write({ kind: "renameFolder", folderId, name: normalizeFolderName(name) }, [
      "folders",
    ]);
  }

  /** フォルダを消す。入っていたフィードはフォルダなしに戻す（フィードは消さない） */
  deleteFolder(folderId: string): Promise<void> {
    return this.#write({ kind: "deleteFolder", folderId }, ["folders", "feeds"]);
  }

  /** フィードを別のフォルダに移す。null ならフォルダなし */
  moveFeed(feedId: string, folderId: string | null): Promise<void> {
    return this.#write({ kind: "moveFeed", feedId, folderId }, ["feeds"]);
  }

  /** 購読をやめる。記事はスターを付けたものだけが残る */
  unsubscribe(feedId: string): Promise<void> {
    return this.#write({ kind: "unsubscribe", feedId }, ["feeds", "articles"]);
  }

  async #write(op: Operation, tables: Table[]): Promise<void> {
    if (this.#token === null) throw new ApiError("unauthorized", "ログインしていない");
    await this.#db.transaction((tx) => enqueue(tx, op, this.#now()));
    this.#emit(new Set(tables));
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

/**
 * 手元のデータ（同期で届いた行、まだ送っていない操作、カーソル、トークンなどの設定）を
 * すべて消す
 */
async function clearAll(tx: Executor): Promise<void> {
  await tx.run("delete from pending_ops");
  await tx.run("delete from articles");
  await tx.run("delete from feeds");
  await tx.run("delete from folders");
  await tx.run("delete from settings");
}

/**
 * フォルダ名の空白をまとめ、長すぎれば切り詰める。sendo と同じく、UTF-16 の長さで数え、
 * サロゲートペアの途中では切らない（手元と sendo で名前がずれないように）。空なら投げる。
 */
export function normalizeFolderName(value: string): string {
  const name = value.replace(/\s+/g, " ").trim();
  if (name === "") throw new RangeError("フォルダ名が空");
  let out = "";
  for (const char of name) {
    if (out.length + char.length > MAX_FOLDER_NAME_LENGTH) break;
    out += char;
  }
  return out;
}
