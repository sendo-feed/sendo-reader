import { disconnectDiscord, getDiscord, unsubscribeDiscord } from "./account";
import { ApiError, createSendoApi, type SendoApi } from "./api/client";
import { hasVisibleContent, parseContent } from "./content/parse";
import {
  CONTENT_STORAGE_LIMITS,
  type ContentStorage,
  parseContentStorageLimit,
} from "./content/storage";
import {
  type ContentSource,
  clearPageMissing,
  evictContents,
  getStoredContent,
  markContentMissing,
  markPageMissing,
  nextContentToPrefetch,
  type PrefetchList,
  type PrefetchTarget,
  putStoredContent,
  type StoredContent,
  storedContentBytes,
} from "./db/content";
import type { Database, Executor } from "./db/database";
import { getStoredFeedFetchTimes, putStoredFeedFetchTimes } from "./db/feed-fetch-times";
import {
  type ArticleQuery,
  type ArticleScope,
  countReadSince,
  countUnread,
  getArticle,
  getArticles,
  listArticles,
  listFeeds,
  listFolders,
  listLatestArticleDates,
  searchTerms,
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
  getStoredTranslatedContent,
  putStoredTranslatedContent,
  type StoredTranslatedContent,
} from "./db/translated-content";
import {
  type Article,
  type ArticleContent,
  DEVICE_TYPES,
  type DeviceType,
  type Feed,
  type FeedFetchTimes,
  type Folder,
  type LocalArticleContent,
  type SavedPage,
  type SettingItem,
  type SettingsChange,
  type Table,
  type TranslatedContent,
  type UnreadCounts,
  type User,
} from "./models";
import {
  discoverFeeds,
  type FeedCandidate,
  fetchFeedTimes,
  importOpml,
  type OpmlImportResult,
  requestTranslation,
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
import {
  countPending,
  enqueue,
  lastPendingId,
  type PushResult,
  push,
  type RejectedOperation,
} from "./sync/queue";
import { TranslationRequests } from "./translation-requests";

/** ログインしたユーザー（JSON）を置く設定の鍵 */
const USER_KEY = "auth.user";

/**
 * ログアウトを sendo に送れていない印。送れるまでは、残ったセッションのクッキーで、自動では
 * ログインし直さない（docs/decisions/local-first.md の 6）
 */
const LOGOUT_PENDING_KEY = "auth.logoutPending";

/**
 * 手元に置く本文の量の上限（バイト）を置く設定の鍵。端末ごとの設定なので、sendo に預けず、
 * ログアウトしても消さない（docs/decisions/settings.md の 4）
 */
const CONTENT_STORAGE_LIMIT_KEY = "content.storageLimit";

/**
 * 最後に開いた記事（いま開いている記事）の ID を置く設定の鍵。開封の記録を積むときに覚え、
 * その記事の本文は上限のために消さない（docs/decisions/local-first.md の「記事の本文」）。
 * sendo には預けず、ログアウトで消える
 */
const LAST_OPENED_KEY = "content.lastOpened";

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
   * 同期のあとに、未読の記事の全文を 1 件ずつ選び直しながら先に取っておく（開いたときに待たず、
   * オフラインでも読めるように）。1 回の同期のあとに頼む数。既定は 0（取らない。開いたときに取る）
   */
  prefetchContents?: number;
}

/**
 * 1 回の同期のあとに先に取る全文の数（Web の既定）。全文をまだ抜いていない記事は、sendo が
 * そのリクエストの中で元のサイトに取りにいくので、まとめて頼まない。残りは次の同期のあとに取る。
 * 本文の中の画像は、表示するまで取らない
 */
export const DEFAULT_PREFETCH_CONTENTS = 30;

/** 先読みで、sendo がこれだけ続けて失敗したら（5xx など）、その回はやめる */
const MAX_PREFETCH_FAILURES = 3;

/** 先読みで、同じ記事で sendo がこれだけ失敗したら、しばらくその記事を頼まない */
const MAX_PREFETCH_ATTEMPTS = 3;

/**
 * 先読みで何度も失敗した記事を頼まない時間（ミリ秒）。記事だけの失敗なら、この間隔で 3 回ずつ
 * 頼み直すだけで済み、sendo 全体の一時的な失敗なら、この時間がたてば元に戻る
 */
const PREFETCH_RETRY_AFTER_MS = 6 * 60 * 60 * 1000;

/** 一覧を開いた時刻を覚えておくタブの数（開いているタブの数より十分に多く） */
const MAX_OPEN_TABS = 32;

/** タブの識別子の長さの上限 */
const MAX_TAB_ID_LENGTH = 200;

/**
 * 先読みで、その記事を飛ばして続けてよい失敗か。届かない（network）とログインの問題
 * （unauthorized）は、ほかの記事でも同じなのでやめる。DB などの ApiError でない失敗もやめる
 */
function isSkippablePrefetchError(error: unknown): boolean {
  return error instanceof ApiError && error.kind !== "network" && error.kind !== "unauthorized";
}

export type ChangeListener = (tables: ReadonlySet<Table>) => void;

/** 1 回の同期の結果 */
export interface SyncResult {
  push: PushResult;
  pull: PullResult;
}

/** フォルダ名の長さの上限（sendo と同じ） */
export const MAX_FOLDER_NAME_LENGTH = 200;

/** Sendo の購読更新 API に合わせた表示名の上限（UTF-16） */
export const MAX_FEED_DISPLAY_NAME_LENGTH = 200;

/** まとめて既読にする記事を、範囲の一部に絞る（どれも渡さなければ、範囲のすべて） */
export interface MarkAllReadOptions {
  /** この時刻（ミリ秒）より前に公開された記事だけ */
  publishedBefore?: number;
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
  readonly #rejectionListeners = new Set<(rejection: RejectedOperation) => void>();
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
  /** 取っている訳した本文（記事ごと。同じ記事を続けて頼まれても、1 回だけ取る） */
  readonly #translationFetches = new Map<string, Promise<StoredTranslatedContent | null>>();
  readonly #feedTimesRefreshes = new Map<string, Promise<FeedFetchTimes | null>>();
  readonly #prefetchContents: number;
  #prefetching: Promise<number> | null = null;
  /** 先読みが走っている間に、また頼まれた（終わったあとに、もう一度だけ回す） */
  #prefetchAgain = false;
  /**
   * 先読みで sendo が失敗した（5xx など）記事と、その回数。MAX_PREFETCH_ATTEMPTS 回失敗したら、
   * PREFETCH_RETRY_AFTER_MS のあいだ先読みで頼まない（開いたときは取りにいく）。sendo 全体の
   * 一時的な失敗でも、時間がたてば頼み直す。メモリーにだけ持つ
   */
  readonly #prefetchFailures = new Map<string, { count: number; until: number }>();
  /**
   * 画面がいま開いている一覧（先に取る順を決める）。メモリーにだけ持ち、ログアウトとユーザーの
   * 切り替えで消す
   */
  #openList: PrefetchList | null = null;
  /**
   * タブごとに、最後に開いた一覧（開いた回の番号と範囲）と、それを開いた時刻。タブが前に出て
   * 知らせ直したときに、開いた時刻を変えないために覚える。最近知らせたタブから残し、古いタブから
   * 捨てる
   */
  readonly #openedAt = new Map<string, { seq: number; key: string; since: number }>();
  /** この端末で頼んだ、その場の翻訳（docs/decisions/translation.md の 6）。メモリーにだけ持つ */
  readonly #translationRequests: TranslationRequests;
  /** 頼んだ印が 1 分で外れたときに、画面に読み直してもらうための時計 */
  #translationTimer: ReturnType<typeof setTimeout> | undefined;
  /** これまでに始めた同期の数（頼んだあとに始めた同期かを見分ける） */
  #startedSyncs = 0;

  private constructor(options: ReaderCoreOptions) {
    this.#db = options.db;
    this.#now = options.now ?? Date.now;
    this.#onDataCleared = options.onDataCleared;
    this.#prefetchContents = options.prefetchContents ?? 0;
    this.#translationRequests = new TranslationRequests(this.#now);
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
    this.#feedTimesRefreshes.clear();
    this.#prefetching = null;
    this.#prefetchAgain = false;
    this.#prefetchFailures.clear();
    this.#openList = null;
    this.#openedAt.clear();
    this.#translationRequests.clear();
    clearTimeout(this.#translationTimer);
    this.#translationTimer = undefined;
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
    // 同期を終えたら、裏で、未読の記事の全文を取っておく（同期の結果は待たせない）
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
    const syncNumber = ++this.#startedSyncs;
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
    // 頼んだあとに始めた同期が終わったら、頼んだ印を外し、訳せなかったかを決める
    if (
      signal === this.#session.signal &&
      (await this.#translationRequests.afterSync(syncNumber, (ids) => getArticles(this.#db, ids)))
    ) {
      this.#emit(new Set<Table>(["articles"]));
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
      onReject: (rejection) => {
        for (const listener of this.#rejectionListeners) {
          try {
            listener(rejection);
          } catch (error) {
            console.error("操作の拒否の通知で失敗した", error);
          }
        }
      },
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

  /**
   * 記事の開封の記録を積む。既読の状態やフィード記事の同期とは独立して送る。あわせて、最後に
   * 開いた記事（いま開いている記事）として手元に覚え、その本文を上限のために消さない
   * （docs/decisions/local-first.md の「記事の本文」。画面が開封の記録を積む前は守られない）
   */
  async recordArticleOpen(
    articleId: string,
    id: string = crypto.randomUUID(),
    openedAt = this.#now(),
  ): Promise<void> {
    this.#requireSignedIn();
    const session = this.#session.signal;
    await this.#db.transaction(async (tx) => {
      throwIfSessionEnded(session);
      await this.#enqueue(tx, {
        kind: "recordArticleOpens",
        events: [{ id, articleId, occurredAt: new Date(openedAt).toISOString() }],
      });
      // いま開いている記事として覚える（上限のために、この記事の本文を消さない）
      await setSetting(tx, LAST_OPENED_KEY, articleId);
    });
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
   * 一部に絞れる（「1 日より古いもの」）。
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

  /** 購読の表示名を変える。null なら配信元の名前に戻す */
  async renameFeed(feedId: string, displayName: string | null): Promise<void> {
    const name = displayName === null ? null : displayName.trim();
    if (name !== null && (name.length === 0 || name.length > MAX_FEED_DISPLAY_NAME_LENGTH)) {
      throw new RangeError("表示名は1〜200文字で入力してください。");
    }
    await this.#write({ kind: "renameFeed", feedId, displayName: name }, ["feeds"]);
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
   * 操作と、なくなる一覧の設定の削除を、同じトランザクションで積む。
   */
  async #writeWithListSettings(op: Operation, paths: string[], tables: Table[]): Promise<void> {
    this.#requireSignedIn();
    const session = this.#session.signal;
    const removed = await this.#db.transaction(async (tx) => {
      throwIfSessionEnded(session);
      await this.#enqueue(tx, op);
      return this.#enqueueListSettingsRemoval(tx, paths);
    });
    this.#emit(new Set<Table>(removed ? [...tables, "settings"] : tables));
  }

  /**
   * なくなる一覧の設定を、両方の端末の種類で消す（docs/decisions/settings.md の 3）。
   * ほかの端末が置いた設定がまだ同期で届いていないことがあるので、手元になくても送る。
   */
  async #enqueueListSettingsRemoval(
    tx: Executor,
    paths: string[],
    online = false,
  ): Promise<boolean> {
    const remove = [...new Set(paths.flatMap((path) => listSettingName(path) ?? []))];
    if (remove.length === 0) return false;
    for (const deviceType of DEVICE_TYPES) {
      await this.#dropFromSettingsSeed(tx, deviceType, remove);
      await this.#enqueue(tx, { kind: "setSettings", deviceType, put: [], remove }, online);
    }
    return true;
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

  /** 購読詳細に出す取得時刻を更新する。同じフィードの更新が並んだら、応答を共有する */
  async refreshFeedFetchTimes(feedId: string): Promise<FeedFetchTimes | null> {
    this.#requireSignedIn();
    const existing = this.#feedTimesRefreshes.get(feedId);
    if (existing !== undefined) return existing;
    const session = this.#session.signal;
    const running = (async () => {
      await this.#confirmSameUser(session);
      const times = await fetchFeedTimes(this.#api, feedId, session);
      if (times === null) return null;
      return this.#db.transaction(async (tx) => {
        throwIfSessionEnded(session);
        return (await putStoredFeedFetchTimes(tx, feedId, times)) ? times : null;
      });
    })().finally(() => {
      if (this.#feedTimesRefreshes.get(feedId) === running) this.#feedTimesRefreshes.delete(feedId);
    });
    this.#feedTimesRefreshes.set(feedId, running);
    return running;
  }

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

  /** Discord の購読をやめる。記事の削除は、スター付きも含めて次の差分同期で届く。 */
  unsubscribeDiscord(userId: string, feedId: string): Promise<void> {
    return this.#removeDiscordSubscriptions(userId, async (signal) => {
      await unsubscribeDiscord(this.#api, feedId, signal);
      return [feedId];
    });
  }

  /** Discord との接続を解除する。解除する一覧は、送る前に sendo で確かめる。 */
  disconnectDiscord(userId: string): Promise<void> {
    return this.#removeDiscordSubscriptions(userId, async (signal) => {
      const { subscriptions } = await getDiscord(this.#api, signal);
      await this.#confirmSameUser(signal);
      await disconnectDiscord(this.#api, signal);
      return subscriptions.map(({ feedId }) => feedId);
    });
  }

  async #removeDiscordSubscriptions(
    userId: string,
    remove: (signal: AbortSignal) => Promise<string[]>,
  ): Promise<void> {
    if (this.#user?.id !== userId) {
      throw new ApiError("unauthorized", "別のユーザーでログインしていたので、送らなかった");
    }
    const removed = await this.#online(async (signal) => {
      const feedIds = await remove(signal);
      return this.#db.transaction(async (tx) => {
        throwIfSessionEnded(signal);
        return this.#enqueueListSettingsRemoval(tx, feedIds.map(feedListPath), true);
      });
    });
    if (removed) this.#emit(new Set<Table>(["settings"]));
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
    if (tables.length > 0) this.#emit(new Set(tables));
  }

  // --- 読み出し（手元の DB だけ） ---

  listFolders(): Promise<Folder[]> {
    return listFolders(this.#db);
  }

  listFeeds(): Promise<Feed[]> {
    return listFeeds(this.#db);
  }

  listLatestArticleDates(): Promise<Map<string, number>> {
    return listLatestArticleDates(this.#db);
  }

  /** 保存済みの取得時刻。まだ時刻を確認していなければ null */
  getFeedFetchTimes(feedId: string): Promise<FeedFetchTimes | null> {
    return getStoredFeedFetchTimes(this.#db, feedId);
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

  // 記事には、この端末で頼んだその場の翻訳を重ねて返す（docs/decisions/translation.md の 6）

  async listArticles(query?: ArticleQuery): Promise<Article[]> {
    return (await listArticles(this.#db, query)).map((a) => this.#translationRequests.overlay(a));
  }

  async getArticle(id: string): Promise<Article | null> {
    const article = await getArticle(this.#db, id);
    return article === null ? null : this.#translationRequests.overlay(article);
  }

  /** 記事をまとめて読む（見つからない ID は飛ばす） */
  async getArticles(ids: readonly string[]): Promise<Article[]> {
    return (await getArticles(this.#db, ids)).map((a) => this.#translationRequests.overlay(a));
  }

  // --- 記事の翻訳を頼む（sendo に届かないとできない） ---

  /**
   * 記事をその場で訳してもらう（docs/decisions/translation.md の 4、6）。操作キューには積まず、
   * sendo に届かなければ ApiError（network）。受け付けられたら（もう訳しているか、訳し終えていた
   * ときも）、頼んだ印を付けて、記事が変わったと知らせる。断られたら ApiError（code に理由）。
   * 同期は呼んだ側が頼む（Web ではワーカーが、終わったらすぐ同期する）
   */
  async requestTranslation(articleId: string): Promise<void> {
    this.#requireSignedIn();
    const session = this.#session.signal;
    try {
      await requestTranslation(this.#api, articleId, session);
    } catch (error) {
      if (!(error instanceof ApiError && error.code === "translation_exists")) throw error;
    }
    // 待っている間にログアウトした ／ 別のユーザーでログインし直した
    throwIfSessionEnded(session);
    this.#translationRequests.accept(articleId, this.#startedSyncs);
    this.#scheduleTranslationExpiry();
    this.#emit(new Set<Table>(["articles"]));
  }

  /** 頼んだ印が 1 分で外れたら、画面に読み直してもらう */
  #scheduleTranslationExpiry(): void {
    clearTimeout(this.#translationTimer);
    this.#translationTimer = undefined;
    const at = this.#translationRequests.nextExpiry();
    if (at === null) return;
    this.#translationTimer = setTimeout(
      () => {
        this.#translationTimer = undefined;
        if (this.#translationRequests.expireMarks()) this.#emit(new Set<Table>(["articles"]));
        this.#scheduleTranslationExpiry();
      },
      Math.max(0, at - this.#now()),
    );
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

  /**
   * 手元の訳した本文を読む（ネットワークを待たない。docs/decisions/translation.md の 8）。
   * translatedAt は、画面が出している訳文の訳した時刻で、その時刻の本文だけを使う（ready か none。
   * なければ missing）。本文は、通すタグと属性だけの木にして返す
   */
  async getTranslatedContent(articleId: string, translatedAt: number): Promise<TranslatedContent> {
    const found = await getStoredTranslatedContent(this.#db, articleId);
    const stored = found?.stored;
    if (stored == null || stored.translatedAt !== translatedAt) return { status: "missing" };
    return toTranslatedContent(stored);
  }

  /**
   * 訳した本文を返す（docs/decisions/translation.md の 8、9）。手元に translatedAt の本文か、本文を
   * 訳さなかった印があれば、ネットワークを待たない。なければ sendo から取り、手元に置いてある
   * ものより新しければ置く。sendo の訳文が translatedAt のものでなければ（訳し直した、なくなった）、
   * stale（新しい本文は置いておき、同期で時刻が届いたら使う）。届かなければ ApiError を投げる
   */
  async fetchTranslatedContent(
    articleId: string,
    translatedAt: number,
  ): Promise<TranslatedContent> {
    this.#requireSignedIn();
    // 待つ前に、今のログインの合図を取る（待っている間のログアウトで中断されるように）
    const session = this.#session.signal;
    const found = await getStoredTranslatedContent(this.#db, articleId);
    if (found === null) return { status: "stale" };
    if (found.stored?.translatedAt === translatedAt) return toTranslatedContent(found.stored);
    let fetched = await this.#fetchTranslatedContent(articleId, session);
    // 前の時刻を頼んだ取得に合流して、頼んだ時刻より古い訳文が返った（取っている間に、同期で
    // 新しい時刻が届いた）。その取得は終わったので、一度だけ取り直す
    if (fetched !== null && fetched.translatedAt < translatedAt) {
      fetched = await this.#fetchTranslatedContent(articleId, session);
    }
    if (fetched === null || fetched.translatedAt !== translatedAt) return { status: "stale" };
    return toTranslatedContent(fetched);
  }

  /**
   * 画面がいま開いている一覧を知らせる（docs/decisions/local-first.md の「記事の本文」）。先読みは、
   * この一覧の、読んでいる位置のすぐ下から先に取る。一覧を出さない画面、言葉が空の Search、
   * Recently Read では null を渡す（すべての未読から新しい順に取る）。最後に知らせたものに従い、
   * 走っている先読みも、次の 1 件から従う。
   *
   * opened は、知らせたタブ（tab）と、そのタブで一覧を開いた回の番号（seq。一覧を開くたびに替える）。
   * 同じタブが同じ回のまま知らせ直したとき（タブが前に出た）は、開いた時刻を、その回に最初に
   * 知らせた時刻のままにする
   */
  setOpenList(scope: ArticleScope | null, opened: OpenedList): void {
    if (
      typeof opened !== "object" ||
      opened === null ||
      typeof opened.tab !== "string" ||
      opened.tab.length > MAX_TAB_ID_LENGTH ||
      !Number.isSafeInteger(opened.seq)
    ) {
      throw new TypeError("一覧を開いたタブと回の番号の形が違う");
    }
    const normalized = normalizeOpenList(scope);
    if (normalized === null) {
      this.#openList = null;
      return;
    }
    const key = JSON.stringify(normalized);
    const last = this.#openedAt.get(opened.tab);
    const since =
      last !== undefined && last.seq === opened.seq && last.key === key ? last.since : this.#now();
    // 最近知らせたタブを後ろに並べ直し、多すぎたら一番前（長く知らせていないタブ）から捨てる
    this.#openedAt.delete(opened.tab);
    this.#openedAt.set(opened.tab, { seq: opened.seq, key, since });
    if (this.#openedAt.size > MAX_OPEN_TABS) {
      const oldest = this.#openedAt.keys().next().value;
      if (oldest !== undefined) this.#openedAt.delete(oldest);
    }
    this.#openList = { scope: normalized, since };
  }

  /**
   * 未読で手元に全文がない記事の全文を、1 件ずつ選び直しながら limit 件まで取っておく
   * （docs/decisions/local-first.md の「記事の本文」）。訳文のある記事は、全文ではなく訳した本文を
   * 取る（手元に今の訳した時刻の訳した本文がなければ、全文があっても選ぶ。sendo が本文を訳さなかった
   * 記事は全文を取る。docs/decisions/translation.md の 10）。開いている一覧（setOpenList）があれば、その
   * 一覧の、読んでいる位置のすぐ下から先に取る。全文が取れなかった記事は印を置いて先読みでは
   * 取り直さず、フィード本文があれば代わりに取っておく。リンクのない記事は全文を頼まない。手元の
   * 本文が上限に届いたら、既読の分を消して空け、空かなければやめる。上限が Off なら取らない。
   *
   * 新しく置けた本文の数を返す。届かない（network）かログインの問題（unauthorized）ならそこで
   * やめて投げる（次の同期のあとに続きを取る）。そのほかの失敗（sendo の 5xx など）はその記事を
   * 飛ばして続け、続けて何件も失敗したらやめる（飛ばした記事は、次の同期のあとにまた頼む。同じ
   * 記事が何度も失敗したら、しばらく頼まない）。
   * 1 回に頼むのは limit 件まで（試した記事の数で数え、途中の同期で届いた記事もその中に入る）。
   * 走っている最中に頼まれたら、その結果を返す。選び直しで、途中で届いた記事は同じ回に入るが、
   * 回が終わる間際に頼まれたときは、件数が残っていれば同じ回の続きとしてもう一度回す
   */
  prefetchArticleContents(limit: number = DEFAULT_PREFETCH_CONTENTS): Promise<number> {
    if (this.#prefetching !== null) {
      this.#prefetchAgain = true;
      return this.#prefetching;
    }
    return this.#startPrefetch(limit, []);
  }

  /**
   * 先読みの回を始める。tried は、この回で試した記事（回し直しにも引き継ぎ、選び直さない。頼んだ
   * 数もここで数えるので、回し直しても limit 件を超えない）
   */
  #startPrefetch(limit: number, tried: string[]): Promise<number> {
    const session = this.#session.signal;
    let failed = false;
    const running = (async () => {
      let fetched = 0;
      do {
        this.#prefetchAgain = false;
        fetched += await this.#prefetchOnce(limit, session, tried);
      } while (this.#prefetchAgain && !session.aborted && tried.length < limit);
      return fetched;
    })()
      .catch((error: unknown) => {
        failed = true;
        throw error;
      })
      .finally(() => {
        if (this.#prefetching !== running) return;
        this.#prefetching = null;
        // ループが最後に見たあとに頼まれていたら、同じ回の続きとして回し直す（件数と試した記事を
        // 引き継ぐ。失敗して抜けたときと、件数を使い切ったときは、次の同期に任せる）
        const again = this.#prefetchAgain && !failed && !session.aborted && tried.length < limit;
        this.#prefetchAgain = false;
        if (again) void this.#startPrefetch(limit, tried).catch(() => undefined);
      });
    this.#prefetching = running;
    return running;
  }

  /**
   * 先読みを 1 回回す。1 件取るたびに、手元から次の 1 件を選び直す（docs/decisions/local-first.md の
   * 「記事の本文」）。既読になった記事は選ばれず、途中の同期で届いた記事も同じ回に入る。頼むのは
   * limit 件まで（頼んだ数で数える）。この回で試した記事は、この回では選び直さない。新しく置けた
   * 本文の数を返す
   */
  async #prefetchOnce(limit: number, session: AbortSignal, tried: string[]): Promise<number> {
    if (this.#user === null) return 0;
    if ((await this.#contentStorageLimit()) === 0) return 0;
    const giveUp = this.#prefetchGiveUp();
    let confirmed = false;
    let fetched = 0;
    let failures = 0;
    while (tried.length < limit) {
      if (session.aborted) break;
      const target = await nextContentToPrefetch(this.#db, [...giveUp, ...tried], this.#openList);
      if (target === null) break;
      if (!confirmed) {
        // 取る前に、一度だけユーザーを確かめる（記事ごとには確かめない）
        await this.#confirmSameUser(session);
        confirmed = true;
      }
      if (!(await this.#makeContentRoom())) break;
      tried.push(target.id);
      try {
        if (await this.#prefetchContent(target, session)) fetched += 1;
        failures = 0;
        this.#prefetchFailures.delete(target.id);
      } catch (error) {
        if (!isSkippablePrefetchError(error)) throw error;
        // ログインが替わっていたら、前のログインの記事を数えない
        if (session.aborted) break;
        // sendo がこの記事で失敗した。飛ばして続け、続けて何件も失敗したらやめる。同じ記事が
        // 何度も失敗したら、しばらく頼まない（その記事が古い記事の先読みを止めないように）
        const count = (this.#prefetchFailures.get(target.id)?.count ?? 0) + 1;
        this.#prefetchFailures.set(target.id, {
          count,
          until: count >= MAX_PREFETCH_ATTEMPTS ? this.#now() + PREFETCH_RETRY_AFTER_MS : 0,
        });
        failures += 1;
        if (failures >= MAX_PREFETCH_FAILURES) break;
      }
    }
    return fetched;
  }

  /** 何度も失敗して、しばらく先読みで頼まない記事（頼まない期間が過ぎた記録は、ここで消す） */
  #prefetchGiveUp(): string[] {
    const now = this.#now();
    const giveUp: string[] = [];
    for (const [id, failure] of this.#prefetchFailures) {
      if (failure.until !== 0 && failure.until <= now) this.#prefetchFailures.delete(id);
      else if (failure.until !== 0) giveUp.push(id);
    }
    return giveUp;
  }

  /**
   * 1 件の本文を取っておく。訳文のある記事は訳した本文を取る（docs/decisions/translation.md の
   * 10）。sendo が本文を訳さなかったら、原文の本文を取る。sendo の訳文の時刻が選んだときと違えば
   * （取る間に訳し直した）、この回では取らない。原文の本文は、全文を頼める記事は全文を取り、取れ
   * なければ、フィード本文があれば代わりに取る。新しく本文を置けたら true（選んでから順番が来るまで
   * に、開いて取っていた記事は取り直さず false）
   */
  async #prefetchContent(target: PrefetchTarget, session: AbortSignal): Promise<boolean> {
    const articleId = target.id;
    if (target.translatedAt !== null) {
      const found = await getStoredTranslatedContent(this.#db, articleId);
      if (found?.stored?.translatedAt === target.translatedAt) return false;
      const fetched = await this.#fetchTranslatedContent(articleId, session, true);
      if (fetched === null || fetched.translatedAt !== target.translatedAt) return false;
      if (fetched.html !== null) return true;
    }
    if (!target.feedOnly) {
      // 選んでから順番が来るまでに、開いて取っていたら、取り直さない
      const page = await getStoredContent(this.#db, articleId, "page");
      if (page?.stored != null) return false;
      if ((await this.#fetchContent(articleId, session, true, "page")) !== null) return true;
    }
    const feed = await getStoredContent(this.#db, articleId, "feed");
    if (feed === null || !feed.hasContent || feed.stored !== null) return false;
    return (await this.#fetchContent(articleId, session, true, "feed")) !== null;
  }

  /**
   * 手元の本文が上限に届いていたら、既読の分を消して空ける。上限より少なくなれば true（Off なら
   * false）。最後に開いた記事（いま開いている記事）の本文は消さない
   */
  async #makeContentRoom(): Promise<boolean> {
    return this.#db.transaction(async (tx) => {
      const limit = await this.#contentStorageLimit(tx);
      // 上限ちょうどでも空きはないので、上限より少なくなるまで消す
      return limit > 0 && (await evictContents(tx, limit - 1, await protectedArticles(tx))) < limit;
    });
  }

  async #contentStorageLimit(db: Executor = this.#db): Promise<number> {
    return parseContentStorageLimit(await getSetting(db, CONTENT_STORAGE_LIMIT_KEY));
  }

  /** 手元に置いた本文の量と、その上限（端末ごとの設定。sendo には預けない） */
  async getContentStorage(): Promise<ContentStorage> {
    const [limit, used] = await Promise.all([
      this.#contentStorageLimit(),
      storedContentBytes(this.#db),
    ]);
    return { limit, used };
  }

  /**
   * 手元に置く本文の量の上限を変える（CONTENT_STORAGE_LIMITS のどれか。0 は Off）。超えていれば、
   * 既読の分を消す。先に取れるようになったら、続きを取りにいく（待たない）
   */
  async setContentStorageLimit(limit: number): Promise<ContentStorage> {
    if (!CONTENT_STORAGE_LIMITS.includes(limit)) {
      throw new RangeError("本文を置く量の上限は、決めた値のどれか");
    }
    const used = await this.#db.transaction(async (tx) => {
      await setSetting(tx, CONTENT_STORAGE_LIMIT_KEY, String(limit));
      return limit > 0
        ? evictContents(tx, limit, await protectedArticles(tx))
        : storedContentBytes(tx);
    });
    if (limit > 0 && this.#prefetchContents > 0 && this.#user !== null) {
      void this.prefetchArticleContents(this.#prefetchContents).catch(() => undefined);
    }
    return { limit, used };
  }

  /**
   * sendo のセッションのユーザーが、手元のユーザーと同じかを確かめる（docs/decisions/local-first.md
   * の 6）。違えば、手元を消してそのユーザーに替え、ApiError（unauthorized）を投げる（頼まれた
   * 読み出しは、前のユーザーのためのもの）
   */
  async #confirmSameUser(session: AbortSignal): Promise<void> {
    if ((await this.#confirmUser(session)) !== session) {
      throw new ApiError("unauthorized", "別のユーザーでログインしていたので、取らなかった");
    }
  }

  /**
   * sendo から本文を取り、手元に置く。フィード本文がなければ、記事を本文なしにして null。
   * ページの全文がなければ、フィード本文は変えずに、全文が取れなかった印を置いて null（先読みでは
   * 取り直さない。開いたときは取りにいく）。全文が取れたら、その印を消す。
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
        if (content === null) {
          if (source === "feed") return markContentMissing(tx, articleId);
          // 全文が取れなかった。先読みでは取り直さない（開いたときは取りにいく）
          await markPageMissing(tx, articleId, this.#now());
          return false;
        }
        await putStoredContent(tx, articleId, content, this.#now(), source);
        // 全文が取れたら、前に取れなかった印を消す
        if (source === "page") await clearPageMissing(tx, articleId);
        // 上限を超えたら、既読の分を消す。いま置いた本文と、最後に開いた記事（いま開いている
        // 記事）の本文は消さない（開いて取った本文は、超えていても置く）
        const limit = await this.#contentStorageLimit(tx);
        if (limit > 0) await evictContents(tx, limit, await protectedArticles(tx, articleId));
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

  /**
   * sendo から訳した本文を取り、手元に置いてあるものより新しければ置く。sendo に訳文がなければ
   * null。取る前に、セッションのユーザーを確かめる（confirmed なら、呼ぶ側が確かめてある。
   * #fetchContent と同じ）
   */
  #fetchTranslatedContent(
    articleId: string,
    session: AbortSignal,
    confirmed = false,
  ): Promise<StoredTranslatedContent | null> {
    if (session.aborted) {
      return Promise.reject(new ApiError("unauthorized", "ログインし直したので取らなかった"));
    }
    const existing = this.#translationFetches.get(articleId);
    if (existing !== undefined) return existing;
    const running = (async () => {
      if (!confirmed) await this.#confirmSameUser(session);
      const fetched = await this.#api.articleTranslation(articleId, session);
      if (fetched === null) return null;
      await this.#db.transaction(async (tx) => {
        // 取っている間にログアウトしたり、ユーザーが替わったりしたら、置かない
        throwIfSessionEnded(session);
        if (!(await putStoredTranslatedContent(tx, articleId, fetched, this.#now()))) return;
        // 上限を超えたら、既読の分を消す。いま置いた本文と、最後に開いた記事の本文は消さない
        const limit = await this.#contentStorageLimit(tx);
        if (limit > 0) await evictContents(tx, limit, await protectedArticles(tx, articleId));
      });
      return fetched;
    })().finally(() => {
      if (this.#translationFetches.get(articleId) === running) {
        this.#translationFetches.delete(articleId);
      }
    });
    this.#translationFetches.set(articleId, running);
    return running;
  }

  // --- 変更の通知 ---

  /** 手元の表が変わったら呼ぶ。やめるときは返した関数を呼ぶ */
  onChange(listener: ChangeListener): () => void {
    this.#listeners.add(listener);
    return () => this.#listeners.delete(listener);
  }

  /** sendo が操作を断り、手元の反映を戻したときに呼ぶ。 */
  onReject(listener: (rejection: RejectedOperation) => void): () => void {
    this.#rejectionListeners.add(listener);
    return () => this.#rejectionListeners.delete(listener);
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

/** 一覧を開いたタブと、そのタブで一覧を開いた回の番号（setOpenList） */
export interface OpenedList {
  tab: string;
  seq: number;
}

/**
 * 画面が知らせた一覧を、決まった形にする（キーの順をそろえ、ないものは入れない）。言葉が空の
 * 検索は、一覧を開いていないのと同じ（null）。形が違えば TypeError
 */
function normalizeOpenList(scope: ArticleScope | null): ArticleScope | null {
  if (scope === null) return null;
  if (typeof scope !== "object") throw new TypeError("開いている一覧は、オブジェクトか null");
  const optionalString = (value: unknown) => value === undefined || typeof value === "string";
  if (
    !optionalString(scope.feedId) ||
    !optionalString(scope.folderId) ||
    !optionalString(scope.search) ||
    !(scope.starred === undefined || typeof scope.starred === "boolean")
  ) {
    throw new TypeError("開いている一覧の形が違う");
  }
  if (scope.search !== undefined && searchTerms(scope.search).length === 0) return null;
  const normalized: ArticleScope = {};
  if (scope.feedId !== undefined) normalized.feedId = scope.feedId;
  if (scope.folderId !== undefined) normalized.folderId = scope.folderId;
  if (scope.starred === true) normalized.starred = true;
  if (scope.search !== undefined) normalized.search = searchTerms(scope.search).join(" ");
  return normalized;
}

/**
 * 手元のデータ（同期で届いた行、まだ送っていない操作、カーソル、ログインしたユーザーなどの設定）を
 * すべて消す。端末ごとの設定（本文を置く量の上限）だけは残す
 */
async function clearAll(tx: Executor): Promise<void> {
  await tx.run("delete from pending_ops");
  // 手元に置いた本文も、記事と一緒に消える（スキーマのトリガー）
  await tx.run("delete from articles");
  await tx.run("delete from feeds");
  await tx.run("delete from folders");
  await tx.run("delete from synced_settings");
  await clearSavedPages(tx);
  // 本文を置く量の上限は、端末ごとの設定なので残す
  await tx.run("delete from settings where key <> ?", [CONTENT_STORAGE_LIMIT_KEY]);
}

/**
 * 手元に置いた本文（信頼できない HTML）を、画面に渡す木にする。出すもの（文字か画像）が
 * 残らなければ null（要約を出す）
 */
function toArticleContent(stored: StoredContent): ArticleContent | null {
  const nodes = parseContent(stored.html);
  return hasVisibleContent(nodes) ? { nodes, source: stored.source } : null;
}

/**
 * 手元に置いた訳した本文を、画面に渡す形にする。本文を訳さなかった印か、出すもの（文字か画像）が
 * 残らなければ none（原文の本文を出す）
 */
function toTranslatedContent(stored: StoredTranslatedContent): TranslatedContent {
  if (stored.html === null) return { status: "none" };
  const nodes = parseContent(stored.html);
  return hasVisibleContent(nodes)
    ? { status: "ready", content: { nodes, source: stored.source ?? "feed" } }
    : { status: "none" };
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

/**
 * 上限のために本文を消さない記事（未読とスターのほかに）。最後に開いた記事（いま開いている記事）
 * と、keep（いま本文を置いた記事。開封の記録より先に本文が届くことがある）
 */
async function protectedArticles(tx: Executor, keep?: string): Promise<string[]> {
  const opened = await getSetting(tx, LAST_OPENED_KEY);
  return [opened, keep].filter((id): id is string => typeof id === "string");
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
