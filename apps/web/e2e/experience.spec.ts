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
  // 公開日時は、ブラウザーの時計で「いま」にする（「1 日より古い記事」に入らないように）
  const t = Date.now();
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
  const unread = page.locator("nav.sidebar a", { hasText: "未読" });
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
  // 左上に、未読の数と、この一覧の進み具合（2 件読んで 1 件残っている）を出す。押すと内訳が出る
  await page.getByRole("button", { name: "未読 1 件。この一覧の進み具合 67%" }).click();
  await expect(page.getByRole("dialog")).toContainText("「未読」で読んだ記事 2 件");
  await expect(page.getByRole("dialog")).toContainText("「未読」に残っている未読 1 件");
  await page.keyboard.press("Escape");

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

  // Shift + A は、範囲を選んでからまとめて既読にする。少しの間、取り消せる
  await page.keyboard.press("Shift+A");
  await expect(page.getByRole("dialog")).toContainText("未読 2 件");
  await page.keyboard.press("Enter");
  await expect(page).toHaveTitle("未読 - Sendo");
  await page.getByRole("status").getByRole("button", { name: "取り消す" }).click();
  await expect(page.getByRole("status")).toContainText("2 件を未読に戻しました。");
  await expect(page).toHaveTitle("(2) 未読 - Sendo");
  await page.keyboard.press("Shift+A");
  await page.getByRole("button", { name: "1 日より古い記事だけ" }).click();
  await expect(page.getByRole("status")).toContainText("既読にする記事はありませんでした。");
  await expect(page).toHaveTitle("(2) 未読 - Sendo");
  await page.keyboard.press("Shift+A");
  await page.getByRole("dialog").getByRole("button", { name: "すべて既読にする" }).click();
  await expect(page.getByRole("status")).toContainText("2 件を既読にしました。");
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

test("一覧の形・並び順・絞り込みは一覧ごとに覚え、表示の設定とともに、開き直しても残る", async ({
  page,
  context,
}) => {
  const { server, blog } = seed();
  await routeFakeSendo(context, server);
  await page.goto("/");
  await signIn(page);
  const list = page.locator(".article-list");
  await expect(list.locator(".title")).toHaveText(["1 番目", "2 番目", "3 番目"]);
  // 一覧には、要約を出さない。行の高さは、どの行も同じ
  await expect(list.getByText("1 番目の要約")).toHaveCount(0);
  const rowHeights = () =>
    list
      .locator(".row")
      .evaluateAll((rows) => [
        ...new Set(rows.map((row) => Math.round(row.getBoundingClientRect().height))),
      ]);
  expect(await rowHeights()).toHaveLength(1);
  await expect(list.locator("ol")).not.toHaveClass(/compact/);

  // タイトルを 1 行だけにし、古い順に並べる
  await list.getByRole("button", { name: "画像も出す" }).click();
  await expect(list.locator("ol")).toHaveClass(/compact/);
  expect(await rowHeights()).toHaveLength(1);
  await list.getByRole("button", { name: "古い順に並べる" }).click();
  await expect(list.locator(".title")).toHaveText(["3 番目", "2 番目", "1 番目"]);

  // フィードの一覧は既読の記事も出す。未読だけに絞れる。表示の設定は一覧ごとに覚えるので、
  // 「未読」で変えた並び順と形は、ここには及ばない
  await list.getByText("3 番目").click();
  await page.locator("nav.sidebar").getByRole("link", { name: "Blog" }).click();
  await expect(list.locator(".title")).toHaveText(["1 番目", "3 番目"]);
  await expect(list.locator("ol")).not.toHaveClass(/compact/);
  await list.getByRole("button", { name: "未読だけを出す" }).click();
  await expect(list.locator(".title")).toHaveText(["1 番目"]);

  // フォルダを畳み、未読のないフィードを隠す
  const nav = page.locator("nav.sidebar");
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
  const oldest = list.getByRole("button", { name: "古い順に並べる" });
  await page.goto(`/feeds/${blog.id}`);
  await expect(list.locator(".title")).toHaveText(["1 番目"]);
  await expect(oldest).toHaveAttribute("aria-pressed", "false");
  await page.goto("/");
  await expect(list.locator(".title")).toHaveText(["2 番目", "1 番目"]);
  await expect(oldest).toHaveAttribute("aria-pressed", "true");
  await expect(list.locator("ol")).toHaveClass(/compact/);
});

test("狭い画面では、メニューを左から開き、一覧と記事を行き来する", async ({ page, context }) => {
  const { server } = seed();
  await routeFakeSendo(context, server);
  await page.setViewportSize({ width: 390, height: 780 });
  await page.goto("/");
  await signIn(page);
  const list = page.locator(".article-list");
  const nav = page.locator("nav.sidebar");
  await expect(list.locator(".item")).toHaveCount(3);
  await expect(nav).toBeHidden();
  await expect(page.getByRole("button", { name: "この一覧の進み具合 0%" })).toBeVisible();

  await page.getByRole("button", { name: "メニュー", exact: true }).click();
  await expect(nav).toBeVisible();
  await nav.getByRole("link", { name: "すべて" }).click();
  await expect(nav).toBeHidden();
  await expect(page).toHaveURL(/\/all$/);

  // 行を右へスワイプするとスター、左へスワイプすると既読・未読（縦に動かしたときは、何もしない）
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
  await flick("1 番目", 120, 5);
  await expect(row.getByRole("button", { name: "スターを外す" })).toBeAttached();
  await expect(row).toHaveClass(/unread/);
  await flick("1 番目", -120, 5);
  await expect(row).not.toHaveClass(/unread/);
  await expect(page).not.toHaveURL(/article=/);

  // 下のバーは、一覧の画面でだけ出す。スター、検索、追加、未読へ移れる
  const tabs = page.getByRole("navigation", { name: "主な画面" });
  await expect(tabs).toBeVisible();
  await tabs.getByRole("link", { name: "スター" }).click();
  await expect(page).toHaveURL(/\/starred$/);
  await expect(tabs.getByRole("link", { name: "スター" })).toHaveAttribute("aria-current", "page");
  await tabs.getByRole("link", { name: "検索" }).click();
  await expect(page).toHaveURL(/\/search$/);
  await tabs.getByRole("link", { name: "追加" }).click();
  await expect(page.getByRole("heading", { name: "購読の管理" })).toBeVisible();
  await expect(tabs).toBeVisible();
  await tabs.getByRole("link", { name: "未読" }).click();
  await expect(page).toHaveURL(/\/$/);
  await page.getByRole("button", { name: "メニュー", exact: true }).click();
  await nav.getByRole("link", { name: "すべて" }).click();

  // 記事を開くと記事だけになり、「戻る」で一覧に戻る
  await list.getByText("2 番目").click();
  await expect(page.getByRole("heading", { level: 1 })).toHaveText("2 番目");
  await expect(list).toBeHidden();
  // 記事の画面では、下のバーを出さない（同じ場所に、記事の操作が入る）
  await expect(tabs).toBeHidden();
  await expect(page.getByRole("button", { name: "一覧に戻る" })).toBeVisible();
  await page.getByRole("button", { name: "次の記事" }).click();
  await expect(page.getByRole("heading", { level: 1 })).toHaveText("3 番目");
  // 記事を右へスワイプすると、一覧に戻る。左には何も割り当てていない（縦に読み進める動きでも、
  // 何も起きない）。割り当ては、設定で変えられる
  const flickArticle = (dx: number, dy: number) =>
    page.locator(".article-view").evaluate(
      (view, { dx, dy }) => {
        const at = (x: number, y: number) =>
          new Touch({ identifier: 1, target: view, clientX: x, clientY: y });
        const fire = (type: string, touches: Touch[], changed: Touch[]) =>
          view.dispatchEvent(
            new TouchEvent(type, { bubbles: true, touches, changedTouches: changed }),
          );
        fire("touchstart", [at(200, 300)], [at(200, 300)]);
        fire("touchend", [], [at(200 + dx, 300 + dy)]);
      },
      { dx, dy },
    );
  await flickArticle(60, -200);
  await flickArticle(-140, 10);
  await page.waitForTimeout(200);
  await expect(page.getByRole("heading", { level: 1 })).toHaveText("3 番目");
  await flickArticle(140, 10);
  await expect(list).toBeVisible();
  await expect(page).toHaveURL(/\/all$/);
  await expect(tabs).toBeVisible();

  // 設定で、記事を左へスワイプしたら次の記事、一覧の行を左へスワイプしても何もしない、に変える
  // （既定では、一覧の行を左へスワイプすると既読・未読が替わる）
  await page.getByRole("button", { name: "メニュー", exact: true }).click();
  await nav.getByRole("link", { name: "設定" }).click();
  await page.getByLabel("記事を左へ").selectOption({ label: "次の記事" });
  await page.getByLabel("一覧の行を左へ").selectOption({ label: "何もしない" });
  await page.reload();
  await expect(page.getByLabel("記事を左へ")).toHaveValue("next");
  await tabs.getByRole("link", { name: "スター" }).click();
  await expect(list.locator(".title")).toHaveText(["1 番目"]);
  await flick("1 番目", -120, 5);
  await page.waitForTimeout(300);
  await expect(row).not.toHaveClass(/unread/);
  await expect(row.getByRole("button", { name: "スターを外す" })).toBeAttached();
  await page.getByRole("button", { name: "メニュー", exact: true }).click();
  await nav.getByRole("link", { name: "すべて" }).click();
  await list.getByText("2 番目").click();
  await expect(page.getByRole("heading", { level: 1 })).toHaveText("2 番目");
  await flickArticle(-140, 10);
  await expect(page.getByRole("heading", { level: 1 })).toHaveText("3 番目");
  await flickArticle(140, 10);
  await expect(list).toBeVisible();

  // 広い画面では、左のメニューを出したままにして、下のバーは出さない
  await page.setViewportSize({ width: 1100, height: 780 });
  await expect(tabs).toBeHidden();
  await expect(nav).toBeVisible();
});

test("j を続けて押して通り過ぎた記事も、既読になる", async ({ page, context }) => {
  const { server } = seed();
  await routeFakeSendo(context, server);
  await page.goto("/");
  await signIn(page);
  await expect(page.locator(".article-list .item")).toHaveCount(3);

  // 表示を待たずに、3 回続けて押す
  await page.keyboard.press("j");
  await page.keyboard.press("j");
  await page.keyboard.press("j");
  await expect(page.getByRole("heading", { level: 1 })).toHaveText("3 番目");
  await expect(page).toHaveTitle("未読 - Sendo");
  await expect(
    page.getByRole("button", { name: "未読 0 件。この一覧の進み具合 100%" }),
  ).toBeVisible();
});

test("末尾まで出した一覧に、それより古い記事が加わったら、続きとして出す", async ({
  page,
  context,
}) => {
  const { server } = seed();
  const [first, , third] = [...server.inbox.values()];
  if (first === undefined || third === undefined) throw new Error("unreachable");
  server.setArticleState(first.id, { starred: true });
  await routeFakeSendo(context, server);
  await page.goto("/");
  await signIn(page);
  await page.locator("nav.sidebar").getByRole("link", { name: "スター" }).click();
  const list = page.locator(".article-list");
  await expect(list.locator(".title")).toHaveText(["1 番目"]);
  await expect(list.getByText("ここまで")).toBeVisible();

  // ほかの端末で、出している記事より古い記事にスターを付けた
  server.setArticleState(third.id, { starred: true });
  await page.getByRole("button", { name: "今すぐ同期" }).click();
  await expect(list.locator(".title")).toHaveText(["1 番目", "3 番目"]);
});

test("古い順の一覧でも、出している記事より前に入る記事が加わったら、新しい記事として知らせる", async ({
  page,
  context,
}) => {
  const { server } = seed();
  const [first, , third] = [...server.inbox.values()];
  if (first === undefined || third === undefined) throw new Error("unreachable");
  server.setArticleState(first.id, { starred: true });
  await routeFakeSendo(context, server);
  await page.goto("/");
  await signIn(page);
  await page.locator("nav.sidebar").getByRole("link", { name: "スター" }).click();
  const list = page.locator(".article-list");
  await list.getByRole("button", { name: "古い順に並べる" }).click();
  await expect(list.locator(".title")).toHaveText(["1 番目"]);

  server.setArticleState(third.id, { starred: true });
  await page.getByRole("button", { name: "今すぐ同期" }).click();
  await list.getByRole("button", { name: "新しい記事 1 件を読む" }).click();
  await expect(list.locator(".title")).toHaveText(["3 番目", "1 番目"]);
});

test("一覧を動かして通り過ぎた記事は既読になる。設定で切れる", async ({ page, context }) => {
  const server = new FakeSendo();
  const feed = server.subscribe({ url: "https://blog.example/feed.xml", title: "Blog" });
  for (let i = 0; i < 40; i++) {
    server.deliver(feed.id, { title: `記事 ${i}`, publishedAt: server.now - i * 60_000 });
  }
  await routeFakeSendo(context, server);
  await page.setViewportSize({ width: 390, height: 780 });
  await page.goto("/");
  await signIn(page);
  const list = page.locator(".article-list");
  const unreadRows = list.locator(".row.unread");
  await expect(list.locator(".item")).toHaveCount(40);
  await expect(unreadRows).toHaveCount(40);
  const scrollBy = (top: number) => list.evaluate((el, top) => el.scrollBy({ top }), top);

  // 行がすっかり消えるのを待たない。上の端が見出しの下に少し隠れたら、その行は既読になる
  // 行の上に付く日付の見出しが隠れただけなら、まだ既読にしない
  const firstRowTop = await list.evaluate((el) => {
    const header = el.querySelector("header");
    const row = el.querySelector(".row");
    if (header === null || row === null) throw new Error("unreachable");
    return row.getBoundingClientRect().top - header.getBoundingClientRect().bottom;
  });
  expect(firstRowTop).toBeGreaterThan(10);
  await scrollBy(firstRowTop - 4);
  await page.waitForTimeout(600);
  await expect(unreadRows).toHaveCount(40);
  await scrollBy(28);
  await expect(unreadRows).toHaveCount(39);
  await expect(list.locator(".row").first()).not.toHaveClass(/unread/);
  await expect(list.locator(".row").first()).toBeInViewport();

  // 先頭の何件かが見出しの下を通り過ぎるまで動かす。通り過ぎた記事だけが既読になり、一覧には残る
  await scrollBy(400);
  await expect(unreadRows).not.toHaveCount(39);
  const afterScroll = await unreadRows.count();
  expect(afterScroll).toBeGreaterThan(30);
  await expect(list.locator(".row").first()).not.toHaveClass(/unread/);
  await expect(list.locator(".item")).toHaveCount(40);
  await expect(page.getByRole("button", { name: /この一覧の進み具合 [1-9]/ })).toContainText(
    String(afterScroll),
  );

  // 記事を開いて一覧が隠れても、開いた記事のほかは既読にしない
  await list.locator(".row.unread .item").first().click();
  await expect(page.getByRole("heading", { level: 1 })).toBeVisible();
  await page.goBack();
  await expect(unreadRows).toHaveCount(afterScroll - 1);

  // 切ると、動かしても既読にしない
  await page.getByRole("button", { name: "メニュー", exact: true }).click();
  await page.locator("nav.sidebar").getByRole("link", { name: "設定" }).click();
  await page.getByLabel("一覧を動かして通り過ぎた記事を、既読にする").uncheck();
  await page.goBack();
  await expect(list.locator(".item").first()).toBeVisible();
  const before = await unreadRows.count();
  await scrollBy(600);
  await page.waitForTimeout(600);
  await expect(unreadRows).toHaveCount(before);

  await page.getByRole("button", { name: "メニュー", exact: true }).click();
  await page.getByRole("button", { name: "今すぐ同期" }).click();
  await expect
    .poll(() => [...server.inbox.values()].filter((a) => a.readAt === null).length)
    .toBe(before);
});

test("一覧を動かしたあとに別の一覧へ替えたら、先頭に戻り、見ていない記事を既読にしない", async ({
  page,
  context,
}) => {
  const server = new FakeSendo();
  const first = server.subscribe({ url: "https://a.example/feed.xml", title: "Alpha" });
  const second = server.subscribe({ url: "https://b.example/feed.xml", title: "Beta" });
  for (let i = 0; i < 40; i++) {
    server.deliver(first.id, { title: `A ${i}`, publishedAt: server.now - i * 60_000 });
    server.deliver(second.id, { title: `B ${i}`, publishedAt: server.now - (i + 40) * 60_000 });
  }
  await routeFakeSendo(context, server);
  await page.setViewportSize({ width: 1200, height: 700 });
  await page.goto("/");
  await signIn(page);
  const list = page.locator(".article-list");
  const nav = page.locator("nav.sidebar");
  await expect(nav.getByRole("link", { name: "Beta" })).toContainText("40");
  await nav.getByRole("link", { name: "Alpha" }).click();
  await expect(list.locator(".item")).toHaveCount(40);

  await list.evaluate((el) => el.scrollBy({ top: 600 }));
  await expect(nav.getByRole("link", { name: "Alpha" })).not.toContainText("40");

  await nav.getByRole("link", { name: "Beta" }).click();
  await expect(list.locator(".title").first()).toHaveText("B 0");
  await expect.poll(() => list.evaluate((el) => el.scrollTop)).toBe(0);
  await page.waitForTimeout(600);
  await expect(nav.getByRole("link", { name: "Beta" })).toContainText("40");
  await expect(list.locator(".row.unread")).toHaveCount(40);
});

test("行を長く押す（右クリックする）と記事の操作が出て、上・下をまとめて既読にできる。一覧の終わりから次のフィードへ進める", async ({
  page,
  context,
}) => {
  const server = new FakeSendo();
  const alpha = server.subscribe({ url: "https://a.example/feed.xml", title: "Alpha" });
  const beta = server.subscribe({ url: "https://b.example/feed.xml", title: "Beta" });
  const t = Date.now();
  for (let i = 1; i <= 5; i++) {
    server.deliver(alpha.id, { title: `A ${i}`, publishedAt: t - i * 60_000 });
  }
  server.deliver(beta.id, { title: "B 1", publishedAt: t - 600_000 });
  await routeFakeSendo(context, server);
  await page.goto("/");
  await signIn(page);
  const list = page.locator(".article-list");
  const nav = page.locator("nav.sidebar");
  const row = (title: string) => list.locator(".row", { hasText: title });
  const unreadTitles = () => list.locator(".row.unread .title").allTextContents();
  await nav.getByRole("link", { name: "Alpha" }).click();
  await expect(list.locator(".item")).toHaveCount(5);

  // 右クリックで操作を出し、これより下をまとめて既読にする。取り消せる
  await row("A 3").click({ button: "right" });
  await expect(page.getByRole("dialog")).toContainText("A 3");
  await page.getByRole("button", { name: "これより下を既読にする" }).click();
  await expect(page.getByRole("status")).toContainText("2 件を既読にしました。");
  await expect.poll(unreadTitles).toEqual(["A 1", "A 2", "A 3"]);
  await page.getByRole("status").getByRole("button", { name: "取り消す" }).click();
  await expect.poll(unreadTitles).toEqual(["A 1", "A 2", "A 3", "A 4", "A 5"]);

  // これより上
  await row("A 3").click({ button: "right" });
  await page.getByRole("button", { name: "これより上を既読にする" }).click();
  await expect.poll(unreadTitles).toEqual(["A 3", "A 4", "A 5"]);

  // 指で長く押しても、同じ操作が出る。指を離しても、記事は開かない
  await row("A 4").evaluate(async (element) => {
    const box = element.getBoundingClientRect();
    const touch = new Touch({
      identifier: 1,
      target: element,
      clientX: box.left + 40,
      clientY: box.top + 20,
    });
    element.dispatchEvent(
      new TouchEvent("touchstart", { bubbles: true, touches: [touch], changedTouches: [touch] }),
    );
    await new Promise((resolve) => setTimeout(resolve, 700));
    element.dispatchEvent(
      new TouchEvent("touchend", { bubbles: true, touches: [], changedTouches: [touch] }),
    );
    element.querySelector<HTMLElement>(".item")?.click();
  });
  await expect(page.getByRole("dialog")).toContainText("A 4");
  await expect(page).not.toHaveURL(/article=/);
  await page.getByRole("dialog").getByRole("button", { name: "既読にする", exact: true }).click();
  await expect.poll(unreadTitles).toEqual(["A 3", "A 5"]);

  // 一覧の終わりから、残りを既読にして次のフィードへ進む
  await list.getByRole("button", { name: "既読にして、次のフィード「Beta」へ" }).click();
  await expect(page).toHaveURL(new RegExp(`/feeds/${beta.id}$`));
  await expect(list.locator(".title")).toHaveText(["B 1"]);
  await expect(nav.getByRole("link", { name: "Alpha" })).not.toContainText("2");
  await expect(list.getByRole("button", { name: "すべて既読にする" })).toBeVisible();

  // 未読だけを出していて記事がないフィードでも、次のフィードへ進める
  await nav.getByRole("link", { name: "Alpha" }).click();
  await list.getByRole("button", { name: "未読だけを出す" }).click();
  await expect(list.getByText("すべて読み終えました。")).toBeVisible();
  await list.getByRole("button", { name: "次のフィード「Beta」へ" }).click();
  await expect(page).toHaveURL(new RegExp(`/feeds/${beta.id}$`));
  await expect(list.locator(".title")).toHaveText(["B 1"]);

  // Shift + J で、次の未読のあるフィードへ
  await nav.getByRole("link", { name: "未読" }).click();
  await page.keyboard.press("Shift+J");
  await expect(page).toHaveURL(new RegExp(`/feeds/${beta.id}$`));
});

test("記事の画面から、リンクを共有し、文字の大きさを変えられる", async ({ page, context }) => {
  const { server } = seed();
  const [first] = [...server.inbox.values()];
  if (first === undefined) throw new Error("unreachable");
  first.url = "https://blog.example/first";
  await context.grantPermissions(["clipboard-read", "clipboard-write"]);
  await routeFakeSendo(context, server);
  await page.goto("/");
  await signIn(page);
  const view = page.locator(".article-view");
  await page.locator(".article-list .title", { hasText: "1 番目" }).click();
  await expect(view.getByRole("heading", { level: 1 })).toHaveText("1 番目");

  // 共有の窓がなければ、リンクをコピーする
  await view.getByRole("button", { name: "共有する" }).click();
  await expect(view.getByRole("status")).toHaveText("リンクをコピーしました。");
  expect(await page.evaluate(() => navigator.clipboard.readText())).toBe(
    "https://blog.example/first",
  );

  // 共有の窓があれば、タイトルと URL を渡す
  await page.evaluate(() => {
    const shared: ShareData[] = [];
    Object.assign(window, { shared });
    Object.defineProperty(navigator, "share", {
      configurable: true,
      value: (data: ShareData) => {
        shared.push(data);
        return Promise.resolve();
      },
    });
  });
  await view.getByRole("button", { name: "共有する" }).click();
  await expect
    .poll(() => page.evaluate(() => (window as unknown as { shared: ShareData[] }).shared))
    .toEqual([{ title: "1 番目", url: "https://blog.example/first" }]);

  // 記事を開いたまま、文字の大きさを変える
  await view.getByRole("button", { name: "文字の大きさとテーマ" }).click();
  await page.getByRole("dialog").getByText("大", { exact: true }).click();
  await expect(page.locator("html")).toHaveAttribute("data-text-size", "large");
  await expect(page.getByRole("dialog")).not.toContainText("記事の一覧");
  await page.keyboard.press("Escape");

  // 文字を大きくしても、記事の欄からボタンがはみ出さない（3 カラムの狭い欄でも、狭い画面の
  // 下のバーでも）
  for (const [width, first] of [
    [1024, "記事を閉じる"],
    [360, "一覧に戻る"],
  ] as const) {
    await page.setViewportSize({ width, height: 640 });
    const pane = await view.boundingBox();
    for (const name of [first, "文字の大きさとテーマ"]) {
      const box = await view.getByRole("button", { name }).boundingBox();
      expect(box?.x).toBeGreaterThanOrEqual(pane?.x ?? 0);
      expect((box?.x ?? 0) + (box?.width ?? 0)).toBeLessThanOrEqual(
        (pane?.x ?? 0) + (pane?.width ?? 0),
      );
    }
  }
});

test("手元の記事を探せる（オフラインでも）。探した結果は、通り過ぎても既読にしない", async ({
  page,
  context,
}) => {
  const server = new FakeSendo();
  const feed = server.subscribe({ url: "https://blog.example/feed.xml", title: "Blog" });
  const t = Date.now();
  server.deliver(feed.id, { title: "SQLite を OPFS で使う", publishedAt: t - 1000 });
  server.deliver(feed.id, {
    title: "同期の設計",
    summary: "カーソルと sqlite の話",
    publishedAt: t - 2000,
  });
  server.deliver(feed.id, { title: "週末のまとめ", author: "山田 太郎", publishedAt: t - 3000 });
  await routeFakeSendo(context, server);
  await page.goto("/");
  await signIn(page);
  const list = page.locator(".article-list");
  await expect(list.locator(".item")).toHaveCount(3);
  await context.setOffline(true);

  // / で検索の画面を開く。すぐ打てる
  await page.keyboard.press("/");
  await expect(page).toHaveURL(/\/search$/);
  const input = list.getByRole("searchbox", { name: "記事を探す" });
  await expect(input).toBeFocused();
  await expect(list.getByText("手元の記事を探します。")).toBeVisible();

  // 探す言葉が空の間は、記事を出していない。入力から抜けて j を押しても、見えていない記事を
  // 開かない（既読にもしない）
  await input.press("Enter");
  await page.keyboard.press("j");
  await page.waitForTimeout(300);
  await expect(page).not.toHaveURL(/article=/);
  await expect(page).toHaveTitle("(3) 検索 - Sendo");
  await input.focus();

  // タイトル・要約・著者から探す。空白で区切ると、すべての言葉が入っているものだけ
  await input.fill("sqlite");
  await expect(list.locator(".title")).toHaveText(["SQLite を OPFS で使う", "同期の設計"]);
  await expect(page).toHaveURL(/\/search\?q=sqlite$/);
  await input.fill("sqlite カーソル");
  await expect(list.locator(".title")).toHaveText(["同期の設計"]);
  await input.fill("山田");
  await expect(list.locator(".title")).toHaveText(["週末のまとめ"]);
  await input.fill("どこにもない言葉");
  await expect(list.getByText("見つかりませんでした。")).toBeVisible();

  // Enter で入力から抜けると、j で結果を開ける。開き直しても、探した言葉が残る
  await input.fill("sqlite");
  await expect(list.locator(".title")).toHaveCount(2);
  await input.press("Enter");
  await page.keyboard.press("j");
  await expect(page.getByRole("heading", { level: 1 })).toHaveText("SQLite を OPFS で使う");
  await page.reload();
  await expect(list.getByRole("searchbox", { name: "記事を探す" })).toHaveValue("sqlite");
  await expect(list.locator(".title")).toHaveText(["SQLite を OPFS で使う", "同期の設計"]);

  // 打ってすぐ別の画面へ移っても、検索の画面に引き戻さない
  await list
    .getByRole("searchbox", { name: "記事を探す" })
    .pressSequentially("opfs", { delay: 10 });
  await page.locator("nav.sidebar").getByRole("link", { name: "購読の管理" }).click();
  await page.waitForTimeout(500);
  await expect(page).toHaveURL(/\/manage$/);
  await page.locator("nav.sidebar").getByRole("link", { name: "検索" }).click();
  await list
    .getByRole("searchbox", { name: "記事を探す" })
    .pressSequentially("opfs", { delay: 10 });
  await page.locator("nav.sidebar").getByRole("link", { name: "スター" }).click();
  await page.waitForTimeout(500);
  await expect(page).toHaveURL(/\/starred$/);

  // 左のメニューからも開ける
  await page.locator("nav.sidebar").getByRole("link", { name: "未読" }).click();
  await page.locator("nav.sidebar").getByRole("link", { name: "検索" }).click();
  await expect(list.getByRole("searchbox", { name: "記事を探す" })).toHaveValue("");
});

test("見出しや下のバーを押すと一覧の先頭に戻る。先頭で下に引くと、読み直して同期する", async ({
  page,
  context,
}) => {
  const server = new FakeSendo();
  const feed = server.subscribe({ url: "https://blog.example/feed.xml", title: "Blog" });
  for (let i = 0; i < 40; i++) {
    server.deliver(feed.id, { title: `記事 ${i}`, publishedAt: Date.now() - (i + 1) * 60_000 });
  }
  await routeFakeSendo(context, server);
  await page.setViewportSize({ width: 390, height: 780 });
  await page.goto("/");
  await signIn(page);
  const list = page.locator(".article-list");
  await expect(list.locator(".item")).toHaveCount(40);
  const scrollTop = () => list.evaluate((el) => el.scrollTop);

  // 見出しを押すと、先頭に戻る
  await list.evaluate((el) => el.scrollTo({ top: 1500 }));
  await expect.poll(scrollTop).toBeGreaterThan(1000);
  await list.getByRole("button", { name: /^未読/ }).click();
  await expect.poll(scrollTop).toBe(0);

  // 下のバーで、いまいる画面をもう一度押しても、先頭に戻る（画面は移らない）
  await list.evaluate((el) => el.scrollTo({ top: 1500 }));
  await expect.poll(scrollTop).toBeGreaterThan(1000);
  await page
    .getByRole("navigation", { name: "主な画面" })
    .getByRole("link", { name: "未読" })
    .click();
  await expect.poll(scrollTop).toBe(0);
  await expect(page).toHaveURL(/\/$/);

  // 通り過ぎて既読になった記事は、一覧に残っている。その間に、新しい記事が sendo に届いた
  await expect(list.locator(".row:not(.unread)").first()).toBeAttached();
  const readCount = await list.locator(".row:not(.unread)").count();
  expect(readCount).toBeGreaterThan(0);
  server.deliver(feed.id, { title: "届いたばかり", publishedAt: Date.now() });

  const drag = (dy: number, end: "touchend" | "touchcancel" = "touchend") =>
    list.evaluate(
      (el, { dy, end }) => {
        const at = (y: number) =>
          new Touch({ identifier: 1, target: el, clientX: 200, clientY: y });
        const fire = (type: string, touches: Touch[], changed: Touch[]) =>
          el.dispatchEvent(
            new TouchEvent(type, { bubbles: true, touches, changedTouches: changed }),
          );
        fire("touchstart", [at(200)], [at(200)]);
        for (const step of [0.3, 0.6, 1])
          fire("touchmove", [at(200 + dy * step)], [at(200 + dy * step)]);
        fire(end, [], [at(200 + dy)]);
      },
      { dy, end },
    );

  // 少し引いただけ、引いている途中でタッチが取り消された、では何もしない
  await drag(60);
  await drag(200, "touchcancel");
  await page.waitForTimeout(300);
  await expect(list.locator(".item")).toHaveCount(40);
  await expect(list.locator(".pull")).toHaveCount(0);

  // 先頭で下に引いて離すと、既読の記事が消えて、届いた記事が先頭に入る
  await drag(200);
  await expect(list.locator(".title").first()).toHaveText("届いたばかり");
  await expect(list.locator(".item")).toHaveCount(41 - readCount);
  await expect(list.locator(".row:not(.unread)")).toHaveCount(0);
  await expect(list.locator(".pull")).toHaveCount(0);

  // 一覧の途中では、下に動かしても更新しない
  await list.evaluate((el) => el.scrollTo({ top: 300 }));
  const requests = server.requests.length;
  await drag(200);
  await page.waitForTimeout(500);
  expect(server.requests.length).toBe(requests);
});

test("引いて更新の同期を待っている間に読み進めたら、同期が終わっても先頭に戻さない", async ({
  page,
  context,
}) => {
  const server = new FakeSendo();
  const feed = server.subscribe({ url: "https://blog.example/feed.xml", title: "Blog" });
  for (let i = 0; i < 40; i++) {
    server.deliver(feed.id, { title: `記事 ${i}`, publishedAt: Date.now() - (i + 1) * 60_000 });
  }
  await routeFakeSendo(context, server);
  await page.setViewportSize({ width: 390, height: 780 });
  await page.goto("/");
  await signIn(page);
  const list = page.locator(".article-list");
  await expect(list.locator(".item")).toHaveCount(40);
  // 設定で、通り過ぎた記事を既読にしない（一覧の数を変えずに、位置だけを見る）
  server.putSetting("mobile", "reader.markReadOnScroll", false);
  server.putSetting("desktop", "reader.markReadOnScroll", false);
  await page.getByRole("button", { name: "メニュー", exact: true }).click();
  await page.getByRole("button", { name: "今すぐ同期" }).click();
  await page.keyboard.press("Escape");

  // 同期の応答を、こちらが通すまで止める
  let release = () => {};
  const held = new Promise<void>((resolve) => {
    release = resolve;
  });
  server.onRequest = (path) => (path === "GET /sync" ? held : Promise.resolve());
  server.deliver(feed.id, { title: "届いたばかり", publishedAt: Date.now() });

  await list.evaluate((el) => {
    const at = (y: number) => new Touch({ identifier: 1, target: el, clientX: 200, clientY: y });
    const fire = (type: string, touches: Touch[], changed: Touch[]) =>
      el.dispatchEvent(new TouchEvent(type, { bubbles: true, touches, changedTouches: changed }));
    fire("touchstart", [at(200)], [at(200)]);
    fire("touchmove", [at(300)], [at(300)]);
    fire("touchmove", [at(400)], [at(400)]);
    fire("touchend", [], [at(400)]);
  });
  await expect(list.locator(".pull")).toBeVisible();

  // 待っている間に、読み進める
  await list.evaluate((el) => el.scrollTo({ top: 900 }));
  server.onRequest = null;
  release();
  await expect(list.locator(".pull")).toHaveCount(0);
  expect(await list.evaluate((el) => el.scrollTop)).toBeGreaterThan(800);
  // 届いた記事は、一覧には割り込ませず、件数で知らせる
  await expect(list.getByRole("button", { name: "新しい記事 1 件を読む" })).toBeVisible();
  await expect(list.locator(".item")).toHaveCount(40);
});
