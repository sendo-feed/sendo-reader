import type { BrowserContext, Page } from "@playwright/test";
import { FakeSendo, TOKEN } from "../../../packages/core/test/fake-sendo";

export { FakeSendo, TOKEN };

/**
 * 画面（とそのワーカー）から /api への通信を、偽の sendo に答えさせる。
 * 偽の sendo は packages/core のテストと同じもの（sendo の差分同期の決まりで動く）。
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
        body: response.status === 204 ? "" : await response.text(),
      });
    } catch {
      await route.abort("failed");
    }
  });
}

export async function signIn(page: Page, token = TOKEN): Promise<void> {
  await page.getByLabel("アクセストークン").fill(token);
  await page.getByRole("button", { name: "ログイン" }).click();
}
