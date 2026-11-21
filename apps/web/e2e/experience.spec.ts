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

test("フォルダ名は未読があるときだけ太字になり、既読化と取り消しで切り替わる", async ({
  page,
  context,
}) => {
  const { server, folder } = seed();
  const readFolder = server.createFolder("Read folder");
  const emptyFolder = server.createFolder("Empty folder");
  const feed = server.subscribe({
    url: "https://read.example/feed.xml",
    title: "Read feed",
    folderId: readFolder.id,
  });
  const article = server.deliver(feed.id, { title: "既読の記事" });
  server.setArticleState(article.id, { read: true });
  await routeFakeSendo(context, server);
  await page.goto("/");
  await signIn(page);

  const nav = page.locator("nav.sidebar");
  const unread = nav.locator(`a[href="/folders/${folder.id}"]`);
  const read = nav.locator(`a[href="/folders/${readFolder.id}"]`);
  const empty = nav.locator(`a[href="/folders/${emptyFolder.id}"]`);
  await expect(unread).toHaveCSS("font-weight", "600");
  await expect(read).toHaveCSS("font-weight", "400");
  await expect(empty).toHaveCSS("font-weight", "400");
  await read.click();
  await expect(read).toHaveAttribute("aria-current", "page");
  await expect(read).toHaveCSS("font-weight", "400");
  await empty.click();
  await expect(empty).toHaveAttribute("aria-current", "page");
  await expect(empty).toHaveCSS("font-weight", "400");

  await unread.click();
  await nav.getByRole("button", { name: "Collapse Tech" }).click();
  await expect(unread).toHaveCSS("font-weight", "600");
  // 通信できなくても、手元の未読件数で更新する
  await context.setOffline(true);
  await page.keyboard.press("Shift+A");
  await page.getByRole("dialog").getByRole("button", { name: "Mark all as read" }).click();
  await expect(unread.locator(".count")).toHaveCount(0);
  await expect(unread).toHaveCSS("font-weight", "400");
  await page.getByRole("status").getByRole("button", { name: "Undo" }).click();
  await expect(unread.locator(".count")).toHaveText("2");
  await expect(unread).toHaveCSS("font-weight", "600");
  await nav.getByRole("button", { name: "Expand Tech" }).click();
  await expect(unread).toHaveCSS("font-weight", "600");
});

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
  const unread = page.locator("nav.sidebar a", { hasText: "All" });
  await expect(list.locator(".item")).toHaveCount(3);
  await expect(page).toHaveTitle("(3) All - Sendo");

  // j で次の記事を開く（開くと既読になる）。k で前に戻る
  await page.keyboard.press("j");
  await expect(view.getByRole("heading", { level: 1 })).toHaveText("1 番目");
  await page.keyboard.press("j");
  await expect(view.getByRole("heading", { level: 1 })).toHaveText("2 番目");
  await expect(unread).toContainText("1");
  await page.keyboard.press("k");
  await expect(view.getByRole("heading", { level: 1 })).toHaveText("1 番目");
  // 左上に、未読の数と、この一覧の進み具合（2 件読んで 1 件残っている）を出す。押すと内訳が出る
  await page.getByRole("button", { name: "1 unread. Progress 67%" }).click();
  await expect(page.getByRole("dialog")).toContainText("「All」で読んだ記事 2 件");
  await expect(page.getByRole("dialog")).toContainText("「All」に残っている未読 1 件");
  await page.keyboard.press("Escape");

  // s でスター、m で未読に戻す
  await page.keyboard.press("s");
  await expect(view.getByRole("button", { name: "Unsave" })).toBeVisible();
  await page.keyboard.press("m");
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
  await expect(list.locator(".row.current").getByRole("button", { name: "Unsave" })).toBeVisible();

  // Shift + A は、範囲を選んでからまとめて既読にする。少しの間、取り消せる
  await page.keyboard.press("Shift+A");
  await expect(page.getByRole("dialog")).toContainText("未読 2 件");
  await page.keyboard.press("Enter");
  await expect(page).toHaveTitle("All - Sendo");
  await page.getByRole("status").getByRole("button", { name: "Undo" }).click();
  await expect(page.getByRole("status")).toContainText("2 件を未読に戻しました。");
  await expect(page).toHaveTitle("(2) All - Sendo");
  await page.keyboard.press("Shift+A");
  await page.getByRole("button", { name: "Older than 1 day" }).click();
  await expect(page.getByRole("status")).toContainText("既読にする記事はありませんでした。");
  await expect(page).toHaveTitle("(2) All - Sendo");
  await page.keyboard.press("Shift+A");
  await page.getByRole("dialog").getByRole("button", { name: "Mark all as read" }).click();
  await expect(page.getByRole("status")).toContainText("2 件を既読にしました。");
  await expect(unread).not.toContainText("2");
  await expect(page).toHaveTitle("All - Sendo");

  // ? で操作の一覧、g a で All に移る
  await page.keyboard.press("?");
  await expect(page.getByRole("dialog")).toContainText("Keyboard shortcuts");
  await page.keyboard.press("Escape");
  await page.keyboard.press("g");
  await page.keyboard.press("a");
  await expect(page).toHaveURL(/\/$/);

  await page.getByRole("button", { name: "Sync now" }).click();
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

  // 並び順は選ばせない（新しい順だけ）
  await expect(list.getByRole("button", { name: "Oldest first" })).toHaveCount(0);

  // 未読は、一覧の絞り込みの状態。どの一覧も、はじめは未読だけを出し、切り替えると既読も出す。
  // 表示の設定は一覧ごとに覚えるので、Blog で切り替えた分は、All には及ばない
  await list.getByText("3 番目").click();
  await page.locator("nav.sidebar").getByRole("link", { name: "Blog" }).click();
  await expect(list.locator(".title")).toHaveText(["1 番目"]);
  const unreadOnly = list.getByRole("button", { name: "Unread only" });
  await expect(unreadOnly).toHaveAttribute("aria-pressed", "true");
  await unreadOnly.click();
  await expect(list.locator(".title")).toHaveText(["1 番目", "3 番目"]);
  // All でも、同じ切り替えで既読も出せる
  await page.locator("nav.sidebar").getByRole("link", { name: "All" }).click();
  await expect(list.locator(".title")).toHaveText(["1 番目", "2 番目"]);
  await expect(unreadOnly).toHaveAttribute("aria-pressed", "true");
  await unreadOnly.click();
  await expect(list.locator(".title")).toHaveText(["1 番目", "2 番目", "3 番目"]);
  await unreadOnly.click();
  await expect(list.locator(".title")).toHaveText(["1 番目", "2 番目"]);

  // フォルダを畳み、未読のないフィードを隠す
  const nav = page.locator("nav.sidebar");
  await nav.getByRole("button", { name: "Collapse Tech" }).click();
  await expect(nav.getByRole("link", { name: "Blog" })).toHaveCount(0);
  await nav.getByRole("button", { name: "Expand Tech" }).click();
  await expect(nav.getByRole("link", { name: "Blog" })).toBeVisible();

  // テーマと文字の大きさ
  await nav.getByRole("link", { name: "Settings" }).click();
  await page.getByText("Dark", { exact: true }).click();
  await page.getByRole("slider", { name: "Text size" }).fill("3");
  await expect(page.locator("html")).toHaveAttribute("data-theme", "dark");

  await page.reload();
  await expect(page.locator("html")).toHaveAttribute("data-theme", "dark");
  await expect(page.locator("html")).toHaveAttribute("data-text-size", "large");
  await expect(page.getByRole("slider", { name: "Text size" })).toHaveValue("3");
  // 読み込み直しても、一覧ごとの設定が残る
  await page.goto(`/feeds/${blog.id}`);
  await expect(list.locator(".title")).toHaveText(["1 番目", "3 番目"]);
  await expect(unreadOnly).toHaveAttribute("aria-pressed", "false");
  await page.goto("/");
  await expect(list.locator(".title")).toHaveText(["1 番目", "2 番目"]);
  await expect(unreadOnly).toHaveAttribute("aria-pressed", "true");
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
  await expect(page.getByRole("button", { name: "Progress 0%" })).toBeVisible();

  await page.getByRole("button", { name: "Menu", exact: true }).click();
  await expect(nav).toBeVisible();
  await nav.getByRole("link", { name: "All" }).click();
  await expect(nav).toBeHidden();
  // 既読の記事も出す（未読だけにするかは、一覧の絞り込みで選ぶ）
  await list.getByRole("button", { name: "Unread only" }).click();
  await expect(page).toHaveURL(/\/$/);

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
  await expect(row.getByRole("button", { name: "Unsave" })).toBeAttached();
  await expect(row).toHaveClass(/unread/);
  await flick("1 番目", -120, 5);
  await expect(row).not.toHaveClass(/unread/);
  await expect(page).not.toHaveURL(/article=/);

  // 下のバーは、一覧の画面でだけ出す。スター、検索、追加、未読へ移れる
  const tabs = page.getByRole("navigation", { name: "Main" });
  await expect(tabs).toBeVisible();
  await tabs.getByRole("link", { name: "Saved" }).click();
  await expect(page).toHaveURL(/\/starred$/);
  await expect(tabs.getByRole("link", { name: "Saved" })).toHaveAttribute("aria-current", "page");
  await tabs.getByRole("link", { name: "Search" }).click();
  await expect(page).toHaveURL(/\/search$/);
  await tabs.getByRole("link", { name: "Add" }).click();
  await expect(page.getByRole("heading", { name: "Manage feeds" })).toBeVisible();
  await expect(tabs).toBeVisible();
  await tabs.getByRole("link", { name: "All" }).click();
  await expect(page).toHaveURL(/\/$/);
  await page.getByRole("button", { name: "Menu", exact: true }).click();
  await nav.getByRole("link", { name: "All" }).click();

  // 記事を開くと記事だけになり、「戻る」で一覧に戻る
  await list.getByText("2 番目").click();
  await expect(page.getByRole("heading", { level: 1 })).toHaveText("2 番目");
  await expect(list).toBeHidden();
  // 記事の画面では、下のバーを出さない（同じ場所に、記事の操作が入る）
  await expect(tabs).toBeHidden();
  await expect(page.getByRole("button", { name: "Back" })).toBeVisible();
  // 「戻る」で戻ったときは、一覧を左から入れる
  await page.getByRole("button", { name: "Back" }).click();
  await expect(list).toBeVisible();
  await expect(page.locator(".reader")).toHaveClass(/returning/);
  await list.getByText("2 番目").click();
  await expect(page.getByRole("heading", { level: 1 })).toHaveText("2 番目");
  // 次の記事へ移ると、中身を短く浮かび上がらせる
  await page.getByRole("button", { name: "Next" }).click();
  await expect(page.getByRole("heading", { level: 1 })).toHaveText("3 番目");
  await expect(page.locator(".article-view .content")).toHaveClass(/fade-in/);
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
  await page.waitForTimeout(300);
  await expect(page.getByRole("heading", { level: 1 })).toHaveText("3 番目");
  // 右へ動かしている間は、記事が指に付いて動き、後ろに一覧が見える。足りないところで指を止めて
  // 離すと、記事は元の位置に戻る
  const view = page.locator(".article-view");
  const touchArticle = (type: "touchmove" | "touchend", dx: number) =>
    view.evaluate(
      (element, { type, dx }) => {
        const at = (x: number) =>
          new Touch({ identifier: 1, target: element, clientX: x, clientY: 300 });
        if (type === "touchmove") {
          element.dispatchEvent(
            new TouchEvent("touchstart", {
              bubbles: true,
              touches: [at(200)],
              changedTouches: [at(200)],
            }),
          );
          for (const step of [0.3, 0.6, 1]) {
            const touch = at(200 + dx * step);
            element.dispatchEvent(
              new TouchEvent("touchmove", {
                bubbles: true,
                cancelable: true,
                touches: [touch],
                changedTouches: [touch],
              }),
            );
          }
        } else {
          element.dispatchEvent(
            new TouchEvent("touchend", {
              bubbles: true,
              touches: [],
              changedTouches: [at(200 + dx)],
            }),
          );
        }
      },
      { type, dx },
    );
  await touchArticle("touchmove", 50);
  await expect(view).toHaveClass(/moved/);
  await expect(list).toBeVisible();
  await page.waitForTimeout(150);
  await touchArticle("touchend", 50);
  await expect(view).not.toHaveClass(/moved/);
  await expect(list).toBeHidden();
  await expect(page.getByRole("heading", { level: 1 })).toHaveText("3 番目");
  // 十分に動かしてから離すと、記事を外へ流して、一覧に戻る
  await touchArticle("touchmove", 140);
  await touchArticle("touchend", 140);
  await expect(list).toBeVisible();
  await expect(page).toHaveURL(/\/$/);
  // スワイプで戻ったときは、後ろに見せていた一覧にそのまま替わる（入れ直さない）
  await expect(page.locator(".reader")).not.toHaveClass(/returning/);
  await list.getByText("3 番目").click();
  await expect(page.getByRole("heading", { level: 1 })).toHaveText("3 番目");
  await flickArticle(140, 10);
  await expect(list).toBeVisible();
  await expect(page).toHaveURL(/\/$/);
  await expect(tabs).toBeVisible();

  // 設定で、記事を左へスワイプしたら次の記事、一覧の行を左へスワイプしても何もしない、に変える
  // （既定では、一覧の行を左へスワイプすると既読・未読が替わる）
  await page.getByRole("button", { name: "Menu", exact: true }).click();
  await nav.getByRole("link", { name: "Settings" }).click();
  await page.getByRole("tab", { name: "Reading", exact: true }).click();
  await page.getByLabel("Article: swipe left").selectOption({ label: "Next" });
  await page.getByLabel("List: swipe left").selectOption({ label: "None" });
  await page.reload();
  await page.getByRole("tab", { name: "Reading", exact: true }).click();
  await expect(page.getByLabel("Article: swipe left")).toHaveValue("next");
  await tabs.getByRole("link", { name: "Saved" }).click();
  await expect(list.locator(".title")).toHaveText(["1 番目"]);
  await flick("1 番目", -120, 5);
  await page.waitForTimeout(300);
  await expect(row).not.toHaveClass(/unread/);
  await expect(row.getByRole("button", { name: "Unsave" })).toBeAttached();
  await page.getByRole("button", { name: "Menu", exact: true }).click();
  await nav.getByRole("link", { name: "All" }).click();
  await list.getByText("2 番目").click();
  await expect(page.getByRole("heading", { level: 1 })).toHaveText("2 番目");
  await flickArticle(-140, 10);
  await expect(page.getByRole("heading", { level: 1 })).toHaveText("3 番目");
  // 次の記事が、反対の側から入り終わるまでは、次のスワイプを受けない
  await expect(view).not.toHaveClass(/moved/);
  await flickArticle(140, 10);
  await expect(list).toBeVisible();
  // 記事を外へ流している間に、ブラウザーの戻るで一覧に戻ったら、次の記事は開かない
  await list.getByText("2 番目").click();
  await expect(page.getByRole("heading", { level: 1 })).toHaveText("2 番目");
  await flickArticle(-140, 10);
  await page.evaluate(() => history.back());
  await expect(list).toBeVisible();
  await page.waitForTimeout(500);
  await expect(page).not.toHaveURL(/article=/);
  await expect(list).toBeVisible();

  // 記事を左へスワイプしたら保存を切り替える、に変える。記事は外へ流さず、少しだけ動かして、
  // 空いたところに印を出す。離したら切り替えて、元の位置に戻す
  await page.getByRole("button", { name: "Menu", exact: true }).click();
  await nav.getByRole("link", { name: "Settings" }).click();
  await page.getByRole("tab", { name: "Reading", exact: true }).click();
  await page.getByLabel("Article: swipe left").selectOption({ label: "Save / Unsave" });
  await page.getByRole("button", { name: "Menu", exact: true }).click();
  await nav.getByRole("link", { name: "All" }).click();
  await list.getByText("2 番目").click();
  await expect(page.getByRole("heading", { level: 1 })).toHaveText("2 番目");
  await expect(page.getByRole("button", { name: "Save", exact: true })).toBeVisible();
  await touchArticle("touchmove", -140);
  await expect(page.locator(".star-hint")).toHaveText("Save");
  await expect(page.locator(".star-hint")).toHaveClass(/armed/);
  // 記事の画面はそのまま（後ろに一覧を見せない）
  await expect(list).toBeHidden();
  await touchArticle("touchend", -140);
  await expect(page.getByRole("button", { name: "Unsave" })).toBeVisible();
  await expect(page.getByRole("status").filter({ hasText: "Saved に入れました。" })).toBeVisible();
  await expect(view).not.toHaveClass(/moved/);
  await expect(page.locator(".star-hint")).toHaveCount(0);
  await expect(page.getByRole("heading", { level: 1 })).toHaveText("2 番目");
  // もう一度スワイプすると、保存をやめる
  await flickArticle(-140, 10);
  await expect(page.getByRole("button", { name: "Save", exact: true })).toBeVisible();
  await page.getByRole("button", { name: "Back" }).click();
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
  await expect(page).toHaveTitle("All - Sendo");
  await expect(page.getByRole("button", { name: "0 unread. Progress 100%" })).toBeVisible();
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
  await page.locator("nav.sidebar").getByRole("link", { name: "Saved" }).click();
  const list = page.locator(".article-list");
  await expect(list.locator(".title")).toHaveText(["1 番目"]);
  await expect(list.getByText("End of list")).toBeVisible();

  // ほかの端末で、出している記事より古い記事にスターを付けた
  server.setArticleState(third.id, { starred: true });
  await page.getByRole("button", { name: "Sync now" }).click();
  await expect(list.locator(".title")).toHaveText(["1 番目", "3 番目"]);
});

test("出している記事より前に入る記事が加わったら、新しい記事として知らせる", async ({
  page,
  context,
}) => {
  const { server } = seed();
  const [first, , third] = [...server.inbox.values()];
  if (first === undefined || third === undefined) throw new Error("unreachable");
  server.setArticleState(third.id, { starred: true });
  await routeFakeSendo(context, server);
  await page.goto("/");
  await signIn(page);
  await page.locator("nav.sidebar").getByRole("link", { name: "Saved" }).click();
  const list = page.locator(".article-list");
  await expect(list.locator(".title")).toHaveText(["3 番目"]);

  // ほかの端末で、出している記事より新しい記事にスターを付けた
  server.setArticleState(first.id, { starred: true });
  await page.getByRole("button", { name: "Sync now" }).click();
  await list.getByRole("button", { name: "1 new" }).click();
  await expect(list.locator(".title")).toHaveText(["1 番目", "3 番目"]);
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
  const scrollBy = (top: number) => page.evaluate((top) => window.scrollBy({ top }), top);

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
  await expect(page.getByRole("button", { name: /^Progress [1-9]/ })).toContainText(
    String(afterScroll),
  );

  // 記事を開いて一覧が隠れても、開いた記事のほかは既読にしない
  await list.locator(".row.unread .item").first().click();
  await expect(page.getByRole("heading", { level: 1 })).toBeVisible();
  await page.goBack();
  await expect(unreadRows).toHaveCount(afterScroll - 1);

  // 切ると、動かしても既読にしない
  await page.getByRole("button", { name: "Menu", exact: true }).click();
  await page.locator("nav.sidebar").getByRole("link", { name: "Settings" }).click();
  await page.getByRole("tab", { name: "Reading", exact: true }).click();
  await page.getByLabel("Mark as read on scroll").uncheck();
  await page.goBack();
  await expect(list.locator(".item").first()).toBeVisible();
  const before = await unreadRows.count();
  await scrollBy(600);
  await page.waitForTimeout(600);
  await expect(unreadRows).toHaveCount(before);

  await page.getByRole("button", { name: "Menu", exact: true }).click();
  await page.getByRole("button", { name: "Sync now" }).click();
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

test("行を長く押しても（右クリックしても）、記事の操作のメニューは出ない。一覧の終わりから次のフィードへ進める", async ({
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
  await nav.getByRole("link", { name: "Alpha" }).click();
  await expect(list.locator(".item")).toHaveCount(5);

  // 右クリックは、ブラウザの既定のメニューに任せる（reader は止めず、窓も出さない）
  const prevented = await row("A 3").evaluate((element) => {
    const event = new MouseEvent("contextmenu", { bubbles: true, cancelable: true, button: 2 });
    element.querySelector(".item")?.dispatchEvent(event);
    return event.defaultPrevented;
  });
  expect(prevented).toBe(false);
  await expect(page.getByRole("dialog")).toHaveCount(0);

  // 指で長く押しても、窓は出ず、ブラウザのリンクのメニューも止める（長く押すと、指が触れている
  // 間に contextmenu が来る）。指を離したあとに押せば、記事が開く
  const touchPrevented = await row("A 4").evaluate(async (element) => {
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
    const menu = new MouseEvent("contextmenu", { bubbles: true, cancelable: true });
    element.querySelector(".item")?.dispatchEvent(menu);
    element.dispatchEvent(
      new TouchEvent("touchend", { bubbles: true, touches: [], changedTouches: [touch] }),
    );
    return menu.defaultPrevented;
  });
  expect(touchPrevented).toBe(true);
  await expect(page.getByRole("dialog")).toHaveCount(0);
  await row("A 4").locator(".item").click();
  await expect(page).toHaveURL(/article=/);
  await expect(page.locator(".article-view").getByRole("heading", { level: 1 })).toHaveText("A 4");
  await page.keyboard.press("Escape");
  await expect(page).not.toHaveURL(/article=/);

  // 一覧の終わりから、残りを既読にして次のフィードへ進む
  await list.getByRole("button", { name: "Mark all as read, next: Beta" }).click();
  await expect(page).toHaveURL(new RegExp(`/feeds/${beta.id}$`));
  await expect(list.locator(".title")).toHaveText(["B 1"]);
  await expect(nav.getByRole("link", { name: "Alpha" })).not.toContainText("2");
  await expect(list.locator("button.primary", { hasText: "Mark all as read" })).toBeVisible();

  // 未読だけを出していて記事がないフィードでも、次のフィードへ進める
  await nav.getByRole("link", { name: "Alpha" }).click();
  await expect(list.getByText("すべて読み終えました。")).toBeVisible();
  await list.getByRole("button", { name: "Next: Beta" }).click();
  await expect(page).toHaveURL(new RegExp(`/feeds/${beta.id}$`));
  await expect(list.locator(".title")).toHaveText(["B 1"]);

  // Shift + J で、次の未読のあるフィードへ
  await nav.getByRole("link", { name: "All" }).click();
  await page.keyboard.press("Shift+J");
  await expect(page).toHaveURL(new RegExp(`/feeds/${beta.id}$`));
});

test("記事の画面から、リンクを共有できる。文字を大きくしても、バーのボタンがはみ出さない", async ({
  page,
  context,
}) => {
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
  await view.getByRole("button", { name: "Share" }).click();
  await expect(view.locator(".notice")).toHaveText("リンクをコピーしました。");
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
  await view.getByRole("button", { name: "Share" }).click();
  await expect
    .poll(() => page.evaluate(() => (window as unknown as { shared: ShareData[] }).shared))
    .toEqual([{ title: "1 番目", url: "https://blog.example/first" }]);

  // 記事の画面には、めったに使わない操作（未読に戻す、表示の設定、元の記事を開く）を出さない。
  // 元の記事はタイトルから開く
  for (const name of ["Mark as read", "Mark as unread", "Appearance"]) {
    await expect(view.getByRole("button", { name, exact: true })).toHaveCount(0);
  }
  await expect(view.getByRole("link", { name: "Open original", exact: true })).toHaveCount(0);
  await expect(view.getByRole("heading", { level: 1 }).getByRole("link")).toHaveAttribute(
    "href",
    "https://blog.example/first",
  );

  // 文字の大きさは Settings で変え、記事に戻る
  await page.locator("nav.sidebar").getByRole("link", { name: "Settings" }).click();
  await page.getByRole("slider", { name: "Text size" }).fill("4");
  await expect(page.locator("html")).toHaveAttribute("data-text-size", "xlarge");
  await page.goBack();
  await expect(view.getByRole("heading", { level: 1 })).toHaveText("1 番目");

  // 文字を大きくしても、記事の欄からボタンがはみ出さない（3 カラムの狭い欄でも、狭い画面の
  // 下のバーでも）
  for (const [width, first] of [
    [1024, "Close"],
    [360, "Back"],
  ] as const) {
    await page.setViewportSize({ width, height: 640 });
    // 狭い画面に替わると、記事の欄が右から入ってくる。動き終えてから測る（動いている途中に、
    // 欄とボタンを別々の時点で測ると、ずれてはみ出して見える）
    await view.evaluate((element) =>
      Promise.all(element.getAnimations({ subtree: true }).map((animation) => animation.finished)),
    );
    const pane = await view.boundingBox();
    for (const name of [first, "More actions"]) {
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
  const input = list.getByRole("searchbox", { name: "Search articles" });
  await expect(input).toBeFocused();
  await expect(list.getByText("手元の記事を探します。")).toBeVisible();

  // 探す言葉が空の間は、記事を出していない。入力から抜けて j を押しても、見えていない記事を
  // 開かない（既読にもしない）
  await input.press("Enter");
  await page.keyboard.press("j");
  await page.waitForTimeout(300);
  await expect(page).not.toHaveURL(/article=/);
  await expect(page).toHaveTitle("(3) Search - Sendo");
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
  await expect(list.getByRole("searchbox", { name: "Search articles" })).toHaveValue("sqlite");
  await expect(list.locator(".title")).toHaveText(["SQLite を OPFS で使う", "同期の設計"]);

  // 打ってすぐ別の画面へ移っても、検索の画面に引き戻さない
  await list
    .getByRole("searchbox", { name: "Search articles" })
    .pressSequentially("opfs", { delay: 10 });
  await page.locator("nav.sidebar").getByRole("link", { name: "Manage feeds" }).click();
  await page.waitForTimeout(500);
  await expect(page).toHaveURL(/\/manage$/);
  await page.locator("nav.sidebar").getByRole("link", { name: "Search" }).click();
  await list
    .getByRole("searchbox", { name: "Search articles" })
    .pressSequentially("opfs", { delay: 10 });
  await page.locator("nav.sidebar").getByRole("link", { name: "Saved" }).click();
  await page.waitForTimeout(500);
  await expect(page).toHaveURL(/\/starred$/);

  // 左のメニューからも開ける
  await page.locator("nav.sidebar").getByRole("link", { name: "All" }).click();
  await page.locator("nav.sidebar").getByRole("link", { name: "Search" }).click();
  await expect(list.getByRole("searchbox", { name: "Search articles" })).toHaveValue("");
});

test("見出しを押すと一覧の先頭に戻る。先頭で下に引くと、読み直して同期する", async ({
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
  const scrollTop = () => page.evaluate(() => window.scrollY);

  // 見出しを押すと、先頭に戻る
  await page.evaluate(() => window.scrollTo({ top: 1500 }));
  await expect.poll(scrollTop).toBeGreaterThan(1000);
  await list.getByRole("button", { name: /^All/ }).click();
  await expect.poll(scrollTop).toBe(0);

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
  await expect(list.locator(".pull-busy")).toHaveCount(0);

  // 先頭で下に引いて離すと、既読の記事が消えて、届いた記事が先頭に入る
  await drag(200);
  await expect(list.locator(".title").first()).toHaveText("届いたばかり");
  await expect(list.locator(".item")).toHaveCount(41 - readCount);
  await expect(list.locator(".row:not(.unread)")).toHaveCount(0);
  await expect(list.locator(".pull-busy")).toHaveCount(0);

  // 一覧の途中では、下に動かしても更新しない（数えるのは同期だけ。裏の先読みの本文の取得や、
  // ユーザーの確かめは数えない）
  const scrolledAt = server.requests.length;
  await page.evaluate(() => window.scrollTo({ top: 300 }));
  // 通り過ぎた記事を既読にして送り、そのあとの同期が終わるのを待ってから数え始める
  await expect
    .poll(() => {
      const after = server.requests.slice(scrolledAt);
      const sent = after.findIndex((request) => request.startsWith("PATCH "));
      return sent >= 0 && after.slice(sent).some((request) => request.startsWith("GET /sync"));
    })
    .toBe(true);
  const syncRequests = () => server.requests.filter((request) => request.startsWith("GET /sync"));
  const requests = syncRequests().length;
  await drag(200);
  await page.waitForTimeout(500);
  expect(syncRequests()).toHaveLength(requests);
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
  await page.getByRole("button", { name: "Menu", exact: true }).click();
  await page.getByRole("button", { name: "Sync now" }).click();
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
  await expect(list.locator(".pull-busy")).toBeVisible();

  // 待っている間に、読み進める
  await page.evaluate(() => window.scrollTo({ top: 900 }));
  server.onRequest = null;
  release();
  await expect(list.locator(".pull-busy")).toHaveCount(0);
  expect(await page.evaluate(() => window.scrollY)).toBeGreaterThan(800);
  // 届いた記事は、一覧には割り込ませず、件数で知らせる
  await expect(list.getByRole("button", { name: "1 new" })).toBeVisible();
  await expect(list.locator(".item")).toHaveCount(40);
});

test("狭い画面では、ページ全体が動く。記事は先頭から出し、戻ると一覧の位置に戻る", async ({
  page,
  context,
}) => {
  const server = new FakeSendo();
  const feed = server.subscribe({ url: "https://blog.example/feed.xml", title: "Blog" });
  for (let i = 0; i < 40; i++) {
    server.deliver(feed.id, {
      title: `記事 ${i}`,
      summary: "本文。".repeat(200),
      publishedAt: Date.now() - (i + 1) * 60_000,
    });
  }
  await routeFakeSendo(context, server);
  await page.setViewportSize({ width: 390, height: 780 });
  await page.goto("/");
  await signIn(page);
  const list = page.locator(".article-list");
  await expect(list.locator(".item")).toHaveCount(40);
  const scrollY = () => page.evaluate(() => window.scrollY);

  // 一覧の欄ではなく、ページが動く（iPhone の、いちばん上を押すと先頭に戻る動きが効く）
  await page.evaluate(() => window.scrollTo({ top: 1500 }));
  await expect.poll(scrollY).toBeGreaterThan(1000);
  expect(await list.evaluate((el) => el.scrollTop)).toBe(0);
  // 見出しは画面の上に、下のバーは画面の下に貼り付いたまま
  expect(await list.locator("header").evaluate((el) => el.getBoundingClientRect().top)).toBe(0);
  const tabs = page.getByRole("navigation", { name: "Main" });
  expect(
    await tabs.evaluate((el) => Math.round(window.innerHeight - el.getBoundingClientRect().bottom)),
  ).toBe(0);
  const listTop = await scrollY();

  // 画面のまんなかの記事を開くと、記事は先頭から出る
  const title = await page.evaluate(() => {
    const row = document.elementFromPoint(200, 400)?.closest(".item");
    return row?.querySelector(".title")?.textContent ?? "";
  });
  expect(title).toMatch(/^記事 \d+$/);
  await list
    .locator(".item", { hasText: new RegExp(`^${title}\\b`) })
    .first()
    .click();
  await expect(page.getByRole("heading", { level: 1 })).toHaveText(title);
  await expect.poll(scrollY).toBe(0);
  // 記事を読み進めても、記事の操作は画面の下に貼り付いたまま
  await page.evaluate(() => window.scrollTo({ top: 600 }));
  const toolbar = page.locator(".article-view .toolbar");
  expect(
    await toolbar.evaluate((el) =>
      Math.round(window.innerHeight - el.getBoundingClientRect().bottom),
    ),
  ).toBe(0);

  // 戻ると、開く前の一覧の位置に戻る
  await page.getByRole("button", { name: "Back", exact: true }).click();
  await expect(list).toBeVisible();
  await expect.poll(scrollY).toBe(listTop);

  // 別の画面（購読の管理）に移ると、前の画面の位置を引き継がず、先頭から出す
  await tabs.getByRole("link", { name: "Add" }).click();
  await expect(page.getByRole("heading", { name: "Manage feeds", level: 1 })).toBeVisible();
  await expect.poll(scrollY).toBe(0);
});
