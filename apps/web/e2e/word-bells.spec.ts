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

  test("打ってすぐベルを押しても、入力にある言葉に付ける", async ({ page, context }) => {
    const { server } = seed();
    await routeFakeSendo(context, server);
    await page.goto("/search");
    await signIn(page);
    await searchBox(page).fill("Azure");
    await expect(searchBell(page, "Azure")).toBeVisible();
    // 探すのは打ち終えて少し待ってから。その前に押す（ベルの名前が、まだ前の言葉のうちに押す）
    await searchBox(page).pressSequentially(" 障害");
    await searchBell(page, "Azure").click();
    await expect(searchBell(page, "Azure 障害")).toHaveAttribute("aria-pressed", "true");
    await syncNow(page);
    expect(serverTargets(server)).toEqual([{ feedId: null, words: "Azure 障害" }]);
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

test.describe("manage feed のベルの言葉", () => {
  function rowBell(page: Page) {
    return page.getByRole("main").getByRole("button", { name: "Bell: Hacker News", exact: true });
  }

  async function openFeedOptions(page: Page) {
    await page.getByRole("button", { name: "Feed options: Hacker News", exact: true }).click();
    return page.getByRole("dialog", { name: "Hacker News" });
  }

  async function closeDialog(page: Page) {
    const dialog = page.getByRole("dialog", { name: "Hacker News" });
    await dialog.getByRole("button", { name: "Close" }).click();
    await expect(dialog).toHaveCount(0);
  }

  test("Hacker News のベルに Rust を足すと「Hacker News AND Rust」のベルになり、言葉を消すと購読だけのベルに戻る", async ({
    page,
    context,
  }) => {
    const { server, news } = seed();
    await routeFakeSendo(context, server);
    await page.goto("/manage");
    await signIn(page);
    await rowBell(page).click();
    await expect(rowBell(page)).toHaveAttribute("aria-pressed", "true");

    let dialog = await openFeedOptions(page);
    await expect(dialog.getByRole("checkbox", { name: "Notify new articles" })).toBeChecked();
    const words = dialog.getByRole("textbox", { name: "Words (optional)" });
    await expect(words).toHaveValue("");
    await words.fill("Rust");
    await words.press("Enter");
    await closeDialog(page);
    // 言葉のあるベルも、行のベルは付いたまま
    await expect(rowBell(page)).toHaveAttribute("aria-pressed", "true");
    await syncNow(page);
    expect(serverTargets(server)).toEqual([{ feedId: news.id, words: "Rust" }]);

    dialog = await openFeedOptions(page);
    await expect(words).toHaveValue("Rust");
    await words.fill("");
    await words.press("Enter");
    await closeDialog(page);
    await syncNow(page);
    expect(serverTargets(server)).toEqual([{ feedId: news.id, words: null }]);
    await expect(rowBell(page)).toHaveAttribute("aria-pressed", "true");

    // Esc で窓を閉じても、打った言葉を決める
    dialog = await openFeedOptions(page);
    await words.fill("Go");
    await words.press("Escape");
    await expect(dialog).toHaveCount(0);
    await syncNow(page);
    expect(serverTargets(server)).toEqual([{ feedId: news.id, words: "Go" }]);
  });

  test("同じ購読にベルが 2 つあれば、あとに作ったほうの言葉を出してそれだけを替え、ほかにもあると知らせる。大文字と小文字だけ違う言葉は積まず、保存した形に戻す", async ({
    page,
    context,
  }) => {
    const { server, news } = seed();
    const feedOnly = server.addBell({ feedId: news.id });
    server.advance(1);
    const rust = server.addBell({ feedId: news.id, words: "Rust" });
    await routeFakeSendo(context, server);
    await page.goto("/manage");
    await signIn(page);

    const dialog = await openFeedOptions(page);
    const words = dialog.getByRole("textbox", { name: "Words (optional)" });
    await expect(words).toHaveValue("Rust");
    await expect(
      dialog.getByText(
        "このフィードには、ほかにもベルがあります。Settings の Notifications で見られます。",
      ),
    ).toBeVisible();

    await words.fill("rust");
    await words.press("Enter");
    await expect(words).toHaveValue("Rust");

    await words.fill("Go");
    await words.press("Enter");
    await closeDialog(page);
    await syncNow(page);
    expect(server.bells.get(rust.id)?.deleted).toBe(true);
    expect(server.bells.get(feedOnly.id)?.deleted).toBe(false);
    expect(serverTargets(server)).toEqual([
      { feedId: news.id, words: null },
      { feedId: news.id, words: "Go" },
    ]);
    expect(server.bellRequests.map((body) => body.words)).toEqual(["Go"]);
  });

  test("上限を超える言葉は打っている間に知らせて付け替えず、上限ちょうどは付けられる。Notify new articles を外すとベルが外れる", async ({
    page,
    context,
  }) => {
    const { server, news } = seed();
    await routeFakeSendo(context, server);
    await page.goto("/manage");
    await signIn(page);
    await rowBell(page).click();
    await syncNow(page);

    const dialog = await openFeedOptions(page);
    const words = dialog.getByRole("textbox", { name: "Words (optional)" });
    const eight = Array.from({ length: 8 }, (_, i) => `w${i}`).join(" ");
    await words.fill(`${eight} w8`);
    await expect(dialog.getByRole("alert")).toHaveText("言葉は 8 個まで入れられます。");
    await words.press("Enter");
    await words.fill(eight);
    await expect(dialog.getByRole("alert")).toHaveCount(0);
    await words.press("Enter");
    await closeDialog(page);
    await syncNow(page);
    expect(serverTargets(server)).toEqual([{ feedId: news.id, words: eight }]);
    expect(server.bellRequests.map((body) => body.words)).toEqual([undefined, eight]);

    await openFeedOptions(page);
    const notify = dialog.getByRole("checkbox", { name: "Notify new articles" });
    await notify.uncheck();
    await expect(words).toHaveCount(0);
    await closeDialog(page);
    await expect(rowBell(page)).toHaveAttribute("aria-pressed", "false");
    await syncNow(page);
    expect(server.activeBells()).toEqual([]);
  });

  test("上限を超える言葉を入れたまま窓を閉じて開き直すと、保存している言葉に戻る", async ({
    page,
    context,
  }) => {
    const { server, news } = seed();
    await routeFakeSendo(context, server);
    await page.goto("/manage");
    await signIn(page);
    await rowBell(page).click();
    await syncNow(page);

    const dialog = await openFeedOptions(page);
    const words = dialog.getByRole("textbox", { name: "Words (optional)" });
    const nine = Array.from({ length: 9 }, (_, i) => `w${i}`).join(" ");
    await words.fill(nine);
    await words.press("Enter");
    await expect(dialog.getByRole("alert")).toHaveText("言葉は 8 個まで入れられます。");
    await closeDialog(page);

    await openFeedOptions(page);
    await expect(words).toHaveValue("");
    await expect(dialog.getByRole("alert")).toHaveCount(0);
    await closeDialog(page);
    await syncNow(page);
    expect(serverTargets(server)).toEqual([{ feedId: news.id, words: null }]);
  });
});

test("Settings の Notifications に付けたベルを並べ、押すとそのベルだけが外れる", async ({
  page,
  context,
}) => {
  const { server, news } = seed();
  const rust = server.subscribe({ url: "https://blog.rust-lang.org/feed.xml", title: "Rust Blog" });
  server.addBell({ feedId: rust.id });
  server.advance(1);
  server.addBell({ feedId: news.id, words: "Rust" });
  server.advance(1);
  const azure = server.addBell({ words: "Azure 障害" });
  await routeFakeSendo(context, server);
  await page.goto("/settings");
  await signIn(page);
  await page.getByRole("tab", { name: "Notifications", exact: true }).click();
  const panel = page.getByRole("tabpanel", { name: "Notifications" });
  await expect(
    panel.getByText(
      "ベルを付けたフィードと言葉に新しい記事が来たら、この端末に知らせます。ベルは同期で、ほかの端末と共有します。",
    ),
  ).toBeVisible();
  const bells = panel.getByRole("region", { name: "Bells" }).getByRole("listitem");
  await expect(bells).toHaveText([
    /Rust Blog\s*すべての新しい記事/,
    /Hacker News\s*Rust を含むときだけ/,
    /Azure 障害\s*どのフィードでも/,
  ]);

  await panel
    .getByRole("button", { name: "Turn off bell: Hacker News · Rust", exact: true })
    .click();
  await expect(bells).toHaveText([/Rust Blog/, /Azure 障害/]);
  await syncNow(page);
  expect(serverTargets(server)).toEqual([
    { feedId: rust.id, words: null },
    { feedId: null, words: "Azure 障害" },
  ]);

  // ほかの画面で付けたベルも、一覧に出る（作った順。偽の sendo の時計は進めないと進まない）
  server.advance(1);
  await page.goto("/search?q=Go");
  const bell = page.getByRole("button", { name: "Bell: Go", exact: true });
  await bell.click();
  await expect(bell).toHaveAttribute("aria-pressed", "true");
  await page.goto("/settings");
  await page.getByRole("tab", { name: "Notifications", exact: true }).click();
  await expect(bells).toHaveText([/Rust Blog/, /Azure 障害/, /Go\s*どのフィードでも/]);
  await panel.getByRole("button", { name: "Turn off bell: Azure 障害", exact: true }).click();
  await syncNow(page);
  expect(server.bells.get(azure.id)?.deleted).toBe(true);
  expect(serverTargets(server)).toEqual([
    { feedId: rust.id, words: null },
    { feedId: null, words: "Go" },
  ]);
});

test("Settings のベルの一覧には、選んでいないワークスペースの購読の名前を出さず、あることだけを知らせる", async ({
  page,
  context,
}) => {
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
  server.addBell({ feedId: ordinary.id });
  server.advance(1);
  server.addBell({ feedId: personal.id, words: "Rust" });
  server.advance(1);
  server.addBell({ words: "Azure 障害" });
  await routeFakeSendo(context, server);
  await page.goto("/");
  await signIn(page);
  await page.getByRole("button", { name: /^Workspaces:/ }).click();
  const dialog = page.getByRole("dialog", { name: "Workspaces", exact: true });
  await dialog.getByRole("button", { name: "Only Public", exact: true }).click();
  await dialog.getByRole("button", { name: "Close", exact: true }).click();

  await page.goto("/settings");
  await page.getByRole("tab", { name: "Notifications", exact: true }).click();
  const region = page.getByRole("region", { name: "Bells" });
  await expect(region.getByRole("listitem")).toHaveText([/Public feed/, /Azure 障害/]);
  await expect(region).not.toContainText("Hidden feed");
  const hidden = region.getByText(
    "選んでいないワークスペースの購読のベルは、ここに出していません。外すには、そのワークスペースに切り替えてください。",
  );
  await expect(hidden).toBeVisible();

  // 出しているベルを外しても、範囲の外のベルがあれば「まだありません」とは出さない
  await region.getByRole("button", { name: "Turn off bell: Public feed", exact: true }).click();
  await region.getByRole("button", { name: "Turn off bell: Azure 障害", exact: true }).click();
  await expect(region.getByRole("listitem")).toHaveCount(0);
  await expect(hidden).toBeVisible();
  await expect(region).not.toContainText("ベルはまだありません。");
});
