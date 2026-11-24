import type { AppUpdateNotice } from "./app-update";

/** 新しい版の知らせ。Dismiss の状態は画面のメモリーにだけ持つ（docs/decisions/ui.md の 5） */
class UpdateNotice {
  visible = $state<AppUpdateNotice | null>(null);

  show(notice: AppUpdateNotice | null): void {
    this.visible = notice;
  }

  dismiss(): void {
    this.visible = null;
  }
}

export const updateNotice = new UpdateNotice();

export type Notice = "leaveStalled" | "versionMismatch" | AppUpdateNotice;

/**
 * どの知らせを出すか。このタブがいま使えないことを言う知らせを先に出す。
 * 新しい版の知らせは、読み込み直すと消えるものを出している画面では出さない
 */
export function selectNotice(state: {
  leaveStalled: boolean;
  versionMismatch: boolean;
  update: AppUpdateNotice | null;
  canReload: boolean;
}): Notice | null {
  if (state.leaveStalled) return "leaveStalled";
  if (state.versionMismatch) return "versionMismatch";
  return state.canReload ? state.update : null;
}

/** ホーム画面のアプリとして開いているか（iOS の Safari は navigator.standalone で分かる） */
export function isStandalone(): boolean {
  return (
    matchMedia("(display-mode: standalone)").matches ||
    (navigator as Navigator & { standalone?: boolean }).standalone === true
  );
}
