import { expect, test } from "@playwright/test";
import { FakeSendo, routeFakeSendo, signIn } from "./fake-sendo";

function seed() {
  const server = new FakeSendo();
  const folder = server.createFolder("Tech");
  const blog = server.subscribe({
    url: "https://blog.example/feed.xml",
    title: "Blog",
    folderId: folder.id,
  });
  const news = server.subscribe({ url: "https://news.example/feed.xml", title: "News" });
  server.deliver(blog.id, { title: "Blog の記事" });
  server.deliver(news.id, { title: "News の記事" });
  return { server, folder, blog, news };
}

test("PC のサイドバーをアイコンに畳み、オフラインでも操作・保存して元に戻せる", async ({
  page,
  context,
}) => {
  const { server, blog, folder } = seed();
  await routeFakeSendo(context, server);
  await page.goto("/");
  await signIn(page);
  const nav = page.getByRole("navigation", { name: "Feeds", exact: true });
  await expect(page.locator(".article-list .item")).toHaveCount(2);
  const fullWidth = (await nav.boundingBox())?.width ?? 0;
  await page.screenshot({ path: test.info().outputPath("sidebar-expanded.png") });
  await context.setOffline(true);
  const toggle = nav.getByRole("button", { name: "Collapse sidebar" });
  await toggle.focus();
  await page.keyboard.press("Enter");
  await expect(nav.getByRole("button", { name: "Expand sidebar" })).toBeFocused();
  await expect(nav.getByRole("button", { name: "Expand sidebar" })).toHaveAttribute(
    "aria-expanded",
    "false",
  );
  await expect.poll(async () => (await nav.boundingBox())?.width ?? fullWidth).toBeLessThan(80);
  expect(fullWidth).toBeGreaterThan(200);
  await page.screenshot({ path: test.info().outputPath("sidebar-compact.png") });

  // 名前は読み上げとツールチップに残り、フォルダ・フィードもアイコンで開ける
  await nav.getByRole("link", { name: /Tech/ }).click();
  await expect(page).toHaveURL(new RegExp(`/folders/${folder.id}`));
  const feed = nav.getByRole("link", { name: /Blog/ });
  await expect(feed).toHaveAttribute("title", /Blog/);
  await feed.click();
  await expect(page).toHaveURL(new RegExp(`/feeds/${blog.id}`));
  await expect(feed).toHaveAttribute("aria-current", "page");
  await nav.getByRole("link", { name: "Settings" }).click();
  await expect(page.getByRole("heading", { name: "Settings", level: 1 })).toBeVisible();
  await expect.poll(async () => (await nav.boundingBox())?.width ?? fullWidth).toBeLessThan(80);

  await page.reload();
  await expect(nav.getByRole("button", { name: "Expand sidebar" })).toBeVisible();
  await context.setOffline(false);
  await nav.getByRole("button", { name: "Sync now" }).click();
  await expect
    .poll(() => server.settingsOf("desktop"))
    .toEqual({ "reader.sidebarCollapsed": true });
  await nav.getByRole("button", { name: "Expand sidebar" }).click();
  await expect.poll(async () => (await nav.boundingBox())?.width).toBe(fullWidth);
  await expect.poll(() => server.settingsOf("desktop")).toEqual({});
});

test("PC の設定と購読管理はサイドバーの横幅とウィンドウの変化に追従する", async ({
  page,
  context,
}) => {
  const { server } = seed();
  await routeFakeSendo(context, server);
  await page.setViewportSize({ width: 1280, height: 720 });
  await page.goto("/settings");
  await signIn(page);

  const nav = page.getByRole("navigation", { name: "Feeds", exact: true });
  const main = page.getByRole("main");
  for (const name of ["Settings", "Manage feeds"]) {
    await nav.getByRole("link", { name, exact: true }).click();
    await expect(main.getByRole("heading", { name, level: 1 })).toBeVisible();

    for (const toggle of ["Collapse sidebar", "Expand sidebar"]) {
      for (const width of [1280, 1600]) {
        await page.setViewportSize({ width, height: 720 });
        const navRight = await nav.evaluate((element) => element.getBoundingClientRect().right);
        const { left, right } = await main.evaluate((element) => {
          const rect = element.getBoundingClientRect();
          return { left: rect.left, right: rect.right };
        });
        expect.soft(left).toBeCloseTo(navRight);
        expect.soft(right, `${name} (${width}px, ${toggle})`).toBeCloseTo(width);
      }
      await nav.getByRole("button", { name: toggle, exact: true }).click();
    }
  }
});

test("同期した折りたたみ状態は PC に当たり、狭い画面では通常のメニューを使う", async ({
  page,
  context,
}) => {
  const { server } = seed();
  server.putSetting("desktop", "reader.sidebarCollapsed", true);
  await routeFakeSendo(context, server);
  await page.goto("/");
  await signIn(page);
  const nav = page.getByRole("navigation", { name: "Feeds", exact: true });
  await expect(nav.getByRole("button", { name: "Expand sidebar" })).toBeVisible();
  await expect.poll(async () => (await nav.boundingBox())?.width ?? 1000).toBeLessThan(80);
  await page.setViewportSize({ width: 390, height: 844 });
  await page.getByRole("button", { name: "Menu", exact: true }).click();
  await expect(nav).toBeVisible();
  await expect(nav.getByRole("button", { name: "Expand sidebar" })).toBeHidden();
  await expect(nav.locator(".logo")).toBeVisible();
  await page.screenshot({ path: test.info().outputPath("sidebar-mobile.png") });
  await expect(nav.locator(".name", { hasText: "Blog" })).toHaveCSS("position", "static");
  await expect.poll(async () => (await nav.boundingBox())?.width ?? 0).toBeGreaterThan(200);
  await nav.getByRole("link", { name: /Blog/ }).click();
  await expect(page.locator(".reader")).not.toHaveClass(/menu-open/);
  await page.setViewportSize({ width: 1280, height: 720 });
  await expect(nav.getByRole("button", { name: "Expand sidebar" })).toBeVisible();
  await expect.poll(async () => (await nav.boundingBox())?.width ?? 1000).toBeLessThan(80);

  server.removeSetting("desktop", "reader.sidebarCollapsed");
  await nav.getByRole("button", { name: "Sync now" }).click();
  await expect(nav.getByRole("button", { name: "Collapse sidebar" })).toBeVisible();
});
