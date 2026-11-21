import type { ContentStorage } from "@sendo-reader/core";
import type { ReaderClient } from "@sendo-reader/core/web";

/**
 * Settings の Offline の欄の状態（手元に置く本文の量と、その上限。docs/decisions/local-first.md の
 * 「記事の本文」）。この端末だけの設定で、sendo には預けない。
 *
 * 欄を開いている間は、裏の先読みで増えた量を出すために、一定の間隔で読み直す。上限を変えられ
 * なかったら、選択欄を実際の値に戻す。
 */
export class ContentStorageState {
  /** 手元の本文の量と上限。読めるまでは null */
  storage = $state<ContentStorage | null>(null);
  /** 選択欄の値（上限のバイト数の文字列）。変えられなかったら、実際の値に戻す */
  selected = $state("");
  /** 読めなかった（load）か、変えられなかった（save） */
  failed = $state<"load" | "save" | null>(null);

  readonly #client: Pick<ReaderClient, "getContentStorage" | "setContentStorageLimit">;
  #saving = 0;
  #timer: ReturnType<typeof setInterval> | null = null;

  constructor(client: Pick<ReaderClient, "getContentStorage" | "setContentStorageLimit">) {
    this.#client = client;
  }

  /** 読む（初めて開いたときと、読めなかったときのやり直し） */
  async load(): Promise<void> {
    try {
      this.#apply(await this.#client.getContentStorage());
      this.failed = null;
    } catch {
      this.failed = "load";
    }
  }

  /** 上限を変える。変えられなかったら、選択欄を実際の値に戻す */
  async select(value: string): Promise<void> {
    this.selected = value;
    this.#saving += 1;
    try {
      this.#apply(await this.#client.setContentStorageLimit(Number(value)));
      this.failed = null;
    } catch {
      this.failed = "save";
      if (this.storage !== null) this.selected = String(this.storage.limit);
    } finally {
      this.#saving -= 1;
    }
  }

  /** 使っている量だけを読み直す（変えている途中の上限は上書きしない） */
  async refresh(): Promise<void> {
    if (this.storage === null || this.#saving > 0) return;
    try {
      const next = await this.#client.getContentStorage();
      if (this.#saving > 0) return;
      this.#apply(next);
    } catch {
      // 読み直せなくても、前の値を出しておく（次の間隔でまた読む）
    }
  }

  /** 欄を開いている間、intervalMs ごとに読み直す */
  start(intervalMs: number): void {
    this.stop();
    this.#timer = setInterval(() => void this.refresh(), intervalMs);
  }

  stop(): void {
    if (this.#timer !== null) clearInterval(this.#timer);
    this.#timer = null;
  }

  #apply(storage: ContentStorage): void {
    this.storage = storage;
    this.selected = String(storage.limit);
  }
}

const UNITS = ["KB", "MB", "GB"] as const;

/**
 * バイト数を、選択肢と同じ書き方（200MB、1GB、512KB）にする。KB は切り上げ、MB と GB は小数 1 桁まで
 * （.0 は付けない）。丸めて 1024 に届いたら、次の単位にする
 */
export function formatBytes(bytes: number): string {
  const round = (value: number, unit: number) =>
    unit === 0 ? Math.ceil(value) : Math.round(value * 10) / 10;
  let value = bytes / 1024;
  let unit = 0;
  while (unit < UNITS.length - 1 && round(value, unit) >= 1024) {
    value /= 1024;
    unit += 1;
  }
  return `${round(value, unit)}${UNITS[unit]}`;
}
