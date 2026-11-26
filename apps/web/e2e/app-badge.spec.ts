import { type BrowserContext, expect, type Page, test } from "@playwright/test";
import { FakeSendo, routeFakeSendo, signIn } from "./fake-sendo";

/**
 * インストールしたアプリのアイコンのバッジに、手元のすべての未読の数を出す（Badging API）。
 * 画面から呼ぶので、ページの navigator.setAppBadge ／ clearAppBadge を差し替えて、呼ばれた順に覚える。
 * missing はない（使えないブラウザー）、failing は呼ぶと失敗する（iOS で通知を許可していない）
 */
async function stubBadge(context: BrowserContext, mode: "working" | "missing" | "failing") {
  await context.addInitScript((mode) => {
    const calls: unknown[] = [];
    Object.assign(window, { badgeCalls: calls });
    const prototype = Navigator.prototype as Partial<Navigator>;
    if (mode === "missing") {
      delete prototype.setAppBadge;
      delete prototype.clearAppBadge;
      return;
    }
    const call = (value: unknown) => {
      calls.push(value);
      return mode === "failing"
        ? Promise.reject(new DOMException("通知を許可していない", "NotAllowedError"))
        : Promise.resolve();
    };
    Object.defineProperty(prototype, "setAppBadge", {
      configurable: true,
      value: (contents: number) => call(contents),
    });
    Object.defineProperty(prototype, "clearAppBadge", {
      configurable: true,
      value: () => call("clear"),
    });
  }, mode);
}

const badgeCalls = (page: Page) =>
  page.evaluate(() => (window as unknown as { badgeCalls: unknown[] }).badgeCalls);
const lastBadge = async (page: Page) => (await badgeCalls(page)).at(-1);

function seed(unread: number) {
  const server = new FakeSendo();
  // 一覧を動かしただけでは既読にしない（数が変わる時を、操作で決める）
  for (const device of ["desktop", "mobile"]) {
    server.putSetting(device, "reader.markReadOnScroll", false);
  }
  const feed = server.subscribe({ url: "https://blog.example/feed.xml", title: "Blog" });
  for (let i = 0; i < unread; i++) {
    server.deliver(feed.id, { title: `記事 ${i}`, publishedAt: Date.now() - i * 60_000 });
  }
  return { server, feed };
}

async function markFirstRead(page: Page) {
  const row = page.locator(".article-list .row.unread").first();
  await row.hover();
  await row.getByRole("button", { name: "Mark as read", exact: true }).click();
}

test("起動したとき、既読にしたとき、同期で届いたときに未読の数を出し、0 件で消す", async ({
  page,
  context,
}) => {
  const { server, feed } = seed(12);
  await routeFakeSendo(context, server);
  await stubBadge(context, "working");
  await page.goto("/");
  await signIn(page);
  const unread = page.locator(".article-list .row.unread");
  await expect(unread).toHaveCount(12);

  // 手元に未読が 12 件ある状態で起動する
  await page.reload();
  await expect(unread).toHaveCount(12);
  await expect.poll(() => badgeCalls(page)).toEqual([12]);

  await markFirstRead(page);
  await expect.poll(() => badgeCalls(page)).toEqual([12, 11]);

  for (let i = 0; i < 3; i++) server.deliver(feed.id, { title: `新着 ${i}` });
  await page.getByRole("button", { name: "Sync now" }).click();
  await expect.poll(() => badgeCalls(page)).toEqual([12, 11, 14]);

  await page.keyboard.press("Shift+A");
  await page.getByRole("dialog").getByRole("button", { name: "Mark all as read" }).click();
  await expect.poll(() => badgeCalls(page)).toEqual([12, 11, 14, "clear"]);
});

test("タブが 2 つでも同じ数を出し、代表でないタブの操作でも書き換える。ログアウトで消す", async ({
  page,
  context,
}) => {
  const { server } = seed(5);
  await routeFakeSendo(context, server);
  await stubBadge(context, "working");
  await page.goto("/");
  await signIn(page);
  await expect(page.locator(".article-list .row.unread")).toHaveCount(5);
  await expect.poll(() => lastBadge(page)).toBe(5);

  // 先に開いたタブが代表で、あとから開いたタブは代表に頼む
  const second = await context.newPage();
  await second.goto("/");
  await expect(second.locator(".article-list .row.unread")).toHaveCount(5);
  await expect.poll(() => badgeCalls(second)).toEqual([5]);

  await markFirstRead(second);
  await expect.poll(() => lastBadge(second)).toBe(4);
  await expect.poll(() => lastBadge(page)).toBe(4);

  await second.locator("nav.sidebar").getByRole("button", { name: "Sign out" }).click();
  await expect(second.getByRole("button", { name: "Google でログイン" })).toBeVisible();
  await expect.poll(() => lastBadge(second)).toBe("clear");
  await expect.poll(() => lastBadge(page)).toBe("clear");
});

test("ワークスペースで絞っていても、すべての未読の数を出す", async ({ page, context }) => {
  const server = new FakeSendo();
  server.workspacesSupported = true;
  const publicSpace = server.createWorkspace("Public");
  const privateSpace = server.createWorkspace("Personal");
  const ordinary = server.subscribe({
    url: "https://public.example/feed",
    title: "Public feed",
    workspaceId: publicSpace.id,
  });
  const personal = server.subscribe({
    url: "https://private.example/feed",
    title: "Hidden feed",
    workspaceId: privateSpace.id,
  });
  server.deliver(ordinary.id, { title: "Public article" });
  for (let i = 0; i < 2; i++) server.deliver(personal.id, { title: `Hidden article ${i}` });
  await routeFakeSendo(context, server);
  await stubBadge(context, "working");
  await page.goto("/");
  await signIn(page);
  await expect.poll(() => lastBadge(page)).toBe(3);

  const nav = page.getByRole("navigation", { name: "Feeds", exact: true });
  const dialog = page.getByRole("dialog", { name: "Workspaces", exact: true });
  await nav.getByRole("button", { name: /^Workspaces:/ }).click();
  await dialog.getByRole("button", { name: "Only Public", exact: true }).click();
  await dialog.getByRole("button", { name: "Close", exact: true }).click();
  await expect(page).toHaveTitle("(1) All - Sendo");
  await page.reload();
  await expect(page).toHaveTitle("(1) All - Sendo");
  await expect.poll(() => badgeCalls(page)).toEqual([3]);
});

for (const mode of ["missing", "failing"] as const) {
  test(`Badging API が${mode === "missing" ? "ない" : "失敗する"}ときは、何も起きず、画面にエラーを出さない`, async ({
    page,
    context,
  }) => {
    const errors: string[] = [];
    page.on("pageerror", (error) => errors.push(error.message));
    const { server } = seed(2);
    await routeFakeSendo(context, server);
    await stubBadge(context, mode);
    await page.goto("/");
    await signIn(page);
    const unread = page.locator(".article-list .row.unread");
    await expect(unread).toHaveCount(2);
    expect(await page.evaluate(() => "setAppBadge" in navigator)).toBe(mode === "failing");

    await markFirstRead(page);
    await expect(unread).toHaveCount(1);
    if (mode === "failing") await expect.poll(() => lastBadge(page)).toBe(1);
    await page.waitForTimeout(500);
    expect(errors).toEqual([]);
    await expect(page.getByRole("alert")).toHaveCount(0);
  });
}
