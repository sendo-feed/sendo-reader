/**
 * 新しい版の知らせ（docs/decisions/ui.md の 5）。
 *
 * 新しい版に替わったのに、画面が前に出ていて読み込み直せない間、そのことを知らせる（lib/app-update.ts
 * の onUpdateReady）。閉じたら、読み込み直すまで出し直さない。閉じたあとに、さらに新しい版に
 * 替わったら、また出す。閉じた印は、このページのメモリーにだけ持つ（読み込み直すと消える）
 */
class UpdateNotice {
  /** 新しい版に替わった回数 */
  #ready = $state(0);
  /** 閉じたときの #ready */
  #dismissed = $state(0);

  /** 新しい版に替わった（まだ読み込み直していない） */
  ready(): void {
    this.#ready += 1;
  }

  /** 閉じる。いまの版では、もう出さない */
  dismiss(): void {
    this.#dismissed = this.#ready;
  }

  /** 知らせを出したい（閉じていない新しい版がある） */
  get pending(): boolean {
    return this.#ready > this.#dismissed;
  }
}

export const updateNotice = new UpdateNotice();

/** 画面の上に浮かせて出す知らせ。同時に出すのは 1 つだけ */
export type TopNotice = "leaveStalled" | "versionMismatch" | "updateReady";

/**
 * どの知らせを出すか。このタブがいま使えないことを言う知らせ（reader の外へ移る途中で止まった、
 * 版の違うタブがある）を先に出す。新しい版の知らせは、読み込み直すと消えるものを出している画面
 * （canReload が false）では出さず、ほかの画面に移ったら出す
 */
export function topNotice(state: {
  leaveStalled: boolean;
  versionMismatch: boolean;
  updatePending: boolean;
  canReload: boolean;
}): TopNotice | null {
  if (state.leaveStalled) return "leaveStalled";
  if (state.versionMismatch) return "versionMismatch";
  if (state.updatePending && state.canReload) return "updateReady";
  return null;
}

/** ホーム画面のアプリとして開いているか（iOS の Safari は navigator.standalone で分かる） */
export function isStandalone(): boolean {
  return (
    matchMedia("(display-mode: standalone)").matches ||
    (navigator as Navigator & { standalone?: boolean }).standalone === true
  );
}
