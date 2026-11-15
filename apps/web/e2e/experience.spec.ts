import { expect, test } from "@playwright/test";
import { FakeSendo, routeFakeSendo, signIn } from "./fake-sendo";

/** 読む画面の使い心地（キーボード、一覧の形、表示の設定、狭い画面） */

function seed() {
  const server = new FakeSendo();
  const folder = server.createFolder("Tech");
  const blog = server.subscribe({
    url: "https://blog.example/feed.xml",
    title: "Blog",
    folderId: folder.id,
  });
  const news = server.subscribe({ url: "https://news.example/feed.xml", title: "News" });
  const t = server.now;
  server.deliver(blog.id, { title: "1 番目", summary: "1 番目の要約", publishedAt: t - 1000 });
  server.deliver(news.id, { title: "2 番目", publishedAt: t - 2000 });
  server.deliver(blog.id, { title: "3 番目", publishedAt: t - 3000 });
  return { server, folder, blog, news };
}

test("キーボードで、記事を移り、既読とスターを切り替え、まとめて既読にする", async ({
  page,
  context,
}) => {
  const { server } = seed();
  await routeFakeSendo(context, server);
  await page.goto("/");
  await signIn(page);
  const list = page.locator(".article-list");
  const view = page.locator(".article-view");
  const unread = page.locator("nav a", { hasText: "未読" });
  await expect(list.locator(".item")).toHaveCount(3);
  await expect(page).toHaveTitle("(3) 未読 - Sendo");

  // j で次の記事を開く（開くと既読になる）。k で前に戻る
  await page.keyboard.press("j");
  await expect(view.getByRole("heading", { level: 1 })).toHaveText("1 番目");
  await page.keyboard.press("j");
  await expect(view.getByRole("heading", { level: 1 })).toHaveText("2 番目");
  await expect(unread).toContainText("1");
  await page.keyboard.press("k");
  await expect(view.getByRole("heading", { level: 1 })).toHaveText("1 番目");
  // 左上に、未読の数と今日の進み具合（2 件読んで 1 件残っている）を出す
  await expect(
    page.getByRole("img", { name: "未読 1 件。今日は 2 件読みました（67%）" }),
  ).toBeVisible();

  // s でスター、m で未読に戻す
  await page.keyboard.press("s");
  await expect(view.getByRole("button", { name: "スターを外す" })).toBeVisible();
  await page.keyboard.press("m");
  await expect(view.getByRole("button", { name: "既読にする" })).toBeVisible();
  await expect(unread).toContainText("2");

  // Esc で閉じる。記事から記事へ移っても履歴は増やさないので、一覧に戻る
  await page.keyboard.press("Escape");
  await expect(page).not.toHaveURL(/article=/);
  await expect(view.getByText("記事を選んでください。")).toBeVisible();

  // n で開かずに選び、行の操作でスターを付ける。文字を打っているときは効かない
  await page.keyboard.press("n");
  await expect(list.locator(".row.current")).toContainText("2 番目");
  await expect(page).not.toHaveURL(/article=/);
  await page.keyboard.press("s");
  await expect(
    list.locator(".row.current").getByRole("button", { name: "スターを外す" }),
  ).toBeVisible();

  // Shift + A は、確かめてからまとめて既読にする
  await page.keyboard.press("Shift+A");
  await expect(page.getByRole("dialog")).toContainText("未読 2 件");
  await page.keyboard.press("Enter");
  await expect(unread).not.toContainText("2");
  await expect(page).toHaveTitle("未読 - Sendo");

  // ? で操作の一覧、g a で「すべて」に移る
  await page.keyboard.press("?");
  await expect(page.getByRole("dialog")).toContainText("キーボードの操作");
  await page.keyboard.press("Escape");
  await page.keyboard.press("g");
  await page.keyboard.press("a");
  await expect(page).toHaveURL(/\/all$/);

  await page.getByRole("button", { name: "今すぐ同期" }).click();
  await expect
    .poll(() => [...server.inbox.values()].filter((a) => a.readAt !== null).length)
    .toBe(3);
  await expect
    .poll(() => [...server.inbox.values()].filter((a) => a.starredAt !== null).length)
    .toBe(2);
});

test("一覧の形・並び順・絞り込みと、表示の設定は、開き直しても残る", async ({ page, context }) => {
  const { server, blog } = seed();
  await routeFakeSendo(context, server);
  await page.goto("/");
  await signIn(page);
  const list = page.locator(".article-list");
  await expect(list.locator(".title")).toHaveText(["1 番目", "2 番目", "3 番目"]);
  await expect(list.getByText("1 番目の要約")).toBeVisible();

  // タイトルだけにし、古い順に並べる
  await list.getByRole("button", { name: "要約も出す" }).click();
  await expect(list.getByText("1 番目の要約")).toHaveCount(0);
  await list.getByRole("button", { name: "古い順に並べる" }).click();
  await expect(list.locator(".title")).toHaveText(["3 番目", "2 番目", "1 番目"]);

  // フィードの一覧は既読の記事も出す。未読だけに絞れる
  await list.getByText("3 番目").click();
  await page.locator("nav").getByRole("link", { name: "Blog" }).click();
  await expect(list.locator(".title")).toHaveText(["3 番目", "1 番目"]);
  await list.getByRole("button", { name: "未読だけを出す" }).click();
  await expect(list.locator(".title")).toHaveText(["1 番目"]);

  // フォルダを畳み、未読のないフィードを隠す
  const nav = page.locator("nav");
  await nav.getByRole("button", { name: "Tech を畳む" }).click();
  await expect(nav.getByRole("link", { name: "Blog" })).toHaveCount(0);
  await nav.getByRole("button", { name: "Tech を開く" }).click();
  await expect(nav.getByRole("link", { name: "Blog" })).toBeVisible();

  // テーマと文字の大きさ
  await nav.getByRole("link", { name: "設定" }).click();
  await page.getByText("ダーク", { exact: true }).click();
  await page.getByText("大", { exact: true }).click();
  await expect(page.locator("html")).toHaveAttribute("data-theme", "dark");

  await page.reload();
  await expect(page.locator("html")).toHaveAttribute("data-theme", "dark");
  await expect(page.locator("html")).toHaveAttribute("data-text-size", "large");
  await page.goto(`/feeds/${blog.id}`);
  await expect(list.locator(".title")).toHaveText(["1 番目"]);
  await expect(list.getByRole("button", { name: "古い順に並べる" })).toHaveAttribute(
    "aria-pressed",
    "true",
  );
});

test("狭い画面では、メニューを左から開き、一覧と記事を行き来する", async ({ page, context }) => {
  const { server } = seed();
  await routeFakeSendo(context, server);
  await page.setViewportSize({ width: 390, height: 780 });
  await page.goto("/");
  await signIn(page);
  const list = page.locator(".article-list");
  const nav = page.locator("nav");
  await expect(list.locator(".item")).toHaveCount(3);
  await expect(nav).toBeHidden();

  await page.getByRole("button", { name: "メニュー", exact: true }).click();
  await expect(nav).toBeVisible();
  await nav.getByRole("link", { name: "すべて" }).click();
  await expect(nav).toBeHidden();
  await expect(page).toHaveURL(/\/all$/);

  // 行を左へはじくとスター、右へはじくと既読（縦に動かしたときは、何もしない）
  const flick = (title: string, dx: number, dy: number) =>
    list.locator(".row", { hasText: title }).evaluate(
      (row, { dx, dy }) => {
        const box = row.getBoundingClientRect();
        const at = (x: number, y: number) =>
          new Touch({ identifier: 1, target: row, clientX: x, clientY: y });
        const x = box.left + box.width / 2;
        const y = box.top + box.height / 2;
        const fire = (type: string, touches: Touch[], changed: Touch[]) =>
          row.dispatchEvent(
            new TouchEvent(type, { bubbles: true, touches, changedTouches: changed }),
          );
        fire("touchstart", [at(x, y)], [at(x, y)]);
        for (const step of [0.3, 0.6, 1]) {
          const touch = at(x + dx * step, y + dy * step);
          fire("touchmove", [touch], [touch]);
        }
        fire("touchend", [], [at(x + dx, y + dy)]);
      },
      { dx, dy },
    );
  const row = list.locator(".row", { hasText: "1 番目" });
  await flick("1 番目", -20, -120);
  await expect(row).toHaveClass(/unread/);
  await flick("1 番目", -120, 5);
  await expect(row.getByRole("button", { name: "スターを外す" })).toBeAttached();
  await expect(row).toHaveClass(/unread/);
  await flick("1 番目", 120, 5);
  await expect(row).not.toHaveClass(/unread/);
  await expect(page).not.toHaveURL(/article=/);

  // 記事を開くと記事だけになり、「戻る」で一覧に戻る
  await list.getByText("2 番目").click();
  await expect(page.getByRole("heading", { level: 1 })).toHaveText("2 番目");
  await expect(list).toBeHidden();
  await page.getByRole("button", { name: "次の記事" }).click();
  await expect(page.getByRole("heading", { level: 1 })).toHaveText("3 番目");
  await page.goBack();
  await expect(list).toBeVisible();
  await expect(page).toHaveURL(/\/all$/);
});
