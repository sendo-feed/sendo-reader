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

  // 記事の画面にも同じラベルを出す。見出しは原文のまま（訳文の表示は別の Issue）
  await rows.nth(0).locator(".item").click();
  const view = page.locator(".article-view");
  await expect(view.getByRole("heading", { level: 1 })).toHaveText("Refactoring with Codemods");
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
