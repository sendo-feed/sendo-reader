import { readFile } from "node:fs/promises";
import { expect, type Page, test } from "@playwright/test";
import { FakeSendo, routeFakeSendo, signIn } from "./fake-sendo";

/**
 * 取得した全文を、HTML か Markdown の 1 つのファイルでダウンロードする。画像は data: URI で
 * 埋め込み、取れなかった画像は代替テキストで残す。フィードの本文を出していても、書き出すのは全文。
 * 訳文を出していれば、訳したタイトルと訳した本文（本文を訳さなかった記事は全文）を書き出す
 */

// Chromium は、ファイルシステムの文字コードで表せない名前（LANG が空のときの日本語など）を
// "download" に替える。動かす環境によらず名前を確かめられるよう、UTF-8 にしておく
test.use({ launchOptions: { env: { ...process.env, LANG: "C.UTF-8", LC_ALL: "C.UTF-8" } } });

function seed() {
  const server = new FakeSendo();
  const feed = server.subscribe({ url: "https://example.com/feed", title: "Blog" });
  const article = server.deliver(feed.id, {
    title: "全文の記事: a/b",
    summary: "短い要約",
    content: "<p>フィードの本文</p>",
    url: "https://blog.example/posts/1",
  });
  server.pageContents.set(
    article.id,
    "<h2>元ページの見出し</h2><p>要約にない全文の続き &lt;script&gt;</p>" +
      `<p><img src="${server.imageUrl("https://blog.example/a.png")}" alt="図">` +
      `<img src="${server.imageUrl("https://blog.example/broken.png")}" alt="壊れた図"></p>`,
  );
  server.imageStatusFor.set("https://blog.example/broken.png", 502);
  const summaryOnly = server.deliver(feed.id, { title: "要約だけの記事", summary: "要約だけ" });
  return { server, article, summaryOnly };
}

function actions(page: Page) {
  return page.getByRole("dialog").filter({
    has: page.getByRole("heading", { name: "Article actions", exact: true }),
  });
}

async function openActions(page: Page) {
  await page.locator(".article-view").getByRole("button", { name: "More actions" }).click();
  await expect(actions(page)).toBeVisible();
}

/** Download を押してから、形式（HTML ／ Markdown）を選ぶ */
async function download(page: Page, format: "HTML" | "Markdown") {
  await openActions(page);
  await actions(page).getByRole("button", { name: "Download", exact: true }).click();
  const [file] = await Promise.all([
    page.waitForEvent("download"),
    actions(page).getByRole("button", { name: format, exact: true }).click(),
  ]);
  await expect(actions(page)).not.toBeVisible();
  return { name: file.suggestedFilename(), text: await readFile(await file.path(), "utf8") };
}

test("取得した全文を、画像を埋め込んだ HTML と Markdown でダウンロードできる", async ({
  page,
  context,
}) => {
  const { server, article, summaryOnly } = seed();
  await routeFakeSendo(context, server);
  await page.goto("/");
  await signIn(page);
  const view = page.locator(".article-view");

  // 全文のない記事では、出さない
  await page.locator(".article-list .item", { hasText: summaryOnly.title ?? "" }).click();
  await expect(view.getByRole("status")).toContainText("全文を取得できませんでした");
  await openActions(page);
  await expect(actions(page).getByRole("button", { name: /^Download/ })).toHaveCount(0);
  await page.keyboard.press("Escape");

  await page.locator(".article-list .item", { hasText: article.title ?? "" }).click();
  await expect(view.locator(".body")).toContainText("要約にない全文の続き");
  // フィードの本文を出していても、書き出すのは全文
  await openActions(page);
  await actions(page).getByRole("button", { name: "Show feed content", exact: true }).click();
  await expect(view.locator(".body")).toHaveText("フィードの本文");

  // 形式ごとの操作は並べず、Download を押してから選ぶ。選ぶ前に戻れる
  await openActions(page);
  await expect(actions(page).getByRole("button", { name: /^Download/ })).toHaveText(["Download"]);
  await actions(page).getByRole("button", { name: "Download", exact: true }).click();
  await expect(actions(page).getByRole("button", { name: "HTML", exact: true })).toBeFocused();
  await expect(actions(page).getByRole("button", { name: "Markdown", exact: true })).toBeVisible();
  await actions(page).getByRole("button", { name: "Back", exact: true }).click();
  await expect(actions(page).getByRole("button", { name: "Show full text" })).toBeVisible();
  await expect(actions(page).getByRole("button", { name: "HTML", exact: true })).toHaveCount(0);
  // 閉じて開き直すと、最初の操作から出る
  await actions(page).getByRole("button", { name: "Download", exact: true }).click();
  await page.keyboard.press("Escape");
  await openActions(page);
  await expect(actions(page).getByRole("button", { name: "Download", exact: true })).toBeVisible();
  await page.keyboard.press("Escape");

  const markdown = await download(page, "Markdown");
  expect(markdown.name).toBe("全文の記事_ a_b.md");
  expect(markdown.text).toContain('title: "全文の記事: a/b"');
  expect(markdown.text).toContain('url: "https://blog.example/posts/1"');
  expect(markdown.text).toContain('feed: "Blog"');
  expect(markdown.text).toContain("# [全文の記事: a/b](https://blog.example/posts/1)");
  expect(markdown.text).toContain("## 元ページの見出し");
  expect(markdown.text).toContain("要約にない全文の続き \\<script\\>");
  expect(markdown.text).toMatch(/!\[図\]\(data:image\/png;base64,[A-Za-z0-9+/=]+\)/);
  expect(markdown.text).toContain("\\[画像: 壊れた図\\]");
  expect(markdown.text).not.toContain("フィードの本文");
  expect(markdown.text).not.toContain("/api/v1/images");

  const html = await download(page, "HTML");
  expect(html.name).toBe("全文の記事_ a_b.html");
  expect(html.text.startsWith("<!doctype html>")).toBe(true);
  expect(html.text).toContain("<h2>元ページの見出し</h2>");
  expect(html.text).toContain("要約にない全文の続き &lt;script&gt;");
  expect(html.text).toMatch(/<img src="data:image\/png;base64,[A-Za-z0-9+/=]+" alt="図">/);
  expect(html.text).toContain("[画像: 壊れた図]");
  expect(html.text).not.toContain("<script");
  expect(html.text).not.toContain("/api/v1/images");

  // オフラインでも、手元の全文と、キャッシュ済みの画像で書き出せる
  server.onRequest = () => Promise.reject(new TypeError("offline"));
  await context.setOffline(true);
  await page.reload();
  await expect(view.locator(".body")).toContainText("要約にない全文の続き");
  const offline = await download(page, "Markdown");
  expect(offline.text).toContain("## 元ページの見出し");
  expect(offline.text).toMatch(/!\[図\]\(data:image\/png;base64,[A-Za-z0-9+/=]+\)/);
});

test("訳文を出していれば、訳したタイトルと訳した本文を書き出す。原文に切り替えると全文", async ({
  page,
  context,
}) => {
  const server = new FakeSendo();
  const feed = server.subscribe({ url: "https://example.com/feed", title: "Blog" });
  const translation = (translatedAt: string) => ({
    language: "en",
    status: "translated",
    title: "訳したタイトル",
    summary: "訳した要約",
    translatedAt,
  });
  const article = server.deliver(feed.id, {
    title: "Original title",
    summary: "Summary",
    url: "https://blog.example/posts/1",
    translation: translation(new Date().toISOString()),
  });
  server.setArticleState(article.id, { read: true });
  server.pageContents.set(article.id, "<p>Full text</p>");
  server.translatedContents.set(
    article.id,
    "<h2>訳した見出し</h2><p>訳した本文 &lt;script&gt;</p>" +
      `<p><img src="${server.imageUrl("https://blog.example/a.png")}" alt="図"></p>`,
  );
  const noBody = server.deliver(feed.id, {
    title: "No body",
    url: "https://blog.example/posts/2",
    translation: { ...translation(new Date().toISOString()), title: "本文を訳さなかった記事" },
  });
  server.setArticleState(noBody.id, { read: true });
  server.pageContents.set(noBody.id, "<p>Full text of no body</p>");
  await routeFakeSendo(context, server);
  await page.goto("/");
  await signIn(page);
  await page.locator(".article-list").getByRole("button", { name: "Unread only" }).click();
  const view = page.locator(".article-view");

  await page.locator(".article-list .item", { hasText: "訳したタイトル" }).click();
  await expect(view.locator(".body h2")).toHaveText("訳した見出し");
  const markdown = await download(page, "Markdown");
  expect(markdown.name).toBe("訳したタイトル.md");
  expect(markdown.text).toContain('title: "訳したタイトル"');
  expect(markdown.text).toContain("## 訳した見出し");
  // 訳の中のタグの文字列は、文字のまま
  expect(markdown.text).toContain("訳した本文 \\<script\\>");
  expect(markdown.text).toMatch(/!\[図\]\(data:image\/png;base64,[A-Za-z0-9+/=]+\)/);
  expect(markdown.text).not.toContain("Full text");
  const html = await download(page, "HTML");
  expect(html.text).toContain("<h2>訳した見出し</h2>");
  expect(html.text).toContain("訳した本文 &lt;script&gt;");
  expect(html.text).not.toContain("<script");

  // 原文に切り替えると、これまでどおり全文
  await page.keyboard.press("t");
  await expect(view.locator(".body")).toHaveText("Full text");
  const original = await download(page, "Markdown");
  expect(original.name).toBe("Original title.md");
  expect(original.text).toContain("Full text");
  expect(original.text).not.toContain("訳した見出し");

  // 本文を訳さなかった記事は、訳文を出していれば、訳したタイトルと全文を書き出す（画面と同じ）
  await page.locator(".article-list .item", { hasText: "本文を訳さなかった記事" }).click();
  await expect(view.locator(".body")).toHaveText("Full text of no body");
  const fallback = await download(page, "Markdown");
  expect(fallback.name).toBe("本文を訳さなかった記事.md");
  expect(fallback.text).toContain('title: "本文を訳さなかった記事"');
  expect(fallback.text).toContain("Full text of no body");
});

test("訳文を出していて、訳した本文が手元にないときは、Download を出さない", async ({
  page,
  context,
}) => {
  const server = new FakeSendo();
  const feed = server.subscribe({ url: "https://example.com/feed", title: "Blog" });
  const article = server.deliver(feed.id, {
    title: "Original title",
    summary: "Summary",
    url: "https://blog.example/posts/1",
    translation: {
      language: "en",
      status: "translated",
      title: "訳したタイトル",
      summary: "訳した要約",
      translatedAt: new Date().toISOString(),
    },
  });
  server.setArticleState(article.id, { read: true });
  server.pageContents.set(article.id, "<p>Full text</p>");
  server.translatedContents.set(article.id, "<p>訳した本文</p>");
  await routeFakeSendo(context, server);
  await page.goto("/");
  await signIn(page);
  await page.locator(".article-list").getByRole("button", { name: "Unread only" }).click();
  await expect(page.locator(".article-list .item")).toHaveCount(1);

  // オフラインで開く。訳した本文が手元にないので、Download は出ない
  server.onRequest = () => Promise.reject(new TypeError("offline"));
  await context.setOffline(true);
  await page.locator(".article-list .item").first().click();
  const view = page.locator(".article-view");
  await expect(view.locator(".summary")).toHaveText("訳した要約");
  await openActions(page);
  await expect(actions(page).getByRole("button", { name: /^Download/ })).toHaveCount(0);
  // 原文に切り替えても、全文が手元にないので出ない
  await actions(page).getByRole("button", { name: "Show original text" }).click();
  await expect(view.getByRole("heading", { level: 1 })).toHaveText("Original title");
  await openActions(page);
  await expect(actions(page).getByRole("button", { name: /^Download/ })).toHaveCount(0);
  await page.keyboard.press("Escape");

  // つながると、原文では全文が届いて出る。訳文に戻すと、訳した本文が届いて出る
  server.onRequest = null;
  await context.setOffline(false);
  await expect(view.locator(".body")).toHaveText("Full text");
  await openActions(page);
  await expect(actions(page).getByRole("button", { name: "Download", exact: true })).toBeVisible();
  await page.keyboard.press("Escape");
  await page.keyboard.press("t");
  await expect(view.locator(".body")).toHaveText("訳した本文");
  await openActions(page);
  await expect(actions(page).getByRole("button", { name: "Download", exact: true })).toBeVisible();
});

test("形式を選んでいる途中に、頼んだ訳文が届いて書き出せなくなったら、最初の操作に戻す", async ({
  page,
  context,
}) => {
  const server = new FakeSendo();
  const feed = server.subscribe({ url: "https://example.com/feed", title: "Blog" });
  const queued = {
    language: "en",
    status: "queued",
    title: null,
    summary: null,
    translatedAt: null,
  };
  const article = server.deliver(feed.id, {
    title: "Original title",
    summary: "Summary",
    url: "https://blog.example/posts/1",
    translation: queued,
  });
  server.setArticleState(article.id, { read: true });
  server.pageContents.set(article.id, "<p>Full text</p>");
  server.translatedContents.set(article.id, "<p>訳した本文</p>");
  await routeFakeSendo(context, server);
  await page.goto("/");
  await signIn(page);
  await page.locator(".article-list").getByRole("button", { name: "Unread only" }).click();
  await page.locator(".article-list .item").first().click();
  const view = page.locator(".article-view");
  await expect(view.locator(".body")).toHaveText("Full text");

  // Translate の返事を止めておき、その間に形式を選ぶ段にする
  let release = () => {};
  server.translationRequestGate = new Promise<void>((resolve) => {
    release = resolve;
  });
  await view.getByRole("button", { name: "Translate", exact: true }).click();
  await openActions(page);
  await actions(page).getByRole("button", { name: "Download", exact: true }).click();
  await expect(actions(page).getByRole("button", { name: "HTML", exact: true })).toBeVisible();

  // 訳し終えていた（translation_exists は受け付けと同じ）。同期で訳文が届き、訳文に替わる
  server.setTranslation(article.id, {
    ...queued,
    status: "translated",
    title: "訳したタイトル",
    summary: "訳した要約",
    translatedAt: new Date().toISOString(),
  });
  release();
  await expect(view.getByRole("heading", { level: 1 })).toHaveText("訳したタイトル");
  await expect(actions(page).getByRole("button", { name: "HTML", exact: true })).toHaveCount(0);
  // 訳した本文が届けば、訳文を書き出せる
  await expect(view.locator(".body")).toHaveText("訳した本文");
  await expect(actions(page).getByRole("button", { name: "Download", exact: true })).toBeVisible();
});
