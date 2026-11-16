import type { BrowserContext, Page } from "@playwright/test";
import { FakeSendo, USER } from "../../../packages/core/test/fake-sendo";

export { FakeSendo, USER };

/**
 * 画面（とそのワーカー）から /api への通信を、偽の sendo に答えさせる。
 * 偽の sendo は packages/core のテストと同じもの（sendo の差分同期の決まりで動く）。
 * クッキーと Sec-Fetch-Site はブラウザが付けたものをそのまま渡すので、セッションのクッキーと
 * CSRF の対策も、本物のブラウザの動きで確かめられる。ログインの入口（ページの移動）にも答える。
 */
export async function routeFakeSendo(context: BrowserContext, server: FakeSendo): Promise<void> {
  await context.route("**/api/v1/**", async (route) => {
    const request = route.request();
    const body = request.postData();
    const init: RequestInit = { method: request.method(), headers: await request.allHeaders() };
    if (body !== null) init.body = body;
    try {
      const response = await server.fetch(new Request(request.url(), init));
      await route.fulfill({
        status: response.status,
        headers: Object.fromEntries(response.headers),
        // 画像の応答もあるので、文字にせず、バイトのまま渡す
        body: response.status === 204 ? "" : Buffer.from(await response.arrayBuffer()),
      });
    } catch {
      await route.abort("failed");
    }
  });
}

/** ログインの画面で「Google でログイン」を押す（偽の sendo は、Google の画面を通さずに戻す） */
export async function signIn(page: Page): Promise<void> {
  await page.getByRole("button", { name: "Google でログイン" }).click();
}
