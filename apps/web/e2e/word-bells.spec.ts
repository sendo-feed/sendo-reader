import { expect, type Page, type Route, test } from "@playwright/test";
import { FakeSendo, routeFakeSendo, signIn } from "./fake-sendo";

/*
 * 言葉のベル（sendo-reader の Issue #331、sendo の docs/decisions/notifications.md の 1〜7）。
 * Search の言葉だけのベル、manage feed の購読 AND 言葉のベル、Settings の一覧。
 */

function seed() {
  const server = new FakeSendo();
  const news = server.subscribe({ url: "https://news.example/rss", title: "Hacker News" });
  server.deliver(news.id, { title: "Azure の東日本リージョンで障害" });
  return { server, news };
}

/** sendo の有効なベルの組 */
function serverTargets(server: FakeSendo) {
  return server.activeBells().map((bell) => ({ feedId: bell.feedId, words: bell.words }));
}

async function syncNow(page: Page) {
  const sync = page.getByRole("button", { name: "Sync now" });
  await sync.click();
  await expect(sync).toBeEnabled();
}

test.describe("Search のベル", () => {
  function searchBox(page: Page) {
    return page.getByRole("searchbox", { name: "Search articles" });
  }

  function searchBell(page: Page, words: string) {
    return page.getByRole("button", { name: `Bell: ${words}`, exact: true });
  }

  test("言葉を入れてベルを押すと、その言葉だけのベルがすぐでき、同期で sendo に届く。同じ言葉でもう一度押すと外れる", async ({
    page,
    context,
  }) => {
    const { server } = seed();
    await routeFakeSendo(context, server);
    await page.goto("/search");
    await signIn(page);
    await searchBox(page).fill("Azure 障害");
    const bell = searchBell(page, "Azure 障害");
    await expect(bell).toHaveAttribute("aria-pressed", "false");
    const note = page.getByText("「Azure 障害」を含む新しい記事を、どのフィードでも知らせます。");
    await expect(note).toHaveCount(0);

    await bell.click();
    await expect(bell).toHaveAttribute("aria-pressed", "true");
    await expect(note).toBeVisible();
    await syncNow(page);
    expect(serverTargets(server)).toEqual([{ feedId: null, words: "Azure 障害" }]);

    // 並びや大文字と小文字が違っても同じベル。押すと外れ、2 つ目は作らない
    await searchBox(page).fill("障害 AZURE");
    const same = searchBell(page, "障害 AZURE");
    await expect(same).toHaveAttribute("aria-pressed", "true");
    await same.click();
    await expect(same).toHaveAttribute("aria-pressed", "false");
    await syncNow(page);
    expect(server.activeBells()).toEqual([]);
    expect(server.bellRequests).toHaveLength(1);
  });

  test("言葉が空ならベルを出さない", async ({ page, context }) => {
    const { server } = seed();
    await routeFakeSendo(context, server);
    await page.goto("/search");
    await signIn(page);
    await expect(searchBox(page)).toBeFocused();
    const bells = page.getByRole("button", { name: /^Bell:/ });
    await expect(bells).toHaveCount(0);
    await searchBox(page).fill("Azure");
    await expect(bells).toHaveCount(1);
    await searchBox(page).fill("　 ");
    await expect(bells).toHaveCount(0);
  });

  test("sendo の上限を超える言葉は送る前に知らせ、上限ちょうどは付けられる", async ({
    page,
    context,
  }) => {
    const { server } = seed();
    await routeFakeSendo(context, server);
    await page.goto("/search");
    await signIn(page);
    const eight = Array.from({ length: 8 }, (_, i) => `w${i}`).join(" ");
    const tooLong = "あ".repeat(65);
    const cases: [string, string][] = [
      [`${eight} w8`, "言葉は 8 個まで入れられます。"],
      [tooLong, "言葉は全体で 64 文字まで入れられます。"],
    ];
    for (const [words, message] of cases) {
      await searchBox(page).fill(words);
      const bell = searchBell(page, words);
      await bell.click();
      await expect(page.getByRole("alert")).toHaveText(message);
      await expect(bell).toHaveAttribute("aria-pressed", "false");
    }
    await syncNow(page);
    expect(server.bellRequests).toEqual([]);

    for (const words of [eight, "あ".repeat(64)]) {
      await searchBox(page).fill(words);
      const bell = searchBell(page, words);
      await bell.click();
      await expect(bell).toHaveAttribute("aria-pressed", "true");
      await expect(page.getByRole("alert")).toHaveCount(0);
    }
    await syncNow(page);
    expect(serverTargets(server)).toEqual([
      { feedId: null, words: eight },
      { feedId: null, words: "あ".repeat(64) },
    ]);
  });

  test("オフラインで押しても画面にはすぐ出て、オンラインに戻ると送られる", async ({
    page,
    context,
  }) => {
    const { server } = seed();
    await routeFakeSendo(context, server);
    await page.goto("/search");
    await signIn(page);
    await searchBox(page).fill("Azure 障害");
    const bell = searchBell(page, "Azure 障害");
    await expect(bell).toHaveAttribute("aria-pressed", "false");

    // setOffline はワーカーの通信を止めないので、sendo への通信も断つ
    const offline = (route: Route) => route.abort("internetdisconnected");
    await context.setOffline(true);
    await context.route("**/api/v1/**", offline);
    await bell.click();
    await expect(bell).toHaveAttribute("aria-pressed", "true");
    await expect(page.getByRole("button", { name: "Sync now" })).toHaveAttribute(
      "title",
      /Offline/,
    );
    await expect(bell).toHaveAttribute("aria-pressed", "true");
    expect(server.bellRequests).toEqual([]);

    await context.unroute("**/api/v1/**", offline);
    await context.setOffline(false);
    // 届かなかった同期は、間をおいてやり直す（最初は 5 秒あと）
    await expect
      .poll(() => serverTargets(server), { timeout: 15_000 })
      .toEqual([{ feedId: null, words: "Azure 障害" }]);
    await expect(bell).toHaveAttribute("aria-pressed", "true");
  });
});
