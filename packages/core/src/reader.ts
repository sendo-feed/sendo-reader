import { ApiError, createSendoApi, type SendoApi } from "./api/client";
import type { Database, Executor } from "./db/database";
import {
  type ArticleQuery,
  countUnread,
  getArticle,
  getArticles,
  listArticles,
  listFeeds,
  listFolders,
} from "./db/queries";
import { migrate } from "./db/schema";
import { deleteSetting, getSetting, setSetting } from "./db/settings";
import type { Article, Feed, Folder, Table, UnreadCounts, User } from "./models";
import {
  discoverFeeds,
  type FeedCandidate,
  importOpml,
  type OpmlImportResult,
  subscribe,
} from "./online";
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

const ALL_TABLES: ReadonlySet<Table> = new Set<Table>(["folders", "feeds", "articles"]);

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

  private constructor(options: ReaderCoreOptions) {
    this.#db = options.db;
    this.#now = options.now ?? Date.now;
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
    if (switched) this.#emit(ALL_TABLES);
    return current;
  }

  /** 今のログインで動いている処理を中断し、新しいログインの中断の合図を返す */
  #beginSession(): AbortSignal {
    this.#session.abort();
    this.#session = new AbortController();
    this.#syncing = null;
    this.#folderIds.clear();
    this.#onlineOps.clear();
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
    const pushed = await this.#push(signal, (id) => {
      const limit = this.#pushLimit();
      return limit === null || id <= limit || this.#onlineOps.has(id);
    });
    const pulled = await pull(this.#db, this.#api, {
      signal,
      onPage: (changed) => this.#emit(changed),
    });
    return { push: pushed, pull: pulled };
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
   * まとめて既読にする。押した時点で手元で未読だった記事だけを既読にし、sendo にも同期済みの
   * 範囲（最後まで同期し終えたカーソル）までだけを頼む（sync.md の 6）。カーソルの範囲に入らない
   * 記事（そのあとに届いた、そのあとに手元で既読・未読を変えた）は、ID で頼む。未読がなければ
   * 何もしない。
   */
  async markAllRead(scope: MarkReadScope): Promise<void> {
    this.#requireSignedIn();
    const session = this.#session.signal;
    const op = await this.#db.transaction(async (tx) => {
      // 書き込みが DB の列で待っている間にログインし直したら、前のアカウントの操作を積まない
      throwIfSessionEnded(session);
      const cursor = await getCompleteCursor(tx);
      const [condition, params] = scopeCondition(scope);
      const unread = await tx.all<{ id: string; read_synced: number }>(
        `select id, read_synced from articles where read_at is null and ${condition}`,
        params,
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
    if (op !== null) this.#emit(new Set<Table>(["articles"]));
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

  /** フォルダを消す。入っていたフィードはフォルダなしに戻す（フィードは消さない） */
  deleteFolder(folderId: string): Promise<void> {
    const id = this.#folderIds.get(folderId) ?? folderId;
    return this.#write({ kind: "deleteFolder", folderId: id }, ["folders", "feeds"]);
  }

  /** フィードを別のフォルダに移す。null ならフォルダなし */
  moveFeed(feedId: string, folderId: string | null): Promise<void> {
    const resolved = folderId === null ? null : (this.#folderIds.get(folderId) ?? folderId);
    return this.#write({ kind: "moveFeed", feedId, folderId: resolved }, ["feeds"]);
  }

  /** 購読をやめる。記事はスターを付けたものだけが残る */
  unsubscribe(feedId: string): Promise<void> {
    return this.#write({ kind: "unsubscribe", feedId }, ["feeds", "articles"]);
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
 * 手元のデータ（同期で届いた行、まだ送っていない操作、カーソル、ログインしたユーザーなどの設定）を
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
