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

/**
 * 呼び出しの数は core が記事の変化を知らせた回数で決まるので、列をまるごとは比べない。
 * before より呼び出しが増えて、最後に書いたのが expected になるのを待つ
 */
async function expectBadgeWritten(page: Page, before: unknown[], expected: unknown) {
  await expect
    .poll(async () => {
      const calls = await badgeCalls(page);
      return calls.length > before.length ? calls.at(-1) : undefined;
    })
    .toBe(expected);
}

/** 書いたのが expected だけ（ほかの数を一度も書いていない）になるのを待つ */
async function expectOnlyBadge(page: Page, expected: unknown) {
  await expect
    .poll(async () => {
      const calls = await badgeCalls(page);
      return calls.length > 0 && calls.every((value) => value === expected);
    })
    .toBe(true);
}

function changeVisibility(page: Page, visibility: DocumentVisibilityState): Promise<void> {
  return page.evaluate((value) => {
    Object.defineProperty(document, "visibilityState", { configurable: true, get: () => value });
    document.dispatchEvent(new Event("visibilitychange"));
  }, visibility);
}

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

test("起動したとき、記事が変わったとき、同期で届いたときに未読の数を出し、0 件で消す", async ({
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
  await expectOnlyBadge(page, 12);

  let before = await badgeCalls(page);
  await markFirstRead(page);
  await expectBadgeWritten(page, before, 11);

  // 未読の数が変わらない記事の変化でも、数え直して同じ数を書く（書いた数を覚えない）
  before = await badgeCalls(page);
  const row = page.locator(".article-list .row.unread").first();
  await row.hover();
  await row.getByRole("button", { name: "Save", exact: true }).click();
  await expect(row.getByRole("button", { name: "Unsave", exact: true })).toBeVisible();
  await expectBadgeWritten(page, before, 11);

  before = await badgeCalls(page);
  for (let i = 0; i < 3; i++) server.deliver(feed.id, { title: `新着 ${i}` });
  await page.getByRole("button", { name: "Sync now" }).click();
  await expectBadgeWritten(page, before, 14);

  before = await badgeCalls(page);
  await page.keyboard.press("Shift+A");
  await page.getByRole("dialog").getByRole("button", { name: "Mark all as read" }).click();
  await expectBadgeWritten(page, before, "clear");
});

test("前に出たら、同じ数でも書き直す（裏にある間に push の app_badge が書いた数を残さない）", async ({
  page,
  context,
}) => {
  const { server } = seed(3);
  await routeFakeSendo(context, server);
  await stubBadge(context, "working");
  await page.goto("/");
  await signIn(page);
  await expect(page.locator(".article-list .row.unread")).toHaveCount(3);
  await expect.poll(() => lastBadge(page)).toBe(3);
  const before = await badgeCalls(page);

  await changeVisibility(page, "hidden");
  await changeVisibility(page, "visible");
  await expectBadgeWritten(page, before, 3);
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
  await expectOnlyBadge(second, 5);

  let beforeFirst = await badgeCalls(page);
  let beforeSecond = await badgeCalls(second);
  await markFirstRead(second);
  await expectBadgeWritten(second, beforeSecond, 4);
  await expectBadgeWritten(page, beforeFirst, 4);

  beforeFirst = await badgeCalls(page);
  beforeSecond = await badgeCalls(second);
  await second.locator("nav.sidebar").getByRole("button", { name: "Sign out" }).click();
  await expect(second.getByRole("button", { name: "Google でログイン" })).toBeVisible();
  await expectBadgeWritten(second, beforeSecond, "clear");
  await expectBadgeWritten(page, beforeFirst, "clear");
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
  await expectOnlyBadge(page, 3);
});

for (const mode of ["missing", "failing"] as const) {
  test(`Badging API が${mode === "missing" ? "ない" : "失敗する"}ときも、画面にエラーを出さない`, async ({
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
