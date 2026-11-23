/**
 * 読み込み直すと消えるものを出している間の印（docs/decisions/ui.md の 5）。
 *
 * パスで分からないもの（開いている Save a URL の窓など）は、出している部品が hold() で印を付け、
 * 閉じたら戻す。自動の読み込み直し（main.ts の canReload）と、新しい版の知らせ（App.svelte）の両方が
 * lib/app-update.ts の canReloadPage を通して見る。$state なので、閉じたら知らせを出し直せる
 */
class ReloadGuard {
  #holds = $state(0);

  /** 印を付ける。返した関数で戻す（何度呼んでも 1 回だけ戻す） */
  hold(): () => void {
    this.#holds += 1;
    let released = false;
    return () => {
      if (released) return;
      released = true;
      this.#holds -= 1;
    };
  }

  /** 印が付いている（読み込み直すと消えるものを出している） */
  get held(): boolean {
    return this.#holds > 0;
  }
}

export const reloadGuard = new ReloadGuard();
