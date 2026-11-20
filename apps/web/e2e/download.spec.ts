import { readFile } from "node:fs/promises";
import { expect, type Page, test } from "@playwright/test";
import { FakeSendo, routeFakeSendo, signIn } from "./fake-sendo";

/**
 * 取得した全文を、HTML か Markdown の 1 つのファイルでダウンロードする。画像は data: URI で
 * 埋め込み、取れなかった画像は代替テキストで残す。フィードの本文を出していても、書き出すのは全文
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

async function download(page: Page, name: string) {
  await openActions(page);
  const [file] = await Promise.all([
    page.waitForEvent("download"),
    actions(page).getByRole("button", { name, exact: true }).click(),
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
  await expect(actions(page).getByRole("button", { name: "Download HTML" })).toHaveCount(0);
  await expect(actions(page).getByRole("button", { name: "Download Markdown" })).toHaveCount(0);
  await page.keyboard.press("Escape");

  await page.locator(".article-list .item", { hasText: article.title ?? "" }).click();
  await expect(view.locator(".body")).toContainText("要約にない全文の続き");
  // フィードの本文を出していても、書き出すのは全文
  await openActions(page);
  await actions(page).getByRole("button", { name: "Show feed content", exact: true }).click();
  await expect(view.locator(".body")).toHaveText("フィードの本文");

  const markdown = await download(page, "Download Markdown");
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

  const html = await download(page, "Download HTML");
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
  const offline = await download(page, "Download Markdown");
  expect(offline.text).toContain("## 元ページの見出し");
  expect(offline.text).toMatch(/!\[図\]\(data:image\/png;base64,[A-Za-z0-9+/=]+\)/);
});
