import { type BrowserContext, expect, type Locator, type Page, test } from "@playwright/test";
import { FakeSendo, routeFakeSendo, signIn } from "./fake-sendo";

/** 翻訳のラベルの枠（docs/decisions/translation.md の 1）。枠ごとのテキストを並べた順に確かめる */
const chips = (scope: Locator) => scope.locator(".translation .chip");

/**
 * 訳した本文（docs/decisions/translation.md の 3、8、9）。訳文のある記事を開くと、全文ではなく
 * 訳した本文を取って出し、原文と切り替えられる
 */

const translated = (title: string, translatedAt: string) => ({
  language: "en",
  status: "translated",
  title,
  summary: "訳した要約。",
  translatedAt,
});

/**
 * オフラインにする。ブラウザをオフラインにしても、テストが横取りしている /api への通信は偽の
 * sendo に届くので、偽の sendo の側でも、届かないことにする
 */
async function setOffline(context: BrowserContext, server: FakeSendo, offline: boolean) {
  server.onRequest = offline ? () => Promise.reject(new TypeError("offline")) : null;
  await context.setOffline(offline);
}

/**
 * 既読の記事を 1 つ置いて開く（未読の記事は同期のあとに全文を先に取るので、開いたときに何を
 * 取ったかを見るために既読にしておく）
 */
async function open(
  page: Page,
  context: BrowserContext,
  options: { translatedBody: string | null; translation?: unknown; title?: string } = {
    translatedBody: "<p>訳した本文</p>",
  },
) {
  const server = new FakeSendo();
  const feed = server.subscribe({ url: "https://blog.example/feed.xml", title: "Blog" });
  const article = server.deliver(feed.id, {
    title: options.title ?? "Refactoring with Codemods",
    summary: "Codemods are scripts.",
    content: "<p>Feed body</p>",
    url: "https://blog.example/codemods",
    translation:
      options.translation ??
      translated("コードモッドでリファクタリングする", new Date().toISOString()),
  });
  server.setArticleState(article.id, { read: true });
  server.pageContents.set(article.id, "<p>Full text</p>");
  server.translatedContents.set(article.id, options.translatedBody);
  await routeFakeSendo(context, server);
  await page.goto("/");
  await signIn(page);
  await page.locator(".article-list").getByRole("button", { name: "Unread only" }).click();
  await page.locator(".article-list .item").first().click();
  const view = page.locator(".article-view");
  return { server, article, view };
}

test("訳文のある記事を開くと、全文ではなく訳した本文を出す。原文に切り替えると全文を取る", async ({
  page,
  context,
}) => {
  const { server, article, view } = await open(page, context, {
    translatedBody:
      "<p>訳した<strong>本文</strong></p><p>&lt;script&gt;alert(1)&lt;/script&gt;</p>",
  });
  const heading = view.getByRole("heading", { level: 1 });
  const actions = page.getByRole("dialog", { name: "Article actions" });
  await expect(heading).toHaveText("コードモッドでリファクタリングする");
  await expect(view.locator(".body p").first()).toHaveText("訳した本文");
  // 訳の中のタグの文字列は、文字のまま出す
  await expect(view.locator(".body p").nth(1)).toHaveText("<script>alert(1)</script>");
  await expect(view.locator(".body script")).toHaveCount(0);
  expect(server.translationContentRequests).toEqual([article.id]);
  expect(server.pageContentRequests).toEqual([]);

  // 訳文を出している間は、原文の中の本文を選ばせない
  await view.getByRole("button", { name: "More actions" }).click();
  await expect(actions.getByRole("button", { name: "Show full text" })).toHaveCount(0);
  await expect(actions.getByRole("button", { name: "Show feed content" })).toHaveCount(0);
  await actions.getByRole("button", { name: "Show original text" }).click();

  // 原文に切り替えると、全文を取って出す
  await expect(heading).toHaveText("Refactoring with Codemods");
  await expect(view.locator(".body")).toHaveText("Full text");
  expect(server.pageContentRequests).toEqual([article.id]);
  await view.getByRole("button", { name: "More actions" }).click();
  await expect(actions.getByRole("button", { name: "Show feed content" })).toBeVisible();
  await page.keyboard.press("Escape");

  // 訳文に戻すと、手元の訳した本文を出す（取り直さない）
  await page.keyboard.press("t");
  await expect(heading).toHaveText("コードモッドでリファクタリングする");
  await expect(view.locator(".body p").first()).toHaveText("訳した本文");
  expect(server.translationContentRequests).toEqual([article.id]);

  // 読み込み直すと、手元の訳した本文から出す
  await page.reload();
  await expect(view.locator(".body p").first()).toHaveText("訳した本文");
  expect(server.translationContentRequests).toEqual([article.id]);
});

test("本文を訳さなかった記事は、原文の本文を出し、全文の切り替えも出す", async ({
  page,
  context,
}) => {
  const { server, article, view } = await open(page, context, { translatedBody: null });
  const actions = page.getByRole("dialog", { name: "Article actions" });
  await expect(view.getByRole("heading", { level: 1 })).toHaveText(
    "コードモッドでリファクタリングする",
  );
  // これまでどおり全文を取る
  await expect(view.locator(".body")).toHaveText("Full text");
  expect(server.pageContentRequests).toEqual([article.id]);
  await view.getByRole("button", { name: "More actions" }).click();
  await expect(actions.getByRole("button", { name: "Show feed content" })).toBeVisible();
  await actions.getByRole("button", { name: "Show feed content" }).click();
  await expect(view.locator(".body")).toHaveText("Feed body");

  // 印を置いたので、開き直しても訳した本文を取り直さない
  await page.reload();
  await expect(view.locator(".body")).toHaveText("Full text");
  expect(server.translationContentRequests).toEqual([article.id]);
});

test("オフラインで訳した本文が手元にないときは、訳した要約を出し、つながったら訳した本文に替える", async ({
  page,
  context,
}) => {
  const server = new FakeSendo();
  const feed = server.subscribe({ url: "https://blog.example/feed.xml", title: "Blog" });
  const article = server.deliver(feed.id, {
    title: "Refactoring with Codemods",
    summary: "Codemods are scripts.",
    url: "https://blog.example/codemods",
    translation: translated("コードモッドでリファクタリングする", new Date().toISOString()),
  });
  server.setArticleState(article.id, { read: true });
  server.translatedContents.set(article.id, "<p>訳した本文</p>");
  await routeFakeSendo(context, server);
  await page.goto("/");
  await signIn(page);
  await page.locator(".article-list").getByRole("button", { name: "Unread only" }).click();
  await expect(page.locator(".article-list .item")).toHaveCount(1);

  await setOffline(context, server, true);
  await page.locator(".article-list .item").first().click();
  const view = page.locator(".article-view");
  await expect(view.locator(".summary")).toHaveText("訳した要約。");
  await expect(view.locator(".content-note")).toContainText("つながったら読めます");

  await setOffline(context, server, false);
  await expect(view.locator(".body")).toHaveText("訳した本文");
  await expect(view.locator(".summary")).toHaveCount(0);
});

test("オフラインで開いて原文に切り替え、つながってから訳文に戻すと、訳した本文を出す", async ({
  page,
  context,
}) => {
  const server = new FakeSendo();
  const feed = server.subscribe({ url: "https://blog.example/feed.xml", title: "Blog" });
  const article = server.deliver(feed.id, {
    title: "Refactoring with Codemods",
    summary: "Codemods are scripts.",
    url: "https://blog.example/codemods",
    translation: translated("コードモッドでリファクタリングする", new Date().toISOString()),
  });
  server.setArticleState(article.id, { read: true });
  server.translatedContents.set(article.id, "<p>訳した本文</p>");
  await routeFakeSendo(context, server);
  await page.goto("/");
  await signIn(page);
  await page.locator(".article-list").getByRole("button", { name: "Unread only" }).click();
  await expect(page.locator(".article-list .item")).toHaveCount(1);

  await setOffline(context, server, true);
  await page.locator(".article-list .item").first().click();
  const view = page.locator(".article-view");
  await expect(view.locator(".summary")).toHaveText("訳した要約。");
  await page.keyboard.press("t");
  await expect(view.getByRole("heading", { level: 1 })).toHaveText("Refactoring with Codemods");

  // 原文を出している間に、つながったら取り直す
  await setOffline(context, server, false);
  await expect.poll(() => server.translationContentRequests).toEqual([article.id]);
  await page.keyboard.press("t");
  await expect(view.getByRole("heading", { level: 1 })).toHaveText(
    "コードモッドでリファクタリングする",
  );
  await expect(view.locator(".body")).toHaveText("訳した本文");
  expect(server.translationContentRequests).toEqual([article.id]);
});

test("つながったまま訳した本文が取れなかったら、原文から訳文に戻したときに取り直す", async ({
  page,
  context,
}) => {
  const { server, article, view } = await (async () => {
    const server = new FakeSendo();
    const feed = server.subscribe({ url: "https://blog.example/feed.xml", title: "Blog" });
    const article = server.deliver(feed.id, {
      title: "Refactoring with Codemods",
      summary: "Codemods are scripts.",
      url: "https://blog.example/codemods",
      translation: translated("コードモッドでリファクタリングする", new Date().toISOString()),
    });
    server.setArticleState(article.id, { read: true });
    server.translatedContents.set(article.id, "<p>訳した本文</p>");
    await routeFakeSendo(context, server);
    await page.goto("/");
    await signIn(page);
    await page.locator(".article-list").getByRole("button", { name: "Unread only" }).click();
    await expect(page.locator(".article-list .item")).toHaveCount(1);
    return { server, article, view: page.locator(".article-view") };
  })();
  // 訳した本文だけが届かない（ブラウザはつながったままなので、つながった知らせは来ない）
  server.onRequest = (path) =>
    path.endsWith("/translation") ? Promise.reject(new TypeError("failed")) : Promise.resolve();
  await page.locator(".article-list .item").first().click();
  await expect(view.locator(".content-note")).toContainText("つながったら読めます");
  await page.keyboard.press("t");
  await expect(view.getByRole("heading", { level: 1 })).toHaveText("Refactoring with Codemods");

  server.onRequest = null;
  await page.keyboard.press("t");
  await expect(view.locator(".body")).toHaveText("訳した本文");
  expect(server.translationContentRequests).toEqual([article.id]);
});

test("開いている間に訳し直されても、出している訳した本文は替えない。開き直すと新しい訳", async ({
  page,
  context,
}) => {
  const { server, article, view } = await open(page, context);
  await expect(view.locator(".body")).toHaveText("訳した本文");

  server.setTranslation(
    article.id,
    translated("新しい訳のタイトル", new Date(Date.now() + 60_000).toISOString()),
  );
  server.translatedContents.set(article.id, "<p>新しい訳</p>");
  await page.getByRole("button", { name: "Sync now" }).click();
  await expect(page.locator(".article-list .item").first()).toContainText("新しい訳のタイトル");
  await expect(view.getByRole("heading", { level: 1 })).toHaveText(
    "コードモッドでリファクタリングする",
  );
  await expect(view.locator(".body")).toHaveText("訳した本文");

  await page.keyboard.press("Escape");
  await page.locator(".article-list .item").first().click();
  await expect(view.getByRole("heading", { level: 1 })).toHaveText("新しい訳のタイトル");
  await expect(view.locator(".body")).toHaveText("新しい訳");
});

test("訳した要約で待っている間に訳文が替わったら、新しい訳文に替える", async ({
  page,
  context,
}) => {
  const server = new FakeSendo();
  const feed = server.subscribe({ url: "https://blog.example/feed.xml", title: "Blog" });
  const first = new Date().toISOString();
  const article = server.deliver(feed.id, {
    title: "Refactoring with Codemods",
    summary: "Codemods are scripts.",
    url: "https://blog.example/codemods",
    translation: translated("古い訳のタイトル", first),
  });
  server.setArticleState(article.id, { read: true });
  await routeFakeSendo(context, server);
  await page.goto("/");
  await signIn(page);
  await page.locator(".article-list").getByRole("button", { name: "Unread only" }).click();
  await expect(page.locator(".article-list .item")).toHaveCount(1);

  // 同期の前に sendo で訳し直した。取った訳文は手元の時刻と違うので、訳した要約で待つ
  server.setTranslation(
    article.id,
    translated("新しい訳のタイトル", new Date(Date.now() + 60_000).toISOString()),
  );
  server.translatedContents.set(article.id, "<p>新しい訳</p>");
  await page.locator(".article-list .item").first().click();
  const view = page.locator(".article-view");
  await expect(view.getByRole("heading", { level: 1 })).toHaveText("古い訳のタイトル");
  await expect(view.locator(".summary")).toHaveText("訳した要約。");
  // 取っている間も訳した要約を出すので、取りにいったことは、届くのを待って確かめる
  await expect.poll(() => server.translationContentRequests).toEqual([article.id]);

  // 同期で新しい訳した時刻が届いたら、タイトルと本文をまとめて新しい訳文に替える（取り直さない）
  await page.getByRole("button", { name: "Sync now" }).click();
  await expect(view.getByRole("heading", { level: 1 })).toHaveText("新しい訳のタイトル");
  await expect(view.locator(".body")).toHaveText("新しい訳");
  expect(server.translationContentRequests).toEqual([article.id]);
});

test("Translate で頼んだ記事は、訳文が届くと訳した本文に替わる", async ({ page, context }) => {
  const { server, article, view } = await open(page, context, {
    translatedBody: "<p>訳した本文</p>",
    title: "Feature Toggles",
    translation: {
      language: "en",
      status: "queued",
      title: null,
      summary: null,
      translatedAt: null,
    },
  });
  await expect(view.locator(".body")).toHaveText("Full text");
  await view.getByRole("button", { name: "Translate", exact: true }).click();
  await expect(chips(view.locator("header"))).toHaveText(["EN", "Translating"]);
  server.setTranslation(article.id, translated("フィーチャートグル", new Date().toISOString()));
  await page.getByRole("button", { name: "Sync now" }).click();
  await expect(view.getByRole("heading", { level: 1 })).toHaveText("フィーチャートグル");
  await expect(view.locator(".body")).toHaveText("訳した本文");
});

test("訳文のある未読の記事は、同期のあとに訳した本文を先に取っておき、オフラインで開いても出る", async ({
  page,
  context,
}) => {
  const server = new FakeSendo();
  const feed = server.subscribe({ url: "https://blog.example/feed.xml", title: "Blog" });
  const article = server.deliver(feed.id, {
    title: "Refactoring with Codemods",
    summary: "Codemods are scripts.",
    url: "https://blog.example/codemods",
    translation: translated("コードモッドでリファクタリングする", new Date().toISOString()),
  });
  server.pageContents.set(article.id, "<p>Full text</p>");
  server.translatedContents.set(article.id, "<p>訳した本文</p>");
  await routeFakeSendo(context, server);
  await page.goto("/");
  await signIn(page);
  // 全文ではなく、訳した本文を先に取る
  await expect.poll(() => server.translationContentRequests).toEqual([article.id]);
  expect(server.pageContentRequests).toEqual([]);

  await setOffline(context, server, true);
  await page.locator(".article-list .item").first().click();
  const view = page.locator(".article-view");
  await expect(view.getByRole("heading", { level: 1 })).toHaveText(
    "コードモッドでリファクタリングする",
  );
  await expect(view.locator(".body")).toHaveText("訳した本文");
});
