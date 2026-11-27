import type { BrowserContext, Page } from "@playwright/test";

/**
 * 版の違うタブの代表のワーカー（docs/decisions/local-first.md の 5）を、同じオリジンの別のページで
 * 真似る（代表のロックを取り、番号を変えて、または番号を付けずに名乗る。届いた頼みには答えない）。
 */

/**
 * 版の違うタブの代表を真似るページを開く。代表のロックを頼むところまで待ち、ロックを取ったら
 * 名乗り、本物の代表と同じく同期の様子も送る。version が null なら、番号を付けずに名乗る（この
 * 決まりより前の版）
 */
export async function openOtherVersion(
  context: BrowserContext,
  version: number | null,
): Promise<Page> {
  const other = await context.newPage();
  // アプリを動かさない、同じオリジンのページ
  await other.goto("/manifest.webmanifest");
  await other.evaluate((version) => {
    const leaderId = crypto.randomUUID();
    const peers = new BroadcastChannel("sendo-reader:peers");
    const leader =
      version === null ? { type: "leader", leaderId } : { type: "leader", version, leaderId };
    const status = {
      type: "status",
      ...(version === null ? {} : { version }),
      status: {
        signedIn: true,
        user: null,
        syncing: false,
        lastSyncedAt: null,
        error: null,
        pending: 0,
        logoutPending: false,
        savedPageError: null,
      },
    };
    const announce = () => {
      peers.postMessage(leader);
      peers.postMessage(status);
    };
    let isLeader = false;
    peers.addEventListener("message", (event: MessageEvent<{ type: string }>) => {
      if (isLeader && event.data.type === "hello") announce();
    });
    const granted = new Promise<void>((resolve) => {
      void navigator.locks.request("sendo-reader:leader", () => {
        isLeader = true;
        announce();
        resolve();
        return new Promise(() => {});
      });
    });
    Object.assign(window, { peers, granted, announce });
  }, version);
  return other;
}

/** 真似たページが代表のロックを取るまで待つ */
export async function leading(other: Page): Promise<void> {
  await other.evaluate(() => (window as unknown as { granted: Promise<void> }).granted);
}
