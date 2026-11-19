import type { SyncStatus } from "./scheduler";

/**
 * sendo の通知（WebSocket の /api/v1/sync/updates）を受け、同期を頼む
 * （docs/decisions/local-first.md の 3。決まりは sendo の docs/decisions/sync.md の 9 と、OpenAPI の
 * /sync/updates の説明が正）。
 *
 * - ログインしている間だけつなぐ。ログアウトしたときと、同期が 401 を返したときは閉じる
 * - 接続が開いたときと、{"type":"sync_required"} を受けたときに、同期を頼む（待ってまとめるのは
 *   スケジューラー）
 * - つながらなければ、間を延ばしながらつなぎ直す。sendo が通知に対応しているかは、別の API で
 *   問い合わせない（つながらない間は、定期同期で動く）
 * - こちらからはメッセージを送らない
 *
 * 閉じるコードごとの動き（sendo の sync.md の 9）
 * - 1001（sendo が止まる、入れ替わる）：数秒待ってつなぎ直す
 * - 1008（セッションが切れた）：すぐにはつなぎ直さず、同期を 1 回して確かめる。401 なら、ログインし
 *   直すまでつながない。通れば、間を延ばしながらつなぎ直す
 * - 1013（接続数の上限）：1 分以上空けてつなぎ直す
 * - そのほか（1006 など。101 を返す前に断られたときも、ブラウザからは 1006 に見える）：間を延ばし
 *   ながらつなぎ直す
 */

/** ブラウザの WebSocket のうち、使うところだけ */
export interface WebSocketLike {
  onopen: ((event: unknown) => void) | null;
  onmessage: ((event: { data: unknown }) => void) | null;
  onclose: ((event: { code: number }) => void) | null;
  onerror: ((event: unknown) => void) | null;
  close(code?: number, reason?: string): void;
}

export interface SyncUpdatesOptions {
  /** 通知の入口につなぐ。投げたら、つながらなかったものとして扱う */
  connect: () => WebSocketLike;
  /** 同期を頼む（スケジューラーが少し待ってまとめる） */
  requestSync: () => void;
  /** セッションを確かめるために、すぐ同期を 1 回頼む（1008 のとき） */
  checkSession: () => void;
  now?: () => number;
  setTimeout?: (fn: () => void, ms: number) => unknown;
  clearTimeout?: (handle: unknown) => void;
  /** 0 以上 1 未満。つなぎ直す時刻をずらす */
  random?: () => number;
}

/** つながらないときの、つなぎ直すまでの間（続くほど延ばす） */
export const RECONNECT_DELAYS_MS = [
  2_000, 5_000, 15_000, 30_000, 60_000, 120_000, 300_000,
] as const;
const MAX_RECONNECT_DELAY_MS = 300_000;
/** 1001（sendo が止まる、入れ替わる）のあと、つなぎ直すまでの間 */
export const GOING_AWAY_DELAY_MS = 3_000;
/** 1008（セッションが切れた）のあと、つなぎ直すまでの最短の間（その前に同期で確かめる） */
export const SESSION_CHECK_DELAY_MS = 5_000;
/** 1013（接続数の上限）のあと、つなぎ直すまでの最短の間 */
export const TRY_AGAIN_LATER_DELAY_MS = 60_000;
/** この時間より長く開いていた接続が切れたら、つなぎ直しの間を最初に戻す */
export const STABLE_CONNECTION_MS = 60_000;

const GOING_AWAY = 1001;
const POLICY_VIOLATION = 1008;
const TRY_AGAIN_LATER = 1013;
const NORMAL_CLOSURE = 1000;

export class SyncUpdates {
  readonly #connect: () => WebSocketLike;
  readonly #requestSync: () => void;
  readonly #checkSession: () => void;
  readonly #now: () => number;
  readonly #setTimeout: (fn: () => void, ms: number) => unknown;
  readonly #clearTimeout: (handle: unknown) => void;
  readonly #random: () => number;

  #socket: WebSocketLike | null = null;
  /** 今の接続が開いた時刻（開く前は null） */
  #openedAt: number | null = null;
  #timer: unknown = null;
  #failures = 0;
  /** ログインしていて、セッションも切れていない */
  #enabled = false;
  #stopped = false;

  constructor(options: SyncUpdatesOptions) {
    this.#connect = options.connect;
    this.#requestSync = options.requestSync;
    this.#checkSession = options.checkSession;
    this.#now = options.now ?? Date.now;
    this.#setTimeout = options.setTimeout ?? ((fn, ms) => globalThis.setTimeout(fn, ms));
    this.#clearTimeout =
      options.clearTimeout ??
      ((handle) => globalThis.clearTimeout(handle as ReturnType<typeof setTimeout>));
    this.#random = options.random ?? Math.random;
  }

  /** つないでいるか（開いているか） */
  get connected(): boolean {
    return this.#socket !== null && this.#openedAt !== null;
  }

  /** 同期の様子が変わったら呼ぶ。ログインしている間だけつなぐ */
  update(status: SyncStatus): void {
    const enabled = status.signedIn && status.error !== "unauthorized";
    if (enabled === this.#enabled) return;
    this.#enabled = enabled;
    this.#failures = 0;
    if (enabled) {
      this.#open();
    } else {
      this.#cancelTimer();
      this.#drop();
    }
  }

  /** オンラインに戻ったら、待たずにつなぎ直す */
  online(): void {
    if (!this.#enabled || this.#stopped || this.#socket !== null) return;
    this.#cancelTimer();
    this.#failures = 0;
    this.#open();
  }

  stop(): void {
    this.#stopped = true;
    this.#enabled = false;
    this.#cancelTimer();
    this.#drop();
  }

  #open(): void {
    if (this.#stopped || !this.#enabled || this.#socket !== null) return;
    this.#timer = null;
    let socket: WebSocketLike;
    try {
      socket = this.#connect();
    } catch (error) {
      console.warn("通知につなげなかった", error);
      this.#reconnectLater(this.#backoff());
      return;
    }
    this.#socket = socket;
    this.#openedAt = null;
    socket.onopen = () => {
      if (this.#socket !== socket) return;
      this.#openedAt = this.#now();
      // つながるまでの間に変わったものを取る（初回も、つなぎ直したときも）
      this.#requestSync();
    };
    socket.onmessage = (event) => {
      if (this.#socket !== socket) return;
      if (isSyncRequired(event.data)) this.#requestSync();
    };
    // 失敗の中身は close のコードで分ける（error のあとには、かならず close が来る）
    socket.onerror = () => {};
    socket.onclose = (event) => {
      if (this.#socket !== socket) return;
      this.#closed(event.code);
    };
  }

  #closed(code: number): void {
    const openedAt = this.#openedAt;
    this.#socket = null;
    this.#openedAt = null;
    if (openedAt !== null && this.#now() - openedAt >= STABLE_CONNECTION_MS) this.#failures = 0;
    if (!this.#enabled || this.#stopped) return;
    switch (code) {
      case GOING_AWAY:
        this.#reconnectLater(GOING_AWAY_DELAY_MS);
        return;
      case POLICY_VIOLATION:
        // 同期の 401 が届いたら update で止まる。通れば、間を延ばしてつなぎ直す
        this.#checkSession();
        this.#reconnectLater(Math.max(SESSION_CHECK_DELAY_MS, this.#backoff()));
        return;
      case TRY_AGAIN_LATER:
        this.#reconnectLater(Math.max(TRY_AGAIN_LATER_DELAY_MS, this.#backoff()));
        return;
      default:
        this.#reconnectLater(this.#backoff());
    }
  }

  /** 失敗が続くほど延ばした間。呼ぶたびに失敗を数える */
  #backoff(): number {
    const delay = RECONNECT_DELAYS_MS[Math.min(this.#failures, RECONNECT_DELAYS_MS.length - 1)];
    this.#failures += 1;
    return delay ?? MAX_RECONNECT_DELAY_MS;
  }

  #reconnectLater(delayMs: number): void {
    this.#cancelTimer();
    // 一斉につなぎ直さないように、少し（最大 25%）ずらす
    const jittered = Math.round(delayMs * (1 + this.#random() * 0.25));
    this.#timer = this.#setTimeout(() => {
      this.#timer = null;
      this.#open();
    }, jittered);
  }

  #cancelTimer(): void {
    if (this.#timer === null) return;
    this.#clearTimeout(this.#timer);
    this.#timer = null;
  }

  /** 今の接続を、つなぎ直さずに閉じる */
  #drop(): void {
    const socket = this.#socket;
    this.#socket = null;
    this.#openedAt = null;
    if (socket === null) return;
    socket.onopen = null;
    socket.onmessage = null;
    socket.onclose = null;
    socket.onerror = null;
    try {
      socket.close(NORMAL_CLOSURE);
    } catch {
      // 開く前に閉じても、閉じたことにする
    }
  }
}

/** sendo の {"type":"sync_required"} か。知らない形は無視する（あとで種類が増えても止めない） */
function isSyncRequired(data: unknown): boolean {
  if (typeof data !== "string") return false;
  try {
    const message: unknown = JSON.parse(data);
    return (
      typeof message === "object" &&
      message !== null &&
      (message as { type?: unknown }).type === "sync_required"
    );
  } catch {
    return false;
  }
}

/** sendo の API の入口（例："/api/v1"）から、通知の入口の URL（ws: ／ wss:）を作る */
export function syncUpdatesUrl(baseUrl: string, location: string): string {
  const url = new URL(`${baseUrl.replace(/\/+$/, "")}/sync/updates`, location);
  url.protocol = url.protocol === "https:" ? "wss:" : "ws:";
  return url.href;
}
