import { ApiError, createSendoApi, type SendoApi } from "./api/client";
import type { Database } from "./db/database";
import {
  type ArticleQuery,
  countUnread,
  getArticle,
  listArticles,
  listFeeds,
  listFolders,
} from "./db/queries";
import { migrate } from "./db/schema";
import { deleteSetting, getSetting, setSetting } from "./db/settings";
import type { Article, Feed, Folder, Table, UnreadCounts } from "./models";
import { clearSyncedData, type PullResult, pull } from "./sync/pull";

const TOKEN_KEY = "auth.token";

export interface ReaderCoreOptions {
  db: Database;
  /** API の入口。画面では "/api/v1" */
  baseUrl: string;
  fetch?: typeof fetch;
  now?: () => number;
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
  #syncing: Promise<PullResult> | null = null;

  private constructor(options: ReaderCoreOptions) {
    this.#db = options.db;
    this.#now = options.now ?? Date.now;
    this.#api = createSendoApi({
      baseUrl: options.baseUrl,
      token: () => this.#token,
      ...(options.fetch === undefined ? {} : { fetch: options.fetch }),
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
   * sendo で発行したアクセストークンを確かめてから、手元に置く。
   * 使えないトークンなら ApiError（unauthorized）を投げ、何も置かない。
   */
  async signIn(token: string): Promise<void> {
    const trimmed = token.trim();
    if (trimmed === "") throw new ApiError("unauthorized", "トークンが空");
    await this.#api.verifyToken(trimmed);
    await setSetting(this.#db, TOKEN_KEY, trimmed);
    this.#token = trimmed;
  }

  /** トークンと、同期で届いた手元のデータをまとめて消す */
  async signOut(): Promise<void> {
    await this.#syncing?.catch(() => undefined);
    await clearSyncedData(this.#db);
    await deleteSetting(this.#db, TOKEN_KEY);
    this.#token = null;
    this.#emit(new Set<Table>(["folders", "feeds", "articles"]));
  }

  // --- 同期 ---

  /**
   * sendo から差分を取り込む。すでに同期中なら、その結果を待つ（同時に 2 つは走らせない）。
   * ログインしていなければ ApiError（unauthorized）を投げる。
   */
  sync(): Promise<PullResult> {
    if (this.#syncing !== null) return this.#syncing;
    this.#syncing = this.#runSync().finally(() => {
      this.#syncing = null;
    });
    return this.#syncing;
  }

  async #runSync(): Promise<PullResult> {
    if (this.#token === null) throw new ApiError("unauthorized", "ログインしていない");
    return pull(this.#db, this.#api, {
      now: this.#now,
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
