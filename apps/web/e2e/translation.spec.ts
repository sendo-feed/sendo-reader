import { type BrowserContext, expect, type Locator, type Page, test } from "@playwright/test";
import { FakeSendo, routeFakeSendo, signIn } from "./fake-sendo";

/** 翻訳のラベルの枠（docs/decisions/translation.md の 1）。toHaveText に配列を渡し、枠ごとのテキストを並べた順に確かめる */
const chips = (scope: Locator) => scope.locator(".translation .chip");

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
  await expect(chips(rows.nth(0))).toHaveText(["EN", "Translated"]);
  await expect(rows.nth(1)).toContainText("Feature Toggles");
  await expect(chips(rows.nth(1))).toHaveText(["FR", "Queued"]);
  await expect(rows.nth(2).locator(".translation")).toHaveCount(0);

  // 記事の画面にも同じラベルを出す
  await rows.nth(0).locator(".item").click();
  const view = page.locator(".article-view");
  await expect(view.getByRole("heading", { level: 1 })).toHaveText(
    "コードモッドでリファクタリングする",
  );
  await expect(chips(view.locator("header"))).toHaveText(["EN", "Translated"]);

  server.setTranslation(waiting.id, {
    language: "fr",
    status: "translated",
    title: "フィーチャートグル",
    summary: null,
    translatedAt: new Date(now).toISOString(),
  });
  await page.getByRole("button", { name: "Sync now" }).click();
  await expect(rows.nth(1)).toContainText("フィーチャートグル");
  await expect(chips(rows.nth(1))).toHaveText(["FR", "Translated"]);
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
  await expect(chips(view.locator("header"))).toHaveText(["FR", "Translated"]);
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

/**
 * 記事の画面のラベルに、訳したモデルと思考量を足す（docs/decisions/translation.md の 1。sendo の
 * translation.md の 18）。一覧の行と、訳文のない記事には足さない
 */
test("記事の画面のラベルに訳したモデルと思考量を足し、一覧の行と訳文のない記事には足さない", async ({
  page,
  context,
}) => {
  const server = new FakeSendo();
  const feed = server.subscribe({ url: "https://blog.example/feed.xml", title: "Blog" });
  const now = Date.now();
  const translated = (title: string) => ({
    language: "en",
    status: "translated",
    title,
    summary: null,
    translatedAt: new Date(now).toISOString(),
    retranslated: false,
    failure: null,
  });
  const cases: { title: string; translation: unknown; label: string[] }[] = [
    {
      title: "Haiku",
      translation: { ...translated("ハイク"), model: "claude-haiku-5-5", effort: "low" },
      label: ["EN", "Translated", "Haiku 5.5", "low"],
    },
    {
      title: "Unknown",
      translation: { ...translated("知らないモデル"), model: "gpt-unknown", effort: "ultra" },
      label: ["EN", "Translated", "gpt-unknown", "ultra"],
    },
    {
      title: "No effort",
      translation: { ...translated("思考量なし"), model: "claude-sonnet-5-5", effort: null },
      label: ["EN", "Translated", "Sonnet 5.5"],
    },
    {
      title: "No model",
      translation: { ...translated("モデルなし"), model: null, effort: "low" },
      label: ["EN", "Translated"],
    },
    {
      // 条件に対応する前の sendo（項目がない）
      title: "Old sendo",
      translation: translated("古い sendo"),
      label: ["EN", "Translated"],
    },
    {
      // 文字でない値と空の文字は、届かないもの。翻訳のほかの項目は使う
      title: "Broken",
      translation: { ...translated("壊れた条件"), model: 5, effort: "" },
      label: ["EN", "Translated"],
    },
    {
      title: "Queued",
      translation: {
        ...translated("unused"),
        status: "queued",
        title: null,
        translatedAt: null,
        model: null,
        effort: null,
      },
      label: ["EN", "Queued"],
    },
  ];
  for (const [i, { title, translation }] of cases.entries()) {
    server.deliver(feed.id, { title, publishedAt: now - i * 1000, translation });
  }
  await routeFakeSendo(context, server);
  await page.goto("/");
  await signIn(page);

  const list = page.locator(".article-list");
  const view = page.locator(".article-view");
  await expect(list.locator(".row")).toHaveCount(cases.length);
  // 一覧の行には足さない
  for (const [i, { label }] of cases.entries()) {
    await expect(chips(list.locator(".row").nth(i))).toHaveText(label.slice(0, 2));
  }
  await list.getByRole("button", { name: "Unread only" }).click();
  for (const [i, { label }] of cases.entries()) {
    await list.locator(".item").nth(i).click();
    await expect(chips(view.locator("header"))).toHaveText(label);
  }
});

/**
 * ラベルの見た目（docs/decisions/translation.md の 1）。項目ごとの枠に分け、言語の枠だけ、どの言語も
 * 同じ 1 色で塗る（明るいテーマでも暗いテーマでも読める）。見た目の区切り文字は出さず、読み上げでは
 * 区切る。長いモデルの ID でも、狭い画面で枠が折り返して、横にはみ出さない
 */
test("ラベルは枠に分けて言語の枠だけを塗り、読み上げでは区切り、狭い画面でもはみ出さない", async ({
  page,
  context,
}) => {
  const server = new FakeSendo();
  const feed = server.subscribe({ url: "https://blog.example/feed.xml", title: "Blog" });
  const now = Date.now();
  const translated = (title: string, model: string) => ({
    language: "en",
    status: "translated",
    title,
    summary: null,
    translatedAt: new Date(now).toISOString(),
    retranslated: false,
    failure: null,
    model,
    effort: "low",
  });
  const longModel = "claude-experimental-long-context-translation-preview-model-20261123-build-42";
  server.deliver(feed.id, {
    title: "Haiku",
    publishedAt: now - 1000,
    translation: translated("ハイク", "claude-haiku-5-5"),
  });
  server.deliver(feed.id, {
    title: "Long model",
    publishedAt: now - 2000,
    translation: translated("長いモデルの ID", longModel),
  });
  server.deliver(feed.id, {
    title: "French",
    publishedAt: now - 3000,
    translation: { ...translated("フランス語", "claude-haiku-5-5"), language: "fr" },
  });
  await routeFakeSendo(context, server);
  await page.setViewportSize({ width: 360, height: 740 });
  await page.goto("/");
  await signIn(page);

  const list = page.locator(".article-list");
  const view = page.locator(".article-view");
  const rows = list.locator(".row");
  await expect(rows).toHaveCount(3);
  await list.getByRole("button", { name: "Unread only" }).click();

  /** 枠ごとの背景と文字の色、文字と背景の対比（WCAG の式） */
  const styles = (scope: Locator) =>
    chips(scope).evaluateAll((elements) => {
      const luminance = (color: string) => {
        const [r, g, b] = (color.match(/[\d.]+/g) ?? []).slice(0, 3).map((value) => {
          const c = Number(value) / 255;
          return c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
        });
        return 0.2126 * (r ?? 0) + 0.7152 * (g ?? 0) + 0.0722 * (b ?? 0);
      };
      return elements.map((element) => {
        const style = getComputedStyle(element);
        const [light, dark] = [luminance(style.color), luminance(style.backgroundColor)].sort(
          (a, b) => b - a,
        );
        return {
          background: style.backgroundColor,
          contrast: ((light ?? 0) + 0.05) / ((dark ?? 0) + 0.05),
        };
      });
    });
  const TRANSPARENT = "rgba(0, 0, 0, 0)";

  const backgrounds = new Set<string | undefined>();
  for (const scheme of ["light", "dark"] as const) {
    await page.emulateMedia({ colorScheme: scheme });
    // 一覧の行：言語の枠だけ塗り、状態の枠は線だけ。どの言語も同じ色
    const [en, enStatus] = await styles(rows.nth(0));
    backgrounds.add(en?.background);
    const [fr] = await styles(rows.nth(2));
    expect(en?.background).not.toBe(TRANSPARENT);
    expect(en?.contrast).toBeGreaterThanOrEqual(4.5);
    expect(fr?.background).toBe(en?.background);
    expect(enStatus?.background).toBe(TRANSPARENT);
  }
  // テーマごとの色に替わっている
  expect(backgrounds.size).toBe(2);
  await page.emulateMedia({ colorScheme: "light" });
  // 読み上げでは、枠の間を区切る（見た目には区切り文字を出さない。Chromium は枠の前後に空白を足す）
  await expect(rows.nth(0).locator(".item")).toHaveAccessibleName(/ EN\s*, Translated$/);
  await expect(chips(rows.nth(0))).toHaveText(["EN", "Translated"]);

  await rows.nth(0).locator(".item").click();
  const header = view.locator("header");
  await expect(chips(header)).toHaveText(["EN", "Translated", "Haiku 5.5", "low"]);
  for (const scheme of ["light", "dark"] as const) {
    await page.emulateMedia({ colorScheme: scheme });
    const [language, ...others] = await styles(header);
    expect(language?.background).not.toBe(TRANSPARENT);
    expect(language?.contrast).toBeGreaterThanOrEqual(4.5);
    expect(others.map(({ background }) => background)).toEqual([
      TRANSPARENT,
      TRANSPARENT,
      TRANSPARENT,
    ]);
  }
  await page.emulateMedia({ colorScheme: "light" });
  await expect(header.locator(".translation")).toHaveText(
    /^\s*EN\s*, Translated\s*, Haiku 5\.5\s*, low\s*$/,
  );

  // 長いモデルの ID：届いたまま出し、枠の中で折り返して、ページを横にはみ出さない
  await page.goBack();
  await rows.nth(1).locator(".item").click();
  await expect(chips(header)).toHaveText(["EN", "Translated", longModel, "low"]);
  const overflow = await header.evaluate((element) => {
    const right = element.getBoundingClientRect().right;
    return {
      page: document.documentElement.scrollWidth - document.documentElement.clientWidth,
      chips: [...element.querySelectorAll(".chip")].map(
        (chip) => chip.getBoundingClientRect().right - right,
      ),
    };
  });
  expect(overflow.page).toBeLessThanOrEqual(0);
  for (const over of overflow.chips) expect(over).toBeLessThanOrEqual(0.5);
});

/**
 * 一覧の行のラベル（docs/decisions/translation.md の 1）。サムネイルのある行を狭い画面（360px、320px）で
 * 出しても、枠が文字の入る部分（.text）の右端を超えてサムネイルの下にもぐらない。保存の印・アイコン・
 * フィードの名前・時刻は 1 行のまま（時刻は落ちない）で、入りきらなければラベルだけを次の行に送る。
 * フィードの名前は少しでも見せる。2 行になっても、行の高さ（6.5rem）からはみ出さない。時刻の長い
 * 去年以前の記事と、翻訳のない記事も入れ、既定の文字の大きさと最大（xlarge）で確かめる
 */
for (const width of [360, 320]) {
  for (const textSize of ["medium", "xlarge"] as const) {
    test(`サムネイルのある一覧の行でも、狭い画面でラベルがはみ出さず、時刻が落ちない（${width}px、文字の大きさ ${textSize}）`, async ({
      page,
      context,
    }) => {
      const server = new FakeSendo();
      const feed = server.subscribe({
        url: "https://blog.example/feed.xml",
        title: "Engineering Blog of a Very Long Name",
        iconUrl: server.imageUrl("https://blog.example/favicon.ico"),
      });
      if (textSize !== "medium") {
        for (const device of ["mobile", "desktop"]) {
          server.putSetting(device, "reader.textSize", textSize);
        }
      }
      const now = Date.now();
      // 去年以前の記事は、時刻が日付（2025/11/23 など）になり長い
      const old = new Date(new Date(now).getFullYear() - 1, 10, 23).getTime();
      const translation = (status: string) => ({
        language: "en",
        status,
        title: null,
        summary: null,
        translatedAt: status === "translated" ? new Date(now).toISOString() : null,
        retranslated: false,
        failure: null,
      });
      // Untranslated がいちばん長い。タイトルは 3 行に折り返す長さにする
      const cases: { name: string; publishedAt: number; label: string[] | null }[] = [
        { name: "untranslated", publishedAt: now - 1000, label: ["EN", "Untranslated"] },
        { name: "translating", publishedAt: now - 2000, label: ["EN", "Translating"] },
        { name: "translated", publishedAt: now - 3000, label: ["EN", "Translated"] },
        { name: "queued", publishedAt: now - 4000, label: ["EN", "Queued"] },
        { name: "none", publishedAt: now - 5000, label: null },
        { name: "old-untranslated", publishedAt: old, label: ["EN", "Untranslated"] },
        { name: "old-none", publishedAt: old - 1000, label: null },
      ];
      for (const { name, publishedAt, label } of cases) {
        server.deliver(feed.id, {
          title: `${name} の記事。タイトルが長くて、狭い画面では何行にも折り返す。`.repeat(3),
          publishedAt,
          thumbnailUrl: server.imageUrl(`https://blog.example/${name}.png`),
          ...(label !== null && {
            translation: translation(name.replace(/^old-/, "")),
          }),
        });
      }
      await routeFakeSendo(context, server);
      await page.setViewportSize({ width, height: 900 });
      await page.goto("/");
      await signIn(page);
      if (textSize !== "medium") {
        await expect(page.locator("html")).toHaveAttribute("data-text-size", textSize);
      }

      const rows = page.locator(".article-list .row");
      await expect(rows).toHaveCount(cases.length);
      await expect(page.locator(".article-list .thumb:visible")).toHaveCount(cases.length);
      for (const [i, { name, label }] of cases.entries()) {
        const row = rows.nth(i);
        if (label === null) await expect(chips(row)).toHaveCount(0);
        else await expect(chips(row)).toHaveText(label);
        const box = await row.evaluate((element) => {
          const rect = (selector: string) => {
            const found = element.querySelector(selector);
            if (found === null) throw new Error(selector);
            return found.getBoundingClientRect();
          };
          const text = rect(".text");
          const item = rect(".item");
          const feed = rect(".feed");
          const time = rect(".time");
          const thumb = rect(".thumb");
          const chipRects = [...element.querySelectorAll(".chip")].map((chip) =>
            chip.getBoundingClientRect(),
          );
          // 枠の右端（枠のない行は -Infinity で、確かめることがない）
          const right = Math.max(...chipRects.map((chip) => chip.right), Number.NEGATIVE_INFINITY);
          return {
            overText: right - text.right,
            leftOfThumb: right - thumb.left,
            // 同じ行に並ぶ枠と、フィードの名前・時刻が重ならない
            overlap: Math.max(
              ...chipRects
                .filter((chip) => chip.top < time.bottom && time.top < chip.bottom)
                .map((chip) => time.right - chip.left),
              Number.NEGATIVE_INFINITY,
            ),
            timeDrop: Math.abs(time.top - feed.top),
            feedWidth: feed.width,
            textTop: text.top - item.top,
            textBottom: item.bottom - text.bottom,
          };
        });
        expect(box.overText, name).toBeLessThanOrEqual(0.5);
        expect(box.leftOfThumb, name).toBeLessThan(0);
        expect(box.overlap, name).toBeLessThanOrEqual(0);
        expect(box.timeDrop, name).toBeLessThan(1);
        // 320px・xlarge の去年以前の記事は、保存の印・アイコン・長い日付だけで幅を使い切り、フィードの
        // 名前が 0 になる（ラベルのない行も同じ。翻訳のラベルとは関わらない、前からの制限）
        if (!(width === 320 && textSize === "xlarge" && name.startsWith("old-"))) {
          expect(box.feedWidth, name).toBeGreaterThan(10);
        }
        expect(box.textTop, name).toBeGreaterThanOrEqual(0);
        expect(box.textBottom, name).toBeGreaterThanOrEqual(0);
      }
      expect(
        await page.evaluate(
          () => document.documentElement.scrollWidth - document.documentElement.clientWidth,
        ),
      ).toBeLessThanOrEqual(0);
    });
  }
}

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
    await expect(chips(view.locator("header"))).toHaveText(["EN", "Queued"]);
    await button.click();
    await expect(chips(view.locator("header"))).toHaveText(["EN", "Translating"]);
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
    await expect(chips(view.locator("header"))).toHaveText(["EN", "Translated"]);
  });

  test("sendo で訳せずに戻ったら日本語の文で知らせ、もう一度頼める", async ({ page, context }) => {
    const { server, article, view } = await open(page, context);
    await view.getByRole("button", { name: "Translate", exact: true }).click();
    await expect(chips(view.locator("header"))).toHaveText(["EN", "Translating"]);
    server.setTranslation(article.id, { ...queued, status: "untranslated" });
    await page.getByRole("button", { name: "Sync now" }).click();
    await expect(view.getByRole("alert")).toHaveText(
      "訳せませんでした。Translate でもう一度頼めます。",
    );
    await expect(chips(view.locator("header"))).toHaveText(["EN", "Untranslated"]);
    await view.getByRole("button", { name: "Translate", exact: true }).click();
    await expect(chips(view.locator("header"))).toHaveText(["EN", "Translating"]);
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
    await expect(chips(view.locator("header"))).toHaveText(["EN", "Translating"]);
    server.setTranslation(article.id, { ...queued, status: "untranslated" });
    await page.getByRole("button", { name: "Sync now" }).click();
    await expect(view.getByRole("alert")).toBeVisible();

    // ほかの端末が頼み、訳し終えた
    server.setTranslation(article.id, { ...queued, status: "translating" });
    await page.getByRole("button", { name: "Sync now" }).click();
    await expect(chips(view.locator("header"))).toHaveText(["EN", "Translating"]);
    server.setTranslation(article.id, {
      language: "en",
      status: "translated",
      title: "フィーチャートグル",
      summary: null,
      translatedAt: new Date().toISOString(),
    });
    await page.getByRole("button", { name: "Sync now" }).click();
    await expect(chips(view.locator("header"))).toHaveText(["EN", "Translated"]);
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
    await expect(chips(view.locator("header"))).toHaveText(["EN", "Translated"]);
    await expect(view.getByRole("alert")).toHaveCount(0);
  });

  test("断られたら理由を出し、また押せる", async ({ page, context }) => {
    const { server, view } = await open(page, context);
    server.translationRequestError = { status: 503, code: "translation_unavailable" };
    const button = view.getByRole("button", { name: "Translate", exact: true });
    await button.click();
    await expect(view.getByRole("alert")).toContainText("この Sendo では翻訳を使えません");
    await expect(button).toBeEnabled();
    await expect(chips(view.locator("header"))).toHaveText(["EN", "Queued"]);
  });

  test("translation_exists は、受け付けられたときと同じに出す", async ({ page, context }) => {
    const { server, view } = await open(page, context);
    server.translationRequestError = { status: 409, code: "translation_exists" };
    await view.getByRole("button", { name: "Translate", exact: true }).click();
    await expect(chips(view.locator("header"))).toHaveText(["EN", "Translating"]);
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
    await expect(chips(view.locator("header"))).toHaveText(["EN", "Translating"]);
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
    await expect(chips(undItem)).toHaveText(["Untranslated"]);
    await undItem.click();
    await expect(view.getByRole("heading", { level: 1 })).toHaveText("und");
    await expect(chips(view.locator("header"))).toHaveText(["Untranslated"]);
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
    await expect(chips(view.locator("header"))).toHaveText(["EN", "Translating"]);
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
    await expect(chips(otherView.locator("header"))).toHaveText(["EN", "Queued"]);
    await view.getByRole("button", { name: "Translate", exact: true }).click();
    await expect(chips(otherView.locator("header"))).toHaveText(["EN", "Translating"]);
    await expect(otherView.getByRole("button", { name: "Translate", exact: true })).toHaveCount(0);
  });
});

/**
 * 品質優先の段階で訳し直してもらう（docs/decisions/translation.md の 1、3、5、6）。More actions に
 * 置き、確かめの窓で選んでから頼む。記事の画面のラベルには、届いた翻訳のモデルと思考量を出す
 */
test.describe("Retranslate (High quality)", () => {
  const sonnet = (at: number) => ({
    language: "en",
    status: "translated",
    title: "フィーチャートグル",
    summary: null,
    translatedAt: new Date(at).toISOString(),
    retranslated: false,
    model: "claude-sonnet-5-5",
    effort: "medium",
  });
  const opus = (at: number) => ({
    ...sonnet(at),
    title: "機能フラグ",
    retranslated: true,
    model: "claude-opus-5-5",
    effort: "high",
  });
  const SONNET_LABEL = ["EN", "Translated", "Sonnet 5.5", "medium"];
  const OPUS_LABEL = ["EN", "Translated", "Opus 5.5", "high"];

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
      name: "Retranslate (High quality)",
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
    await expect(chips(view.locator("header"))).toHaveText(SONNET_LABEL);

    // やめると頼まない。窓はボタンと同じ名前で、品質を優先するモデルで訳し直すことと、置き換えを伝える
    await openActions(page);
    await retranslateButton(page).click();
    const confirm = page.getByRole("dialog", { name: "Retranslate (High quality)" });
    await expect(confirm).toContainText("品質を優先するモデルで訳し直します。");
    await expect(confirm).toContainText(
      "訳し直した訳文は、この記事と、同じ元記事のほかの記事を読むすべての人の訳文を置き換えます。",
    );
    await confirm.getByRole("button", { name: "Cancel" }).click();
    await expect(confirm).toBeHidden();
    expect(server.retranslationRequests).toEqual([]);

    await openActions(page);
    await retranslateButton(page).click();
    await confirm.getByRole("button", { name: "Retranslate", exact: true }).click();
    // 頼んだ印のある間と、訳し直しの最中（もとの訳文を出していて、届く条件ももとのもの）は、モデルと
    // 思考量を足さない
    await expect(chips(view.locator("header"))).toHaveText(["EN", "Translating"]);
    expect(server.retranslationRequests).toEqual([article.id]);
    expect(server.translationRequests).toEqual([]);
    await page.getByRole("button", { name: "Sync now" }).click();
    await expect(page.getByRole("button", { name: "Sync now" })).toBeEnabled();
    await expect(chips(view.locator("header"))).toHaveText(["EN", "Translating"]);
    // もとの訳文は残り、訳し直しの最中は出さない
    await expect(heading).toHaveText("フィーチャートグル");
    await openActions(page);
    await expect(retranslateButton(page)).toHaveCount(0);
    await page.keyboard.press("Escape");

    server.setTranslation(article.id, opus(Date.now()));
    await page.getByRole("button", { name: "Sync now" }).click();
    // この端末で頼んだ記事なので、開いたままでも訳し直した訳文に替える
    await expect(heading).toHaveText("機能フラグ");
    await expect(chips(view.locator("header"))).toHaveText(OPUS_LABEL);
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
    const confirm = page.getByRole("dialog", { name: "Retranslate (High quality)" });
    await confirm.getByRole("button", { name: "Retranslate", exact: true }).click();
    await expect(chips(view.locator("header"))).toHaveText(["EN", "Translating"]);

    server.setTranslation(article.id, before);
    await page.getByRole("button", { name: "Sync now" }).click();
    await expect(view.getByRole("alert")).toHaveText(
      "訳し直せませんでした。もとの訳文のままです。More actions の Retranslate (High quality) でもう一度頼めます。",
    );
    await expect(view.getByRole("heading", { level: 1 })).toHaveText("フィーチャートグル");
    await expect(chips(view.locator("header"))).toHaveText(SONNET_LABEL);

    await openActions(page);
    await retranslateButton(page).click();
    await confirm.getByRole("button", { name: "Retranslate", exact: true }).click();
    await expect(chips(view.locator("header"))).toHaveText(["EN", "Translating"]);
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
      .getByRole("dialog", { name: "Retranslate (High quality)" })
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
    const confirm = page.getByRole("dialog", { name: "Retranslate (High quality)" });
    await expect(confirm).toContainText("同じ元記事のほかの記事を読むすべての人の訳文");
    await confirm.getByRole("button", { name: "Retranslate", exact: true }).click();
    await expect(chips(view.locator("header"))).toHaveText(["EN", "Translating"]);
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
    await expect(chips(view.locator("header"))).toHaveText(OPUS_LABEL);
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
    await expect(chips(view.locator("header"))).toHaveText(OPUS_LABEL);
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
      .getByRole("dialog", { name: "Retranslate (High quality)" })
      .getByRole("button", { name: "Retranslate", exact: true })
      .click();
    await expect(chips(view.locator("header"))).toHaveText(["EN", "Translating"]);
    server.setTranslation(article.id, before);
    await page.getByRole("button", { name: "Sync now" }).click();
    await expect(view.getByRole("alert")).toBeVisible();

    // ほかの端末が頼み、訳し直し終えた
    server.setTranslation(article.id, { ...before, status: "translating" });
    await page.getByRole("button", { name: "Sync now" }).click();
    await expect(chips(view.locator("header"))).toHaveText(["EN", "Translating"]);
    server.setTranslation(article.id, opus(Date.now()));
    await page.getByRole("button", { name: "Sync now" }).click();
    await expect(chips(view.locator("header"))).toHaveText(OPUS_LABEL);
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
    await expect(chips(view.locator("header"))).toHaveText(SONNET_LABEL);
    await expect(heading).toHaveText("Feature Toggles");

    await openActions(page);
    await retranslateButton(page).click();
    await page
      .getByRole("dialog", { name: "Retranslate (High quality)" })
      .getByRole("button", { name: "Retranslate", exact: true })
      .click();
    await expect(chips(view.locator("header"))).toHaveText(["EN", "Translating"]);
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
    await expect(chips(view.locator("header"))).toHaveText(["EN", "Translating"]);
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
    const confirm = page.getByRole("dialog", { name: "Retranslate (High quality)" });
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

/**
 * 訳せなかった理由（docs/decisions/translation.md の 1、6。sendo の translation.md の 17）。sendo が
 * 配った理由を手元に置き、記事の画面のラベルの下に文を出す
 */
test.describe("訳せなかった理由", () => {
  const untranslated = {
    language: "en",
    status: "untranslated",
    title: null,
    summary: null,
    translatedAt: null,
    retranslated: false,
    failure: null,
  };
  /** 記事 007f6c3e-… と同じ形（その場の翻訳で cyber の拒否） */
  const refusedOnDemand = {
    ...untranslated,
    failure: { kind: "refused", category: "cyber", stage: "on_demand" },
  };
  const ON_DEMAND_TEXT =
    "サイバーセキュリティの安全策で、翻訳を断られました。頼み直しても、同じ結果になる見込みが高いです。";
  const BATCH_TEXT = "安全策で、翻訳を断られました。Translate で頼み直すと、通ることがあります。";

  async function open(page: Page, context: BrowserContext, translation: unknown) {
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

  test("その場の翻訳で拒否された記事には、種類を添えた理由の文を出す。一覧の行には出さず、読み込み直しても、ほかのタブでも同じ文が出る", async ({
    page,
    context,
  }) => {
    const { view } = await open(page, context, refusedOnDemand);
    await expect(chips(view.locator("header"))).toHaveText(["EN", "Untranslated"]);
    await expect(view.locator(".translation-failure")).toHaveText(ON_DEMAND_TEXT);
    // 理由があっても Translate は出す
    await expect(view.getByRole("button", { name: "Translate", exact: true })).toBeEnabled();
    // 開いただけでは、知らせ（alert）にしない
    await expect(view.getByRole("alert")).toHaveCount(0);
    await expect(page.locator(".article-list")).not.toContainText("安全策");

    await page.reload();
    await expect(page.locator(".article-view .translation-failure")).toHaveText(ON_DEMAND_TEXT);

    const other = await context.newPage();
    await other.goto(page.url());
    await expect(other.locator(".article-view .translation-failure")).toHaveText(ON_DEMAND_TEXT);
  });

  test("開いている間に理由が届くと出し、ほかの端末の頼みで Translating になると消え、訳文が届いても出さない", async ({
    page,
    context,
  }) => {
    const { server, article, view } = await open(page, context, untranslated);
    const note = view.locator(".translation-failure");
    await expect(chips(view.locator("header"))).toHaveText(["EN", "Untranslated"]);
    await expect(note).toHaveCount(0);

    server.setTranslation(article.id, {
      ...untranslated,
      failure: { kind: "refused", category: null, stage: "batch" },
    });
    await page.getByRole("button", { name: "Sync now" }).click();
    await expect(note).toHaveText(BATCH_TEXT);

    server.setTranslation(article.id, { ...untranslated, status: "translating" });
    await page.getByRole("button", { name: "Sync now" }).click();
    await expect(chips(view.locator("header"))).toHaveText(["EN", "Translating"]);
    await expect(note).toHaveCount(0);

    server.setTranslation(article.id, {
      ...untranslated,
      status: "translated",
      title: "フィーチャートグル",
      translatedAt: new Date().toISOString(),
    });
    await page.getByRole("button", { name: "Sync now" }).click();
    await expect(chips(view.locator("header"))).toHaveText(["EN", "Translated"]);
    await expect(note).toHaveCount(0);
  });

  test("この端末で頼んでいる間（Translating）は出さず、訳せずに理由が届いたら、理由の文だけを 1 回知らせる", async ({
    page,
    context,
  }) => {
    const { server, article, view } = await open(page, context, {
      ...untranslated,
      failure: { kind: "failed", category: null, stage: "batch" },
    });
    const note = view.locator(".translation-failure");
    await expect(note).toHaveText("訳せませんでした。Translate でもう一度頼めます。");
    await view.getByRole("button", { name: "Translate", exact: true }).click();
    await expect(chips(view.locator("header"))).toHaveText(["EN", "Translating"]);
    await expect(note).toHaveCount(0);

    server.setTranslation(article.id, refusedOnDemand);
    await page.getByRole("button", { name: "Sync now" }).click();
    await expect(view.getByRole("alert")).toHaveText(ON_DEMAND_TEXT);
    // この端末の失敗の文は出さず、理由の文も 1 回だけ（決定の 6）
    await expect(view.locator("header .content-note")).toHaveCount(1);
    await expect(view.getByText("訳せませんでした。Translate でもう一度頼めます。")).toHaveCount(0);
    await expect(chips(view.locator("header"))).toHaveText(["EN", "Untranslated"]);
  });

  test("頼んだあと受け付けを取り消されてもとの理由のまま戻ったら、もとの理由の文を出す", async ({
    page,
    context,
  }) => {
    const { server, article, view } = await open(page, context, refusedOnDemand);
    await view.getByRole("button", { name: "Translate", exact: true }).click();
    await expect(chips(view.locator("header"))).toHaveText(["EN", "Translating"]);
    server.setTranslation(article.id, refusedOnDemand);
    await page.getByRole("button", { name: "Sync now" }).click();
    await expect(view.getByRole("alert")).toHaveText(ON_DEMAND_TEXT);
    await expect(view.getByText("訳せませんでした。Translate でもう一度頼めます。")).toHaveCount(0);
  });
});
