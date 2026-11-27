/**
 * 読み込み直すと消えるものを出している間の印（docs/decisions/ui.md の 5）。
 *
 * パスで分からないもの（開いている Save a URL の窓など）は、出している部品が hold() で印を付け、
 * 閉じたら戻す。自動の読み込み直し（main.ts の canReload）と、新しい版の知らせ（App.svelte）の両方が
 * lib/reload-paths.ts の canReloadPage を通して見る。$state なので、閉じたら知らせを出し直せる
 */
class ReloadGuard {
  /**
   * 付いている印の数。hold() は部品の $effect の中から呼ばれるので、$state にしない。$state を読んで
   * 書くと、その effect が自分の書いた値を見張ることになり、走り続ける
   */
  #count = 0;
  /** 印が付いているか。書くだけで、hold() の中では読まない */
  #held = $state(false);

  /** 印を付ける。返した関数で戻す（何度呼んでも 1 回だけ戻す） */
  hold(): () => void {
    this.#count += 1;
    this.#held = true;
    let released = false;
    return () => {
      if (released) return;
      released = true;
      this.#count -= 1;
      this.#held = this.#count > 0;
    };
  }

  /** 印が付いている（読み込み直すと消えるものを出している） */
  get held(): boolean {
    return this.#held;
  }
}

export const reloadGuard = new ReloadGuard();
