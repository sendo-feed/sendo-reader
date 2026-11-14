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
import {
  discoverFeeds,
  type FeedCandidate,
  importOpml,
  type OpmlImportResult,
  subscribe,
} from "./online";
import { LOCAL_ID_PREFIX, type MarkReadScope, type Operation, scopeCondition } from "./sync/ops";
import { getCursor, type PullResult, pull } from "./sync/pull";
import { countPending, enqueue, lastPendingId, type PushResult, push } from "./sync/queue";

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
  /** 手元で作ったフォルダの仮の ID から、sendo が付けた ID へ（画面が仮の ID を持ったままでも使えるように） */
  readonly #folderIds = new Map<string, string>();

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
    core.#lastOpId = await lastPendingId(options.db);
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
    this.#folderIds.clear();
    this.#onlineOps.clear();
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

  async #runSync(signal: AbortSignal): Promise<SyncResult> {
    if (this.#token === null) throw new ApiError("unauthorized", "ログインしていない");
    const pushed = await this.#push(signal, (id) => {
      const limit = this.#pushLimit();
      return limit === null || id <= limit || this.#onlineOps.has(id);
    });
    const pulled = await pull(this.#db, this.#api, {
      now: this.#now,
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
   * 範囲（カーソル）までだけを頼む（sync.md の 6）。まだ一度も同期していないか、未読がなければ
   * 何もしない。
   */
  async markAllRead(scope: MarkReadScope): Promise<void> {
    this.#requireSignedIn();
    const session = this.#session.signal;
    const op = await this.#db.transaction(async (tx) => {
      // 書き込みが DB の列で待っている間にログインし直したら、前のアカウントの操作を積まない
      throwIfSessionEnded(session);
      const cursor = await getCursor(tx);
      if (cursor === null) return null;
      const [condition, params] = scopeCondition(scope);
      const unread = await tx.all<{ id: string }>(
        `select id from articles where read_at is null and ${condition}`,
        params,
      );
      if (unread.length === 0) return null;
      const op: Operation = {
        kind: "markRead",
        scope,
        articleIds: unread.map((row) => row.id),
        cursor,
        at: this.#now(),
      };
      await this.#enqueue(tx, op);
      return op;
    });
    if (op !== null) this.#emit(new Set<Table>(["articles"]));
  }

  /**
   * フォルダを作る。sendo が ID を付けるまでは仮の ID（local- で始まる）で使え、その ID を返す。
   * 仮の ID は呼ぶ側で決めてもよい（送り直しても二重に作らないように）。
   */
  async createFolder(
    name: string,
    folderId = `${LOCAL_ID_PREFIX}${crypto.randomUUID()}`,
  ): Promise<string> {
    if (!folderId.startsWith(LOCAL_ID_PREFIX)) {
      throw new RangeError(`仮の ID は ${LOCAL_ID_PREFIX} で始める`);
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
   * ばかりのフォルダ（仮の ID）も渡せる。そのときは、フォルダなしで購読してから、操作キューで
   * そのフォルダに移す（sendo がフォルダに ID を付けたら、付け替わる）。
   *
   * 返すのは手元の状態（応答を待っている間にした操作を重ねたもの）。待っている間に購読を
   * やめていれば null。
   */
  async subscribe(url: string, folderId: string | null = null): Promise<Feed | null> {
    this.#requireSignedIn();
    const feed = await this.#online(async (signal) => {
      const wanted = folderId === null ? null : (this.#folderIds.get(folderId) ?? folderId);
      const isLocalFolder = wanted?.startsWith(LOCAL_ID_PREFIX) === true;
      return subscribe(
        this.#db,
        this.#api,
        { url, folderId: isLocalFolder ? null : wanted },
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
        // 呼んだ時点までの操作と、先に呼んだ通信が要る操作が積んだ操作を、先に送る
        await this.#push(signal, (id) => id <= barrier.id || this.#onlineOps.has(id));
        return fn(signal);
      });
    } finally {
      this.#barriers.delete(barrier);
    }
  }

  #requireSignedIn(): void {
    if (this.#token === null) throw new ApiError("unauthorized", "ログインしていない");
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

/** 書き込みを始めたときのログインが、もう終わっていたら投げる */
function throwIfSessionEnded(session: AbortSignal): void {
  if (session.aborted) throw new ApiError("unauthorized", "ログインし直したので書き込まなかった");
}
