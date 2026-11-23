import { type BrowserContext, expect, type Page, test } from "@playwright/test";
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
  server.deliver(feed.id, {
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

  // 訳文のない記事では、切り替えが出ない（t は Translate になる。下の Translate のテスト）
  await toggles.click();
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

  // 原文にしてほかの画面（Saved）に移り、戻ると原文
  await page.keyboard.press("t");
  await expect(heading).toHaveText("Refactoring with Codemods");
  await page.locator("nav.sidebar").getByRole("link", { name: "Saved" }).click();
  await expect(heading).toHaveCount(0);
  await page.goBack();
  await expect(heading).toHaveText("Refactoring with Codemods");
});

test("訳文のない記事（untranslated、翻訳なし）では切り替えが出ず、URL のない訳し済みの記事でも More actions で切り替えられる", async ({
  page,
  context,
}) => {
  const server = new FakeSendo();
  const feed = server.subscribe({ url: "https://blog.example/feed.xml", title: "Blog" });
  const now = Date.now();
  server.deliver(feed.id, {
    title: "Untranslated",
    publishedAt: now - 1000,
    translation: {
      language: "en",
      status: "untranslated",
      title: null,
      summary: null,
      translatedAt: null,
    },
  });
  server.deliver(feed.id, { title: "No translation", publishedAt: now - 2000 });
  server.deliver(feed.id, {
    title: "No link",
    url: null,
    publishedAt: now - 3000,
    translation: {
      language: "en",
      status: "translated",
      title: "リンクのない記事",
      summary: null,
      translatedAt: new Date(now).toISOString(),
    },
  });
  await routeFakeSendo(context, server);
  await page.goto("/");
  await signIn(page);

  const list = page.locator(".article-list");
  const view = page.locator(".article-view");
  const heading = view.getByRole("heading", { level: 1 });
  const more = view.getByRole("button", { name: "More actions" });
  const actions = page.getByRole("dialog", { name: "Article actions" });
  await expect(list.locator(".item")).toHaveCount(3);

  for (const title of ["Untranslated", "No translation"]) {
    await list.locator(".item").filter({ hasText: title }).click();
    await expect(heading).toHaveText(title);
    await more.click();
    await expect(actions.getByRole("button", { name: "Show original text" })).toHaveCount(0);
    await page.keyboard.press("Escape");
  }
  // 翻訳の項目のない記事では、t は何もしない（Translate も出ない）
  await page.keyboard.press("t");
  await expect(heading).toHaveText("No translation");
  expect(server.translationRequests).toEqual([]);

  await list.locator(".item").filter({ hasText: "リンクのない記事" }).click();
  await expect(heading).toHaveText("リンクのない記事");
  await more.click();
  // 元のページがないので、全文は出さない
  await expect(actions.getByRole("button", { name: "Show full text" })).toHaveCount(0);
  await actions.getByRole("button", { name: "Show original text" }).click();
  await expect(heading).toHaveText("No link");
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
  await expect(page.getByRole("dialog")).toContainText(
    "Translate / switch translation and original",
  );
});

/** 記事の画面の Translate で、その場で訳してもらう（docs/decisions/translation.md の 4、6） */
test.describe("Translate", () => {
  const queued = {
    language: "en",
    status: "queued",
    title: null,
    summary: null,
    translatedAt: null,
  };

  async function open(page: Page, context: BrowserContext, translation: unknown = queued) {
    const server = new FakeSendo();
    const feed = server.subscribe({ url: "https://blog.example/feed.xml", title: "Blog" });
    const article = server.deliver(feed.id, { title: "Feature Toggles", translation });
    await routeFakeSendo(context, server);
    await page.goto("/");
    await signIn(page);
    await page.locator(".article-list .item").first().click();
    const view = page.locator(".article-view");
    await expect(view.getByRole("heading", { level: 1 })).toHaveText("Feature Toggles");
    return { server, article, view };
  }

  test("押すとすぐ Translating になり、訳文が届くと見出しが訳したタイトルに替わる", async ({
    page,
    context,
  }) => {
    const { server, article, view } = await open(page, context);
    const button = view.getByRole("button", { name: "Translate", exact: true });
    await expect(view.locator("header .translation")).toHaveText("・ EN · Queued");
    await button.click();
    await expect(view.locator("header .translation")).toHaveText("・ EN · Translating");
    await expect(button).toHaveCount(0);
    expect(server.translationRequests).toEqual([article.id]);

    server.setTranslation(article.id, {
      language: "en",
      status: "translated",
      title: "フィーチャートグル",
      summary: null,
      translatedAt: new Date().toISOString(),
    });
    await page.getByRole("button", { name: "Sync now" }).click();
    // この端末で頼んだ記事なので、開いたままでも訳文に替える
    await expect(view.getByRole("heading", { level: 1 })).toHaveText("フィーチャートグル");
    await expect(view.locator("header .translation")).toHaveText("・ EN · Translated");
  });

  test("sendo で訳せずに戻ったら日本語の文で知らせ、もう一度頼める", async ({ page, context }) => {
    const { server, article, view } = await open(page, context);
    await view.getByRole("button", { name: "Translate", exact: true }).click();
    await expect(view.locator("header .translation")).toHaveText("・ EN · Translating");
    server.setTranslation(article.id, { ...queued, status: "untranslated" });
    await page.getByRole("button", { name: "Sync now" }).click();
    await expect(view.getByRole("alert")).toHaveText(
      "訳せませんでした。Translate でもう一度頼めます。",
    );
    await expect(view.locator("header .translation")).toHaveText("・ EN · Untranslated");
    await view.getByRole("button", { name: "Translate", exact: true }).click();
    await expect(view.locator("header .translation")).toHaveText("・ EN · Translating");
    await expect(view.getByRole("alert")).toHaveCount(0);
    expect(server.translationRequests).toEqual([article.id, article.id]);
  });

  test("訳せなかったあとでほかの端末が訳しても、開いている見出しは替えない", async ({
    page,
    context,
  }) => {
    const { server, article, view } = await open(page, context);
    const heading = view.getByRole("heading", { level: 1 });
    await view.getByRole("button", { name: "Translate", exact: true }).click();
    await expect(view.locator("header .translation")).toHaveText("・ EN · Translating");
    server.setTranslation(article.id, { ...queued, status: "untranslated" });
    await page.getByRole("button", { name: "Sync now" }).click();
    await expect(view.getByRole("alert")).toBeVisible();

    // ほかの端末が頼み、訳し終えた
    server.setTranslation(article.id, { ...queued, status: "translating" });
    await page.getByRole("button", { name: "Sync now" }).click();
    await expect(view.locator("header .translation")).toHaveText("・ EN · Translating");
    server.setTranslation(article.id, {
      language: "en",
      status: "translated",
      title: "フィーチャートグル",
      summary: null,
      translatedAt: new Date().toISOString(),
    });
    await page.getByRole("button", { name: "Sync now" }).click();
    await expect(view.locator("header .translation")).toHaveText("・ EN · Translated");
    await expect(heading).toHaveText("Feature Toggles");
    await expect(view.getByRole("alert")).toHaveCount(0);
  });

  test("押したときにはもう訳し終えていても、訳文に替える", async ({ page, context }) => {
    const { server, article, view } = await open(page, context);
    // 手元はまだ queued のまま、sendo ではほかの端末が訳し終えている（translation_exists が返る）
    server.setTranslation(article.id, {
      language: "en",
      status: "translated",
      title: "フィーチャートグル",
      summary: null,
      translatedAt: new Date().toISOString(),
    });
    await view.getByRole("button", { name: "Translate", exact: true }).click();
    await expect(view.getByRole("heading", { level: 1 })).toHaveText("フィーチャートグル");
    await expect(view.locator("header .translation")).toHaveText("・ EN · Translated");
    await expect(view.getByRole("alert")).toHaveCount(0);
  });

  test("断られたら理由を出し、また押せる", async ({ page, context }) => {
    const { server, view } = await open(page, context);
    server.translationRequestError = { status: 503, code: "translation_unavailable" };
    const button = view.getByRole("button", { name: "Translate", exact: true });
    await button.click();
    await expect(view.getByRole("alert")).toContainText("この Sendo では翻訳を使えません");
    await expect(button).toBeEnabled();
    await expect(view.locator("header .translation")).toHaveText("・ EN · Queued");
  });

  test("translation_exists は、受け付けられたときと同じに出す", async ({ page, context }) => {
    const { server, view } = await open(page, context);
    server.translationRequestError = { status: 409, code: "translation_exists" };
    await view.getByRole("button", { name: "Translate", exact: true }).click();
    await expect(view.locator("header .translation")).toHaveText("・ EN · Translating");
    await expect(view.getByRole("alert")).toHaveCount(0);
  });

  test("オフラインのときは押せない", async ({ page, context }) => {
    const { view } = await open(page, context);
    const button = view.getByRole("button", { name: "Translate", exact: true });
    await context.setOffline(true);
    await expect(button).toBeDisabled();
    await context.setOffline(false);
    await expect(button).toBeEnabled();
  });

  test("t で頼める", async ({ page, context }) => {
    const { server, article, view } = await open(page, context);
    await page.keyboard.press("t");
    await expect(view.locator("header .translation")).toHaveText("・ EN · Translating");
    expect(server.translationRequests).toEqual([article.id]);
  });

  test("und の untranslated の記事には出て、言語を省いた Untranslated のラベルも出る。訳し済みと翻訳なしの記事には出ない", async ({
    page,
    context,
  }) => {
    const server = new FakeSendo();
    const feed = server.subscribe({ url: "https://blog.example/feed.xml", title: "Blog" });
    const now = Date.now();
    server.deliver(feed.id, {
      title: "und",
      publishedAt: now - 1000,
      translation: { ...queued, language: "und", status: "untranslated" },
    });
    server.deliver(feed.id, {
      title: "done",
      publishedAt: now - 2000,
      translation: {
        language: "en",
        status: "translated",
        title: "訳し済み",
        summary: null,
        translatedAt: new Date(now).toISOString(),
      },
    });
    server.deliver(feed.id, { title: "日本語", publishedAt: now - 3000 });
    await routeFakeSendo(context, server);
    await page.goto("/");
    await signIn(page);
    const list = page.locator(".article-list");
    const view = page.locator(".article-view");
    const button = view.getByRole("button", { name: "Translate", exact: true });
    const undItem = list.locator(".item").filter({ hasText: "und" });
    // 一覧の行にも、言語を省いた Untranslated を出す（まだ訳すかどうかを決めていない記事と見分ける）
    await expect(undItem.locator(".translation")).toHaveText("Untranslated");
    await undItem.click();
    await expect(view.getByRole("heading", { level: 1 })).toHaveText("und");
    await expect(view.locator("header .translation")).toHaveText("・ Untranslated");
    await expect(button).toBeVisible();
    for (const title of ["訳し済み", "日本語"]) {
      await list.locator(".item").filter({ hasText: title }).click();
      await expect(view.getByRole("heading", { level: 1 })).toHaveText(title);
      await expect(button).toHaveCount(0);
    }
  });

  test("返る前にほかの記事に移っても止まらず、戻ると届いた状態で出る", async ({
    page,
    context,
  }) => {
    const server = new FakeSendo();
    const feed = server.subscribe({ url: "https://blog.example/feed.xml", title: "Blog" });
    const now = Date.now();
    const article = server.deliver(feed.id, {
      title: "Feature Toggles",
      publishedAt: now - 1000,
      translation: queued,
    });
    server.deliver(feed.id, { title: "Other", publishedAt: now - 2000, translation: queued });
    let release = () => {};
    server.translationRequestGate = new Promise<void>((resolve) => {
      release = resolve;
    });
    await routeFakeSendo(context, server);
    await page.goto("/");
    await signIn(page);
    const list = page.locator(".article-list");
    const view = page.locator(".article-view");
    await list.getByRole("button", { name: "Unread only" }).click();
    await list.locator(".item").filter({ hasText: "Feature Toggles" }).click();
    await view.getByRole("button", { name: "Translate", exact: true }).click();
    await expect.poll(() => server.translationRequests).toEqual([article.id]);

    // 返る前にほかの記事に移る。そちらの Translate は押せる
    await list.locator(".item").filter({ hasText: "Other" }).click();
    await expect(view.getByRole("heading", { level: 1 })).toHaveText("Other");
    await expect(view.getByRole("button", { name: "Translate", exact: true })).toBeEnabled();
    release();

    await list.locator(".item").filter({ hasText: "Feature Toggles" }).click();
    await expect(view.locator("header .translation")).toHaveText("・ EN · Translating");
    server.setTranslation(article.id, {
      language: "en",
      status: "translated",
      title: "フィーチャートグル",
      summary: null,
      translatedAt: new Date(now).toISOString(),
    });
    await page.getByRole("button", { name: "Sync now" }).click();
    await expect(view.getByRole("heading", { level: 1 })).toHaveText("フィーチャートグル");
  });

  test("ほかのタブでも Translating になり、押せなくなる", async ({ page, context }) => {
    const { view } = await open(page, context);
    const other = await context.newPage();
    await other.goto(page.url());
    const otherView = other.locator(".article-view");
    await expect(otherView.locator("header .translation")).toHaveText("・ EN · Queued");
    await view.getByRole("button", { name: "Translate", exact: true }).click();
    await expect(otherView.locator("header .translation")).toHaveText("・ EN · Translating");
    await expect(otherView.getByRole("button", { name: "Translate", exact: true })).toHaveCount(0);
  });
});

/**
 * Opus で訳し直してもらう（docs/decisions/translation.md の 3、5、6）。More actions に置き、確かめの
 * 窓で選んでから頼む
 */
test.describe("Retranslate with Opus", () => {
  const sonnet = (at: number) => ({
    language: "en",
    status: "translated",
    title: "フィーチャートグル",
    summary: null,
    translatedAt: new Date(at).toISOString(),
    retranslated: false,
  });
  const opus = (at: number) => ({
    ...sonnet(at),
    title: "機能フラグ",
    retranslated: true,
  });

  async function open(page: Page, context: BrowserContext, translation: unknown) {
    const server = new FakeSendo();
    const feed = server.subscribe({ url: "https://blog.example/feed.xml", title: "Blog" });
    const article = server.deliver(feed.id, {
      title: "Feature Toggles",
      url: "https://blog.example/toggles",
      translation,
    });
    await routeFakeSendo(context, server);
    await page.goto("/");
    await signIn(page);
    await page.locator(".article-list .item").first().click();
    const view = page.locator(".article-view");
    return { server, article, view };
  }

  const retranslateButton = (page: Page) =>
    page.getByRole("dialog", { name: "Article actions" }).getByRole("button", {
      name: "Retranslate with Opus",
    });

  async function openActions(page: Page) {
    await page.locator(".article-view").getByRole("button", { name: "More actions" }).click();
    await expect(page.getByRole("dialog", { name: "Article actions" })).toBeVisible();
  }

  test("確かめてから頼み、Translating になり、訳し直した訳文が届くと見出しが替わる", async ({
    page,
    context,
  }) => {
    const { server, article, view } = await open(page, context, sonnet(Date.now() - 60_000));
    const heading = view.getByRole("heading", { level: 1 });
    await expect(heading).toHaveText("フィーチャートグル");

    // やめると頼まない
    await openActions(page);
    await retranslateButton(page).click();
    const confirm = page.getByRole("dialog", { name: "Retranslate with Opus" });
    await expect(confirm).toContainText(
      "訳し直した訳文は、この記事と、同じ元記事のほかの記事を読むすべての人の訳文を置き換えます。",
    );
    await confirm.getByRole("button", { name: "Cancel" }).click();
    await expect(confirm).toBeHidden();
    expect(server.retranslationRequests).toEqual([]);

    await openActions(page);
    await retranslateButton(page).click();
    await confirm.getByRole("button", { name: "Retranslate", exact: true }).click();
    await expect(view.locator("header .translation")).toHaveText("・ EN · Translating");
    expect(server.retranslationRequests).toEqual([article.id]);
    expect(server.translationRequests).toEqual([]);
    // もとの訳文は残り、訳し直しの最中は出さない
    await expect(heading).toHaveText("フィーチャートグル");
    await openActions(page);
    await expect(retranslateButton(page)).toHaveCount(0);
    await page.keyboard.press("Escape");

    server.setTranslation(article.id, opus(Date.now()));
    await page.getByRole("button", { name: "Sync now" }).click();
    // この端末で頼んだ記事なので、開いたままでも訳し直した訳文に替える
    await expect(heading).toHaveText("機能フラグ");
    await expect(view.locator("header .translation")).toHaveText("・ EN · Translated");
    await openActions(page);
    await expect(retranslateButton(page)).toHaveCount(0);
  });

  test("sendo で訳し直せずに戻ったら日本語の文で知らせ、もとの訳文のまま、もう一度頼める", async ({
    page,
    context,
  }) => {
    const before = sonnet(Date.now() - 60_000);
    const { server, article, view } = await open(page, context, before);
    await openActions(page);
    await retranslateButton(page).click();
    const confirm = page.getByRole("dialog", { name: "Retranslate with Opus" });
    await confirm.getByRole("button", { name: "Retranslate", exact: true }).click();
    await expect(view.locator("header .translation")).toHaveText("・ EN · Translating");

    server.setTranslation(article.id, before);
    await page.getByRole("button", { name: "Sync now" }).click();
    await expect(view.getByRole("alert")).toHaveText(
      "訳し直せませんでした。もとの訳文のままです。More actions の Retranslate with Opus でもう一度頼めます。",
    );
    await expect(view.getByRole("heading", { level: 1 })).toHaveText("フィーチャートグル");
    await expect(view.locator("header .translation")).toHaveText("・ EN · Translated");

    await openActions(page);
    await retranslateButton(page).click();
    await confirm.getByRole("button", { name: "Retranslate", exact: true }).click();
    await expect(view.locator("header .translation")).toHaveText("・ EN · Translating");
    await expect(view.getByRole("alert")).toHaveCount(0);
    expect(server.retranslationRequests).toEqual([article.id, article.id]);
  });

  test("断られたら（もう訳し直してあった）理由を出し、同期して出さなくなる。開いている見出しは替えない", async ({
    page,
    context,
  }) => {
    const { server, article, view } = await open(page, context, sonnet(Date.now() - 60_000));
    // ほかの端末が訳し直したが、この端末はまだ同期していない
    server.setTranslation(article.id, opus(Date.now()));
    await openActions(page);
    await retranslateButton(page).click();
    await page
      .getByRole("dialog", { name: "Retranslate with Opus" })
      .getByRole("button", { name: "Retranslate", exact: true })
      .click();
    await expect(view.getByRole("alert")).toHaveText(
      "この記事は、もう訳し直したか、訳し直しの最中か、訳し直せる訳文がありません。",
    );
    // 断られたので同期し、訳し直しの印が届く（Sync now を押さなくても）
    await expect
      .poll(async () => {
        await openActions(page);
        const count = await retranslateButton(page).count();
        await page.keyboard.press("Escape");
        return count;
      })
      .toBe(0);
    await expect(view.getByRole("heading", { level: 1 })).toHaveText("フィーチャートグル");
  });

  test("訳し直した記事と、訳文のない記事には出さない", async ({ page, context }) => {
    const server = new FakeSendo();
    const feed = server.subscribe({ url: "https://blog.example/feed.xml", title: "Blog" });
    const now = Date.now();
    server.deliver(feed.id, {
      title: "Retranslated",
      url: "https://blog.example/retranslated",
      publishedAt: now - 1000,
      translation: opus(now),
    });
    server.deliver(feed.id, {
      title: "Queued",
      url: "https://blog.example/queued",
      publishedAt: now - 2000,
      translation: { ...sonnet(0), status: "queued", title: null, translatedAt: null },
    });
    await routeFakeSendo(context, server);
    await page.goto("/");
    await signIn(page);
    const view = page.locator(".article-view");
    const items = page.locator(".article-list .item");

    await items.nth(0).click();
    await expect(view.getByRole("heading", { level: 1 })).toHaveText("機能フラグ");
    await openActions(page);
    await expect(page.getByRole("button", { name: "Show original text" })).toBeVisible();
    await expect(retranslateButton(page)).toHaveCount(0);
    await page.keyboard.press("Escape");

    await items.nth(1).click();
    await expect(view.getByRole("heading", { level: 1 })).toHaveText("Queued");
    await openActions(page);
    await expect(retranslateButton(page)).toHaveCount(0);
  });

  test("同じ元記事のほかの記事を訳し直して、訳し直しが写って印が届いた記事には出さない。開いていれば見出しは替えず、失敗の文も出さない", async ({
    page,
    context,
  }) => {
    const server = new FakeSendo();
    const now = Date.now();
    const url = "https://blog.example/toggles";
    const first = server.deliver(
      server.subscribe({ url: "https://blog.example/feed.xml", title: "Blog" }).id,
      { title: "Feature Toggles", url, publishedAt: now - 1000, translation: sonnet(now - 60_000) },
    );
    const second = server.deliver(
      server.subscribe({ url: "https://news.example/feed.xml", title: "News" }).id,
      {
        title: "Feature Toggles (discussion)",
        url,
        publishedAt: now - 2000,
        translation: { ...sonnet(now - 60_000), title: "フィーチャートグルの議論" },
      },
    );
    server.translatedContents.set(second.id, "<p>議論の訳した本文</p>");
    await routeFakeSendo(context, server);
    await page.goto("/");
    await signIn(page);
    const view = page.locator(".article-view");
    const heading = view.getByRole("heading", { level: 1 });
    const items = page.locator(".article-list .item");

    await items.nth(0).click();
    await expect(heading).toHaveText("フィーチャートグル");
    await openActions(page);
    await retranslateButton(page).click();
    const confirm = page.getByRole("dialog", { name: "Retranslate with Opus" });
    await expect(confirm).toContainText("同じ元記事のほかの記事を読むすべての人の訳文");
    await confirm.getByRole("button", { name: "Retranslate", exact: true }).click();
    await expect(view.locator("header .translation")).toHaveText("・ EN · Translating");
    expect(server.retranslationRequests).toEqual([first.id]);

    // 写る先の記事を開いている間に、sendo が同じ元記事のほかの記事にも訳し直しを写した。訳した本文を
    // 出すまで待つ（本文を待っている間に訳文が替われば替えるため。決定の 3）
    await items.nth(1).click();
    await expect(heading).toHaveText("フィーチャートグルの議論");
    await expect(view.getByText("議論の訳した本文")).toBeVisible();
    server.setTranslation(first.id, opus(Date.now()));
    server.setTranslation(second.id, {
      ...opus(Date.now()),
      title: "機能フラグの議論",
    });
    await page.getByRole("button", { name: "Sync now" }).click();
    // この端末で頼んだ記事ではないので、開いている見出しは替えず、失敗の文も出さない
    await expect
      .poll(async () => {
        await openActions(page);
        const count = await retranslateButton(page).count();
        await page.keyboard.press("Escape");
        return count;
      })
      .toBe(0);
    await expect(heading).toHaveText("フィーチャートグルの議論");
    await expect(view.locator("header .translation")).toHaveText("・ EN · Translated");
    await expect(view.getByText("訳し直せませんでした", { exact: false })).toHaveCount(0);
    await expect(items.nth(1)).toContainText("機能フラグの議論");

    // 頼んだ記事は、訳し直した訳文で出る
    await items.nth(0).click();
    await expect(heading).toHaveText("機能フラグ");
    expect(server.retranslationRequests).toEqual([first.id]);
  });

  test("ほかの端末で訳し直されたら、同期のあとで出さない。開いている見出しは替えない", async ({
    page,
    context,
  }) => {
    const { server, article, view } = await open(page, context, sonnet(Date.now() - 60_000));
    server.setTranslation(article.id, opus(Date.now()));
    await page.getByRole("button", { name: "Sync now" }).click();
    await expect(view.locator("header .translation")).toHaveText("・ EN · Translated");
    await expect(view.getByRole("heading", { level: 1 })).toHaveText("フィーチャートグル");
    await openActions(page);
    await expect(retranslateButton(page)).toHaveCount(0);
  });

  test("訳し直せなかったあとでほかの端末が訳し直しても、開いている見出しは替えない", async ({
    page,
    context,
  }) => {
    const before = sonnet(Date.now() - 60_000);
    const { server, article, view } = await open(page, context, before);
    const heading = view.getByRole("heading", { level: 1 });
    await openActions(page);
    await retranslateButton(page).click();
    await page
      .getByRole("dialog", { name: "Retranslate with Opus" })
      .getByRole("button", { name: "Retranslate", exact: true })
      .click();
    await expect(view.locator("header .translation")).toHaveText("・ EN · Translating");
    server.setTranslation(article.id, before);
    await page.getByRole("button", { name: "Sync now" }).click();
    await expect(view.getByRole("alert")).toBeVisible();

    // ほかの端末が頼み、訳し直し終えた
    server.setTranslation(article.id, { ...before, status: "translating" });
    await page.getByRole("button", { name: "Sync now" }).click();
    await expect(view.locator("header .translation")).toHaveText("・ EN · Translating");
    server.setTranslation(article.id, opus(Date.now()));
    await page.getByRole("button", { name: "Sync now" }).click();
    await expect(view.locator("header .translation")).toHaveText("・ EN · Translated");
    await expect(heading).toHaveText("フィーチャートグル");
  });

  test("開いたあとに訳文が届いた記事で頼むと、原文のまま待ち、訳し直した訳文が届いたら替える", async ({
    page,
    context,
  }) => {
    const { server, article, view } = await open(page, context, {
      ...sonnet(0),
      status: "queued",
      title: null,
      translatedAt: null,
    });
    const heading = view.getByRole("heading", { level: 1 });
    await expect(heading).toHaveText("Feature Toggles");
    // 開いている間にバッチが終わった。開いている見出しは替えない（決定の 3）
    server.setTranslation(article.id, sonnet(Date.now() - 60_000));
    await page.getByRole("button", { name: "Sync now" }).click();
    await expect(view.locator("header .translation")).toHaveText("・ EN · Translated");
    await expect(heading).toHaveText("Feature Toggles");

    await openActions(page);
    await retranslateButton(page).click();
    await page
      .getByRole("dialog", { name: "Retranslate with Opus" })
      .getByRole("button", { name: "Retranslate", exact: true })
      .click();
    await expect(view.locator("header .translation")).toHaveText("・ EN · Translating");
    // 頼んだのは訳し直しなので、Sonnet の訳文には替えない
    await expect(heading).toHaveText("Feature Toggles");

    server.setTranslation(article.id, opus(Date.now()));
    await page.getByRole("button", { name: "Sync now" }).click();
    await expect(heading).toHaveText("機能フラグ");
  });

  test("その場の翻訳で訳文に替わったあとは、ほかの端末が訳し直しても、開いている見出しは替えない", async ({
    page,
    context,
  }) => {
    const queued = { ...sonnet(0), status: "queued", title: null, translatedAt: null };
    const { server, article, view } = await open(page, context, queued);
    const heading = view.getByRole("heading", { level: 1 });
    await view.getByRole("button", { name: "Translate", exact: true }).click();
    await expect(view.locator("header .translation")).toHaveText("・ EN · Translating");
    server.translatedContents.set(article.id, "<p>訳した本文</p>");
    server.setTranslation(article.id, sonnet(Date.now() - 60_000));
    await page.getByRole("button", { name: "Sync now" }).click();
    await expect(heading).toHaveText("フィーチャートグル");
    // 訳した本文を出すまで待つ（訳した要約を出して本文を待っている間に訳文が替われば、替えるため。
    // 決定の 3）
    await expect(view.getByText("訳した本文")).toBeVisible();

    // ほかの端末が訳し直した。この端末が頼んだものではない
    server.setTranslation(article.id, opus(Date.now()));
    await page.getByRole("button", { name: "Sync now" }).click();
    await openActions(page);
    await expect(retranslateButton(page)).toHaveCount(0);
    await page.keyboard.press("Escape");
    await expect(heading).toHaveText("フィーチャートグル");
  });

  test("確かめの窓は、記事を替えると閉じる", async ({ page, context }) => {
    const { server, view } = await open(page, context, sonnet(Date.now() - 60_000));
    await openActions(page);
    await retranslateButton(page).click();
    const confirm = page.getByRole("dialog", { name: "Retranslate with Opus" });
    await expect(confirm).toBeVisible();
    await page.goBack();
    await expect(view.getByRole("heading", { level: 1 })).toHaveCount(0);
    await expect(confirm).toBeHidden();
    expect(server.retranslationRequests).toEqual([]);
  });

  test("オフラインのときは押せない", async ({ page, context }) => {
    await open(page, context, sonnet(Date.now() - 60_000));
    await openActions(page);
    const button = retranslateButton(page);
    await context.setOffline(true);
    await expect(button).toBeDisabled();
    await context.setOffline(false);
    await expect(button).toBeEnabled();
  });
});
