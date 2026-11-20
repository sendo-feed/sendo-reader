import { devices, expect, test } from "@playwright/test";
import { FakeSendo, routeFakeSendo, signIn } from "./fake-sendo";

/** 表示の設定を sendo に預け、同じ種類の端末に引き継ぐ（docs/decisions/settings.md） */

function seed() {
  const server = new FakeSendo();
  const feed = server.subscribe({ url: "https://blog.example/feed.xml", title: "Blog" });
  server.deliver(feed.id, { title: "1 番目", publishedAt: Date.now() - 1000 });
  return { server, feed };
}

async function openSettings(page: import("@playwright/test").Page) {
  await page.locator("nav.sidebar").getByRole("link", { name: "Settings" }).click();
  await expect(page.getByRole("heading", { name: "Settings", level: 1 })).toBeVisible();
  // いま動いている版（コミットと、ビルドした時刻）を出す
  await expect(page.getByText(/^Version [0-9a-f]{7} \(.+\)$/)).toBeVisible();
}

test("変えた設定を sendo に預け、読み込み直しても残る。既定に戻したら、項目を消す", async ({
  page,
  context,
}) => {
  const { server } = seed();
  await routeFakeSendo(context, server);
  await page.goto("/");
  await signIn(page);
  await expect(page.locator(".article-list .item")).toHaveCount(1);

  await openSettings(page);
  await page.getByText("Dark", { exact: true }).click();
  await expect(page.locator("html")).toHaveAttribute("data-theme", "dark");
  // PC のブラウザーは desktop として預ける。既定のままの項目は、預けない
  await expect.poll(() => server.settingsOf("desktop")).toEqual({ "reader.theme": "dark" });
  expect(server.settingsOf("mobile")).toEqual({});

  await page.reload();
  await expect(page.locator("html")).toHaveAttribute("data-theme", "dark");
  await expect(page.getByLabel("Dark")).toBeChecked();

  await page.getByText("Auto", { exact: true }).click();
  await expect(page.locator("html")).not.toHaveAttribute("data-theme");
  await expect.poll(() => server.settingsOf("desktop")).toEqual({});
});

test("ほかの端末が変えた設定が、同期で届いて画面に当たる。別の種類の設定は、当てない", async ({
  page,
  context,
}) => {
  const { server } = seed();
  server.putSetting("mobile", "reader.theme", "dark");
  await routeFakeSendo(context, server);
  await page.goto("/");
  await signIn(page);
  await expect(page.locator(".article-list .item")).toHaveCount(1);
  await expect(page.locator("html")).not.toHaveAttribute("data-theme");

  server.putSetting("desktop", "reader.textSize", "large");
  server.putSetting("desktop", "reader.markReadOnScroll", false);
  await page.getByRole("button", { name: "Sync now" }).click();
  await expect(page.locator("html")).toHaveAttribute("data-text-size", "large");
  // 前の版が預けた、もう使わない項目（一覧の形）があっても、壊れない
  server.putSetting("desktop", "reader.layout", "compact");
  await expect(page.locator("html")).not.toHaveAttribute("data-theme");

  // 消した（既定に戻した）ことも届く
  server.removeSetting("desktop", "reader.textSize");
  await page.getByRole("button", { name: "Sync now" }).click();
  await expect(page.locator("html")).not.toHaveAttribute("data-text-size");
});

test("オフラインで変えた設定は、つながったあとに送る", async ({ page, context }) => {
  const { server } = seed();
  await routeFakeSendo(context, server);
  await page.goto("/");
  await signIn(page);
  await expect(page.locator(".article-list .item")).toHaveCount(1);

  // sendo に届かない
  server.onRequest = () => Promise.reject(new TypeError("offline"));
  await openSettings(page);
  await page.getByRole("slider", { name: "Text size" }).fill("3");
  await expect(page.locator("html")).toHaveAttribute("data-text-size", "large");
  await page.waitForTimeout(1000);
  expect(server.settingsOf("desktop")).toEqual({});

  server.onRequest = null;
  await page.getByRole("button", { name: "Sync now" }).click();
  await expect.poll(() => server.settingsOf("desktop")).toEqual({ "reader.textSize": "large" });
});

test("前の版が localStorage に置いた設定は、同期してから、sendo にない項目だけを送る", async ({
  page,
  context,
}) => {
  const { server, feed } = seed();
  // ほかの端末が、先にテーマを置いている
  server.putSetting("desktop", "reader.theme", "light");
  await routeFakeSendo(context, server);
  await page.goto("/");
  await page.evaluate((feedId) => {
    localStorage.setItem(
      "sendo.prefs",
      JSON.stringify({
        theme: "dark",
        textSize: "large",
        layout: "compact",
        views: { [`/feeds/${feedId}`]: { unreadOnly: false } },
        swipes: { listLeft: "read", listRight: "none", articleLeft: "none", articleRight: "back" },
      }),
    );
  }, feed.id);
  await signIn(page);
  await expect(page.locator(".article-list .item")).toHaveCount(1);

  // sendo にあったテーマは、届いたほうを採る。なかった項目だけを送る（既定と同じ値は送らない）
  await expect
    .poll(() => server.settingsOf("desktop"))
    .toEqual({
      "reader.theme": "light",
      "reader.textSize": "large",
      "reader.swipe.listRight": "none",
      [`reader.list:/feeds/${feed.id}`]: { unreadOnly: false },
    });
  await expect(page.locator("html")).toHaveAttribute("data-theme", "light");
  await expect(page.locator("html")).toHaveAttribute("data-text-size", "large");
  expect(await page.evaluate(() => localStorage.getItem("sendo.prefs"))).toBeNull();
});

test("購読をやめると、そのフィードの一覧の設定を消す", async ({ page, context }) => {
  const { server, feed } = seed();
  await routeFakeSendo(context, server);
  await page.goto("/");
  await signIn(page);
  await page.locator("nav.sidebar").getByRole("link", { name: /Blog/ }).click();
  await page.getByRole("button", { name: "Unread only" }).click();
  const name = `reader.list:/feeds/${feed.id}`;
  await expect.poll(() => Object.keys(server.settingsOf("desktop"))).toEqual([name]);

  await page.goto("/manage");
  await page.getByRole("button", { name: "Feed options: Blog", exact: true }).click();
  await page.getByRole("dialog").getByRole("button", { name: "Unsubscribe…", exact: true }).click();
  await page.getByRole("dialog").getByRole("button", { name: "Unsubscribe", exact: true }).click();
  await expect.poll(() => server.settingsOf("desktop")).toEqual({});
});

test.describe("スマホ", () => {
  const { defaultBrowserType: _, ...phone } = devices["Pixel 7"];
  test.use(phone);

  test("スマホは mobile として預ける", async ({ page, context }) => {
    const { server } = seed();
    server.putSetting("mobile", "reader.theme", "dark");
    server.putSetting("desktop", "reader.textSize", "large");
    await routeFakeSendo(context, server);
    await page.goto("/");
    await signIn(page);
    await expect(page.locator(".article-list .item")).toHaveCount(1);
    await expect(page.locator("html")).toHaveAttribute("data-theme", "dark");
    await expect(page.locator("html")).not.toHaveAttribute("data-text-size");

    await page.getByRole("button", { name: "Menu", exact: true }).click();
    await openSettings(page);
    await page.getByRole("slider", { name: "Text size" }).fill("1");
    await expect
      .poll(() => server.settingsOf("mobile"))
      .toEqual({ "reader.theme": "dark", "reader.textSize": "small" });
    expect(server.settingsOf("desktop")).toEqual({ "reader.textSize": "large" });
  });
});

test("前の版が預けた並び順（古い順）は読まずに無視し、新しい順に並べる。預けた値は消さない", async ({
  page,
  context,
}) => {
  const { server, feed } = seed();
  server.deliver(feed.id, { title: "2 番目", publishedAt: Date.now() - 2000 });
  server.putSetting("desktop", "reader.oldestFirst", true);
  server.putSetting("desktop", `reader.list:/feeds/${feed.id}`, { oldestFirst: true });
  await routeFakeSendo(context, server);
  await page.goto("/");
  await signIn(page);
  const list = page.locator(".article-list");
  await expect(list.locator(".title")).toHaveText(["1 番目", "2 番目"]);
  await expect(list.getByRole("button", { name: "Oldest first" })).toHaveCount(0);
  await page.locator("nav.sidebar").getByRole("link", { name: /Blog/ }).click();
  await expect(list.locator(".title")).toHaveText(["1 番目", "2 番目"]);
  // 未読だけの切り替えは、これまでどおり一覧ごとに預ける（その一覧の項目は置き直される）
  await list.getByRole("button", { name: "Unread only" }).click();
  await expect
    .poll(() => server.settingsOf("desktop"))
    .toEqual({
      "reader.oldestFirst": true,
      [`reader.list:/feeds/${feed.id}`]: { unreadOnly: false },
    });
});
