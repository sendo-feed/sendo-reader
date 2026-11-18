import { ApiError, createSendoApi, type SendoApi } from "./api/client";
import { hasVisibleContent, parseContent } from "./content/parse";
import {
  type ContentSource,
  getStoredContent,
  listContentToPrefetch,
  markContentMissing,
  putStoredContent,
  type StoredContent,
} from "./db/content";
import type { Database, Executor } from "./db/database";
import {
  type ArticleQuery,
  countReadSince,
  countUnread,
  getArticle,
  getArticles,
  listArticles,
  listFeeds,
  listFolders,
} from "./db/queries";
import { clearSavedPages, countSavedPages, getSavedPage, listSavedPages } from "./db/saved-pages";
import { migrate } from "./db/schema";
import { deleteSetting, getSetting, setSetting } from "./db/settings";
import {
  getSettingsSeed,
  hasSyncedSetting,
  listSyncedSettings,
  setSettingsSeed,
} from "./db/synced-settings";
import {
  type Article,
  type ArticleContent,
  DEVICE_TYPES,
  type DeviceType,
  type Feed,
  type Folder,
  type LocalArticleContent,
  type SavedPage,
  type SettingItem,
  type SettingsChange,
  type Table,
  type UnreadCounts,
  type User,
} from "./models";
import {
  discoverFeeds,
  type FeedCandidate,
  importOpml,
  type OpmlImportResult,
  subscribe,
} from "./online";
import {
  normalizeSavedUrl,
  SAVED_ID_PATTERN,
  SAVED_PAGE_LIMIT,
  SAVED_TITLE_LIMIT,
  savedPageId,
} from "./saved";
import { feedListPath, folderListPath, listSettingName, normalizeSettingsChange } from "./settings";
import {
  FOLDER_ID_PATTERN,
  getFolderIdRemaps,
  type MarkReadScope,
  type Operation,
  scopeCondition,
} from "./sync/ops";
import { getCompleteCursor, type PullResult, pull } from "./sync/pull";
import { countPending, enqueue, lastPendingId, type PushResult, push } from "./sync/queue";

/** ログインしたユーザー（JSON）を置く設定の鍵 */
const USER_KEY = "auth.user";

/**
 * ログアウトを sendo に送れていない印。送れるまでは、残ったセッションのクッキーで、自動では
 * ログインし直さない（docs/decisions/local-first.md の 6）
 */
const LOGOUT_PENDING_KEY = "auth.logoutPending";

const ALL_TABLES: ReadonlySet<Table> = new Set<Table>([
  "folders",
  "feeds",
  "articles",
  "settings",
  "savedPages",
]);

export interface ReaderCoreOptions {
  db: Database;
  /** API の入口。画面では "/api/v1" */
  baseUrl: string;
  fetch?: typeof fetch;
  now?: () => number;
  /** 1 つのリクエストを待つ上限（ミリ秒） */
  requestTimeoutMs?: number;
  /**
   * 手元の DB をまとめて消したあと（ログアウトした、ユーザーが替わった）に呼ぶ。DB の外に置いた、
   * その人のデータ（Web では、Service Worker の画像のキャッシュ。docs/decisions/images.md の 4）を
   * 一緒に消す。失敗しても、ログアウトやユーザーの切り替えは止めない
   */
  onDataCleared?: () => Promise<void>;
  /**
   * 同期のあとに、未読の新しい記事の本文を、この数まで先に取っておく（オフラインでも読める
   * ように）。既定は 0（取らない。開いたときに取る）
   */
  prefetchContents?: number;
}

/**
 * 先に取っておく本文の数の目安（Web の既定）。本文 1 件につき、sendo の側で R2 を 1 回読み、
 * Workers のリクエストを 1 回使うので、数を絞る。本文の中の画像は、表示するまで取らない
 */
export const DEFAULT_PREFETCH_CONTENTS = 30;

export type ChangeListener = (tables: ReadonlySet<Table>) => void;

/** 1 回の同期の結果 */
export interface SyncResult {
  push: PushResult;
  pull: PullResult;
}

/** フォルダ名の長さの上限（sendo と同じ） */
export const MAX_FOLDER_NAME_LENGTH = 200;

/** まとめて既読にする記事を、範囲の一部に絞る（どれも渡さなければ、範囲のすべて） */
export interface MarkAllReadOptions {
  /** この時刻（ミリ秒）より前に公開された記事だけ */
  publishedBefore?: number;
  /** 一覧の並び（公開日時、同じなら id）で、この記事より古い記事だけ */
  olderThan?: { publishedAt: number; id: string };
  /** 一覧の並びで、この記事より新しい記事だけ */
  newerThan?: { publishedAt: number; id: string };
}

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
  readonly #onDataCleared: (() => Promise<void>) | undefined;
  readonly #listeners = new Set<ChangeListener>();
  /** 手元に置いた、ログインしたユーザー。毎回 DB を読まずに済むように持っておく */
  #user: User | null = null;
  /**
   * 今のログインの中断の合図。ログアウトやログインのし直しで中断し、送っている途中の
   * リクエストを止め、その同期が手元の DB に書き戻さないようにする
   */
  #session = new AbortController();
  #syncing: Promise<SyncResult> | null = null;
  #lane: Promise<unknown> = Promise.resolve();
  /** 最後に積んだ操作の番号 */
  #lastOpId = 0;
  /**
   * 通信が要る操作（購読、OPML の取り込み）を呼んだ時点の、最後の操作の番号。その操作が終わる
   * までは、これより後に積んだ操作を送らず、これ以下の操作にまとめない（呼んだ順を守る）
   */
  readonly #barriers = new Set<{ readonly id: number }>();
  /**
   * 通信が要る操作が、応答を受けて積んだ操作（購読で頼んだフォルダへの移動）。呼んだ順では、
   * その操作の位置にあるので、あとから呼んだ通信が要る操作より前に送ってよい
   */
  readonly #onlineOps = new Set<number>();
  /**
   * 手元で作ったフォルダの ID から、まとめた先（sendo にあった、同じ名前のフォルダ）の ID へ
   * （画面がまとめる前の ID を持ったままでも使えるように）
   */
  readonly #folderIds = new Map<string, string>();
  /** 取りにいっている本文（出どころと記事の ID ごと）。同じ本文を同時に 2 回取らない */
  readonly #contentFetches = new Map<string, Promise<StoredContent | null>>();
  readonly #prefetchContents: number;
  #prefetching: Promise<number> | null = null;

  private constructor(options: ReaderCoreOptions) {
    this.#db = options.db;
    this.#now = options.now ?? Date.now;
    this.#onDataCleared = options.onDataCleared;
    this.#prefetchContents = options.prefetchContents ?? 0;
    this.#api = createSendoApi({
      baseUrl: options.baseUrl,
      ...(options.fetch === undefined ? {} : { fetch: options.fetch }),
      ...(options.requestTimeoutMs === undefined ? {} : { timeoutMs: options.requestTimeoutMs }),
    });
  }

  /** DB のマイグレーションを当ててから使い始める */
  static async open(options: ReaderCoreOptions): Promise<ReaderCore> {
    await migrate(options.db);
    const core = new ReaderCore(options);
    core.#user = parseUser(await getSetting(options.db, USER_KEY));
    core.#lastOpId = await lastPendingId(options.db);
    for (const [from, to] of Object.entries(await getFolderIdRemaps(options.db))) {
      core.#folderIds.set(from, to);
    }
    return core;
  }

  // --- ログイン（docs/decisions/local-first.md の 6） ---

  /** 手元にログインしたユーザーがいる（オフラインでも、手元で読み書きできる） */
  isSignedIn(): boolean {
    return this.#user !== null;
  }

  /** 手元に置いた、ログインしたユーザー */
  currentUser(): User | null {
    return this.#user === null ? null : { ...this.#user };
  }

  /**
   * 起動したときに呼ぶ。手元にユーザーがいれば、ネットワークを待たずに true を返す（sendo の
   * セッションは、送る前に確かめる）。いなければ sendo のセッションを見て、ログインしていれば
   * そのユーザーで使い始める（Google のログインから戻ってきたとき）。していなければ false。
   *
   * ログアウトを sendo に送れていなければ、残ったクッキーでログインし直さず、false を返す。
   * 確かめている間にログアウトしたり、ほかのタブが先に使い始めたりしたら、そのときの様子を返す。
   * sendo に届かなければ ApiError（network）を投げる。
   */
  async restoreSession(): Promise<boolean> {
    // 待つ前に、今のログインの合図を取る（待っている間に始まったログアウトで中断されるように）
    const signal = this.#session.signal;
    if (this.#user !== null) return true;
    if ((await getSetting(this.#db, LOGOUT_PENDING_KEY)) !== null) return false;
    try {
      await this.#adopt(await this.#api.me(signal), signal);
      return true;
    } catch (error) {
      if (signal.aborted) return this.#user !== null;
      if (error instanceof ApiError && error.kind === "unauthorized") return false;
      throw error;
    }
  }

  /**
   * ログインの画面（sendo の /auth/google/login）へ移る前に呼ぶ。ログアウトを sendo に送れて
   * いなければ、ここで送る。送れなければ ApiError を投げ、ログインに進ませない（ログインし終える
   * 前に、残った前のセッションで使い始めないように）。
   */
  async prepareSignIn(): Promise<void> {
    const signal = this.#session.signal;
    if ((await getSetting(this.#db, LOGOUT_PENDING_KEY)) === null) return;
    await this.#sendLogout(signal);
  }

  /**
   * 手元のデータ（同期で届いた行、まだ送っていない操作、ログインしたユーザー）をまとめて消し、
   * sendo にログアウトを送る印を置く。ネットワークを待たない（送っている途中の同期も、待たずに
   * 中断する）。sendo へは sendPendingSignOut で送る（Web では、スケジューラーがすぐに送り、
   * 届かなければ送り直す）。送り終えるまでは、残ったクッキーで自動ではログインしない。
   */
  async signOut(): Promise<void> {
    this.#beginSession();
    this.#user = null;
    await this.#db.transaction(async (tx) => {
      await clearAll(tx);
      await setSetting(tx, LOGOUT_PENDING_KEY, "1");
      this.#user = null;
    });
    await this.#afterDataCleared();
    this.#emit(ALL_TABLES);
  }

  /**
   * 送れていないログアウトがあれば、sendo に送る。送れたか、送るものがなければ true。
   * 届かなければ false（印は残し、あとで送り直す）。
   */
  async sendPendingSignOut(): Promise<boolean> {
    const signal = this.#session.signal;
    if ((await getSetting(this.#db, LOGOUT_PENDING_KEY)) === null) return true;
    try {
      await this.#sendLogout(signal);
      return true;
    } catch {
      return false;
    }
  }

  async #sendLogout(signal: AbortSignal): Promise<void> {
    await this.#api.logout(signal);
    await this.#db.transaction(async (tx) => {
      // 送っている間にログインし直していたら（ログアウトの印は、もう消えている）、何もしない
      signal.throwIfAborted();
      await deleteSetting(tx, LOGOUT_PENDING_KEY);
    });
  }

  /**
   * sendo に送る前に、セッションのユーザーが手元のユーザーと同じかを確かめる。ログインして
   * いなければ ApiError（unauthorized）を投げる（手元のデータと操作は残す）。違うユーザーなら、
   * 手元を消してそのユーザーに替える。続けて使う、今のログインの中断の合図を返す。
   */
  async #confirmUser(signal: AbortSignal): Promise<AbortSignal> {
    return this.#adopt(await this.#api.me(signal), signal);
  }

  /**
   * sendo のセッションのユーザーを、手元のユーザーにする。同じユーザーなら（メールが変わって
   * いれば置き直すだけで）手元を残し、signal をそのまま返す。違えば（手元にいなかったときも）、
   * 前のユーザーの手元のデータと操作を消して最初から同期し直すようにし、新しいログインの中断の
   * 合図を返す。その前にログアウトやログインのし直しがあれば、何もせずに投げる。
   */
  async #adopt(user: User, signal: AbortSignal): Promise<AbortSignal> {
    let current = signal;
    let switched = false;
    await this.#db.transaction(async (tx) => {
      throwIfSessionEnded(signal);
      if (this.#user?.id === user.id) {
        if (this.#user.email !== user.email) {
          await setSetting(tx, USER_KEY, JSON.stringify(user));
          this.#user = { ...user };
        }
        return;
      }
      // 前のユーザーのために走っている処理（同期、通信が要る操作、書き込み）を中断し、
      // 応答を、消したあとの手元に書き戻させない
      current = this.#beginSession();
      await clearAll(tx);
      await setSetting(tx, USER_KEY, JSON.stringify(user));
      // DB の呼び出しは 1 列に並ぶので、手元のユーザーもトランザクションの中で替える
      // （あとに並んだログアウトが、確実に消す）
      this.#user = { ...user };
      switched = true;
    });
    if (switched) {
      await this.#afterDataCleared();
      this.#emit(ALL_TABLES);
    }
    return current;
  }

  /** 今のログインで動いている処理を中断し、新しいログインの中断の合図を返す */
  #beginSession(): AbortSignal {
    this.#session.abort();
    this.#session = new AbortController();
    this.#syncing = null;
    this.#folderIds.clear();
    this.#onlineOps.clear();
    this.#contentFetches.clear();
    this.#prefetching = null;
    return this.#session.signal;
  }

  // --- 同期 ---

  /**
   * 手元の操作を sendo に送り（操作キュー）、そのあと差分を取り込む。すでに同期中なら、
   * その結果を待つ（同時に 2 つは走らせない）。ログインしていなければ ApiError（unauthorized）。
   * 送る前に、sendo のセッションのユーザーを確かめる。セッションが切れていれば ApiError
   * （unauthorized）を投げ、手元のデータと操作は残す。別のユーザーなら、手元を消してそのユーザーで
   * 最初から同期する。操作を送れなかったら（届かない、など）、取り込まずに ApiError を投げる。
   * 操作は残る。
   */
  sync(): Promise<SyncResult> {
    if (this.#syncing !== null) return this.#syncing;
    const signal = this.#session.signal;
    const running: Promise<SyncResult> = this.#exclusive(() => this.#runSync(signal)).finally(
      () => {
        if (this.#syncing === running) this.#syncing = null;
      },
    );
    this.#syncing = running;
    // 同期を終えたら、裏で、未読の新しい記事の本文を取っておく（同期の結果は待たせない）
    if (this.#prefetchContents > 0) {
      running.then(
        () => void this.prefetchArticleContents(this.#prefetchContents).catch(() => undefined),
        () => undefined,
      );
    }
    return running;
  }

  /**
   * sendo とのやり取り（同期、購読、OPML の取り込み）を 1 つずつ順に行う。購読の応答を待って
   * いる間に同期が走ると、その間にした操作（購読の停止など）を送り終えてから古い応答を書き込み、
   * 操作を取り消してしまうため。
   */
  #exclusive<T>(fn: () => Promise<T>): Promise<T> {
    const run = this.#lane.then(fn, fn);
    this.#lane = run.catch(() => undefined);
    return run;
  }

  async #runSync(started: AbortSignal): Promise<SyncResult> {
    this.#requireSignedIn();
    // 別のユーザーでログインしていたら、手元を消して、そのユーザーで最初から同期する
    const signal = await this.#confirmUser(started);
    const allow = (id: number) => {
      const limit = this.#pushLimit();
      return limit === null || id <= limit || this.#onlineOps.has(id);
    };
    const pushed = await this.#push(signal, allow);
    let promoted = false;
    const pulled = await pull(this.#db, this.#api, {
      signal,
      onPage: (changed) => this.#emit(changed),
      onComplete: async (tx, { settings }) => {
        if (!settings || !(await this.#promoteSettingsSeed(tx))) return [];
        promoted = true;
        return ["settings"];
      },
    });
    // 移行待ちの設定を積んだら、続けて送る（次の同期を待たない）
    if (promoted) {
      const again = await this.#push(signal, allow);
      pushed.sent += again.sent;
      pushed.rejected.push(...again.rejected);
      pushed.remapped.push(...again.remapped);
    }
    return { push: pushed, pull: pulled };
  }

  /**
   * 移行待ちの設定（前の版が localStorage に置いていたもの）のうち、手元にない名前だけを、操作
   * キューに積む（docs/decisions/settings.md の 9）。同期を最後まで終えたときに、同じ
   * トランザクションの中で呼ぶので、手元にない名前は、sendo にもない。ある名前は、届いたほうを
   * 採る。済んだら、移行待ちを消す。移行待ちがあったら true
   */
  async #promoteSettingsSeed(tx: Executor): Promise<boolean> {
    const seed = await getSettingsSeed(tx);
    if (seed === null) return false;
    const missing: SettingItem[] = [];
    for (const item of seed.items) {
      if (!(await hasSyncedSetting(tx, seed.deviceType, item.name))) missing.push(item);
    }
    if (missing.length > 0) {
      await this.#enqueue(tx, {
        kind: "setSettings",
        deviceType: seed.deviceType,
        put: missing,
        remove: [],
      });
    }
    await setSettingsSeed(tx, null);
    return true;
  }

  #push(signal: AbortSignal, allow: (id: number) => boolean): Promise<PushResult> {
    return push(this.#db, this.#api, signal, {
      onChange: (tables) => this.#emit(tables),
      onRemap: ({ from, to }) => this.#folderIds.set(from, to),
      allow,
    });
  }

  #pushLimit(): number | null {
    const ids = [...this.#barriers].map((barrier) => barrier.id);
    return ids.length === 0 ? null : Math.min(...ids);
  }

  /** 積むときに、まとめてはいけない番号（通信が要る操作より前に送る操作） */
  #mergeAbove(): number {
    // 通信が要る操作が積んだ操作にも、あとの操作をまとめない（その操作の位置で送るため）
    const ids = [...[...this.#barriers].map((barrier) => barrier.id), ...this.#onlineOps];
    return ids.length === 0 ? 0 : Math.max(...ids);
  }

  /**
   * 操作を手元に反映して積む（すべての書き込みはここを通す）。fromOnline は、通信が要る操作が
   * 応答を受けて積むもの
   */
  async #enqueue(tx: Executor, op: Operation, fromOnline = false): Promise<void> {
    const id = await enqueue(tx, op, this.#now(), { mergeAbove: this.#mergeAbove() });
    this.#lastOpId = Math.max(this.#lastOpId, id);
    if (fromOnline) this.#onlineOps.add(id);
  }

  /** 手元の DB を消したあとに、DB の外に置いたその人のデータも消してもらう */
  async #afterDataCleared(): Promise<void> {
    try {
      await this.#onDataCleared?.();
    } catch {
      // 消せなくても、ログアウトやユーザーの切り替えは進める（手元の DB は、もう消してある）
    }
  }

  /** まだ sendo に送り終えていない操作の数 */
  countPending(): Promise<number> {
    return countPending(this.#db);
  }

  // --- 書き込み（手元にすぐ反映し、操作キューに積む。送るのは sync()） ---

  /** 購読していないページも、URL から手元に保存してあとで同期する。 */
  async savePage(rawUrl: string, rawTitle?: string): Promise<SavedPage> {
    this.#requireSignedIn();
    const session = this.#session.signal;
    const url = normalizeSavedUrl(rawUrl);
    if (url === null)
      throw new ApiError("invalid", "保存には HTTP または HTTPS の URL を入れてください。");
    const title = rawTitle?.trim() || null;
    if (title !== null && title.length > SAVED_TITLE_LIMIT) {
      throw new ApiError("invalid", `タイトルは ${SAVED_TITLE_LIMIT} 文字までです。`);
    }
    const id = await savedPageId(url);
    const page = await this.#db.transaction(async (tx) => {
      throwIfSessionEnded(session);
      const existing = await getSavedPage(tx, id);
      if (existing !== null) return existing;
      if ((await countSavedPages(tx)) >= SAVED_PAGE_LIMIT) {
        throw new ApiError("invalid", `保存できるページは ${SAVED_PAGE_LIMIT} 件までです。`);
      }
      const saved = { id, url, title, savedAt: this.#now() };
      await this.#enqueue(tx, { kind: "setSavedPage", id, page: saved });
      return saved;
    });
    this.#emit(new Set<Table>(["savedPages"]));
    return page;
  }

  unsavePage(id: string): Promise<void> {
    if (!SAVED_ID_PATTERN.test(id)) throw new RangeError("保存ページの ID が正しくありません。");
    return this.#write({ kind: "setSavedPage", id, page: null }, ["savedPages"]);
  }

  /** 記事を既読（true）／未読（false）にする */
  setRead(articleId: string, read: boolean): Promise<void> {
    return this.#write({ kind: "setArticleState", articleId, read, at: this.#now() }, ["articles"]);
  }

  /**
   * いくつかの記事を、まとめて既読（true）／未読（false）にする（一覧を動かして通り過ぎた記事
   * など）。1 つのトランザクションで積み、変わったことは 1 回だけ知らせる。sendo へは記事ごとに送る
   */
  async setReadMany(articleIds: readonly string[], read: boolean): Promise<void> {
    if (articleIds.length === 0) return;
    this.#requireSignedIn();
    const session = this.#session.signal;
    await this.#db.transaction(async (tx) => {
      // 書き込みが DB の列で待っている間にログインし直したら、前のアカウントの操作を積まない
      throwIfSessionEnded(session);
      for (const articleId of new Set(articleIds)) {
        await this.#enqueue(tx, { kind: "setArticleState", articleId, read, at: this.#now() });
      }
    });
    this.#emit(new Set<Table>(["articles"]));
  }

  /** 記事にスターを付ける（true）／外す（false） */
  setStarred(articleId: string, starred: boolean): Promise<void> {
    return this.#write({ kind: "setArticleState", articleId, starred, at: this.#now() }, [
      "articles",
    ]);
  }

  /**
   * まとめて既読にする。押した時点で手元で未読だった記事だけを既読にし、sendo にも同期済みの
   * 範囲（最後まで同期し終えたカーソル）までだけを頼む（sync.md の 6）。カーソルの範囲に入らない
   * 記事（そのあとに届いた、そのあとに手元で既読・未読を変えた）は、ID で頼む。未読がなければ
   * 何もしない。
   *
   * 既読にした記事の ID を返す（取り消すときは、setReadMany で未読に戻す）。options で、範囲の
   * 一部に絞れる（「1 日より古いもの」「この記事より上・下」）。
   */
  async markAllRead(scope: MarkReadScope, options: MarkAllReadOptions = {}): Promise<string[]> {
    this.#requireSignedIn();
    const session = this.#session.signal;
    const narrowed: string[] = [];
    const bounds: (number | string)[] = [];
    if (options.publishedBefore !== undefined) {
      narrowed.push("published_at < ?");
      bounds.push(options.publishedBefore);
    }
    for (const [edge, than] of [
      [options.olderThan, "<"],
      [options.newerThan, ">"],
    ] as const) {
      if (edge === undefined) continue;
      narrowed.push(`(published_at ${than} ? or (published_at = ? and id ${than} ?))`);
      bounds.push(edge.publishedAt, edge.publishedAt, edge.id);
    }
    const op = await this.#db.transaction(async (tx) => {
      // 書き込みが DB の列で待っている間にログインし直したら、前のアカウントの操作を積まない
      throwIfSessionEnded(session);
      // 範囲の一部だけのときは、カーソルでは頼めない（カーソルは範囲のすべてを既読にする）。
      // すべて ID で頼む
      const cursor = narrowed.length === 0 ? await getCompleteCursor(tx) : null;
      const [condition, params] = scopeCondition(scope);
      const unread = await tx.all<{ id: string; read_synced: number }>(
        `select id, read_synced from articles
         where ${["read_at is null", condition, ...narrowed].join(" and ")}`,
        [...params, ...bounds],
      );
      if (unread.length === 0) return null;
      const op: Operation = {
        kind: "markRead",
        scope,
        articleIds: unread.map((row) => row.id),
        cursor,
        extraIds: unread
          .filter((row) => cursor === null || row.read_synced === 0)
          .map((row) => row.id),
        at: this.#now(),
      };
      await this.#enqueue(tx, op);
      return op;
    });
    if (op === null) return [];
    this.#emit(new Set<Table>(["articles"]));
    return op.articleIds;
  }

  /**
   * フォルダを作り、その ID を返す。ID は小文字の UUID で、sendo にもこの ID で作る（送る前も
   * 送ったあとも同じ ID で使える）。ID は呼ぶ側で決めてもよい（送り直しても二重に作らないように）。
   * sendo に同じ名前の別のフォルダがあれば、送ったときにそれにまとめる。
   */
  async createFolder(name: string, folderId: string = crypto.randomUUID()): Promise<string> {
    if (!FOLDER_ID_PATTERN.test(folderId)) {
      throw new RangeError("フォルダの ID は小文字の UUID にする");
    }
    await this.#write(
      { kind: "createFolder", folderId, name: normalizeFolderName(name), at: this.#now() },
      ["folders"],
    );
    return folderId;
  }

  renameFolder(folderId: string, name: string): Promise<void> {
    const id = this.#folderIds.get(folderId) ?? folderId;
    return this.#write({ kind: "renameFolder", folderId: id, name: normalizeFolderName(name) }, [
      "folders",
    ]);
  }

  /**
   * フォルダを消す。入っていたフィードはフォルダなしに戻す（フィードは消さない）。そのフォルダの
   * 一覧の設定も消す
   */
  deleteFolder(folderId: string): Promise<void> {
    const id = this.#folderIds.get(folderId) ?? folderId;
    return this.#writeWithListSettings(
      { kind: "deleteFolder", folderId: id },
      [...new Set([folderId, id])].map(folderListPath),
      ["folders", "feeds"],
    );
  }

  /** フィードを別のフォルダに移す。null ならフォルダなし */
  moveFeed(feedId: string, folderId: string | null): Promise<void> {
    const resolved = folderId === null ? null : (this.#folderIds.get(folderId) ?? folderId);
    return this.#write({ kind: "moveFeed", feedId, folderId: resolved }, ["feeds"]);
  }

  /** 購読をやめる。記事はスターを付けたものだけが残る。そのフィードの一覧の設定も消す */
  unsubscribe(feedId: string): Promise<void> {
    return this.#writeWithListSettings(
      { kind: "unsubscribe", feedId },
      [feedListPath(feedId)],
      ["feeds", "articles"],
    );
  }

  /**
   * 操作を積み、あわせて、なくなる一覧（やめた購読、消したフォルダ）の設定を、両方の端末の種類で
   * 消す（docs/decisions/settings.md の 3。sendo は名前を解釈しないので、消すのは reader の仕事）。
   * 手元にその項目がなくても送る（ほかの端末が置いた設定が、まだ手元に届いていないことがある。
   * ない項目を消しても、sendo では何も起きない）
   */
  async #writeWithListSettings(op: Operation, paths: string[], tables: Table[]): Promise<void> {
    this.#requireSignedIn();
    const session = this.#session.signal;
    const remove = paths.flatMap((path) => listSettingName(path) ?? []);
    await this.#db.transaction(async (tx) => {
      throwIfSessionEnded(session);
      await this.#enqueue(tx, op);
      if (remove.length === 0) return;
      for (const deviceType of DEVICE_TYPES) {
        await this.#dropFromSettingsSeed(tx, deviceType, remove);
        await this.#enqueue(tx, { kind: "setSettings", deviceType, put: [], remove });
      }
    });
    this.#emit(new Set<Table>(remove.length > 0 ? [...tables, "settings"] : tables));
  }

  // --- 設定（docs/decisions/settings.md。手元にすぐ反映し、操作キューに積む） ---

  /** その端末の種類の設定の項目（手元の DB だけを読む） */
  listSettings(deviceType: DeviceType): Promise<SettingItem[]> {
    return listSyncedSettings(this.#db, deviceType);
  }

  /**
   * 設定を置く ／ 消す（既定に戻す）。名前は reader. で始める。名前の形が違う、値が大きすぎる、
   * 同じ名前が 2 度あるときは RangeError
   */
  async changeSettings(deviceType: DeviceType, change: SettingsChange): Promise<void> {
    requireDeviceType(deviceType);
    const { put, remove } = normalizeSettingsChange(change);
    if (put.length === 0 && remove.length === 0) return;
    this.#requireSignedIn();
    const session = this.#session.signal;
    await this.#db.transaction(async (tx) => {
      throwIfSessionEnded(session);
      // 変えた項目は、移行待ちからも外す（消した項目が、移行待ちの値で戻らないように）
      await this.#dropFromSettingsSeed(tx, deviceType, [
        ...put.map((item) => item.name),
        ...remove,
      ]);
      await this.#enqueue(tx, { kind: "setSettings", deviceType, put, remove });
    });
    this.#emit(new Set<Table>(["settings"]));
  }

  /**
   * 前の版が localStorage に置いていた設定を、移行待ちとして手元に置く（docs/decisions/settings.md
   * の 9）。次に同期を最後まで終えたときに、sendo にない項目だけを送る。それまでは、手元にその
   * 名前の項目がない間、設定として使う。同じものを何度渡してもよい
   */
  async seedSettings(deviceType: DeviceType, items: SettingItem[]): Promise<void> {
    requireDeviceType(deviceType);
    const { put } = normalizeSettingsChange({ put: items });
    this.#requireSignedIn();
    const session = this.#session.signal;
    await this.#db.transaction(async (tx) => {
      throwIfSessionEnded(session);
      await setSettingsSeed(tx, put.length === 0 ? null : { deviceType, items: put });
    });
    this.#emit(new Set<Table>(["settings"]));
  }

  async #dropFromSettingsSeed(
    tx: Executor,
    deviceType: DeviceType,
    names: readonly string[],
  ): Promise<void> {
    const seed = await getSettingsSeed(tx);
    if (seed === null || seed.deviceType !== deviceType) return;
    const dropped = new Set(names);
    const items = seed.items.filter((item) => !dropped.has(item.name));
    if (items.length !== seed.items.length) await setSettingsSeed(tx, { deviceType, items });
  }

  // --- 通信が要る操作（画面では待っている間の表示を出す） ---

  /** サイトの URL から、購読できるフィードの候補を探す */
  discoverFeeds(url: string): Promise<FeedCandidate[]> {
    this.#requireSignedIn();
    return discoverFeeds(this.#api, url, this.#session.signal);
  }

  /**
   * フィードを購読し、手元にもすぐ入れる（記事は次の同期で届く）。folderId には、手元で作った
   * ばかりのフォルダも渡せる。まだ sendo に作っていなければ、フォルダなしで購読してから、
   * 操作キューでそのフォルダに移す（フォルダを作る操作のあとに送る）。
   *
   * 返すのは手元の状態（応答を待っている間にした操作を重ねたもの）。待っている間に購読を
   * やめていれば null。
   */
  async subscribe(url: string, folderId: string | null = null): Promise<Feed | null> {
    this.#requireSignedIn();
    const feed = await this.#online(async (signal) => {
      const wanted = folderId === null ? null : (this.#folderIds.get(folderId) ?? folderId);
      // 呼ぶ前に積んだフォルダの作成は、ここまでに送ってある。sendo にあるフォルダにだけ、
      // そのまま購読する（あとから作った、断られて消えたフォルダには、購読してから移す）
      const ready = wanted !== null && (await this.#isFolderOnSendo(wanted));
      return subscribe(
        this.#db,
        this.#api,
        { url, folderId: ready ? wanted : null },
        signal,
        async (tx, feed) => {
          // sendo はすでに購読していたフィードのフォルダを変えずに返すので、ここで移す。
          // ただし、待っている間にこのフィードを操作していたら（移動、購読の停止）、そちらを採る。
          // 移す先のフォルダを待っている間に消していたら、移さない（フォルダなしのまま）。
          // 待っている間の操作は、この列が空くまで送られないので、必ずキューに残っている
          const [later] = await tx.all<{ id: number }>(
            "select id from pending_ops where key = ? and kind in ('moveFeed', 'unsubscribe') limit 1",
            [feed.id],
          );
          const [target] =
            wanted === null
              ? [{ id: null }]
              : await tx.all<{ id: string }>("select id from folders where id = ?", [wanted]);
          if (feed.folderId !== wanted && later === undefined && target !== undefined) {
            await this.#enqueue(tx, { kind: "moveFeed", feedId: feed.id, folderId: wanted }, true);
          }
        },
      );
    });
    this.#emit(new Set<Table>(["feeds"]));
    return feed;
  }

  /** 手元にあり、作る操作をもう送り終えたフォルダか（sendo にもある） */
  async #isFolderOnSendo(folderId: string): Promise<boolean> {
    const rows = await this.#db.all(
      `select 1 from folders where id = ?1 and not exists (
         select 1 from pending_ops where kind = 'createFolder' and key = ?1
       )`,
      [folderId],
    );
    return rows.length > 0;
  }

  /** OPML を取り込む。sendo が順に登録し、フィードと記事は次からの同期で届く */
  importOpml(xml: string): Promise<OpmlImportResult> {
    this.#requireSignedIn();
    return this.#online((signal) => importOpml(this.#api, xml, signal));
  }

  /**
   * 通信が要る操作を、呼んだ順を守って行う。呼んだ時点までに積んだ操作を先に送り、そのあとに
   * 積んだ操作は、この操作が終わるまで送らない（応答を書き込むときに、上に重ね直す）。
   * sendo とのやり取りの列の中で行う。
   */
  async #online<T>(fn: (signal: AbortSignal) => Promise<T>): Promise<T> {
    const signal = this.#session.signal;
    const barrier = { id: this.#lastOpId };
    this.#barriers.add(barrier);
    // 呼ぶ前に始めた書き込みは、まだ積み終えていなくても、DB の列ではこれより前に並んでいる。
    // 列の中で、それらを含む最後の番号まで境界を上げる（あとから呼んだ書き込みより前に済む）
    const ready = this.#db.transaction(async (tx) => {
      barrier.id = Math.max(barrier.id, await lastPendingId(tx));
    });
    ready.catch(() => undefined);
    try {
      return await this.#exclusive(async () => {
        await ready;
        // 別のユーザーでログインしていたら、頼まれた操作（前のユーザーのためのもの）は送らない
        if ((await this.#confirmUser(signal)) !== signal) {
          throw new ApiError("unauthorized", "別のユーザーでログインしていたので、送らなかった");
        }
        // 呼んだ時点までの操作と、先に呼んだ通信が要る操作が積んだ操作を、先に送る
        await this.#push(signal, (id) => id <= barrier.id || this.#onlineOps.has(id));
        return fn(signal);
      });
    } finally {
      this.#barriers.delete(barrier);
    }
  }

  #requireSignedIn(): void {
    if (this.#user === null) throw new ApiError("unauthorized", "ログインしていない");
  }

  async #write(op: Operation, tables: Table[]): Promise<void> {
    this.#requireSignedIn();
    const session = this.#session.signal;
    await this.#db.transaction(async (tx) => {
      // 書き込みが DB の列で待っている間にログインし直したら、前のアカウントの操作を積まない
      throwIfSessionEnded(session);
      await this.#enqueue(tx, op);
    });
    this.#emit(new Set(tables));
  }

  // --- 読み出し（手元の DB だけ） ---

  listFolders(): Promise<Folder[]> {
    return listFolders(this.#db);
  }

  listFeeds(): Promise<Feed[]> {
    return listFeeds(this.#db);
  }

  listSavedPages(hideStarred = false): Promise<SavedPage[]> {
    return listSavedPages(this.#db, hideStarred);
  }

  async getSavedPageForUrl(raw: string): Promise<SavedPage | null> {
    const session = this.#session.signal;
    const url = normalizeSavedUrl(raw);
    if (url === null) return null;
    const id = await savedPageId(url);
    throwIfSessionEnded(session);
    return getSavedPage(this.#db, id);
  }

  listArticles(query?: ArticleQuery): Promise<Article[]> {
    return listArticles(this.#db, query);
  }

  getArticle(id: string): Promise<Article | null> {
    return getArticle(this.#db, id);
  }

  /** 記事をまとめて読む（見つからない ID は飛ばす） */
  getArticles(ids: readonly string[]): Promise<Article[]> {
    return getArticles(this.#db, ids);
  }

  /** since（ミリ秒）からあとに既読にした記事の数 */
  countReadSince(since: number): Promise<number> {
    return countReadSince(this.#db, since);
  }

  countUnread(): Promise<UnreadCounts> {
    return countUnread(this.#db);
  }

  // --- 記事の本文（sendo の docs/decisions/content.md の 6。差分同期には載らず、記事ごとに取る） ---

  /**
   * 手元の本文を読む（ネットワークを待たない）。手元になければ、sendo にあるか（missing）、
   * 本文のない記事か（none）を返す。本文は、通すタグと属性だけの木にして返す（HTML の文字列は、
   * 画面に渡さない）
   * source=page は hasContent によらず、手元に全文がなければ missing
   */
  async getArticleContent(
    articleId: string,
    source: ContentSource = "feed",
  ): Promise<LocalArticleContent> {
    const found = await getStoredContent(this.#db, articleId, source);
    if (found === null || !found.hasContent) return { status: "none" };
    if (found.stored === null) return { status: "missing" };
    const content = toArticleContent(found.stored);
    return content === null ? { status: "none" } : { status: "ready", content };
  }

  /**
   * 本文を返す。手元にあれば、ネットワークを待たない。なければ sendo から取り、手元に置く
   * （本文は、記事を取り込んだあとは変わらないので、取り直さない）。本文のない記事と、sendo に
   * 本文がなかった記事は null。届かなければ ApiError（network など）を投げる。
   *
   * 画面は、これを待っている間、要約を出しておく。
   * source=page の 404 は、フィード本文の hasContent を変えない（あとで再試行できる）
   */
  async fetchArticleContent(
    articleId: string,
    source: ContentSource = "feed",
  ): Promise<ArticleContent | null> {
    this.#requireSignedIn();
    // 待つ前に、今のログインの合図を取る（待っている間のログアウトで中断されるように）
    const session = this.#session.signal;
    const found = await getStoredContent(this.#db, articleId, source);
    if (found === null || !found.hasContent) return null;
    const stored = found.stored ?? (await this.#fetchContent(articleId, session, false, source));
    return stored === null ? null : toArticleContent(stored);
  }

  /** この sendo で元ページから全文を取れるか。オフラインでも保存済みの全文は読める */
  async pageContentAvailable(): Promise<boolean> {
    this.#requireSignedIn();
    const session = this.#session.signal;
    await this.#confirmSameUser(session);
    return this.#api.pageContentAvailable(session);
  }

  /**
   * 未読の新しい limit 件のうち、sendo に本文があって手元にまだない記事の本文を、1 つずつ取って
   * おく。取った数を返す。届かなくなったら、そこでやめる（次の同期のあとに、続きを取る）。
   * すでに取っている最中なら、その結果を返す
   */
  prefetchArticleContents(limit: number = DEFAULT_PREFETCH_CONTENTS): Promise<number> {
    if (this.#prefetching !== null) return this.#prefetching;
    const session = this.#session.signal;
    const running = (async () => {
      if (this.#user === null) return 0;
      const ids = await listContentToPrefetch(this.#db, limit);
      if (ids.length === 0) return 0;
      // まとめて取る前に、一度だけユーザーを確かめる（記事ごとには確かめない）
      await this.#confirmSameUser(session);
      let fetched = 0;
      for (const id of ids) {
        if (session.aborted) break;
        if ((await this.#fetchContent(id, session, true)) !== null) fetched += 1;
      }
      return fetched;
    })().finally(() => {
      if (this.#prefetching === running) this.#prefetching = null;
    });
    this.#prefetching = running;
    return running;
  }

  /**
   * sendo のセッションのユーザーが、手元のユーザーと同じかを確かめる（docs/decisions/local-first.md
   * の 6）。違えば、手元を消してそのユーザーに替え、ApiError（unauthorized）を投げる（頼まれた
   * 記事は、前のユーザーのもの）
   */
  async #confirmSameUser(session: AbortSignal): Promise<void> {
    if ((await this.#confirmUser(session)) !== session) {
      throw new ApiError("unauthorized", "別のユーザーでログインしていたので、取らなかった");
    }
  }

  /**
   * sendo から本文を取り、手元に置く。フィード本文がなければ、記事を本文なしにして null。
   * ページの全文がなければ、フィード本文は変えずに null（上流で再試行する時期を決める）。
   * 取る前に、セッションのユーザーを確かめる（confirmed なら、呼ぶ側が確かめてある）。別の
   * ユーザーのセッションで聞くと、その人の受信箱にない記事は 404 になり、本文なしと取り違える
   */
  #fetchContent(
    articleId: string,
    session: AbortSignal,
    confirmed = false,
    source: ContentSource = "feed",
  ): Promise<StoredContent | null> {
    if (session.aborted) {
      return Promise.reject(new ApiError("unauthorized", "ログインし直したので取らなかった"));
    }
    const key = `${source}:${articleId}`;
    const existing = this.#contentFetches.get(key);
    if (existing !== undefined) return existing;
    const running = (async () => {
      if (!confirmed) await this.#confirmSameUser(session);
      const content = await this.#api.articleContent(articleId, session, source);
      const changed = await this.#db.transaction(async (tx) => {
        // 取っている間にログアウトしたり、ユーザーが替わったりしたら、置かない
        throwIfSessionEnded(session);
        if (content === null) return source === "feed" && markContentMissing(tx, articleId);
        await putStoredContent(tx, articleId, content, this.#now(), source);
        return false;
      });
      // 本文なしに変えたら、記事を読み直してもらう
      if (changed) this.#emit(new Set<Table>(["articles"]));
      return content;
    })().finally(() => {
      if (this.#contentFetches.get(key) === running) this.#contentFetches.delete(key);
    });
    this.#contentFetches.set(key, running);
    return running;
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
 * 手元のデータ（同期で届いた行、まだ送っていない操作、カーソル、ログインしたユーザーなどの設定）を
 * すべて消す
 */
async function clearAll(tx: Executor): Promise<void> {
  await tx.run("delete from pending_ops");
  // 手元に置いた本文も、記事と一緒に消える（スキーマのトリガー）
  await tx.run("delete from articles");
  await tx.run("delete from feeds");
  await tx.run("delete from folders");
  await tx.run("delete from synced_settings");
  await clearSavedPages(tx);
  await tx.run("delete from settings");
}

/**
 * 手元に置いた本文（信頼できない HTML）を、画面に渡す木にする。出すもの（文字か画像）が
 * 残らなければ null（要約を出す）
 */
function toArticleContent(stored: StoredContent): ArticleContent | null {
  const nodes = parseContent(stored.html);
  return hasVisibleContent(nodes) ? { nodes, source: stored.source } : null;
}

/** 端末の種類を確かめる（画面のワーカーの外から来た値なので） */
function requireDeviceType(value: unknown): asserts value is DeviceType {
  if (!DEVICE_TYPES.some((type) => type === value)) {
    throw new RangeError("端末の種類は mobile か desktop");
  }
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

/** 書き込みを始めたときのログインが、もう終わっていたら投げる */
function throwIfSessionEnded(session: AbortSignal): void {
  if (session.aborted) throw new ApiError("unauthorized", "ログインし直したので書き込まなかった");
}

/** 手元に置いたユーザーを読む。形が違えば（壊れていれば）、ログインしていないことにする */
function parseUser(value: string | null): User | null {
  if (value === null) return null;
  try {
    const parsed = JSON.parse(value) as { id?: unknown; email?: unknown } | null;
    return typeof parsed?.id === "string" && parsed.id !== "" && typeof parsed.email === "string"
      ? { id: parsed.id, email: parsed.email }
      : null;
  } catch {
    return null;
  }
}
