import { ApiError, type ApiErrorKind } from "../api/errors";
import type { ReaderCore } from "../reader";

/** 同期の様子。画面の「オフライン」「未送信 N 件」などの表示に使う */
export interface SyncStatus {
  signedIn: boolean;
  syncing: boolean;
  /** 最後に同期できた時刻 */
  lastSyncedAt: number | null;
  /** 最後の同期の失敗の種類（成功したら null） */
  error: ApiErrorKind | null;
  /** まだ sendo に送り終えていない操作の数 */
  pending: number;
}

export interface SchedulerOptions {
  now?: () => number;
  setTimeout?: (fn: () => void, ms: number) => unknown;
  clearTimeout?: (handle: unknown) => void;
  onStatus?: (status: SyncStatus) => void;
}

/** 何もなくても同期する間隔 */
export const PERIODIC_SYNC_MS = 5 * 60 * 1000;
/** 書き込みのあと、まとめて送るまで待つ時間 */
export const WRITE_DEBOUNCE_MS = 500;
/** 届かなかったときに、次に試すまでの時間（失敗が続くほど延ばす） */
export const RETRY_DELAYS_MS = [5_000, 15_000, 60_000, PERIODIC_SYNC_MS] as const;

/**
 * いつ同期するかを決める（プラットフォームによらない）。
 *
 * - 起動したら、すぐ同期する
 * - 書き込んだら、少し待ってから送る（続けて操作したときに、まとめて送れるように）
 * - 何もなくても、一定の間隔で同期する
 * - 届かなかったら、間隔を延ばしながらやり直す。オンラインに戻ったら、すぐ試す
 * - トークンが使えなくなったら止め、ログインし直すまで待つ
 */
export class SyncScheduler {
  readonly #core: ReaderCore;
  readonly #now: () => number;
  readonly #setTimeout: (fn: () => void, ms: number) => unknown;
  readonly #clearTimeout: (handle: unknown) => void;
  readonly #onStatus: (status: SyncStatus) => void;

  #timer: { handle: unknown; at: number } | null = null;
  #running: Promise<void> | null = null;
  /** 走っている間に、もう一度同期してほしいと頼まれた */
  #again = false;
  #failures = 0;
  #stopped = false;
  #status: SyncStatus;

  constructor(core: ReaderCore, options: SchedulerOptions = {}) {
    this.#core = core;
    this.#now = options.now ?? Date.now;
    this.#setTimeout = options.setTimeout ?? ((fn, ms) => globalThis.setTimeout(fn, ms));
    this.#clearTimeout =
      options.clearTimeout ??
      ((handle) => globalThis.clearTimeout(handle as ReturnType<typeof setTimeout>));
    this.#onStatus = options.onStatus ?? (() => {});
    this.#status = {
      signedIn: core.isSignedIn(),
      syncing: false,
      lastSyncedAt: null,
      error: null,
      pending: 0,
    };
  }

  get status(): SyncStatus {
    return { ...this.#status };
  }

  /** すぐ同期する（起動したとき、オンラインに戻ったとき、ログインしたとき、画面で頼まれたとき） */
  requestNow(): void {
    this.#failures = 0;
    this.#schedule(0);
  }

  /** 少し待ってから同期する（書き込んだあと） */
  requestSoon(): void {
    this.#schedule(WRITE_DEBOUNCE_MS);
    void this.#refreshPending();
  }

  /**
   * 今すぐ同期し、終わるまで待つ（画面で「今すぐ同期」を押したとき）。走っている同期があれば
   * その終わりを待ってから、もう一度最初から回す（走っている同期は、そのあとに積んだ操作を
   * 送らないことがあるため）。
   */
  async syncNow(): Promise<void> {
    this.#failures = 0;
    if (this.#running !== null) await this.#running.catch(() => undefined);
    this.#cancelTimer();
    this.#again = false;
    await this.#run();
  }

  stop(): void {
    this.#stopped = true;
    this.#cancelTimer();
  }

  #schedule(delayMs: number): void {
    if (this.#stopped) return;
    const at = this.#now() + delayMs;
    // すでに、それより早く予定していれば変えない
    if (this.#timer !== null && this.#timer.at <= at) return;
    this.#cancelTimer();
    const handle = this.#setTimeout(() => {
      this.#timer = null;
      void this.#run();
    }, delayMs);
    this.#timer = { handle, at };
  }

  #cancelTimer(): void {
    if (this.#timer === null) return;
    this.#clearTimeout(this.#timer.handle);
    this.#timer = null;
  }

  #run(): Promise<void> {
    if (this.#running !== null) {
      // 走っている同期は、そのあとに積んだ操作を送らないことがある。終わったらもう一度回す
      this.#again = true;
      return this.#running;
    }
    this.#running = this.#runOnce().finally(() => {
      this.#running = null;
      if (this.#again) {
        this.#again = false;
        this.#schedule(0);
      }
    });
    return this.#running;
  }

  async #runOnce(): Promise<void> {
    if (!this.#core.isSignedIn()) {
      this.#update({ signedIn: false, syncing: false, error: null });
      // ログアウトで消えた操作の数も、画面から消す
      await this.#refreshPending();
      return;
    }
    this.#update({ signedIn: true, syncing: true });
    try {
      await this.#core.sync();
      this.#failures = 0;
      this.#update({ syncing: false, lastSyncedAt: this.#now(), error: null });
      this.#schedule(PERIODIC_SYNC_MS);
    } catch (error) {
      const kind = error instanceof ApiError ? error.kind : null;
      this.#update({ syncing: false, error: kind ?? "server" });
      if (kind === "unauthorized") {
        // トークンが使えない。ログインし直すまで止める（requestNow で再開する）
        this.#cancelTimer();
      } else {
        if (kind === null) console.error("同期で予期しない失敗", error);
        const delay = RETRY_DELAYS_MS[Math.min(this.#failures, RETRY_DELAYS_MS.length - 1)];
        this.#failures += 1;
        this.#schedule(delay ?? PERIODIC_SYNC_MS);
      }
    } finally {
      await this.#refreshPending();
    }
  }

  async #refreshPending(): Promise<void> {
    try {
      this.#update({ pending: await this.#core.countPending(), signedIn: this.#core.isSignedIn() });
    } catch {
      // 数えられなくても同期は続ける
    }
  }

  #update(patch: Partial<SyncStatus>): void {
    const next = { ...this.#status, ...patch };
    const changed = (Object.keys(next) as (keyof SyncStatus)[]).some(
      (key) => next[key] !== this.#status[key],
    );
    this.#status = next;
    if (changed) this.#onStatus({ ...next });
  }
}
