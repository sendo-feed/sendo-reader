/**
 * テスト用の偽の sendo。差分同期の決定（sendo の docs/decisions/sync.md）と、仮の応答の形
 * （src/api/sync-contract.ts）に沿って、手元のメモリーで動く。
 *
 * - 人ごとの行（フォルダ、購読、受信箱）は、表ごとに書き込み順の変更番号（seq）を持つ
 * - カーソルは表ごとの番号をまとめたもの。中身はクライアントに見せない
 * - フォルダと購読は、消すときに消した印を付ける。印を回収したら、それより古いカーソルは 410
 * - 最初の同期は、未読・スター・直近 30 日に受信箱に入った記事だけ
 */

type TableName = "folders" | "feeds" | "articles";

interface FolderRow {
  id: string;
  name: string;
  createdAt: number;
  deletedAt: number | null;
  seq: number;
}

interface FeedRow {
  id: string;
  url: string;
  title: string | null;
  siteUrl: string | null;
  folderId: string | null;
  createdAt: number;
  deletedAt: number | null;
  seq: number;
}

interface InboxRow {
  id: string;
  feedId: string;
  url: string | null;
  title: string | null;
  summary: string | null;
  author: string | null;
  publishedAt: number;
  receivedAt: number;
  readAt: number | null;
  starredAt: number | null;
  seq: number;
  /** 受信箱に入ったときの番号（カーソルを境界にした「まとめて既読」に使う） */
  firstSeq: number;
}

interface Cursor {
  folders: number;
  feeds: number;
  articles: number;
  /** 最初の同期の途中なら、その範囲の起点（直近 30 日の始まり） */
  initialSince?: number;
}

const DAY = 24 * 60 * 60 * 1000;
export const TOKEN = "sendo_test_token";

export class FakeSendo {
  /** サーバーの時計 */
  now = Date.parse("2026-11-01T00:00:00.000Z");
  /** 1 回の応答に載せる行の数の上限 */
  pageSize = 100;
  /** 受け付けるトークン */
  token = TOKEN;
  /** ほかに受け付けるトークン（別のアカウントに見立てる） */
  readonly otherTokens = new Set<string>();

  readonly folders = new Map<string, FolderRow>();
  readonly feeds = new Map<string, FeedRow>();
  readonly inbox = new Map<string, InboxRow>();
  /** 受けたリクエスト（"GET /sync?cursor=…" の形） */
  readonly requests: string[] = [];
  /** 受けた「まとめて既読」の本文 */
  readonly markReadRequests: Record<string, unknown>[] = [];
  /** サイトの URL ごとの、フィードの候補（GET /feeds/discover） */
  readonly discoverable = new Map<string, { url: string; title: string | null }[]>();
  /** 購読できるフィードの URL と、そのタイトル（POST /feeds で取得できたことにする） */
  readonly fetchable = new Map<string, string | null>();
  /** 受けた OPML */
  readonly opmlImports: string[] = [];
  /** リクエストを受けて、答える前に呼ぶ（送っている途中に画面で操作したことにする、など） */
  onRequest: ((path: string) => Promise<void>) | null = null;

  readonly #maxSeq: Record<TableName, number> = { folders: 0, feeds: 0, articles: 0 };
  /** 消した印を回収した範囲。これより古いカーソルでは差分を出せない */
  readonly #purgedUpTo: Record<"folders" | "feeds", number> = { folders: 0, feeds: 0 };
  readonly #failures: ("network" | number | "hang" | null)[] = [];
  #nextId = 1;

  // --- テストから状態を作る ---

  createFolder(name: string, id = this.#id("folder")): FolderRow {
    const row: FolderRow = {
      id,
      name,
      createdAt: this.now,
      deletedAt: null,
      seq: this.#bump("folders"),
    };
    this.folders.set(id, row);
    return row;
  }

  deleteFolder(id: string): void {
    const folder = this.#mustGet(this.folders, id);
    for (const feed of this.feeds.values()) {
      if (feed.folderId === id && feed.deletedAt === null) {
        feed.folderId = null;
        feed.seq = this.#bump("feeds");
      }
    }
    folder.deletedAt = this.now;
    folder.seq = this.#bump("folders");
  }

  subscribe(input: { url: string; title?: string; folderId?: string | null; id?: string }) {
    const row: FeedRow = {
      id: input.id ?? this.#id("feed"),
      url: input.url,
      title: input.title ?? null,
      siteUrl: null,
      folderId: input.folderId ?? null,
      createdAt: this.now,
      deletedAt: null,
      seq: this.#bump("feeds"),
    };
    this.feeds.set(row.id, row);
    return row;
  }

  moveFeed(feedId: string, folderId: string | null): void {
    const feed = this.#mustGet(this.feeds, feedId);
    feed.folderId = folderId;
    feed.seq = this.#bump("feeds");
  }

  /** 購読をやめる。受信箱からは、スターを付けたもの以外を物理的に消す（sendo と同じ） */
  unsubscribe(feedId: string): void {
    const feed = this.#mustGet(this.feeds, feedId);
    feed.deletedAt = this.now;
    feed.seq = this.#bump("feeds");
    for (const [id, row] of this.inbox) {
      if (row.feedId === feedId && row.starredAt === null) this.inbox.delete(id);
    }
  }

  /** 記事を受信箱に配る（受信の時刻はサーバーの今） */
  deliver(
    feedId: string,
    input: { title?: string; publishedAt?: number; url?: string | null; id?: string } = {},
  ): InboxRow {
    const seq = this.#bump("articles");
    const row: InboxRow = {
      id: input.id ?? this.#id("article"),
      feedId,
      url: input.url === undefined ? "https://example.com/post" : input.url,
      title: input.title ?? null,
      summary: null,
      author: null,
      publishedAt: input.publishedAt ?? this.now,
      receivedAt: this.now,
      readAt: null,
      starredAt: null,
      seq,
      firstSeq: seq,
    };
    this.inbox.set(row.id, row);
    return row;
  }

  /** 別の端末で既読・スターを変えたことにする */
  setArticleState(id: string, state: { read?: boolean; starred?: boolean }): void {
    const row = this.#mustGet(this.inbox, id);
    if (state.read !== undefined) row.readAt = state.read ? (row.readAt ?? this.now) : null;
    if (state.starred !== undefined) {
      row.starredAt = state.starred ? (row.starredAt ?? this.now) : null;
    }
    row.seq = this.#bump("articles");
  }

  /** 消した印をすべて物理的に消す。それより古いカーソルには 410 を返すようになる */
  purgeTombstones(): void {
    for (const [table, rows] of [
      ["folders", this.folders],
      ["feeds", this.feeds],
    ] as const) {
      for (const [id, row] of rows) {
        if (row.deletedAt === null) continue;
        rows.delete(id);
        this.#purgedUpTo[table] = Math.max(this.#purgedUpTo[table], row.seq);
      }
    }
  }

  advance(ms: number): void {
    this.now += ms;
  }

  /**
   * 次からのリクエストを、順に失敗させる。"network" なら届かない、数ならその状態コードを返す、
   * "hang" なら中断されるまで答えない、null ならふつうに答える
   * （例：failNext(null, "network") で 2 つめだけ届かない）
   */
  failNext(...failures: ("network" | number | "hang" | null)[]): void {
    this.#failures.push(...failures);
  }

  // --- HTTP ---

  readonly fetch = async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
    const request = new Request(input, init);
    const url = new URL(request.url);
    const path = url.pathname.replace(/^\/api\/v1/, "");
    this.requests.push(`${request.method} ${path}${url.search}`);

    await this.onRequest?.(`${request.method} ${path}`);
    const failure = this.#failures.shift();
    if (failure === "network") throw new TypeError("fetch failed");
    if (failure === "hang") {
      return new Promise((_, reject) => {
        const abort = () => reject(request.signal.reason);
        if (request.signal.aborted) abort();
        else request.signal.addEventListener("abort", abort, { once: true });
      });
    }
    if (typeof failure === "number") return error(failure, "injected", "injected failure");

    const auth = request.headers.get("authorization");
    if (![this.token, ...this.otherTokens].some((token) => auth === `Bearer ${token}`)) {
      return error(401, "unauthorized", "a valid access token is required");
    }
    if (request.method === "GET" && path === "/sync") {
      return this.#sync(url.searchParams.get("cursor"));
    }
    if (request.method === "GET" && path === "/folders") {
      const items = [...this.folders.values()].filter((row) => row.deletedAt === null);
      return json(200, { items: items.map(folderJson) });
    }
    if (request.method === "GET" && path === "/feeds") {
      const items = [...this.feeds.values()].filter((row) => row.deletedAt === null);
      return json(200, { items: items.map(feedJson) });
    }
    if (request.method === "GET" && path === "/feeds/discover") {
      const target = url.searchParams.get("url") ?? "";
      if (!target.startsWith("https://")) return error(400, "url_not_allowed", "not allowed");
      const candidates = this.discoverable.get(target);
      if (candidates === undefined) return error(422, "fetch_failed", "could not fetch");
      return json(200, { candidates });
    }
    if (request.method === "POST" && path === "/opml") {
      const xml = await request.text();
      this.opmlImports.push(xml);
      const accepted = (xml.match(/xmlUrl=/g) ?? []).length;
      return json(202, { accepted, skippedCount: 0, skipped: [] });
    }
    const body = request.body === null ? {} : ((await request.json()) as Record<string, unknown>);
    if (request.method === "POST" && path === "/feeds") {
      const feedUrl = String(body.url ?? "");
      const folderId = (body.folderId as string | null | undefined) ?? null;
      if (folderId !== null && this.folders.get(folderId)?.deletedAt !== null) {
        return error(400, "folder_not_found", "folder does not exist");
      }
      const existing = [...this.feeds.values()].find(
        (row) => row.url === feedUrl && row.deletedAt === null,
      );
      if (existing !== undefined) return json(200, { feed: feedJson(existing) });
      if (!this.fetchable.has(feedUrl)) return error(422, "feed_not_found", "no feed");
      const title = this.fetchable.get(feedUrl) ?? undefined;
      const created = this.subscribe({ url: feedUrl, folderId, ...(title ? { title } : {}) });
      return json(201, { feed: feedJson(created) });
    }

    let match = /^\/articles\/([^/]+)$/.exec(path);
    if (request.method === "PATCH" && match !== null && match[1] !== "mark-read") {
      const row = this.inbox.get(decodeURIComponent(match[1] ?? ""));
      if (row === undefined) return error(404, "not_found", "article does not exist");
      this.setArticleState(row.id, body as { read?: boolean; starred?: boolean });
      return json(200, { article: { id: row.id } });
    }
    if (request.method === "POST" && path === "/articles/mark-read") {
      return this.#markRead(body);
    }
    if (request.method === "POST" && path === "/folders") {
      const name = String(body.name ?? "").trim();
      if (name === "") return error(400, "invalid_request", "name: empty");
      if (this.#folderByName(name) !== undefined) {
        return error(409, "folder_exists", "a folder with this name exists");
      }
      return json(201, { folder: folderJson(this.createFolder(name)) });
    }
    match = /^\/folders\/([^/]+)$/.exec(path);
    if (match !== null) {
      const folder = this.folders.get(decodeURIComponent(match[1] ?? ""));
      if (folder === undefined || folder.deletedAt !== null) {
        return error(404, "not_found", "folder does not exist");
      }
      if (request.method === "PATCH") {
        const name = String(body.name ?? "").trim();
        const other = this.#folderByName(name);
        if (other !== undefined && other.id !== folder.id) {
          return error(409, "folder_exists", "a folder with this name exists");
        }
        folder.name = name;
        folder.seq = this.#bump("folders");
        return json(200, { folder: folderJson(folder) });
      }
      if (request.method === "DELETE") {
        this.deleteFolder(folder.id);
        return new Response(null, { status: 204 });
      }
    }
    match = /^\/feeds\/([^/]+)$/.exec(path);
    if (match !== null) {
      const feed = this.feeds.get(decodeURIComponent(match[1] ?? ""));
      if (feed === undefined || feed.deletedAt !== null) {
        return error(404, "not_found", "feed does not exist");
      }
      if (request.method === "PATCH") {
        const folderId = body.folderId as string | null;
        if (folderId !== null && this.folders.get(folderId)?.deletedAt !== null) {
          return error(400, "folder_not_found", "folder does not exist");
        }
        this.moveFeed(feed.id, folderId);
        return json(200, { feed: feedJson(feed) });
      }
      if (request.method === "DELETE") {
        this.unsubscribe(feed.id);
        return new Response(null, { status: 204 });
      }
    }
    return error(404, "not_found", "Not Found");
  };

  /** カーソルを境界にした「まとめて既読」（仮の形。src/api/sync-contract.ts） */
  #markRead(body: Record<string, unknown>): Response {
    const cursor = typeof body.cursor === "string" ? decodeCursor(body.cursor) : null;
    if (cursor === null) return error(400, "invalid_request", "cursor: required");
    const inScope = (row: InboxRow): boolean => {
      if (body.all === true) return true;
      if (typeof body.feedId === "string") return row.feedId === body.feedId;
      if (typeof body.folderId === "string") {
        return this.feeds.get(row.feedId)?.folderId === body.folderId;
      }
      return false;
    };
    let updated = 0;
    for (const row of this.inbox.values()) {
      if (row.readAt !== null || row.firstSeq > cursor.articles || !inScope(row)) continue;
      row.readAt = this.now;
      row.seq = this.#bump("articles");
      updated += 1;
    }
    this.markReadRequests.push(body);
    return json(200, { updated });
  }

  #folderByName(name: string): FolderRow | undefined {
    return [...this.folders.values()].find((row) => row.deletedAt === null && row.name === name);
  }

  #sync(rawCursor: string | null): Response {
    const cursor = rawCursor === null ? null : decodeCursor(rawCursor);
    if (rawCursor !== null && cursor === null) {
      return error(400, "invalid_request", "cursor: invalid");
    }
    if (
      cursor !== null &&
      (cursor.folders < this.#purgedUpTo.folders || cursor.feeds < this.#purgedUpTo.feeds)
    ) {
      return error(410, "cursor_expired", "cursor is too old; sync from the beginning");
    }

    const since: Cursor = cursor ?? { folders: 0, feeds: 0, articles: 0 };
    const initialSince = cursor === null ? this.now - 30 * DAY : cursor.initialSince;
    const initial = initialSince !== undefined;

    const pending = {
      folders: [...this.folders.values()]
        .filter((row) => row.seq > since.folders && !(initial && row.deletedAt !== null))
        .sort(bySeq),
      feeds: [...this.feeds.values()]
        .filter((row) => row.seq > since.feeds && !(initial && row.deletedAt !== null))
        .sort(bySeq),
      articles: [...this.inbox.values()]
        .filter(
          (row) =>
            row.seq > since.articles &&
            (!initial ||
              row.readAt === null ||
              row.starredAt !== null ||
              row.receivedAt >= (initialSince ?? 0)),
        )
        .sort(bySeq),
    };

    let room = this.pageSize;
    const next: Cursor = { ...since };
    let hasMore = false;
    const page = { folders: [] as FolderRow[], feeds: [] as FeedRow[], articles: [] as InboxRow[] };
    for (const table of ["folders", "feeds", "articles"] as const) {
      const rows = pending[table];
      const taken = rows.slice(0, room);
      room -= taken.length;
      (page[table] as unknown[]).push(...taken);
      if (taken.length === rows.length) {
        // 載せなかった行（最初の同期の範囲の外）も含めて、この表は今の最大まで済んだ
        next[table] = this.#maxSeq[table];
      } else {
        hasMore = true;
        const last = taken.at(-1);
        if (last !== undefined) next[table] = last.seq;
      }
    }
    if (hasMore && initialSince !== undefined) next.initialSince = initialSince;
    else delete next.initialSince;

    return json(200, {
      cursor: encodeCursor(next),
      hasMore,
      folders: page.folders.map((row) => ({
        ...folderJson(row),
        deletedAt: row.deletedAt === null ? null : iso(row.deletedAt),
      })),
      feeds: page.feeds.map((row) => ({
        ...feedJson(row),
        deletedAt: row.deletedAt === null ? null : iso(row.deletedAt),
      })),
      articles: page.articles.map((row) => ({
        id: row.id,
        feedId: row.feedId,
        url: row.url,
        title: row.title,
        summary: row.summary,
        author: row.author,
        publishedAt: iso(row.publishedAt),
        receivedAt: iso(row.receivedAt),
        readAt: row.readAt === null ? null : iso(row.readAt),
        starredAt: row.starredAt === null ? null : iso(row.starredAt),
      })),
    });
  }

  #bump(table: TableName): number {
    this.#maxSeq[table] += 1;
    return this.#maxSeq[table];
  }

  #id(prefix: string): string {
    return `${prefix}-${this.#nextId++}`;
  }

  #mustGet<T>(rows: Map<string, T>, id: string): T {
    const row = rows.get(id);
    if (row === undefined) throw new Error(`${id} がない`);
    return row;
  }
}

function folderJson(row: FolderRow) {
  return { id: row.id, name: row.name, createdAt: iso(row.createdAt) };
}

function feedJson(row: FeedRow) {
  return {
    id: row.id,
    url: row.url,
    title: row.title,
    siteUrl: row.siteUrl,
    folderId: row.folderId,
    lastFetchedAt: null,
    nextFetchAt: iso(row.createdAt),
    errorCount: 0,
    lastError: null,
    createdAt: iso(row.createdAt),
  };
}

function bySeq(a: { seq: number }, b: { seq: number }): number {
  return a.seq - b.seq;
}

function iso(ms: number): string {
  return new Date(ms).toISOString();
}

function json(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

function error(status: number, code: string, message: string): Response {
  return json(status, { error: { code, message } });
}

function encodeCursor(cursor: Cursor): string {
  return btoa(JSON.stringify(cursor)).replaceAll("+", "-").replaceAll("/", "_").replace(/=+$/, "");
}

function decodeCursor(value: string): Cursor | null {
  try {
    const parsed = JSON.parse(atob(value.replaceAll("-", "+").replaceAll("_", "/"))) as Cursor;
    return typeof parsed.folders === "number" &&
      typeof parsed.feeds === "number" &&
      typeof parsed.articles === "number"
      ? parsed
      : null;
  } catch {
    return null;
  }
}
