import { applyBellChange, type Bell, type BellChange } from "@sendo-reader/core";
import type { ReaderClient } from "@sendo-reader/core/web";

/**
 * 手元に見えるベル（core の listBells）を画面に持つ。bells の知らせで読み直す。
 *
 * 押したら、手元の DB への書き込みを待たずに、書き込んだあとの見込みを出す（docs/decisions/
 * performance.md の操作の反応 100ms）。見込みは core と同じ決まり（core の bells.ts）で作る。書き込み
 * が終わるまでは読み直した結果で上書きせず（続けて押したとき、前の押下の読み直しで表示が戻らない
 * ように）、最後の書き込みが終わってから読み直す。書けなかったら、読み直した手元の DB の状態に戻る
 */
export class BellList {
  bells = $state.raw<readonly Bell[]>([]);
  readonly #client: ReaderClient;
  #writing = 0;
  #reads = 0;
  #drafts = 0;

  constructor(client: ReaderClient) {
    this.#client = client;
  }

  /** 出している間、知らせを受けて読み直す。$effect の中で呼び、返した関数で止める */
  watch(): () => void {
    this.bells = [];
    const off = this.#client.onChange((tables) => {
      if (tables.has("bells")) void this.#read();
    });
    void this.#read();
    return () => {
      this.#reads += 1;
      off();
    };
  }

  /** 見込みをすぐ出し、write（core への書き込み）を待つ。書けなかったら、その失敗を投げる */
  async change(plan: (bells: readonly Bell[]) => BellChange, write: () => Promise<void>) {
    this.#writing += 1;
    this.#reads += 1;
    this.#drafts += 1;
    this.bells = applyBellChange(this.bells, plan(this.bells), {
      id: `draft-${this.#drafts}`,
      createdAt: Date.now(),
    });
    try {
      await write();
    } finally {
      this.#writing -= 1;
      if (this.#writing === 0) await this.#read();
    }
  }

  async #read(): Promise<void> {
    const read = ++this.#reads;
    const bells = await this.#client.listBells().catch(() => null);
    if (bells !== null && read === this.#reads && this.#writing === 0) this.bells = bells;
  }
}
