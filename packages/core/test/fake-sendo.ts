/**
 * テスト用の偽の sendo。差分同期の決定（sendo の docs/decisions/sync.md）と、sendo の OpenAPI
 * （src/api/openapi.json の /sync と /articles/mark-read）に沿って、手元のメモリーで動く。
 *
 * - 人ごとの行（フォルダ、購読、受信箱）は、表ごとに書き込み順の変更番号（seq）を持つ
 * - カーソルは表ごとの番号をまとめたもの。中身はクライアントに見せない
 * - フォルダと購読は、消すときに消した印（deleted: true）を付ける
 * - 受信箱の行は物理的に消し、消した記録（{ id, deleted: true }）を受信箱の続きの番号で残す。
 *   購読をやめると、スターのない記事が受信箱から消える
 * - 印と記録を回収したら、それより古いカーソルは 400（invalid_cursor）
 * - 最初の同期は、未読・スター・直近 30 日に受信箱に入った記事だけ（消した印と記録は送らない）
 * - カーソルを境界にしたまとめて既読は、最後まで同期し終えたカーソルだけを受け付け
 *   （途中なら 400 の sync_incomplete）、既読・未読が最後に変わった番号（readSeq）が境界まで
 *   の未読の記事だけを既読にする
 *
 * 認証は sendo のセッションのクッキー（__Host-sendo_session）だけを受ける（sendo の
 * src/api/auth.ts、login.ts と同じ形）。
 * - リクエストの cookie ヘッダーにあればそれを使う（画面を通したテストでは、ブラウザが付ける）。
 *   なければ、ブラウザの代わりに持っている cookie を使う（Node のテスト）
 * - Authorization を付けたリクエストは 401（reader は付けない決まり。sendo はクッキーを見ない）
 * - ブラウザから来た（cookie ヘッダーのある）状態を変えるリクエストは、Sec-Fetch-Site が
 *   same-origin のものだけを受ける
 * - 行はユーザーごとに分けない（どのユーザーでも同じ行を返す。手元を消すかの確かめに使う）
 *
 * アカウントの画面のための、アクセストークン（発行・一覧・取り消し）と OAuth の許可（一覧・
 * 取り消し、許可の画面の確かめと決定）にも、sendo と同じ形で答える。認可のリクエストは、
 * client_id、redirect_uri、response_type、scope、state だけを見る（PKCE などは見ない）。
 */

type TableName = "folders" | "feeds" | "articles" | "settings" | "savedPages";

interface SavedPageRow {
  id: string;
  url: string;
  title: string | null;
  savedAt: number;
  deleted: boolean;
  seq: number;
}

/** 設定の項目（sendo の docs/decisions/settings.md）。消すと、行を残して消した印を付け、値を捨てる */
export interface SettingRow {
  deviceType: string;
  name: string;
  value: unknown;
  deleted: boolean;
  seq: number;
}

const SETTING_NAME = /^[a-z][a-z0-9-]{0,31}\.[\x21-\x7e]+$/;
const DEVICE_TYPES = new Set(["mobile", "desktop"]);

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
  displayName: string | null;
  siteUrl: string | null;
  folderId: string | null;
  iconUrl: string | null;
  lastFetchedAt: number | null;
  lastSuccessfulFetchAt: number | null;
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
  thumbnailUrl: string | null;
  /** 本文（サニタイズした HTML）。なければ null。取り込んだときに決まり、あとから変わらない */
  content: string | null;
  publishedAt: number;
  receivedAt: number;
  readAt: number | null;
  starredAt: number | null;
  seq: number;
  /** 既読・未読が最後に変わったときの番号（カーソルを境界にした「まとめて既読」に使う） */
  readSeq: number;
}

interface Cursor {
  folders: number;
  feeds: number;
  articles: number;
  /** 設定の位置。設定を配る前の版が出したカーソルには、ない */
  settings?: number;
  savedPages?: number;
  /** 最初の同期の途中なら、その範囲の起点（直近 30 日の始まり） */
  initialSince?: number;
  /** 最後まで送り終えた（この応答の hasMore が false だった） */
  done: boolean;
}

interface ActivityEvent {
  id: string;
  articleId: string;
  occurredAt: string;
}

type Failure = "network" | number | "hang" | "hang-body" | null;

const DAY = 24 * 60 * 60 * 1000;

/** セッションのクッキーの名前（sendo と同じ） */
export const SESSION_COOKIE = "__Host-sendo_session";

export interface FakeUser {
  id: string;
  email: string;
}

export interface FakeToken {
  id: string;
  name: string;
  purpose: "reader" | "mcp";
  scopes: ("read" | "write")[];
  createdAt: number;
  lastUsedAt: number | null;
  secret: string;
}

export interface FakeOAuthClient {
  name: string | null;
  kind: "metadata_document" | "registered";
  redirectUris: string[];
}

export interface FakeGrant {
  id: string;
  clientId: string;
  clientName: string | null;
  clientKind: "metadata_document" | "registered";
  scopes: ("read" | "write")[];
  createdAt: number;
  lastUsedAt: number | null;
}

/** 既定でログインしているユーザー */
export const USER: FakeUser = { id: "user-1", email: "you@example.com" };

const SAFE_METHODS = new Set(["GET", "HEAD", "OPTIONS"]);

export class FakeSendo {
  /** サーバーの時計 */
  now = Date.parse("2026-11-01T00:00:00.000Z");
  /** 1 回の応答に載せる行の数の上限 */
  pageSize = 100;
  /** セッション（クッキーの値から、そのユーザーへ） */
  readonly sessions = new Map<string, FakeUser>();
  /**
   * ブラウザの代わりに持っている、セッションのクッキーの値（Node のテスト用）。リクエストの
   * cookie ヘッダーにクッキーがなければ、これを使う
   */
  cookie: string | null = null;
  /** GET /auth/google/login でログインさせるユーザー。null なら許可していないメール（not_allowed） */
  loginUser: FakeUser | null = USER;
  /** POST /auth/logout を受けた数 */
  logouts = 0;
  /** 発行したアクセストークン（secret は発行の応答でだけ返す） */
  readonly tokens = new Map<string, FakeToken>();
  /** OAuth で出した許可 */
  readonly grants = new Map<string, FakeGrant>();
  /** OAuth のクライアント（client_id から） */
  readonly oauthClients = new Map<string, FakeOAuthClient>();
  /** sendo で OAuth を使う設定があるか。なければ許可の画面の API は 404（oauth_disabled） */
  oauthEnabled = true;

  readonly folders = new Map<string, FolderRow>();
  /** ほかの人のフォルダが使っている ID（POST /folders で、その ID では作れない） */
  readonly foreignFolderIds = new Set<string>();
  /** 受けた POST /folders の本文 */
  readonly folderRequests: Record<string, unknown>[] = [];
  readonly feeds = new Map<string, FeedRow>();
  readonly inbox = new Map<string, InboxRow>();
  /** 受信箱から消えた記事の記録（記事の ID と、受信箱の続きの番号） */
  readonly removals = new Map<string, number>();
  /** 受けたリクエスト（"GET /sync?cursor=…" の形） */
  readonly requests: string[] = [];
  /** 受けた「まとめて既読」の本文 */
  readonly markReadRequests: Record<string, unknown>[] = [];
  readonly activityRequests: ActivityEvent[][] = [];
  readonly articleOpens = new Map<string, ActivityEvent>();
  /** サイトの URL ごとの、フィードの候補（GET /feeds/discover） */
  readonly discoverable = new Map<string, { url: string; title: string | null }[]>();
  /** 購読できるフィードの URL と、そのタイトル（POST /feeds で取得できたことにする） */
  readonly fetchable = new Map<string, string | null>();
  /** 受けた OPML */
  readonly opmlImports: string[] = [];
  /** リクエストを受けて、答える前に呼ぶ（送っている途中に画面で操作したことにする、など） */
  onRequest: ((path: string) => Promise<void>) | null = null;

  /** 設定の項目（鍵は「端末の種類 ＋ 改行 ＋ 名前」） */
  readonly settings = new Map<string, SettingRow>();
  /** 受けた PATCH /settings/{deviceType} */
  readonly settingsRequests: { deviceType: string; body: Record<string, unknown> }[] = [];
  /** 設定を配る前の版の sendo のふりをする（/sync に settings がなく、/settings は 404） */
  settingsSupported = true;
  /** 端末の種類ごとの、項目の数の上限（超えると 409 の settings_full） */
  maxSettings = 1000;
  savedPagesSupported = true;
  maxSavedPages = 2000;
  readonly #savedPages = new Map<string, Map<string, SavedPageRow>>();

  readonly #maxSeq: Record<TableName, number> = {
    folders: 0,
    feeds: 0,
    articles: 0,
    settings: 0,
    savedPages: 0,
  };
  /** 消した印を回収した範囲。これより古いカーソルでは差分を出せない */
  readonly #purgedUpTo: Record<TableName, number> = {
    folders: 0,
    feeds: 0,
    articles: 0,
    settings: 0,
    savedPages: 0,
  };
  readonly #failures: Failure[] = [];
  /** "hang-body" で止めた本文のうち、読み手に取り消されたものの数 */
  cancelledBodies = 0;
  #nextId = 1;

  // --- テストから状態を作る ---

  /**
   * user のセッションを作り、ブラウザの代わりに持つクッキーをそれにする（Google でログインした
   * ことにする）。前に持っていたセッションは消す（sendo と同じ）。クッキーの値を返す
   */
  signInAs(user: FakeUser = USER): string {
    if (this.cookie !== null) this.sessions.delete(this.cookie);
    const value = this.createSession(user);
    this.cookie = value;
    return value;
  }

  /** OAuth で許可を出したことにする */
  addGrant(input: Partial<FakeGrant> & { clientId: string }): FakeGrant {
    const grant: FakeGrant = {
      id: this.#id("grant"),
      clientName: null,
      clientKind: "metadata_document",
      scopes: ["read"],
      createdAt: this.now,
      lastUsedAt: null,
      ...input,
    };
    this.grants.set(grant.id, grant);
    return grant;
  }

  /** 今のセッションを切る（期限切れ、取り消し）。クッキーは残る */
  expireSession(): void {
    if (this.cookie !== null) this.sessions.delete(this.cookie);
  }

  /** user のセッションを作り、クッキーの値を返す（ブラウザに置くのはテストが行う） */
  createSession(user: FakeUser): string {
    const value = `session-${this.#nextId++}`;
    this.sessions.set(value, { ...user });
    return value;
  }

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

  subscribe(input: {
    url: string;
    title?: string;
    folderId?: string | null;
    id?: string;
    iconUrl?: string | null;
  }) {
    const row: FeedRow = {
      id: input.id ?? this.#id("feed"),
      url: input.url,
      title: input.title ?? null,
      displayName: null,
      siteUrl: null,
      folderId: input.folderId ?? null,
      iconUrl: input.iconUrl ?? null,
      lastFetchedAt: null,
      lastSuccessfulFetchAt: null,
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

  renameFeed(feedId: string, displayName: string | null): void {
    const feed = this.#mustGet(this.feeds, feedId);
    feed.displayName = displayName;
    feed.seq = this.#bump("feeds");
  }

  /** 購読をやめる。受信箱からは、スターを付けたもの以外を消し、消した記録を残す（sendo と同じ） */
  unsubscribe(feedId: string): void {
    const feed = this.#mustGet(this.feeds, feedId);
    feed.deletedAt = this.now;
    feed.seq = this.#bump("feeds");
    for (const row of [...this.inbox.values()]) {
      if (row.feedId === feedId && row.starredAt === null) this.removeFromInbox(row.id);
    }
  }

  /** 記事を受信箱から消し、消した記録を残す */
  removeFromInbox(id: string): void {
    this.#mustGet(this.inbox, id);
    this.inbox.delete(id);
    this.removals.set(id, this.#bump("articles"));
  }

  /** 記事を受信箱に配る（受信の時刻はサーバーの今） */
  deliver(
    feedId: string,
    input: {
      title?: string;
      summary?: string;
      author?: string;
      publishedAt?: number;
      url?: string | null;
      id?: string;
      thumbnailUrl?: string | null;
      /** 本文の HTML（sendo がサニタイズしたあとの形で渡す） */
      content?: string | null;
    } = {},
  ): InboxRow {
    const seq = this.#bump("articles");
    const row: InboxRow = {
      id: input.id ?? this.#id("article"),
      feedId,
      url: input.url === undefined ? "https://example.com/post" : input.url,
      title: input.title ?? null,
      summary: input.summary ?? null,
      author: input.author ?? null,
      thumbnailUrl: input.thumbnailUrl ?? null,
      content: input.content ?? null,
      publishedAt: input.publishedAt ?? this.now,
      receivedAt: this.now,
      readAt: null,
      starredAt: null,
      seq,
      readSeq: seq,
    };
    this.inbox.set(row.id, row);
    return row;
  }

  /**
   * フィードのアイコンが付いた ／ 変わったことにする（sendo は 30 日に 1 回探し直す）。名前が
   * 変わったときと同じく、同期の feeds に、そのフィードの行がもう一度届く
   */
  setFeedIcon(id: string, iconUrl: string | null): void {
    const row = this.#mustGet(this.feeds, id);
    row.iconUrl = iconUrl;
    row.seq = this.#bump("feeds");
  }

  /**
   * sendo が配る形の、画像の中継の URL を作る（オリジンの付かないパス）。偽の署名は、もとの URL
   * から決まる。クライアントは、この形を組み立てない ／ 読まない
   */
  imageUrl(original: string): string {
    return `/api/v1/images?url=${encodeURIComponent(original)}&sig=${fakeSignature(original)}`;
  }

  /** 本文を取りに来たリクエスト（記事の ID） */
  readonly contentRequests: string[] = [];
  /** 元ページから抜いた全文（sendo は全文の抽出を常に動かす） */
  readonly pageContents = new Map<string, string>();
  readonly pageContentRequests: string[] = [];
  /** hasContent は true のまま、本文だけがなくなったことにする記事（片付けの途中など） */
  readonly contentGone = new Set<string>();
  /** 本文の出どころとして返す値（あとで、記事のページから抜いた本文の値が増える） */
  contentSource = "feed";
  /** 本文を配る前の版の sendo のふりをする（記事に hasContent を付けない） */
  omitHasContent = false;

  /** 画像の中継が返す状態（200 なら 1×1 の PNG）。502 は配信元から取れない、など */
  imageStatus = 200;
  /** もとの URL ごとに、中継が返す状態（決めていない URL は imageStatus） */
  readonly imageStatusFor = new Map<string, number>();
  /** 画像の中継に来たリクエスト（もとの URL） */
  readonly imageRequests: string[] = [];

  /** 別の端末で既読・スターを変えたことにする */
  setArticleState(id: string, state: { read?: boolean; starred?: boolean }): void {
    const row = this.#mustGet(this.inbox, id);
    row.seq = this.#bump("articles");
    if (state.read !== undefined) {
      const readAt = state.read ? (row.readAt ?? this.now) : null;
      if (readAt !== row.readAt) row.readSeq = row.seq;
      row.readAt = readAt;
    }
    if (state.starred !== undefined) {
      row.starredAt = state.starred ? (row.starredAt ?? this.now) : null;
    }
  }

  /** ほかの端末が設定を置いたことにする。今と同じ値なら、何も変えない */
  putSetting(deviceType: string, name: string, value: unknown): void {
    const key = `${deviceType}\n${name}`;
    const row = this.settings.get(key);
    if (row !== undefined && !row.deleted && JSON.stringify(row.value) === JSON.stringify(value)) {
      return;
    }
    this.settings.set(key, {
      deviceType,
      name,
      value,
      deleted: false,
      seq: this.#bump("settings"),
    });
  }

  /** ほかの端末が設定を消したことにする。ない項目、もう消してある項目は、何も変えない */
  removeSetting(deviceType: string, name: string): void {
    const row = this.settings.get(`${deviceType}\n${name}`);
    if (row === undefined || row.deleted) return;
    row.deleted = true;
    row.value = undefined;
    row.seq = this.#bump("settings");
  }

  /** その種類の、消していない項目（名前から値へ） */
  settingsOf(deviceType: string): Record<string, unknown> {
    const out: Record<string, unknown> = {};
    for (const row of this.settings.values()) {
      if (row.deviceType === deviceType && !row.deleted) out[row.name] = row.value;
    }
    return out;
  }

  /** 消した印と記録をすべて物理的に消す。それより古いカーソルには 400 を返すようになる */
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
    for (const seq of this.removals.values()) {
      this.#purgedUpTo.articles = Math.max(this.#purgedUpTo.articles, seq);
    }
    this.removals.clear();
    for (const [key, row] of this.settings) {
      if (!row.deleted) continue;
      this.settings.delete(key);
      this.#purgedUpTo.settings = Math.max(this.#purgedUpTo.settings, row.seq);
    }
  }

  advance(ms: number): void {
    this.now += ms;
  }

  /**
   * 次からのリクエストを、順に失敗させる。"network" なら届かない、数ならその状態コードを返す、
   * "hang" なら中断されるまで答えない、"hang-body" ならヘッダーと本文の頭だけ返して本文を止める
   * （中断の合図を見ず、読み手が取り消すまで止まったまま）、null ならふつうに答える
   * （例：failNext(null, "network") で 2 つめだけ届かない）
   */
  failNext(...failures: Failure[]): void {
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
      // 呼ぶ側が init に渡した合図を直接見る（Request の signal の引き継ぎは、Node では
      // 弱い参照で、回収されると中断が届かないことがある）
      const signal = init?.signal ?? request.signal;
      return new Promise((_, reject) => {
        const abort = () => reject(signal.reason);
        if (signal.aborted) abort();
        else signal.addEventListener("abort", abort, { once: true });
      });
    }
    if (failure === "hang-body") {
      return new Response(
        new ReadableStream<Uint8Array>({
          start: (controller) => controller.enqueue(new TextEncoder().encode('{"cursor":')),
          cancel: () => {
            this.cancelledBodies += 1;
          },
        }),
        { status: 200, headers: { "content-type": "application/json" } },
      );
    }
    if (typeof failure === "number") return error(failure, "injected", "injected failure");

    // ログイン（ページの移動）とログアウトは、セッションがなくても受ける
    const fromBrowser = readCookie(request.headers.get("cookie"), SESSION_COOKIE);
    const sessionValue = fromBrowser ?? this.cookie;
    if (request.method === "GET" && path === "/auth/google/login") {
      return this.#login(url.searchParams.get("returnTo"), fromBrowser);
    }
    if (request.method === "POST" && path === "/auth/logout") {
      this.logouts += 1;
      if (sessionValue === null) return new Response(null, { status: 204 });
      if (fromBrowser !== null && !isSameOrigin(request)) {
        return error(403, "forbidden", "cross-site requests are not allowed");
      }
      this.sessions.delete(sessionValue);
      if (this.cookie === sessionValue) this.cookie = null;
      return new Response(null, {
        status: 204,
        headers: { "set-cookie": `${SESSION_COOKIE}=; Max-Age=0; Path=/; Secure` },
      });
    }

    if (request.headers.has("authorization")) {
      return error(401, "unauthorized", "access tokens are not accepted from the reader");
    }
    if (request.method === "GET" && path === "/images") {
      // 認証（クッキー）、署名、配信元の順に確かめる（sendo の docs/decisions/images.md）
      const known = sessionValue === null ? undefined : this.sessions.get(sessionValue);
      if (known === undefined) return imageError(401, "unauthorized");
      const original = url.searchParams.get("url") ?? "";
      if (url.searchParams.get("sig") !== fakeSignature(original)) {
        return imageError(403, "invalid_signature");
      }
      this.imageRequests.push(original);
      const status = this.imageStatusFor.get(original) ?? this.imageStatus;
      if (status !== 200) return imageError(status, "image_unavailable");
      return new Response(TINY_PNG.slice(), {
        status: 200,
        headers: {
          "content-type": "image/png",
          "content-length": String(TINY_PNG.byteLength),
          "cache-control": "private, max-age=2592000",
          "x-content-type-options": "nosniff",
          "content-security-policy": "default-src 'none'; sandbox",
          "cross-origin-resource-policy": "same-origin",
        },
      });
    }
    const user = sessionValue === null ? undefined : this.sessions.get(sessionValue);
    if (user === undefined) {
      return error(401, "unauthorized", "a valid access token or session is required");
    }
    if (fromBrowser !== null && !SAFE_METHODS.has(request.method) && !isSameOrigin(request)) {
      return error(403, "forbidden", "cross-site requests are not allowed");
    }
    if (request.method === "GET" && path === "/me") {
      return json(200, { user: { id: user.id, email: user.email } });
    }
    if (path === "/tokens" || path.startsWith("/tokens/")) return this.#tokens(request, path);
    if (path === "/oauth/grants" || path.startsWith("/oauth/grants/")) {
      return this.#grants(request, path);
    }
    if (
      request.method === "POST" &&
      (path === "/oauth/authorize/check" || path === "/oauth/authorize/decide")
    ) {
      return this.#authorize(request, path);
    }
    if (request.method === "GET" && path === "/sync") {
      return this.#sync(
        url.searchParams.get("cursor"),
        this.savedPagesSupported && url.searchParams.get("includeSaved") === "true",
        user.id,
      );
    }
    if (request.method === "POST" && path === "/activity") {
      const { events } = (await request.json()) as { events: ActivityEvent[] };
      if (events.length > 50) return error(400, "invalid_request", "at most 50 events");
      this.activityRequests.push(events);
      let recorded = 0;
      for (const event of events) {
        const key = `${user.id}:${event.id}`;
        if (this.articleOpens.has(key) || !this.inbox.has(event.articleId)) continue;
        this.articleOpens.set(key, event);
        recorded += 1;
      }
      return json(200, { recorded });
    }
    if (this.savedPagesSupported && (path === "/saved" || path.startsWith("/saved/"))) {
      const pages = this.#savedPages.get(user.id) ?? new Map<string, SavedPageRow>();
      this.#savedPages.set(user.id, pages);
      if (request.method === "PUT" && path === "/saved") {
        const body = (await request.json()) as { url: string; title?: string };
        const url = new URL(body.url).href;
        const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(url));
        const id = [...new Uint8Array(digest)].map((n) => n.toString(16).padStart(2, "0")).join("");
        let row = pages.get(id);
        if (row === undefined || row.deleted) {
          if ([...pages.values()].filter((page) => !page.deleted).length >= this.maxSavedPages) {
            return error(409, "saved_limit_reached", "Saved pages limit reached");
          }
          row = {
            id,
            url,
            title: body.title ?? null,
            savedAt: this.now,
            deleted: false,
            seq: ++this.#maxSeq.savedPages,
          };
          pages.set(id, row);
        }
        return json(200, { page: savedPageJson(row) });
      }
      if (request.method === "DELETE") {
        const row = pages.get(path.slice("/saved/".length));
        if (row !== undefined && !row.deleted) {
          row.deleted = true;
          row.seq = ++this.#maxSeq.savedPages;
        }
        return new Response(null, { status: 204 });
      }
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
    if (path.startsWith("/settings/")) {
      if (!this.settingsSupported) return error(404, "not_found", "not found");
      return this.#settings(request.method, path.slice("/settings/".length), body);
    }
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

    const contentMatch = /^\/articles\/([^/]+)\/content$/.exec(path);
    if (request.method === "GET" && contentMatch !== null) {
      const id = decodeURIComponent(contentMatch[1] ?? "");
      if (url.searchParams.get("source") === "page") {
        this.pageContentRequests.push(id);
        if (!this.inbox.has(id)) return error(404, "not_found", "article does not exist");
        const html = this.pageContents.get(id);
        if (html === undefined) {
          return error(404, "page_content_unavailable", "page content unavailable");
        }
        return json(200, { html, source: "page" });
      }
      this.contentRequests.push(id);
      const row = this.inbox.get(id);
      if (row === undefined) return error(404, "not_found", "article does not exist");
      if (row.content === null || this.contentGone.has(id)) {
        return error(404, "no_content", "article has no content");
      }
      return json(200, { html: row.content, source: this.contentSource });
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
      // sendo の #48 と同じく、クライアントが決めた ID（小文字の UUID）を受ける
      this.folderRequests.push(body);
      const name = String(body.name ?? "").trim();
      if (name === "") return error(400, "invalid_request", "name: empty");
      const id = body.id as string | undefined;
      if (id !== undefined && !UUID.test(id)) {
        return error(400, "invalid_request", "id: not a lowercase UUID");
      }
      if (id !== undefined) {
        const same = this.folders.get(id);
        // 送り直し。作らずに、今のフォルダを返す
        if (same !== undefined && same.deletedAt === null) {
          return json(200, { folder: folderJson(same) });
        }
        // 消したフォルダか、ほかの人のフォルダの ID
        if (same !== undefined || this.foreignFolderIds.has(id)) {
          return error(409, "folder_id_taken", "this folder id is taken");
        }
      }
      if (this.#folderByName(name) !== undefined) {
        return error(409, "folder_exists", "a folder with this name exists");
      }
      return json(201, { folder: folderJson(this.createFolder(name, id)) });
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
        const folderId = body.folderId as string | null | undefined;
        const displayName = body.displayName;
        if (typeof folderId === "string" && this.folders.get(folderId)?.deletedAt !== null) {
          return error(400, "folder_not_found", "folder does not exist");
        }
        const name = typeof displayName === "string" ? displayName.trim() : displayName;
        if (
          (folderId === undefined && name === undefined) ||
          (name !== undefined &&
            name !== null &&
            (typeof name !== "string" || name.length === 0 || name.length > 200))
        ) {
          return error(400, "invalid_request", "invalid subscription update");
        }
        if (folderId !== undefined) feed.folderId = folderId;
        if (name !== undefined) feed.displayName = name;
        feed.seq = this.#bump("feeds");
        return json(200, { feed: feedJson(feed) });
      }
      if (request.method === "DELETE") {
        this.unsubscribe(feed.id);
        return new Response(null, { status: 204 });
      }
    }
    return error(404, "not_found", "Not Found");
  };

  /** まとめて既読（ID で、またはカーソルを境界に。sendo の POST /articles/mark-read） */
  #markRead(body: Record<string, unknown>): Response {
    this.markReadRequests.push(body);
    if (Array.isArray(body.ids)) {
      if (body.ids.length === 0 || body.ids.length > 90) {
        return error(400, "invalid_request", "ids: 1 to 90 items");
      }
      let updated = 0;
      for (const id of body.ids as string[]) {
        const row = this.inbox.get(id);
        if (row === undefined || row.readAt !== null) continue;
        this.setArticleState(id, { read: true });
        updated += 1;
      }
      return json(200, { updated });
    }
    if (typeof body.cursor !== "string") {
      return error(400, "invalid_request", "until or cursor: required");
    }
    const cursor = decodeCursor(body.cursor);
    if (cursor === null) return error(400, "invalid_cursor", "cursor is invalid");
    if (!cursor.done) {
      return error(400, "sync_incomplete", "sync until hasMore is false, then pass that cursor");
    }
    const inScope = (row: InboxRow): boolean => {
      if (body.all === true) return true;
      if (typeof body.feedId === "string") return row.feedId === body.feedId;
      if (typeof body.folderId === "string") {
        return this.feeds.get(row.feedId)?.folderId === body.folderId;
      }
      return false;
    };
    let updated = 0;
    for (const row of [...this.inbox.values()]) {
      if (row.readAt !== null || row.readSeq > cursor.articles || !inScope(row)) continue;
      this.setArticleState(row.id, { read: true });
      updated += 1;
    }
    return json(200, { updated });
  }

  #folderByName(name: string): FolderRow | undefined {
    return [...this.folders.values()].find((row) => row.deletedAt === null && row.name === name);
  }

  /** アクセストークンの発行・一覧・取り消し（sendo の src/api/tokens.ts と同じ決まり） */
  async #tokens(request: Request, path: string): Promise<Response> {
    if (request.method === "GET" && path === "/tokens") {
      const items = [...this.tokens.values()].sort((a, b) => b.createdAt - a.createdAt);
      return json(200, { items: items.map(tokenJson) });
    }
    if (request.method === "POST" && path === "/tokens") {
      const body = (await request.json()) as {
        name?: unknown;
        purpose?: unknown;
        scopes?: unknown;
      };
      const name = typeof body.name === "string" ? body.name.trim() : "";
      if (name.length < 1 || name.length > 100) {
        return error(400, "invalid_request", "name must be 1 to 100 characters");
      }
      const purpose = body.purpose === "mcp" ? "mcp" : "reader";
      const asked = Array.isArray(body.scopes) ? (body.scopes as string[]) : null;
      if (purpose === "reader" && asked !== null) {
        return error(400, "invalid_request", "scopes are only for mcp tokens");
      }
      const scopes: FakeToken["scopes"] =
        purpose === "reader"
          ? []
          : asked?.includes("write") === true
            ? ["read", "write"]
            : ["read"];
      const id = this.#id("token");
      const token: FakeToken = {
        id,
        name,
        purpose,
        scopes,
        createdAt: this.now,
        lastUsedAt: null,
        secret: `sendo_${id}_secret`,
      };
      this.tokens.set(id, token);
      return json(201, { token: token.secret, accessToken: tokenJson(token) });
    }
    const id = decodeURIComponent(path.slice("/tokens/".length));
    if (request.method === "DELETE" && this.tokens.delete(id))
      return new Response(null, { status: 204 });
    return error(404, "not_found", "token not found");
  }

  /** OAuth の許可の画面の確かめ（check）と決定（decide）。sendo の src/api/oauth.ts と同じ形 */
  async #authorize(request: Request, path: string): Promise<Response> {
    if (!this.oauthEnabled) return error(404, "oauth_disabled", "OAuth is not configured");
    const body = (await request.json()) as { query?: unknown; approved?: unknown };
    const params = new URLSearchParams(typeof body.query === "string" ? body.query : "");
    const clientId = params.get("client_id") ?? "";
    const client = this.oauthClients.get(clientId);
    if (client === undefined) return error(400, "invalid_client", "unknown client");
    const redirectUri = params.get("redirect_uri") ?? "";
    if (!client.redirectUris.includes(redirectUri)) {
      return error(400, "invalid_redirect_uri", "redirect_uri is not registered");
    }
    const state = params.get("state");
    const back = (values: Record<string, string>) => {
      const url = new URL(redirectUri);
      for (const [key, value] of Object.entries(values)) url.searchParams.set(key, value);
      if (state !== null) url.searchParams.set("state", state);
      url.searchParams.set("iss", "https://sendo.test");
      return url.href;
    };
    if (params.get("response_type") !== "code") {
      return json(400, {
        error: { code: "unsupported_response_type", message: "response_type must be code" },
        redirectTo: back({ error: "unsupported_response_type" }),
      });
    }
    const scopes: FakeGrant["scopes"] = (params.get("scope") ?? "read").split(" ").includes("write")
      ? ["read", "write"]
      : ["read"];
    if (path === "/oauth/authorize/check") {
      const url = new URL(redirectUri);
      return json(200, {
        client: {
          id: clientId,
          name: client.name,
          kind: client.kind,
          host: client.kind === "metadata_document" ? new URL(clientId).host : null,
        },
        redirectUri,
        redirectHost: url.host,
        loopbackRedirect: ["localhost", "127.0.0.1", "[::1]"].includes(url.hostname),
        scopes,
      });
    }
    if (body.approved !== true) {
      return json(200, { redirectTo: back({ error: "access_denied" }) });
    }
    const grant = this.addGrant({
      clientId,
      clientName: client.name,
      clientKind: client.kind,
      scopes,
    });
    return json(200, { redirectTo: back({ code: `code-${grant.id}` }) });
  }

  /** OAuth で出した許可の一覧・取り消し */
  #grants(request: Request, path: string): Response {
    if (request.method === "GET" && path === "/oauth/grants") {
      const items = [...this.grants.values()].sort((a, b) => b.createdAt - a.createdAt);
      return json(200, {
        items: items.map((grant) => ({
          ...grant,
          createdAt: iso(grant.createdAt),
          lastUsedAt: grant.lastUsedAt === null ? null : iso(grant.lastUsedAt),
        })),
      });
    }
    const id = decodeURIComponent(path.slice("/oauth/grants/".length));
    if (request.method === "DELETE" && this.grants.delete(id))
      return new Response(null, { status: 204 });
    return error(404, "not_found", "grant not found");
  }

  /**
   * Google でのログインを、すぐ終えたことにする（Google の画面は通さない）。loginUser の
   * セッションを作ってクッキーを置き、returnTo に戻す。loginUser が null なら
   * /?login_error=not_allowed に戻す
   */
  #login(returnTo: string | null, previous: string | null): Response {
    if (this.loginUser === null) {
      return new Response(null, {
        status: 302,
        headers: { location: "/?login_error=not_allowed" },
      });
    }
    if (previous !== null) this.sessions.delete(previous);
    const value = this.createSession(this.loginUser);
    const target =
      returnTo?.startsWith("/") === true && !returnTo.startsWith("//") ? returnTo : "/";
    return new Response(null, {
      status: 302,
      headers: {
        location: target,
        "set-cookie": `${SESSION_COOKIE}=${value}; Path=/; Secure; HttpOnly; SameSite=Lax`,
      },
    });
  }

  #settings(method: string, deviceType: string, body: Record<string, unknown>): Response {
    if (!DEVICE_TYPES.has(deviceType)) {
      return error(400, "invalid_request", "deviceType: mobile or desktop");
    }
    if (method === "GET") {
      const items = Object.entries(this.settingsOf(deviceType))
        .sort(([a], [b]) => (a < b ? -1 : 1))
        .map(([name, value]) => ({ name, value }));
      return json(200, { items });
    }
    if (method !== "PATCH") return error(404, "not_found", "not found");
    this.settingsRequests.push({ deviceType, body });
    const put = (body.put ?? []) as { name: string; value: unknown }[];
    const remove = (body.remove ?? []) as string[];
    const names = [...put.map((item) => item.name), ...remove];
    if (
      names.length > 100 ||
      new Set(names).size !== names.length ||
      names.some(
        (name) => typeof name !== "string" || name.length > 128 || !SETTING_NAME.test(name),
      ) ||
      put.some(
        (item) =>
          item.value === undefined ||
          new TextEncoder().encode(JSON.stringify(item.value)).length > 8192,
      )
    ) {
      return error(400, "invalid_request", "invalid settings");
    }
    // 消すほうを先に済ませる。上限を超えるなら、置くほうは 1 つも置かない
    for (const name of remove) this.removeSetting(deviceType, name);
    const current = this.settingsOf(deviceType);
    const added = put.filter((item) => !(item.name in current)).length;
    if (Object.keys(current).length + added > this.maxSettings) {
      return error(409, "settings_full", "too many settings");
    }
    for (const item of put) this.putSetting(deviceType, item.name, item.value);
    return new Response(null, { status: 204 });
  }

  #sync(rawCursor: string | null, includeSaved: boolean, userId: string): Response {
    const cursor = rawCursor === null ? null : decodeCursor(rawCursor);
    if (
      (rawCursor !== null && cursor === null) ||
      (cursor !== null &&
        (cursor.folders < this.#purgedUpTo.folders ||
          cursor.feeds < this.#purgedUpTo.feeds ||
          cursor.articles < this.#purgedUpTo.articles ||
          (cursor.settings !== undefined && cursor.settings < this.#purgedUpTo.settings) ||
          (includeSaved &&
            cursor.savedPages !== undefined &&
            cursor.savedPages < this.#purgedUpTo.savedPages)))
    ) {
      return error(400, "invalid_cursor", "cursor is invalid; start over without it");
    }

    // 設定の位置を持たない古いカーソルには、設定だけを最初から送る（全体の同期し直しはさせない）
    const since: Required<Pick<Cursor, TableName>> & Cursor = {
      settings: 0,
      savedPages: 0,
      ...(cursor ?? { folders: 0, feeds: 0, articles: 0, done: false }),
    };
    const settingsInitial = cursor === null || cursor.settings === undefined;
    const savedInitial = cursor === null || cursor.savedPages === undefined;
    const initialSince = cursor === null ? this.now - 30 * DAY : cursor.initialSince;
    const initial = initialSince !== undefined;

    const pending = {
      folders: [...this.folders.values()]
        .filter((row) => row.seq > since.folders && !(initial && row.deletedAt !== null))
        .sort(bySeq),
      feeds: [...this.feeds.values()]
        .filter((row) => row.seq > since.feeds && !(initial && row.deletedAt !== null))
        .sort(bySeq),
      articles: [
        ...[...this.inbox.values()]
          .filter(
            (row) =>
              row.seq > since.articles &&
              (!initial ||
                row.readAt === null ||
                row.starredAt !== null ||
                row.receivedAt >= (initialSince ?? 0)),
          )
          .map((row) => ({ seq: row.seq, row })),
        // 消した記録は差分でだけ送る
        ...(initial
          ? []
          : [...this.removals]
              .filter(([, seq]) => seq > since.articles)
              .map(([id, seq]) => ({ seq, removed: id }))),
      ].sort(bySeq),
      savedPages: includeSaved
        ? [...(this.#savedPages.get(userId)?.values() ?? [])]
            .filter((row) => row.seq > since.savedPages && !(savedInitial && row.deleted))
            .sort(bySeq)
        : [],
      settings: this.settingsSupported
        ? [...this.settings.values()]
            .filter((row) => row.seq > since.settings && !(settingsInitial && row.deleted))
            .sort(bySeq)
        : [],
    };

    let room = this.pageSize;
    const next: Cursor = { ...since };
    let hasMore = false;
    const page = {
      folders: [] as FolderRow[],
      feeds: [] as FeedRow[],
      articles: [] as (typeof pending)["articles"],
      settings: [] as SettingRow[],
      savedPages: [] as SavedPageRow[],
    };
    for (const table of ["folders", "feeds", "articles", "settings", "savedPages"] as const) {
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
    next.done = !hasMore;

    if (!this.settingsSupported) delete next.settings;
    if (!includeSaved) delete next.savedPages;

    return json(200, {
      cursor: encodeCursor(next),
      hasMore,
      ...(this.settingsSupported
        ? {
            settings: page.settings.map((row) =>
              row.deleted
                ? { deviceType: row.deviceType, name: row.name, deleted: true }
                : { deviceType: row.deviceType, name: row.name, value: row.value, deleted: false },
            ),
          }
        : {}),
      ...(includeSaved
        ? {
            savedPages: page.savedPages.map((row) =>
              row.deleted
                ? { id: row.id, deleted: true }
                : { ...savedPageJson(row), deleted: false },
            ),
          }
        : {}),
      folders: page.folders.map((row) => ({
        id: row.id,
        name: row.name,
        createdAt: iso(row.createdAt),
        deleted: row.deletedAt !== null,
      })),
      feeds: page.feeds.map((row) => ({
        id: row.id,
        url: row.url,
        title: row.title,
        displayName: row.displayName,
        siteUrl: row.siteUrl,
        folderId: row.folderId,
        iconUrl: row.iconUrl,
        createdAt: iso(row.createdAt),
        deleted: row.deletedAt !== null,
      })),
      articles: page.articles.map((item) =>
        "removed" in item
          ? { id: item.removed, deleted: true }
          : {
              id: item.row.id,
              feedId: item.row.feedId,
              url: item.row.url,
              title: item.row.title,
              summary: item.row.summary,
              author: item.row.author,
              thumbnailUrl: item.row.thumbnailUrl,
              ...(this.omitHasContent ? {} : { hasContent: item.row.content !== null }),
              publishedAt: iso(item.row.publishedAt),
              receivedAt: iso(item.row.receivedAt),
              readAt: item.row.readAt === null ? null : iso(item.row.readAt),
              starredAt: item.row.starredAt === null ? null : iso(item.row.starredAt),
              deleted: false,
            },
      ),
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

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

function folderJson(row: FolderRow) {
  return { id: row.id, name: row.name, createdAt: iso(row.createdAt) };
}

function feedJson(row: FeedRow) {
  return {
    id: row.id,
    url: row.url,
    title: row.title,
    displayName: row.displayName,
    siteUrl: row.siteUrl,
    folderId: row.folderId,
    iconUrl: row.iconUrl,
    lastFetchedAt: row.lastFetchedAt === null ? null : iso(row.lastFetchedAt),
    lastSuccessfulFetchAt:
      row.lastSuccessfulFetchAt === null ? null : iso(row.lastSuccessfulFetchAt),
    nextFetchAt: iso(row.createdAt),
    errorCount: 0,
    lastError: null,
    createdAt: iso(row.createdAt),
  };
}

function bySeq(a: { seq: number }, b: { seq: number }): number {
  return a.seq - b.seq;
}

function savedPageJson(row: SavedPageRow) {
  return { id: row.id, url: row.url, title: row.title, savedAt: iso(row.savedAt) };
}

function iso(ms: number): string {
  return new Date(ms).toISOString();
}

/** 1×1 の透明な PNG */
const TINY_PNG = Uint8Array.from(
  atob(
    "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==",
  ),
  (char) => char.charCodeAt(0),
);

/** 偽の署名。もとの URL から決まる 22 文字（本物は HMAC。ここでは、合う ／ 合わないだけを見分ける） */
function fakeSignature(original: string): string {
  let hash = 0;
  for (let i = 0; i < original.length; i++)
    hash = (Math.imul(hash, 31) + original.charCodeAt(i)) >>> 0;
  return hash.toString(36).padStart(22, "0");
}

/** 画像の中継の失敗。JSON で、キャッシュさせない */
function imageError(status: number, code: string): Response {
  return new Response(JSON.stringify({ error: { code, message: code } }), {
    status,
    headers: { "content-type": "application/json", "cache-control": "no-store" },
  });
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
      typeof parsed.articles === "number" &&
      typeof parsed.done === "boolean"
      ? parsed
      : null;
  } catch {
    return null;
  }
}

/** cookie ヘッダーから、name のクッキーの値を読む */
function readCookie(header: string | null, name: string): string | null {
  for (const part of header?.split(";") ?? []) {
    const [key, ...value] = part.trim().split("=");
    if (key === name) return value.join("=");
  }
  return null;
}

/** sendo の CSRF の対策と同じ。Sec-Fetch-Site を見て、なければ Origin を見る */
function isSameOrigin(request: Request): boolean {
  const site = request.headers.get("sec-fetch-site");
  if (site !== null) return site === "same-origin";
  return request.headers.get("origin") === new URL(request.url).origin;
}

function tokenJson(token: FakeToken) {
  return {
    id: token.id,
    name: token.name,
    purpose: token.purpose,
    scopes: token.scopes,
    createdAt: iso(token.createdAt),
    lastUsedAt: token.lastUsedAt === null ? null : iso(token.lastUsedAt),
  };
}
