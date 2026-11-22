import { expect, test } from "@playwright/test";
import { FakeSendo, routeFakeSendo, signIn } from "./fake-sendo";

/**
 * 翻訳のラベルと訳したタイトル（docs/decisions/translation.md の 1、2）。偽の sendo から訳し済みの
 * 記事を同期し、一覧と記事の画面に出ることを確かめる
 */
test("一覧に訳したタイトルとラベルを出し、次の同期で替わった翻訳に替える", async ({
  page,
  context,
}) => {
  const server = new FakeSendo();
  const feed = server.subscribe({ url: "https://blog.example/feed.xml", title: "Blog" });
  const now = Date.now();
  server.deliver(feed.id, {
    title: "Refactoring with Codemods",
    publishedAt: now - 1000,
    translation: {
      language: "en",
      status: "translated",
      title: "コードモッドでリファクタリングする",
      summary: "API の変更を自動で当てる",
      translatedAt: new Date(now).toISOString(),
    },
  });
  const waiting = server.deliver(feed.id, {
    title: "Feature Toggles",
    publishedAt: now - 2000,
    translation: {
      language: "fr",
      status: "queued",
      title: null,
      summary: null,
      translatedAt: null,
    },
  });
  server.deliver(feed.id, { title: "日本語の記事", publishedAt: now - 3000 });
  await routeFakeSendo(context, server);
  await page.goto("/");
  await signIn(page);

  const list = page.locator(".article-list");
  const rows = list.locator(".row");
  await expect(rows).toHaveCount(3);
  await expect(rows.nth(0)).toContainText("コードモッドでリファクタリングする");
  await expect(rows.nth(0).locator(".translation")).toHaveText("EN · Translated");
  await expect(rows.nth(1)).toContainText("Feature Toggles");
  await expect(rows.nth(1).locator(".translation")).toHaveText("FR · Queued");
  await expect(rows.nth(2).locator(".translation")).toHaveCount(0);

  // 記事の画面にも同じラベルを出す
  await rows.nth(0).locator(".item").click();
  const view = page.locator(".article-view");
  await expect(view.getByRole("heading", { level: 1 })).toHaveText(
    "コードモッドでリファクタリングする",
  );
  await expect(view.locator("header .translation")).toHaveText("・ EN · Translated");

  server.setTranslation(waiting.id, {
    language: "fr",
    status: "translated",
    title: "フィーチャートグル",
    summary: null,
    translatedAt: new Date(now).toISOString(),
  });
  await page.getByRole("button", { name: "Sync now" }).click();
  await expect(rows.nth(1)).toContainText("フィーチャートグル");
  await expect(rows.nth(1).locator(".translation")).toHaveText("FR · Translated");
});

/**
 * 記事の画面で訳したタイトルを先に出し、原文に切り替える（docs/decisions/translation.md の 3、7）。
 * どちらを出しているかは履歴の項目に持ち、読み込み直しても、戻る・進むでも同じ方に戻る
 */
test("記事の画面で訳したタイトルを出し、原文に切り替え、戻る・読み込み直しで同じ方に戻る", async ({
  page,
  context,
}) => {
  const server = new FakeSendo();
  const feed = server.subscribe({ url: "https://blog.example/feed.xml", title: "Blog" });
  const now = Date.now();
  const translatedAt = new Date(now).toISOString();
  const first = server.deliver(feed.id, {
    title: "Refactoring with Codemods",
    summary: "Codemods are scripts.",
    url: "https://blog.example/codemods",
    publishedAt: now - 1000,
    translation: {
      language: "en",
      status: "translated",
      title: "<b>コードモッド</b>でリファクタリングする",
      summary: "コードモッドはスクリプト。",
      translatedAt,
    },
  });
  const waiting = server.deliver(feed.id, {
    title: "Feature Toggles",
    summary: "Toggles.",
    publishedAt: now - 2000,
    translation: {
      language: "fr",
      status: "queued",
      title: null,
      summary: null,
      translatedAt: null,
    },
  });
  await routeFakeSendo(context, server);
  await page.goto("/");
  await signIn(page);

  const list = page.locator(".article-list");
  const view = page.locator(".article-view");
  const heading = view.getByRole("heading", { level: 1 });
  const actions = page.getByRole("dialog", { name: "Article actions" });
  // 開いた記事は既読になるので、既読も出す
  await list.getByRole("button", { name: "Unread only" }).click();
  await expect(list.locator(".item")).toHaveCount(2);
  const codemods = list.locator(".item").filter({ hasText: "コードモッド" });
  const toggles = list.locator(".item").filter({ hasText: /Feature Toggles|フィーチャートグル/ });

  await codemods.click();
  // 訳したタイトルを文字のまま出し、元のページへのリンクは同じ。本文は原文
  await expect(heading).toHaveText("<b>コードモッド</b>でリファクタリングする");
  await expect(heading.getByRole("link")).toHaveAttribute("href", "https://blog.example/codemods");
  await expect(view).toContainText("Codemods are scripts.");

  await view.getByRole("button", { name: "More actions" }).click();
  await actions.getByRole("button", { name: "Show original text" }).click();
  await expect(heading).toHaveText("Refactoring with Codemods");
  await view.getByRole("button", { name: "More actions" }).click();
  await expect(actions.getByRole("button", { name: "Show translation" })).toBeVisible();
  await page.keyboard.press("Escape");

  // 原文のまま読み込み直すと原文。閉じて（一覧に戻って）進むと原文
  await page.reload();
  await expect(heading).toHaveText("Refactoring with Codemods");
  await page.keyboard.press("Escape");
  await expect(heading).toHaveCount(0);
  await page.goForward();
  await expect(heading).toHaveText("Refactoring with Codemods");

  // t で訳文に戻る。閉じて進んでも訳文
  await page.keyboard.press("t");
  await expect(heading).toHaveText("<b>コードモッド</b>でリファクタリングする");
  await page.keyboard.press("Escape");
  await expect(heading).toHaveCount(0);
  await page.goForward();
  await expect(heading).toHaveText("<b>コードモッド</b>でリファクタリングする");

  // 訳文のない記事では、切り替えが出ず、t は何もしない
  await toggles.click();
  await expect(heading).toHaveText("Feature Toggles");
  await page.keyboard.press("t");
  await expect(heading).toHaveText("Feature Toggles");
  await view.getByRole("button", { name: "More actions" }).click();
  await expect(actions.getByRole("button", { name: "Show original text" })).toHaveCount(0);
  await page.keyboard.press("Escape");

  // 開いている間に訳文が届いても、見出しは替えない。ラベルは替わる。開き直すと訳文
  server.setTranslation(waiting.id, {
    language: "fr",
    status: "translated",
    title: "フィーチャートグル",
    summary: null,
    translatedAt,
  });
  await page.getByRole("button", { name: "Sync now" }).click();
  await expect(view.locator("header .translation")).toHaveText("・ FR · Translated");
  await expect(heading).toHaveText("Feature Toggles");
  await codemods.click();
  await expect(heading).toHaveText("<b>コードモッド</b>でリファクタリングする");
  await toggles.click();
  await expect(heading).toHaveText("フィーチャートグル");

  // 同じ記事を一覧から新しく開くと、訳文から出る
  await codemods.click();
  await page.keyboard.press("t");
  await expect(heading).toHaveText("Refactoring with Codemods");
  await toggles.click();
  await codemods.click();
  await expect(heading).toHaveText("<b>コードモッド</b>でリファクタリングする");
  expect(first.id).not.toBe(waiting.id);
});

test("操作の一覧に t がある", async ({ page, context }) => {
  const server = new FakeSendo();
  const feed = server.subscribe({ url: "https://blog.example/feed.xml", title: "Blog" });
  server.deliver(feed.id, { title: "記事" });
  await routeFakeSendo(context, server);
  await page.goto("/");
  await signIn(page);
  await expect(page.locator(".article-list .item")).toHaveCount(1);
  await page.keyboard.press("?");
  await expect(page.getByRole("dialog")).toContainText("Show translation / original text");
});
