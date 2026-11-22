import { type BrowserContext, expect, type Frame, type Page, test } from "@playwright/test";
import { FakeSendo, routeFakeSendo, signIn } from "./fake-sendo";
import { type RunningPreview, startPreview } from "./x-embed-preview";

/**
 * 記事の中の X の投稿を、隔離フレームの公式ウィジェットで出す（docs/decisions/embeds.md の 2、4）。
 * 手元の preview に、開発用の隔離フレームのオリジン（http://127.0.0.1）を設定し、隔離フレームの
 * ページは、リポジトリの本物（x-embed/）を返させる。X（platform.twitter.com）は、外へ出さずに
 * context.route で偽物にする
 */

const PORT = 4188;
const READER = `http://localhost:${PORT}`;
const EMBED = `http://127.0.0.1:${PORT}`;
const SANDBOX = "allow-scripts allow-same-origin allow-popups allow-popups-to-escape-sandbox";

/** 投稿の ID（1 から順に、19 桁） */
const postId = (n: number) => `12345678901234567${String(n).padStart(2, "0")}`;

// 記事の画面の Service Worker は要らない（同じオリジンの読み込みを横取りする）
test.use({ serviceWorkers: "block" });

let preview: RunningPreview | null = null;
test.beforeAll(async () => {
  preview = await startPreview(PORT, { X_EMBED_ORIGIN: EMBED });
});
test.afterAll(async () => {
  await preview?.stop();
});

/**
 * 偽の widgets.js（隔離フレームの中で動く）。投稿ごとの答え方は how で決める
 * - render:<高さ>：すぐに、その高さの要素で解決する
 * - render:<高さ>:<遅れ>：遅れ（ms）のあとに、その高さの要素で解決する
 * - undefined：すぐに undefined で解決する（存在しない投稿）
 * - manual：テストが __settle で決めるまで、解決しない
 */
type How = `render:${number}` | `render:${number}:${number}` | "undefined" | "manual";

function fakeWidgets(behavior: Record<string, How>): string {
  return `
const behavior = ${JSON.stringify(behavior)};
window.__hellos = [];
window.addEventListener("message", (event) => {
  window.__hellos.push({ data: event.data, origin: event.origin });
});
window.twttr = {
  ready(fn) { setTimeout(() => fn(window.twttr), 0); },
  widgets: {
    createTweet(id, container, options) {
      window.__options = options;
      const how = behavior[id] ?? behavior["*"] ?? "manual";
      const tweet = document.createElement("div");
      // ウィジェットの中のボタン（押された回数を数える）
      window.__innerClicks = 0;
      const inner = document.createElement("button");
      inner.id = "inner";
      inner.textContent = "中のボタン";
      inner.style.display = "block";
      inner.style.width = "100%";
      inner.style.height = "60px";
      inner.addEventListener("click", () => { window.__innerClicks += 1; });
      tweet.append(inner);
      return new Promise((resolve) => {
        window.__settle = (height) => {
          if (height === undefined) return resolve(undefined);
          tweet.style.height = height + "px";
          container.append(tweet);
          resolve(tweet);
        };
        window.__resize = (height) => { tweet.style.height = height + "px"; };
        if (how.startsWith("render:")) {
          const [, height, delay] = how.split(":");
          setTimeout(() => window.__settle(Number(height)), Number(delay ?? 0));
        }
        else if (how === "undefined") window.__settle(undefined);
      });
    },
  },
};
`;
}

/**
 * X への要求（外へは出さない）と、隔離フレームのオリジンへの要求を数える。frames は、読み込んだ
 * 隔離フレームの URL（ハッシュまで。要求の URL にはハッシュが入らないので、投稿ごとに数えるのに使う）
 */
async function routeX(
  page: Page,
  context: BrowserContext,
  behavior: Record<string, How>,
): Promise<{ x: string[]; embed: string[]; frames: string[] }> {
  const requested = { x: [] as string[], embed: [] as string[], frames: [] as string[] };
  context.on("request", (request) => {
    if (request.url().startsWith(`${EMBED}/`)) requested.embed.push(request.url());
  });
  page.on("framenavigated", (frame) => {
    if (frame.url().startsWith(`${EMBED}/#`)) requested.frames.push(frame.url());
  });
  await context.route("https://platform.twitter.com/**", (route) => {
    requested.x.push(route.request().url());
    return route.fulfill({ contentType: "text/javascript", body: fakeWidgets(behavior) });
  });
  return requested;
}

/** reader のページの CSP の違反を集める */
async function collectViolations(page: Page): Promise<() => Promise<string[]>> {
  await page.addInitScript(() => {
    const found: string[] = [];
    Object.assign(window, { cspViolations: found });
    document.addEventListener("securitypolicyviolation", (event) => {
      found.push(`${event.violatedDirective} ${event.blockedURI}`);
    });
  });
  return () =>
    page.evaluate(() => (window as unknown as { cspViolations: string[] }).cspViolations);
}

/** X の投稿の印の付いた引用（sendo が付けた形） */
function quote(n: number): string {
  const id = postId(n);
  return `<blockquote data-x-post="${id}"><p>投稿 ${n} の文</p>— 名前 (@user) <a href="https://x.com/user/status/${id}">日付</a></blockquote>`;
}

/** 間を空ける段落 */
function filler(count: number, from = 0): string {
  return Array.from(
    { length: count },
    (_, i) => `<p>段落 ${from + i}。${"本文。".repeat(30)}</p>`,
  ).join("");
}

type Opened = {
  server: FakeSendo;
  articleId: string;
  requested: { x: string[]; embed: string[]; frames: string[] };
  violations: () => Promise<string[]>;
};

/** 記事を届け、reader を開いて、その記事を開く */
async function openArticle(
  page: Page,
  context: BrowserContext,
  content: string,
  behavior: Record<string, How> = { "*": "render:240" },
  extra: (server: FakeSendo, feedId: string, articleId: string) => void = () => {},
): Promise<Opened> {
  const server = new FakeSendo();
  const feed = server.subscribe({ url: "https://blog.example/feed.xml", title: "Blog" });
  const article = server.deliver(feed.id, {
    title: "X の投稿を引いた記事",
    summary: "要約",
    content,
  });
  extra(server, feed.id, article.id);
  const requested = await routeX(page, context, behavior);
  const violations = await collectViolations(page);
  await routeFakeSendo(context, server);
  await page.goto(`${READER}/`);
  await signIn(page);
  await page.locator(".article-list .item", { hasText: "X の投稿を引いた記事" }).click();
  await expect(page.locator(".article-view h1")).toHaveText("X の投稿を引いた記事");
  return { server, articleId: article.id, requested, violations };
}

function post(page: Page, n: number) {
  return page.locator(".article-view .x-post").filter({ hasText: `投稿 ${n} の文` });
}

/** 投稿の隔離フレーム（iframe の中の文書） */
async function frameOf(page: Page, n: number): Promise<Frame> {
  const find = () =>
    page.frames().find((frame) => frame.url().startsWith(`${EMBED}/#id=${postId(n)}&`));
  await expect.poll(() => find() !== undefined).toBe(true);
  const frame = find();
  if (frame === undefined) throw new Error("隔離フレームがない");
  await frame.waitForLoadState("load");
  return frame;
}

/** 投稿の隔離フレームで、ウィジェットを出す（高さ） */
async function settle(page: Page, n: number, height: number | undefined): Promise<void> {
  const frame = await frameOf(page, n);
  await expect.poll(() => frame.evaluate(() => "__settle" in window)).toBe(true);
  await frame.evaluate((value) => {
    (window as unknown as { __settle: (height?: number) => void }).__settle(value);
  }, height);
}

/** 記事の欄（広い画面で動かす欄）を、投稿が見えるところまで動かす */
async function scrollTo(page: Page, top: number): Promise<void> {
  await page.locator(".article-view").evaluate((node, value) => node.scrollTo({ top: value }), top);
}

async function scrollToEnd(page: Page): Promise<void> {
  await page.locator(".article-view").evaluate((node) => node.scrollTo({ top: node.scrollHeight }));
}

const iframes = (page: Page) => page.locator(".article-view .x-post iframe");

test("表示範囲に入った投稿を、隔離フレームの公式ウィジェットに置き換える", async ({
  page,
  context,
}) => {
  const { violations } = await openArticle(
    page,
    context,
    `<p>前の段落</p>${quote(1)}<p>後の段落</p>`,
    { "*": "manual" },
  );
  const item = post(page, 1);
  const frame = item.locator("iframe");
  await expect(frame).toHaveCount(1);
  await expect(frame).toHaveAttribute("src", `${EMBED}/#id=${postId(1)}&theme=light`);
  await expect(frame).toHaveAttribute("sandbox", SANDBOX);
  await expect(frame).toHaveAttribute("allow", "fullscreen");
  await expect(frame).toHaveAttribute("referrerpolicy", "no-referrer");
  await expect(frame).toHaveAttribute("title", "X の投稿");
  for (const name of ["loading", "srcdoc", "style"]) {
    expect(await frame.getAttribute(name), name).toBeNull();
  }

  // 挨拶は、枠の load で、隔離フレームのオリジンに送る（届けば、送り先が合っている）
  const inner = await frameOf(page, 1);
  await expect
    .poll(() => inner.evaluate(() => (window as unknown as { __hellos: unknown[] }).__hellos))
    .toEqual([{ data: { type: "sendo:x-post:hello" }, origin: READER }]);

  // 出るまでは、元の引用を出し、iframe は場所を取らない
  await expect(item.locator("blockquote")).toBeVisible();
  expect((await frame.boundingBox())?.height).toBe(0);
  await expect(item.getByRole("link", { name: "Open on X" })).toBeVisible();

  await settle(page, 1, 240);
  // 出たら、その高さで見せ、元の引用を隠す。Open on X は出たまま
  await expect(item.locator("blockquote")).toBeHidden();
  await expect.poll(async () => (await frame.boundingBox())?.height).toBe(240);
  await expect(item.getByRole("link", { name: "Open on X" })).toBeVisible();
  // 幅は本文に合わせ、550px まで
  const width = (await frame.boundingBox())?.width ?? 0;
  const bodyWidth = (await page.locator(".article-view .body").boundingBox())?.width ?? 0;
  expect(width).toBe(Math.min(bodyWidth, 550));
  // ウィジェットに渡したのは、ID とテーマだけ
  expect(
    await inner.evaluate(() => (window as unknown as { __options: unknown }).__options),
  ).toEqual({ dnt: true, lang: "ja", conversation: "none", theme: "light" });
  expect(await violations()).toEqual([]);
});

test("ダークのテーマでは、ダークのウィジェットを頼む", async ({ page, context }) => {
  await page.emulateMedia({ colorScheme: "dark" });
  await openArticle(page, context, quote(1));
  await expect(post(page, 1).locator("iframe")).toHaveAttribute(
    "src",
    `${EMBED}/#id=${postId(1)}&theme=dark`,
  );
});

test("記事の下のほうの投稿は、表示範囲に入るまで読み込まない", async ({ page, context }) => {
  const { requested } = await openArticle(page, context, `${filler(40)}${quote(1)}`);
  await expect(page.locator(".article-view .body")).toBeVisible();
  await page.waitForTimeout(500);
  await expect(iframes(page)).toHaveCount(0);
  expect(requested).toEqual({ x: [], embed: [], frames: [] });

  await post(page, 1).scrollIntoViewIfNeeded();
  await expect(post(page, 1).locator("iframe")).toHaveCount(1);
  await expect(post(page, 1).locator("blockquote")).toBeHidden();
  expect(requested.embed.length).toBeGreaterThan(0);
  expect(requested.x.length).toBeGreaterThan(0);
});

test("ツールバーの下に隠れている投稿は、表示範囲に入ったと数えない（広い画面。上のツールバー）", async ({
  page,
  context,
}) => {
  const { requested } = await openArticle(
    page,
    context,
    `${filler(20)}${quote(1)}${filler(40, 20)}`,
  );
  await expect(page.locator(".article-view .body")).toBeVisible();
  // 投稿は、開いたときには画面の外にある
  const place = await page.evaluate(() => {
    const view = document.querySelector(".article-view") as HTMLElement;
    const toolbar = view.querySelector(".toolbar") as HTMLElement;
    const item = view.querySelector(".x-post") as HTMLElement;
    const top = view.getBoundingClientRect().top;
    return {
      toolbarBottom: toolbar.getBoundingClientRect().bottom - top,
      itemBottom: item.getBoundingClientRect().bottom - top + view.scrollTop,
    };
  });
  // 投稿の下の端が、ツールバーの下の端より 4px 上（ツールバーに隠れている）
  await scrollTo(page, place.itemBottom - place.toolbarBottom + 4);
  await page.waitForTimeout(500);
  await expect(iframes(page)).toHaveCount(0);
  expect(requested.frames).toEqual([]);
  // 8px 戻すと、ツールバーの下から 4px 出る
  await scrollTo(page, place.itemBottom - place.toolbarBottom - 4);
  await expect(post(page, 1).locator("iframe")).toHaveCount(1);
});

test("ツールバーの下に隠れている投稿は、表示範囲に入ったと数えない（狭い画面。下のツールバー）", async ({
  page,
  context,
}) => {
  await page.setViewportSize({ width: 390, height: 844 });
  const { requested } = await openArticle(
    page,
    context,
    `${filler(20)}${quote(1)}${filler(40, 20)}`,
  );
  await expect(page.locator(".article-view .body")).toBeVisible();
  // 記事の画面が入ってくる動きが終わってから測る
  await page.evaluate(() => Promise.all(document.getAnimations().map((motion) => motion.finished)));
  const place = await page.evaluate(() => {
    const toolbar = document.querySelector(".article-view .toolbar") as HTMLElement;
    const item = document.querySelector(".article-view .x-post") as HTMLElement;
    return {
      toolbarTop: toolbar.getBoundingClientRect().top,
      itemTop: item.getBoundingClientRect().top + window.scrollY,
    };
  });
  // 投稿の上の端が、下のツールバーの上の端より 4px 下（ツールバーに隠れている）
  await page.evaluate((top) => window.scrollTo({ top }), place.itemTop - place.toolbarTop - 4);
  await page.waitForTimeout(500);
  await expect(iframes(page)).toHaveCount(0);
  expect(requested.frames).toEqual([]);
  // 8px 進めると、ツールバーの上に 4px 出る
  await page.evaluate((top) => window.scrollTo({ top }), place.itemTop - place.toolbarTop + 4);
  await expect(post(page, 1).locator("iframe")).toHaveCount(1);
});

test("読書位置を戻すまでは、先頭に見えた投稿を読み込まない", async ({ page, context }) => {
  const { requested } = await openArticle(page, context, `${quote(1)}${filler(60)}`, {
    "*": "manual",
  });
  // 先頭の投稿は、開いたときに読み込み始める
  await expect(post(page, 1).locator("iframe")).toHaveCount(1);
  // 下まで読んで、位置を書かせてから、読み込み直す
  await scrollToEnd(page);
  await expect(iframes(page)).toHaveCount(0);
  await page.waitForTimeout(500);
  requested.embed.length = 0;
  // 読み込み直したあと、位置を戻すのは、開いたときの全文の自動の取得が終わってから。それを止めて、
  // 先頭が見えたまま（位置が決まる前）の間を作る
  let release: () => void = () => {};
  const held = new Promise<void>((resolve) => {
    release = resolve;
  });
  await context.route("**/api/v1/articles/*/content?source=page", async (route) => {
    await held;
    await route.fallback();
  });
  await page.reload();
  await expect(page.locator(".article-view h1")).toHaveText("X の投稿を引いた記事");
  await expect(post(page, 1).locator("blockquote")).toBeInViewport();
  await page.waitForTimeout(500);
  expect(requested.embed).toEqual([]);
  await expect(iframes(page)).toHaveCount(0);
  release();
  await expect
    .poll(() => page.locator(".article-view").evaluate((node) => node.scrollTop))
    .toBeGreaterThan(1000);
  await page.waitForTimeout(500);
  expect(requested.embed).toEqual([]);
  await expect(iframes(page)).toHaveCount(0);
  // 先頭に戻れば読み込む
  await scrollTo(page, 0);
  await expect(post(page, 1).locator("iframe")).toHaveCount(1);
});

test("同時に読み込むのは 4 つまで。空いたら、待っているものを始める", async ({ page, context }) => {
  await page.setViewportSize({ width: 1280, height: 1400 });
  await openArticle(page, context, [1, 2, 3, 4, 5].map(quote).join(""), { "*": "manual" });
  await expect(iframes(page)).toHaveCount(4);
  await expect(post(page, 5).locator("iframe")).toHaveCount(0);
  await page.waitForTimeout(300);
  await expect(iframes(page)).toHaveCount(4);
  // 1 つ出たら、5 つ目を始める
  await settle(page, 2, 200);
  await expect(post(page, 5).locator("iframe")).toHaveCount(1);
  await expect(iframes(page)).toHaveCount(5);
});

test("読み込み中に表示範囲から出たものは外して、数から外す。待っていたものも取り消す", async ({
  page,
  context,
}) => {
  await page.setViewportSize({ width: 1280, height: 1400 });
  const { requested } = await openArticle(
    page,
    context,
    `${[1, 2, 3, 4, 5].map(quote).join("")}${filler(80)}${quote(6)}`,
    { "*": "manual" },
  );
  await expect(iframes(page)).toHaveCount(4);
  // 1〜4 が読み込み中、5 が待っているまま、下の 6 まで動かす
  await scrollToEnd(page);
  // 1〜4 は外れ（元の引用に戻る）、6 を始める。5 は始めない
  await expect(post(page, 6).locator("iframe")).toHaveCount(1);
  await expect(iframes(page)).toHaveCount(1);
  for (const n of [1, 2, 3, 4, 5]) await expect(post(page, n).locator("blockquote")).toBeAttached();
  await page.waitForTimeout(300);
  expect(requested.frames.filter((url) => url.includes(postId(5)))).toEqual([]);

  // 入り直したら、最初から読み込む
  const loaded = requested.frames.filter((url) => url.includes(postId(1))).length;
  await scrollTo(page, 0);
  await expect(iframes(page)).toHaveCount(4);
  await expect
    .poll(() => requested.frames.filter((url) => url.includes(postId(1))).length)
    .toBeGreaterThan(loaded);
  await settle(page, 1, 200);
  await expect(post(page, 1).locator("blockquote")).toBeHidden();
});

test("出たあとは、表示範囲から出ても外さない", async ({ page, context }) => {
  await openArticle(page, context, `${quote(1)}${filler(60)}`);
  await expect(post(page, 1).locator("blockquote")).toBeHidden();
  await scrollToEnd(page);
  await page.waitForTimeout(300);
  await expect(post(page, 1).locator("iframe")).toHaveCount(1);
  await expect(post(page, 1).locator("blockquote")).toBeHidden();
});

test("failed を受けたら、iframe を外して元の引用に戻し、その記事ではやり直さない", async ({
  page,
  context,
}) => {
  const { requested } = await openArticle(page, context, `${quote(1)}${filler(60)}`, {
    "*": "undefined",
  });
  await expect.poll(() => requested.x.length).toBeGreaterThan(0);
  await expect(iframes(page)).toHaveCount(0);
  await expect(post(page, 1).locator("blockquote")).toBeVisible();
  await expect(post(page, 1).getByRole("link", { name: "Open on X" })).toBeVisible();
  // 出て、入り直しても、やり直さない
  const before = requested.embed.length;
  await scrollToEnd(page);
  await page.waitForTimeout(200);
  await scrollTo(page, 0);
  await page.waitForTimeout(500);
  await expect(iframes(page)).toHaveCount(0);
  expect(requested.embed.length).toBe(before);
});

test("表示範囲に入ったまま 10 秒たっても出なければ、失敗にする。外にいた時間は数えない", async ({
  page,
  context,
}) => {
  await page.clock.install();
  await openArticle(page, context, `${quote(1)}${filler(60)}`, { "*": "manual" });
  const frame = post(page, 1).locator("iframe");
  await expect(frame).toHaveCount(1);
  await page.clock.fastForward(6_000);
  await expect(frame).toHaveCount(1);
  // 外に出ると取り消し、入り直したら 10 秒を数え直す
  await scrollToEnd(page);
  await expect(frame).toHaveCount(0);
  await page.clock.fastForward(20_000);
  await scrollTo(page, 0);
  await expect(frame).toHaveCount(1);
  await page.clock.fastForward(6_000);
  await expect(frame).toHaveCount(1);
  // 時計は、早送りの間も実際の時間で進むので、境の前後に少し幅を持たせる
  await page.clock.fastForward(3_500);
  await expect(frame).toHaveCount(1);
  await page.clock.fastForward(500);
  await expect(frame).toHaveCount(0);
  await expect(post(page, 1).locator("blockquote")).toBeVisible();
  // 失敗したあとは、やり直さない
  await scrollToEnd(page);
  await page.waitForTimeout(200);
  await scrollTo(page, 0);
  await page.waitForTimeout(500);
  await expect(frame).toHaveCount(0);
});

test("受けるのは、その投稿の iframe からの、決まった形のメッセージだけ", async ({
  page,
  context,
}) => {
  await openArticle(page, context, `${quote(1)}${quote(2)}`, { "*": "manual" });
  await expect(iframes(page)).toHaveCount(2);
  const inner = await frameOf(page, 1);
  // 隔離フレームから、形の違うメッセージと、範囲の外の高さを送る
  await inner.evaluate(() => {
    for (const height of [0, -1, 1.5, "240", 4001, null]) {
      parent.postMessage({ type: "sendo:x-post:rendered", height }, "*");
    }
    parent.postMessage("sendo:x-post:rendered", "*");
    parent.postMessage({ type: "sendo:x-post:other", height: 240 }, "*");
    parent.postMessage(null, "*");
  });
  // reader の窓から（オリジンが違う）、隔離フレームのオリジンのほかの窓から
  await page.evaluate(() =>
    window.postMessage({ type: "sendo:x-post:rendered", height: 240 }, "*"),
  );
  const [popup] = await Promise.all([
    page.waitForEvent("popup"),
    page.evaluate((url) => void window.open(url), `${EMBED}/`),
  ]);
  await popup.waitForLoadState("load");
  expect(await popup.evaluate(() => window.opener !== null)).toBe(true);
  await popup.evaluate(() => {
    window.opener?.postMessage({ type: "sendo:x-post:rendered", height: 240 }, "*");
    window.opener?.postMessage({ type: "sendo:x-post:failed" }, "*");
  });
  await popup.close();
  await page.waitForTimeout(300);
  for (const n of [1, 2]) {
    await expect(post(page, n).locator("blockquote")).toBeVisible();
    expect((await post(page, n).locator("iframe").boundingBox())?.height).toBe(0);
  }

  // 1 の iframe からの、ちょうど 4000 は受ける。2 は変わらない
  await inner.evaluate(() =>
    parent.postMessage({ type: "sendo:x-post:rendered", height: 4000 }, "*"),
  );
  await expect
    .poll(async () => (await post(page, 1).locator("iframe").boundingBox())?.height)
    .toBe(4000);
  await expect(post(page, 2).locator("blockquote")).toBeVisible();
  // 2 回目からは、高さを付け直すだけ。failed が来ても、外さない
  await inner.evaluate(() => parent.postMessage({ type: "sendo:x-post:rendered", height: 1 }, "*"));
  await expect
    .poll(async () => (await post(page, 1).locator("iframe").boundingBox())?.height)
    .toBe(1);
  await inner.evaluate(() => parent.postMessage({ type: "sendo:x-post:failed" }, "*"));
  await page.waitForTimeout(200);
  await expect(post(page, 1).locator("iframe")).toHaveCount(1);
});

test("ウィジェットの高さが変わったら、枠の高さを付け直す", async ({ page, context }) => {
  await openArticle(page, context, quote(1), { "*": "render:240" });
  const frame = post(page, 1).locator("iframe");
  await expect.poll(async () => (await frame.boundingBox())?.height).toBe(240);
  const inner = await frameOf(page, 1);
  await inner.evaluate(() =>
    (window as unknown as { __resize: (h: number) => void }).__resize(320),
  );
  await expect.poll(async () => (await frame.boundingBox())?.height).toBe(320);
});

test("オフラインでは始めず、つながったら始める", async ({ page, context }) => {
  const { requested } = await openArticle(page, context, `${filler(40)}${quote(1)}`);
  await context.setOffline(true);
  await post(page, 1).scrollIntoViewIfNeeded();
  await page.waitForTimeout(500);
  await expect(iframes(page)).toHaveCount(0);
  expect(requested.embed).toEqual([]);
  await context.setOffline(false);
  await expect(post(page, 1).locator("iframe")).toHaveCount(1);
  await expect(post(page, 1).locator("blockquote")).toBeHidden();
});

test("読み込み中にオフラインになったら、失敗にせず取り消し、つながったら始め直す", async ({
  page,
  context,
}) => {
  await openArticle(page, context, quote(1), { "*": "manual" });
  await expect(iframes(page)).toHaveCount(1);
  await context.setOffline(true);
  await expect(iframes(page)).toHaveCount(0);
  await expect(post(page, 1).locator("blockquote")).toBeVisible();
  await context.setOffline(false);
  await expect(iframes(page)).toHaveCount(1);
  await settle(page, 1, 200);
  await expect(post(page, 1).locator("blockquote")).toBeHidden();
});

test("全文に差し替わったら、前の iframe を残さず、新しい本文で判定し直す", async ({
  page,
  context,
}) => {
  let release: () => void = () => {};
  const held = new Promise<void>((resolve) => {
    release = resolve;
  });
  const { server, articleId } = await openArticle(
    page,
    context,
    // 全文でも、同じ位置に同じ投稿がある
    `${quote(1)}<p>フィードの本文</p>`,
    { "*": "manual" },
  );
  await expect(post(page, 1).locator("iframe")).toHaveCount(1);
  server.pageContents.set(articleId, `${quote(1)}<p>全文の本文</p>${quote(2)}`);
  // 全文の取得を止めておく
  await context.route("**/api/v1/articles/*/content?source=page", async (route) => {
    await held;
    await route.fallback();
  });
  await page.getByRole("button", { name: "More actions" }).click();
  await page.getByRole("button", { name: "Retry full text" }).click();
  await expect(page.getByText("全文を取得しています…")).toBeVisible();
  // 取得中も、手元の本文の引用は出ている
  await expect(post(page, 1).locator("blockquote")).toBeVisible();
  const old = await post(page, 1).locator("iframe").elementHandle();
  release();
  await expect(page.getByText("全文の本文")).toBeVisible();
  // 前の iframe は外れ、新しい本文の投稿を読み込み直す
  await expect.poll(() => old?.evaluate((node) => node.isConnected)).toBe(false);
  await expect(iframes(page)).toHaveCount(2);
  await settle(page, 2, 200);
  await expect(post(page, 2).locator("blockquote")).toBeHidden();
});

test("記事を切り替えたら、前の記事の iframe と待ちを残さない", async ({ page, context }) => {
  await page.setViewportSize({ width: 1280, height: 1400 });
  await openArticle(
    page,
    context,
    [1, 2, 3, 4, 5].map(quote).join(""),
    { "*": "manual" },
    (server, feedId) => {
      server.deliver(feedId, {
        title: "次の記事",
        summary: "要約",
        content: quote(7),
        publishedAt: 0,
      });
    },
  );
  await expect(iframes(page)).toHaveCount(4);
  await page.keyboard.press("j");
  await expect(page.locator(".article-view h1")).toHaveText("次の記事");
  // 前の記事の 4 つが数を占めたままにならず、次の記事の投稿をすぐ始める
  await expect(iframes(page)).toHaveCount(1);
  await expect(post(page, 7).locator("iframe")).toHaveCount(1);
});

/** 文書が裏に回った ／ 前に出たことにする（Playwright では、タブを裏に回せない） */
async function setHidden(page: Page, hidden: boolean): Promise<void> {
  await page.evaluate((value) => {
    Object.defineProperty(document, "visibilityState", {
      configurable: true,
      get: () => (value ? "hidden" : "visible"),
    });
    document.dispatchEvent(new Event("visibilitychange"));
  }, hidden);
}

test("裏に回っている間は数えず、読み込み中のものは取り消し、前に出たら始め直す", async ({
  page,
  context,
}) => {
  await page.clock.install();
  await openArticle(page, context, quote(1), { "*": "manual" });
  const frame = post(page, 1).locator("iframe");
  await expect(frame).toHaveCount(1);
  await setHidden(page, true);
  await expect(frame).toHaveCount(0);
  await expect(post(page, 1).locator("blockquote")).toBeVisible();
  // 裏にある間は、10 秒を超えても失敗にしない
  await page.clock.fastForward(30_000);
  await setHidden(page, false);
  await expect(frame).toHaveCount(1);
  await settle(page, 1, 200);
  await expect(post(page, 1).locator("blockquote")).toBeHidden();
});

test("取り消してすぐ始め直したら、iframe を作り直し、新しい枠の結果を受ける", async ({
  page,
  context,
}) => {
  await openArticle(page, context, quote(1), { "*": "manual" });
  const frame = post(page, 1).locator("iframe");
  await expect(frame).toHaveCount(1);
  const old = await frame.elementHandle();
  // 同じ処理の中で、取り消し（offline）と始め直し（online）が続く
  await page.evaluate(() => {
    window.dispatchEvent(new Event("offline"));
    window.dispatchEvent(new Event("online"));
  });
  await expect.poll(() => old?.evaluate((node) => node.isConnected)).toBe(false);
  await expect(frame).toHaveCount(1);
  await settle(page, 1, 200);
  await expect(post(page, 1).locator("blockquote")).toBeHidden();
});

/** Settings の Reading を開く */
async function openReadingSettings(page: Page): Promise<void> {
  await page.locator("nav.sidebar").getByRole("link", { name: "Settings" }).click();
  await page.getByRole("tab", { name: "Reading", exact: true }).click();
}

test.describe("読み込むかの設定（reader.xPosts）", () => {
  test("Settings で切り替え、既定と違うときだけ預ける。読み込み直しても残る", async ({
    page,
    context,
  }) => {
    const { server } = await openArticle(page, context, quote(1));
    await openReadingSettings(page);
    const toggle = page.getByLabel("Load X posts");
    await expect(toggle).toBeChecked();
    await expect(page.locator("#x-posts-note")).toContainText("IP");
    await toggle.uncheck();
    await expect.poll(() => server.settingsOf("desktop")).toEqual({ "reader.xPosts": false });
    await page.reload();
    await page.getByRole("tab", { name: "Reading", exact: true }).click();
    await expect(page.getByLabel("Load X posts")).not.toBeChecked();
    // 既定に戻したら、項目を消す
    await page.getByLabel("Load X posts").check();
    await expect.poll(() => server.settingsOf("desktop")).toEqual({});
  });

  test("切ってあれば、表示範囲に入っても読み込まない", async ({ page, context }) => {
    const { requested } = await openArticle(page, context, quote(1), { "*": "manual" }, (server) =>
      server.putSetting("desktop", "reader.xPosts", false),
    );
    await expect(post(page, 1).locator("blockquote")).toBeVisible();
    await page.waitForTimeout(500);
    await expect(iframes(page)).toHaveCount(0);
    expect(requested).toEqual({ x: [], embed: [], frames: [] });
  });

  test("知らない値は、既定（読み込む）として扱う", async ({ page, context }) => {
    await openArticle(page, context, quote(1), { "*": "manual" }, (server) =>
      server.putSetting("desktop", "reader.xPosts", "no"),
    );
    await expect(post(page, 1).locator("iframe")).toHaveCount(1);
  });

  test("同期で切ったと届いたら、開いている記事の枠を外し、そのあと通信しない。入れたら読み込む", async ({
    page,
    context,
  }) => {
    await page.setViewportSize({ width: 1280, height: 1400 });
    const { server, requested } = await openArticle(
      page,
      context,
      [1, 2, 3, 4, 5, 6].map(quote).join(""),
      { "*": "manual" },
    );
    await expect(iframes(page)).toHaveCount(4);
    // 1 は出て、2〜5 は読み込み中、6 は待っている
    await settle(page, 1, 200);
    await expect(post(page, 5).locator("iframe")).toHaveCount(1);
    await expect(post(page, 1).locator("blockquote")).toBeHidden();

    server.putSetting("desktop", "reader.xPosts", false);
    await page.getByRole("button", { name: "Sync now" }).click();
    // 出ていたウィジェットも、読み込み中のものも外し、引用に戻す
    await expect(iframes(page)).toHaveCount(0);
    for (const n of [1, 2, 3, 4, 5, 6])
      await expect(post(page, n).locator("blockquote")).toBeVisible();
    const before = { x: requested.x.length, embed: requested.embed.length };
    await page.waitForTimeout(500);
    expect({ x: requested.x.length, embed: requested.embed.length }).toEqual(before);

    server.removeSetting("desktop", "reader.xPosts");
    await page.getByRole("button", { name: "Sync now" }).click();
    await expect(iframes(page)).toHaveCount(4);
    await expect(post(page, 1).locator("iframe")).toHaveCount(1);
  });

  test("ほかのタブで切ったら、開いている記事の枠を外す", async ({ page, context }) => {
    await openArticle(page, context, quote(1));
    await expect(post(page, 1).locator("blockquote")).toBeHidden();
    const other = await context.newPage();
    await other.goto(`${READER}/`);
    await openReadingSettings(other);
    await other.getByLabel("Load X posts").uncheck();
    await expect(iframes(page)).toHaveCount(0);
    await expect(post(page, 1).locator("blockquote")).toBeVisible();
    await other.close();
  });
});

test("隔離フレームのオリジンが未設定なら、設定の項目を出さず、預けた値も消さない", async ({
  page,
  context,
}) => {
  const server = new FakeSendo();
  server.subscribe({ url: "https://blog.example/feed.xml", title: "Blog" });
  server.putSetting("desktop", "reader.xPosts", false);
  await routeFakeSendo(context, server);
  // X_EMBED_ORIGIN のない preview（playwright.config.ts の webServer）
  await page.goto("http://localhost:4173/");
  await signIn(page);
  await openReadingSettings(page);
  await expect(page.getByLabel("Mark as read on scroll")).toBeVisible();
  await expect(page.getByLabel("Load X posts")).toHaveCount(0);
  // ほかの設定を変えても、預けた値は残る
  await page.getByLabel("Mark as read on scroll").uncheck();
  await expect
    .poll(() => server.settingsOf("desktop"))
    .toEqual({ "reader.xPosts": false, "reader.markReadOnScroll": false });
});

const scrollTopOf = (page: Page) =>
  page.locator(".article-view").evaluate((node) => node.scrollTop);

/** 履歴の項目に書いた、記事の位置 */
function articleState(page: Page): Promise<unknown> {
  return page.evaluate(() => (history.state as { article?: unknown } | null)?.article);
}

/** 本文の段落（filler の n 番目）の、画面の中の上の端 */
async function paragraphTop(page: Page, n: number): Promise<number> {
  const box = await page
    .locator(".article-view .body p", { hasText: new RegExp(`^段落 ${n}。`) })
    .boundingBox();
  if (box === null) throw new Error(`段落 ${n} が見えない`);
  return box.y;
}

/** 投稿のウィジェットが出るのを待つ（元の引用が隠れ、iframe に高さが付く） */
async function expectShown(page: Page, n: number): Promise<void> {
  await expect(post(page, n).locator("blockquote")).toHaveAttribute("hidden", "");
  await expect(post(page, n).locator("iframe")).toBeVisible();
}

/** 投稿を表示範囲に入れて、出るのを待つ */
async function showPost(page: Page, n: number): Promise<void> {
  await post(page, n).scrollIntoViewIfNeeded();
  await expectShown(page, n);
}

/** 記事から設定の画面に移る（履歴の項目を足す。戻るで、記事の項目に戻る） */
async function leaveToSettings(page: Page): Promise<void> {
  await page.locator("nav.sidebar").getByRole("link", { name: "Settings" }).click();
  await expect(page.getByRole("heading", { name: "Settings", level: 1 })).toBeVisible();
}

/** 位置を書くのは、動かし終えて少ししてから */
const letRemember = (page: Page) => page.waitForTimeout(600);

/** 投稿が 3 つあり、下に長く続く記事 */
const THREE_POSTS = `${filler(2)}${quote(1)}${filler(3, 2)}${quote(2)}${filler(3, 5)}${quote(3)}${filler(40, 8)}`;
const THREE_HEIGHTS: Record<string, How> = {
  [postId(1)]: "render:240:300",
  [postId(2)]: "render:320:300",
  [postId(3)]: "render:400:300",
};

/** 3 つの投稿を出しながら、段落 20 が見えるところまで読む。段落 20 の位置を返す */
async function readPastThreePosts(page: Page): Promise<number> {
  for (const n of [1, 2, 3]) await showPost(page, n);
  await page
    .locator(".article-view .body p", { hasText: /^段落 20。/ })
    .evaluate((node) => node.scrollIntoView({ block: "center" }));
  await letRemember(page);
  return paragraphTop(page, 20);
}

test.describe("読書位置（覚えた高さ）", () => {
  test("表示範囲の中で出した投稿の大きさを、位置と一緒に覚える。失敗と読み込み中は覚えない", async ({
    page,
    context,
  }) => {
    await openArticle(page, context, `${quote(1)}${quote(2)}${quote(3)}${filler(40)}`, {
      [postId(1)]: "render:240",
      [postId(2)]: "manual",
      [postId(3)]: "undefined",
    });
    await expectShown(page, 1);
    const width = Math.round((await post(page, 1).locator("iframe").boundingBox())?.width ?? 0);
    await scrollTo(page, 10);
    await letRemember(page);
    expect(await articleState(page)).toMatchObject({
      top: 10,
      xPosts: [{ id: postId(1), width, height: 240 }],
    });
  });

  test("受けるたびに覚え直す。表示範囲の外で受けた高さは、覚えない", async ({ page, context }) => {
    await openArticle(page, context, `${quote(1)}${filler(60)}`, { "*": "render:240" });
    await expectShown(page, 1);
    const inner = await frameOf(page, 1);
    const resize = (height: number) =>
      inner.evaluate(
        (h) => (window as unknown as { __resize: (h: number) => void }).__resize(h),
        height,
      );
    await resize(320);
    await expect
      .poll(async () => (await post(page, 1).locator("iframe").boundingBox())?.height)
      .toBe(320);
    await scrollTo(page, 5);
    await letRemember(page);
    expect(await articleState(page)).toMatchObject({ xPosts: [{ id: postId(1), height: 320 }] });
    // 表示範囲の外で、高さが変わった（画面の外の枠は描画が間引かれるので、知らせは直接送る）
    await scrollToEnd(page);
    await expect.poll(() => scrollTopOf(page)).toBeGreaterThan(3000);
    await page.waitForTimeout(300);
    await inner.evaluate(() =>
      parent.postMessage({ type: "sendo:x-post:rendered", height: 400 }, "*"),
    );
    // 受けて、枠の高さは付け直すが、覚え直さない
    await expect
      .poll(() =>
        post(page, 1)
          .locator("iframe")
          .evaluate((node) => node.getBoundingClientRect().height),
      )
      .toBe(400);
    await scrollTo(page, 3000);
    await letRemember(page);
    expect(await articleState(page)).toMatchObject({
      top: 3000,
      xPosts: [{ id: postId(1), height: 320 }],
    });
  });

  test("X の投稿のない記事では、今までと同じ形で書く", async ({ page, context }) => {
    await openArticle(page, context, filler(60));
    await expect(page.locator(".article-view .body")).toBeVisible();
    await scrollTo(page, 500);
    await letRemember(page);
    const state = await articleState(page);
    expect(Object.keys(state as object).sort()).toEqual(["id", "top"]);
  });

  test("読み込み直すと、覚えた高さの枠を取ってから位置を戻し、同じ段落が同じところにある", async ({
    page,
    context,
  }) => {
    await openArticle(page, context, THREE_POSTS, THREE_HEIGHTS);
    const before = await readPastThreePosts(page);
    await page.reload();
    await expect(page.locator(".article-view h1")).toHaveText("X の投稿を引いた記事");
    // 3 つとも、元の引用の代わりに、覚えた高さの枠を取る
    for (const { n, height } of [
      { n: 1, height: 240 },
      { n: 2, height: 320 },
      { n: 3, height: 400 },
    ]) {
      // 表示範囲に入っている枠は、すぐに読み込みを始める（読み込み中の iframe も、同じ高さを取る）
      const box = post(page, n).locator(".reserved, iframe");
      await expect(box).toHaveCount(1);
      expect((await box.boundingBox())?.height).toBe(height);
      await expect(post(page, n).locator("blockquote")).toBeHidden();
    }
    await expect.poll(() => paragraphTop(page, 20)).not.toBe(Number.NaN);
    expect(Math.abs((await paragraphTop(page, 20)) - before)).toBeLessThanOrEqual(16);
    // 読者が何もしないあいだ、見えている本文が動かない
    // （1px 未満は、ブラウザーのスクロールの補正の端数）
    const settled = await paragraphTop(page, 20);
    for (let i = 0; i < 3; i++) {
      await page.waitForTimeout(1000);
      expect(Math.abs((await paragraphTop(page, 20)) - settled)).toBeLessThan(1);
    }
  });

  test("戻るで記事に戻ったときも、覚えた高さの枠を取って、同じ段落に戻る", async ({
    page,
    context,
  }) => {
    await openArticle(page, context, THREE_POSTS, THREE_HEIGHTS);
    const before = await readPastThreePosts(page);
    await leaveToSettings(page);
    await page.goBack();
    await expect(page.locator(".article-view h1")).toHaveText("X の投稿を引いた記事");
    // 表示範囲に入っている枠は、すぐに読み込みを始める（読み込み中の iframe も、同じ高さを取る）
    await expect(post(page, 3).locator(".reserved, iframe")).toHaveCount(1);
    await expect(post(page, 3).locator("blockquote")).toHaveAttribute("hidden", "");
    await expect
      .poll(async () => Math.abs((await paragraphTop(page, 20)) - before))
      .toBeLessThanOrEqual(16);
  });

  test("幅が違えば、枠を取らずに元の引用を出す", async ({ page, context }) => {
    await openArticle(page, context, `${quote(1)}${filler(60)}`, { "*": "render:240" });
    await expectShown(page, 1);
    await scrollTo(page, 2000);
    await letRemember(page);
    // 枠の幅が変わる（狭い画面）
    await page.setViewportSize({ width: 390, height: 844 });
    await context.route("https://platform.twitter.com/**", (route) => route.abort("failed"));
    await page.reload();
    await expect(page.locator(".article-view h1")).toHaveText("X の投稿を引いた記事");
    await expect(page.locator(".article-view .body")).toBeVisible();
    await page.waitForTimeout(500);
    await expect(post(page, 1).locator(".reserved")).toHaveCount(0);
    await expect(post(page, 1).locator("blockquote")).toBeAttached();
    await expect(post(page, 1).locator("blockquote")).not.toHaveAttribute("hidden", "");
    // 元の引用を出している投稿の大きさは、次に位置を書くときに書かない
    await page.evaluate(() => window.scrollBy({ top: 10 }));
    await letRemember(page);
    const state = (await articleState(page)) as { xPosts?: unknown } | undefined;
    expect(state).toBeDefined();
    expect(state?.xPosts).toBeUndefined();
  });

  test("設定を切ってあれば、戻ったときに枠を取らずに元の引用を出す", async ({ page, context }) => {
    await openArticle(page, context, `${quote(1)}${filler(60)}`, { "*": "render:240" });
    await expectShown(page, 1);
    await scrollTo(page, 2000);
    await letRemember(page);
    // 記事を離れてから切る（記事の項目には、出した投稿の大きさが残っている）
    await leaveToSettings(page);
    await page.getByRole("tab", { name: "Reading", exact: true }).click();
    await page.getByLabel("Load X posts").uncheck();
    await page.goBack();
    await expect(page.locator(".article-view h1")).toHaveText("X の投稿を引いた記事");
    await expect
      .poll(() => page.locator(".article-view").evaluate((node) => node.scrollTop))
      .toBeGreaterThan(1000);
    await expect(post(page, 1).locator(".reserved")).toHaveCount(0);
    await expect(post(page, 1).locator("blockquote")).not.toHaveAttribute("hidden", "");
  });

  test("オフラインなら、戻ったときに枠を取らずに元の引用を出す", async ({ page, context }) => {
    await openArticle(page, context, `${quote(1)}${filler(60)}`, { "*": "render:240" });
    await expectShown(page, 1);
    await scrollTo(page, 2000);
    await letRemember(page);
    await leaveToSettings(page);
    await context.setOffline(true);
    await page.goBack();
    await expect(page.locator(".article-view h1")).toHaveText("X の投稿を引いた記事");
    await expect(post(page, 1)).toBeAttached();
    await page.waitForTimeout(500);
    await expect(post(page, 1).locator(".reserved")).toHaveCount(0);
    await expect(post(page, 1).locator("blockquote")).not.toHaveAttribute("hidden", "");
  });

  test("覚えた高さは、ほかの記事の同じ投稿に当てない", async ({ page, context }) => {
    const behavior: Record<string, How> = { "*": "render:240" };
    const { articleId: firstId } = await openArticle(
      page,
      context,
      `${quote(1)}${filler(60)}`,
      behavior,
      (server, feedId) =>
        server.deliver(feedId, {
          title: "次の記事",
          summary: "要約",
          content: `${filler(1)}${quote(1)}${filler(30, 1)}`,
          publishedAt: 0,
        }),
    );
    await expectShown(page, 1);
    await scrollTo(page, 2000);
    await letRemember(page);
    // 次の記事の投稿は、読み込みを終えない（覚える大きさがない）
    behavior["*"] = "manual";
    await page.keyboard.press("j");
    await expect(page.locator(".article-view h1")).toHaveText("次の記事");
    await expect(post(page, 1)).toBeAttached();
    await expect(post(page, 1).locator(".reserved")).toHaveCount(0);
    // 次の記事の位置に、前の記事の投稿の大きさを書かない
    await scrollTo(page, 1);
    await letRemember(page);
    const state = (await articleState(page)) as { id: string; xPosts?: unknown };
    expect(state.id).not.toBe(firstId);
    expect(state.xPosts).toBeUndefined();
  });

  test("位置を戻したあとに替えた本文には、覚えた高さを当てない", async ({ page, context }) => {
    const behavior: Record<string, How> = { "*": "render:240" };
    // 開いたときに、全文を自動で取って出す
    await openArticle(
      page,
      context,
      `${quote(1)}<p>フィードの本文</p>${filler(60)}`,
      behavior,
      (server, _feedId, articleId) =>
        server.pageContents.set(articleId, `${quote(1)}<p>全文の本文</p>${filler(60)}`),
    );
    await expect(page.getByText("全文の本文")).toBeVisible();
    await expectShown(page, 1);
    await scrollTo(page, 2000);
    await letRemember(page);
    await page.reload();
    await expect(page.getByText("全文の本文")).toBeAttached();
    await expect(post(page, 1).locator(".reserved")).toHaveCount(1);
    // ここからは、読み込みが終わらない
    behavior["*"] = "manual";
    await page.getByRole("button", { name: "More actions" }).click();
    await page.getByRole("button", { name: "Show feed content" }).click();
    await expect(page.getByText("フィードの本文")).toBeAttached();
    await expect(post(page, 1).locator(".reserved")).toHaveCount(0);
    await expect(post(page, 1).locator("blockquote")).not.toHaveAttribute("hidden", "");
  });

  test("位置を戻したところで見えている覚えた高さの枠は、そこに読み込み、本文を動かさない", async ({
    page,
    context,
  }) => {
    await openArticle(page, context, `${filler(3)}${quote(1)}${filler(60, 3)}`, {
      "*": "render:240:500",
    });
    await showPost(page, 1);
    // 投稿が画面の上のほうに見えているところで、読み込み直す
    await post(page, 1).evaluate((node) => node.scrollIntoView({ block: "start" }));
    await scrollTo(page, (await scrollTopOf(page)) - 100);
    await letRemember(page);
    const before = await paragraphTop(page, 5);
    await page.reload();
    await expect(page.locator(".article-view h1")).toHaveText("X の投稿を引いた記事");
    // 読み込みを始める前から、覚えた高さの枠を取っている
    await expect(post(page, 1).locator(".reserved, iframe")).toHaveCount(1);
    await expect
      .poll(async () => Math.abs((await paragraphTop(page, 5)) - before))
      .toBeLessThanOrEqual(16);
    const settled = await paragraphTop(page, 5);
    // 枠の中に読み込み、出ても、下の本文は動かない
    await expect(post(page, 1).locator("iframe")).toHaveCount(1);
    await expectShown(page, 1);
    expect((await post(page, 1).locator("iframe").boundingBox())?.height).toBe(240);
    expect(Math.abs((await paragraphTop(page, 5)) - settled)).toBeLessThan(1);
  });

  test("元の引用に戻した投稿の大きさは、位置と一緒に書かない", async ({ page, context }) => {
    const { server } = await openArticle(page, context, `${quote(1)}${filler(60)}`, {
      "*": "render:240",
    });
    await expectShown(page, 1);
    await scrollTo(page, 2000);
    await letRemember(page);
    expect(await articleState(page)).toMatchObject({ xPosts: [{ id: postId(1) }] });
    // 設定を切ったと届き、ウィジェットを外して元の引用に戻す
    server.putSetting("desktop", "reader.xPosts", false);
    await page.getByRole("button", { name: "Sync now" }).click();
    await expect(post(page, 1).locator("blockquote")).not.toHaveAttribute("hidden", "");
    await scrollTo(page, 2100);
    await letRemember(page);
    const state = (await articleState(page)) as { xPosts?: unknown };
    expect(state.xPosts).toBeUndefined();
  });

  test("読み込み中の投稿を速く通り過ぎても、見えている本文が動かない", async ({
    page,
    context,
  }) => {
    await openArticle(page, context, `${filler(20)}${quote(1)}${quote(2)}${filler(60, 20)}`, {
      "*": "manual",
    });
    // 投稿を表示範囲に入れて読み込みを始め、すぐに下へ通り過ぎる
    await post(page, 1).scrollIntoViewIfNeeded();
    await expect(iframes(page)).toHaveCount(2);
    await page
      .locator(".article-view .body p", { hasText: /^段落 40。/ })
      .evaluate((node) => node.scrollIntoView({ block: "center" }));
    const top = await paragraphTop(page, 40);
    await expect(iframes(page)).toHaveCount(0);
    for (let i = 0; i < 3; i++) {
      await page.waitForTimeout(500);
      expect(await paragraphTop(page, 40)).toBe(top);
    }
  });
});

/**
 * 投稿 1〜4 と 6 を一度出して覚えさせ、答え方を替えてから、1〜4 が見えるところで読み込み直す。
 * 読み込み直したあとは、どれも覚えた高さ（200px）の枠を取る。1〜4 は表示範囲に入っているので、
 * そこに読み込み始め、6 は表示範囲の外で、空の枠のまま待つ
 */
async function reloadWithReservedBoxes(
  page: Page,
  context: BrowserContext,
  after: How,
  content = `${[1, 2, 3, 4].map(quote).join("")}${filler(80)}${quote(6)}`,
): Promise<Opened> {
  await page.setViewportSize({ width: 1280, height: 1400 });
  const behavior: Record<string, How> = { "*": "render:200" };
  const opened = await openArticle(page, context, content, behavior);
  for (const n of [1, 2, 3, 4]) await expectShown(page, n);
  await showPost(page, 6);
  await scrollTo(page, 10);
  await letRemember(page);
  behavior["*"] = after;
  await page.reload();
  await expect(page.locator(".article-view h1")).toHaveText("X の投稿を引いた記事");
  // すぐに失敗する答え方では、1〜4 は元の引用に戻るので、まだ読み込まない 6 だけを確かめる
  for (const n of after === "undefined" ? [6] : [1, 2, 3, 4, 6]) {
    await expect(post(page, n).locator("blockquote")).toHaveAttribute("hidden", "");
  }
  await expect(post(page, 6).locator(".reserved")).toHaveCount(1);
  return opened;
}

/** 位置と一緒に書いた投稿の大きさ（ID から高さ） */
async function writtenSizes(page: Page): Promise<Record<string, number>> {
  const state = (await articleState(page)) as { xPosts?: { id: string; height: number }[] };
  return Object.fromEntries((state.xPosts ?? []).map((size) => [size.id, size.height]));
}

/** 投稿の枠（覚えた高さの空の枠か、iframe）の高さ */
async function boxHeight(page: Page, n: number): Promise<number | undefined> {
  return (await post(page, n).locator(".reserved, iframe").boundingBox())?.height;
}

test.describe("覚えた高さの枠を取ったあと", () => {
  test("読み込み中に表示範囲から出たら、覚えた高さの空の枠に戻し、数から外す。入り直したら読み込み直す", async ({
    page,
    context,
  }) => {
    const { requested } = await reloadWithReservedBoxes(page, context, "manual");
    await expect(iframes(page)).toHaveCount(4);
    for (const n of [1, 2, 3, 4]) expect(await boxHeight(page, n)).toBe(200);
    // 下の投稿まで動かす。1〜4 は空の枠に戻り（高さは同じ、元の引用は出さない）、6 を始める
    await scrollToEnd(page);
    await expect(post(page, 6).locator("iframe")).toHaveCount(1);
    for (const n of [1, 2, 3, 4]) {
      await expect(post(page, n).locator("iframe")).toHaveCount(0);
      await expect(post(page, n).locator(".reserved")).toHaveCount(1);
      expect(await boxHeight(page, n)).toBe(200);
      await expect(post(page, n).locator("blockquote")).toHaveAttribute("hidden", "");
    }
    // 見えている本文は動かない
    const top = await paragraphTop(page, 79);
    await page.waitForTimeout(500);
    expect(Math.abs((await paragraphTop(page, 79)) - top)).toBeLessThan(1);
    // 空の枠を出している投稿の大きさは、位置と一緒に書く
    await letRemember(page);
    expect(await writtenSizes(page)).toMatchObject({
      [postId(1)]: 200,
      [postId(2)]: 200,
      [postId(3)]: 200,
      [postId(4)]: 200,
    });
    // 入り直したら、最初から読み込む
    const loaded = requested.frames.filter((url) => url.includes(postId(1))).length;
    await scrollTo(page, 0);
    await expect(iframes(page)).toHaveCount(4);
    await expect
      .poll(() => requested.frames.filter((url) => url.includes(postId(1))).length)
      .toBeGreaterThan(loaded);
    await settle(page, 1, 200);
    await expectShown(page, 1);
    // 出たあとは、表示範囲から出ても外さない
    await scrollToEnd(page);
    await page.waitForTimeout(300);
    await expect(post(page, 1).locator("iframe")).toHaveCount(1);
  });

  test("覚えた高さの枠が failed を受けたら、元の引用に戻し、やり直さない。大きさも書かない", async ({
    page,
    context,
  }) => {
    await reloadWithReservedBoxes(page, context, "undefined");
    for (const n of [1, 2, 3, 4]) {
      await expect(post(page, n).locator("blockquote")).not.toHaveAttribute("hidden", "");
      await expect(post(page, n).locator(".reserved, iframe")).toHaveCount(0);
    }
    // ほかの投稿の、まだ読み込んでいない枠は、そのまま
    await expect(post(page, 6).locator(".reserved")).toHaveCount(1);
    await scrollToEnd(page);
    await page.waitForTimeout(300);
    await scrollTo(page, 5);
    await letRemember(page);
    await expect(post(page, 1).locator(".reserved, iframe")).toHaveCount(0);
    const state = (await articleState(page)) as { xPosts?: { id: string }[] };
    expect((state.xPosts ?? []).map((size) => size.id)).not.toContain(postId(1));
  });

  test("覚えた高さの枠が、表示範囲に入ったまま 10 秒たっても出なければ、元の引用に戻す", async ({
    page,
    context,
  }) => {
    await page.clock.install();
    await reloadWithReservedBoxes(page, context, "manual");
    await expect(iframes(page)).toHaveCount(4);
    await page.clock.fastForward(10_500);
    await expect(iframes(page)).toHaveCount(0);
    for (const n of [1, 2, 3, 4]) {
      await expect(post(page, n).locator(".reserved")).toHaveCount(0);
      await expect(post(page, n).locator("blockquote")).not.toHaveAttribute("hidden", "");
    }
  });

  test("オフラインになったら、読み込み中の枠も、まだ読み込んでいない枠も、元の引用に戻す。つながったら引用から読み込む", async ({
    page,
    context,
  }) => {
    // 1〜4 は読み込み中、6 は覚えた高さの枠のまま、表示範囲の外にある
    await reloadWithReservedBoxes(page, context, "manual");
    await expect(iframes(page)).toHaveCount(4);

    await context.setOffline(true);
    await expect(iframes(page)).toHaveCount(0);
    for (const n of [1, 2, 3, 4, 6]) {
      await expect(post(page, n).locator(".reserved")).toHaveCount(0);
      await expect(post(page, n).locator("blockquote")).not.toHaveAttribute("hidden", "");
    }
    // 元の引用に戻した投稿の大きさは、書かない
    await scrollTo(page, 30);
    await letRemember(page);
    expect(await writtenSizes(page)).toEqual({});
    // つながったら、表示範囲に入っているものを、元の引用から読み込む（枠は取り直さない）
    await context.setOffline(false);
    await expect(iframes(page)).toHaveCount(4);
    expect(await boxHeight(page, 1)).toBe(0);
    await expect(post(page, 1).locator("blockquote")).not.toHaveAttribute("hidden", "");
    await expect(post(page, 6).locator(".reserved")).toHaveCount(0);
    await settle(page, 1, 200);
    await expectShown(page, 1);
  });

  test("設定を切ったと届いたら、覚えた高さの枠を元の引用に戻す。入れたら引用から読み込む", async ({
    page,
    context,
  }) => {
    const { server } = await reloadWithReservedBoxes(page, context, "manual");
    await expect(iframes(page)).toHaveCount(4);
    server.putSetting("desktop", "reader.xPosts", false);
    await page.getByRole("button", { name: "Sync now" }).click();
    await expect(iframes(page)).toHaveCount(0);
    for (const n of [1, 2, 3, 4, 6]) {
      await expect(post(page, n).locator(".reserved")).toHaveCount(0);
      await expect(post(page, n).locator("blockquote")).not.toHaveAttribute("hidden", "");
    }
    await scrollTo(page, 30);
    await letRemember(page);
    expect(await writtenSizes(page)).toEqual({});
    server.removeSetting("desktop", "reader.xPosts");
    await page.getByRole("button", { name: "Sync now" }).click();
    await expect(iframes(page)).toHaveCount(4);
    expect(await boxHeight(page, 1)).toBe(0);
  });

  test("出た高さが覚えた高さと違えば、その高さに付け直し、覚え直す", async ({ page, context }) => {
    await reloadWithReservedBoxes(page, context, "render:260:300");
    for (const n of [1, 2, 3, 4]) {
      await expect.poll(() => boxHeight(page, n)).toBe(260);
      await expectShown(page, n);
    }
    await scrollTo(page, 20);
    await letRemember(page);
    expect(await articleState(page)).toMatchObject({
      xPosts: expect.arrayContaining([expect.objectContaining({ id: postId(1), height: 260 })]),
    });
  });

  test("読み込み中に裏に回ったら、覚えた高さの空の枠に戻し、前に出たら読み込み直す", async ({
    page,
    context,
  }) => {
    await reloadWithReservedBoxes(page, context, "manual");
    await expect(iframes(page)).toHaveCount(4);
    await setHidden(page, true);
    await expect(iframes(page)).toHaveCount(0);
    for (const n of [1, 2, 3, 4]) {
      await expect(post(page, n).locator(".reserved")).toHaveCount(1);
      expect(await boxHeight(page, n)).toBe(200);
    }
    // 裏に回ったときに書いた位置にも、空の枠の大きさが入っている
    await expect
      .poll(() => writtenSizes(page))
      .toMatchObject({ [postId(1)]: 200, [postId(4)]: 200, [postId(6)]: 200 });
    await setHidden(page, false);
    await expect(iframes(page)).toHaveCount(4);
    expect(await boxHeight(page, 1)).toBe(200);
  });
  test("同じ投稿を 2 回引いた記事で、片方が失敗したら、もう片方の覚えた高さの枠も元の引用に戻す", async ({
    page,
    context,
  }) => {
    const behavior: Record<string, How> = { "*": "render:200" };
    await openArticle(
      page,
      context,
      `${quote(1)}${filler(80)}${quote(1)}${filler(5, 80)}`,
      behavior,
    );
    const first = post(page, 1).first();
    const second = post(page, 1).last();
    await expect(first.locator("blockquote")).toHaveAttribute("hidden", "");
    await second.scrollIntoViewIfNeeded();
    await expect(second.locator("blockquote")).toHaveAttribute("hidden", "");
    await scrollTo(page, 10);
    await letRemember(page);
    behavior["*"] = "undefined";
    await page.reload();
    await expect(page.locator(".article-view h1")).toHaveText("X の投稿を引いた記事");
    // 先頭のものが失敗する。下の、まだ読み込んでいない枠も、元の引用に戻る
    await expect(first.locator("blockquote")).not.toHaveAttribute("hidden", "");
    await expect(second.locator(".reserved")).toHaveCount(0);
    await expect(second.locator("blockquote")).not.toHaveAttribute("hidden", "");
  });
  test("同じ投稿の片方が失敗したあと、読み込み中だったもう片方が表示範囲から出たら、元の引用に戻す", async ({
    page,
    context,
  }) => {
    const behavior: Record<string, How> = { "*": "render:200" };
    await openArticle(page, context, `${quote(1)}${quote(1)}${filler(80)}`, behavior);
    const [first, second] = [post(page, 1).first(), post(page, 1).last()];
    for (const item of [first, second]) {
      await expect(item.locator("blockquote")).toHaveAttribute("hidden", "");
    }
    await scrollTo(page, 10);
    await letRemember(page);
    behavior["*"] = "manual";
    await page.reload();
    await expect(page.locator(".article-view h1")).toHaveText("X の投稿を引いた記事");
    await expect(iframes(page)).toHaveCount(2);
    // 1 つ目だけを失敗させる（2 つ目は読み込み中のまま）
    const frames = () =>
      page.frames().filter((frame) => frame.url().startsWith(`${EMBED}/#id=${postId(1)}&`));
    await expect.poll(() => frames().length).toBe(2);
    const failing = frames()[0];
    if (failing === undefined) throw new Error("隔離フレームがない");
    await failing.waitForLoadState("load");
    await expect.poll(() => failing.evaluate(() => "__settle" in window)).toBe(true);
    await failing.evaluate(() =>
      (window as unknown as { __settle: (height?: number) => void }).__settle(undefined),
    );
    await expect(iframes(page)).toHaveCount(1);
    // 読み込み中の 2 つ目を表示範囲から出すと、空の枠ではなく元の引用に戻る
    await scrollToEnd(page);
    await expect(iframes(page)).toHaveCount(0);
    for (const item of [first, second]) {
      await expect(item.locator(".reserved")).toHaveCount(0);
      await expect(item.locator("blockquote")).not.toHaveAttribute("hidden", "");
    }
  });
});

/** ウィジェットの中のボタンが押された回数 */
function innerClicks(frame: Frame): Promise<number> {
  return frame.evaluate(() => (window as unknown as { __innerClicks: number }).__innerClicks);
}

const cover = (page: Page, n: number) =>
  post(page, n).getByRole("button", { name: "X の投稿を操作する" });

test.describe("ウィジェットの上の覆いとフォーカス", () => {
  test("出たウィジェットには、同じ大きさの透明な覆いがある。読み込み中と失敗のときはない", async ({
    page,
    context,
  }) => {
    const { violations } = await openArticle(page, context, `${quote(1)}${quote(2)}${quote(3)}`, {
      [postId(1)]: "render:240",
      [postId(2)]: "manual",
      [postId(3)]: "undefined",
    });
    await expectShown(page, 1);
    await expect(cover(page, 1)).toHaveCount(1);
    const frameBox = await post(page, 1).locator("iframe").boundingBox();
    expect(await cover(page, 1).boundingBox()).toEqual(frameBox);
    // ポインターを重ねても、押している間も、透明のまま（ウィジェットを塗らない）
    const transparent = "rgba(0, 0, 0, 0)";
    const background = () =>
      cover(page, 1).evaluate((node) => getComputedStyle(node).backgroundColor);
    expect(await background()).toBe(transparent);
    await cover(page, 1).hover();
    expect(await background()).toBe(transparent);
    if (frameBox === null) throw new Error("枠がない");
    await page.mouse.down();
    expect(await background()).toBe(transparent);
    await page.mouse.move(0, 0);
    await page.mouse.up();
    await expect(cover(page, 1)).toHaveCount(1);
    // 読み込み中、失敗して元の引用を出しているときは、覆いはない
    await expect(post(page, 2).locator("iframe")).toHaveCount(1);
    await expect(cover(page, 2)).toHaveCount(0);
    await expect(post(page, 3).locator("blockquote")).not.toHaveAttribute("hidden", "");
    await expect(cover(page, 3)).toHaveCount(0);
    // Open on X のリンクは、覆いの下に隠れない
    const link = post(page, 1).getByRole("link", { name: "Open on X" });
    const hit = await link.evaluate((node) => {
      const box = node.getBoundingClientRect();
      const top = document.elementFromPoint(box.x + box.width / 2, box.y + box.height / 2);
      return top !== null && node.contains(top);
    });
    expect(hit).toBe(true);
    // ウィジェットの高さが変わったら、覆いもついていく
    const inner = await frameOf(page, 1);
    await inner.evaluate(() =>
      (window as unknown as { __resize: (h: number) => void }).__resize(320),
    );
    await expect.poll(async () => (await cover(page, 1).boundingBox())?.height).toBe(320);
    expect(await violations()).toEqual([]);
  });

  test("覆いを 1 回押すと外れ、その操作は中に届かない。次の操作から中に届く", async ({
    page,
    context,
  }) => {
    await openArticle(page, context, quote(1));
    await expectShown(page, 1);
    const inner = await frameOf(page, 1);
    await cover(page, 1).click();
    await expect(cover(page, 1)).toHaveCount(0);
    expect(await innerClicks(inner)).toBe(0);
    await page.frameLocator(`.article-view .x-post iframe`).locator("#inner").click();
    await expect.poll(() => innerClicks(inner)).toBe(1);
  });

  test("覆いはキーボードでフォーカスでき、Enter と Space で外れる。フォーカスの枠が見える", async ({
    page,
    context,
  }) => {
    await openArticle(page, context, `${quote(1)}${quote(2)}`);
    await expectShown(page, 1);
    await expectShown(page, 2);
    // キーボードで、覆いに移る（1 つ目の投稿の Open on X から、1 つ前へ）
    await post(page, 1).getByRole("link", { name: "Open on X" }).focus();
    await page.keyboard.press("Shift+Tab");
    await expect(cover(page, 1)).toBeFocused();
    expect(await cover(page, 1).evaluate((node) => getComputedStyle(node).outlineStyle)).toBe(
      "solid",
    );
    await page.keyboard.press("Enter");
    await expect(cover(page, 1)).toHaveCount(0);
    // 外したあとは、Open on X に移る（フォーカスを見失わない）
    await expect(post(page, 1).getByRole("link", { name: "Open on X" })).toBeFocused();
    await cover(page, 2).focus();
    await page.keyboard.press("Space");
    await expect(cover(page, 2)).toHaveCount(0);
    await expect(post(page, 2).getByRole("link", { name: "Open on X" })).toBeFocused();
  });

  test("ウィジェットが表示範囲から出たら、覆いを掛け直す", async ({ page, context }) => {
    await openArticle(page, context, `${quote(1)}${filler(60)}`);
    await expectShown(page, 1);
    await cover(page, 1).click();
    await expect(cover(page, 1)).toHaveCount(0);
    await scrollToEnd(page);
    await expect(post(page, 1)).not.toBeInViewport();
    await page.waitForTimeout(300);
    await scrollTo(page, 0);
    await expect(cover(page, 1)).toHaveCount(1);
  });

  test("覆いの上でホイールを回すと、記事がスクロールする。覆いは外れない", async ({
    page,
    context,
  }) => {
    await openArticle(page, context, `${quote(1)}${filler(60)}`);
    await expectShown(page, 1);
    const box = await cover(page, 1).boundingBox();
    if (box === null) throw new Error("覆いがない");
    await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
    await page.mouse.wheel(0, 300);
    await expect.poll(() => scrollTopOf(page)).toBeGreaterThan(100);
    await expect(cover(page, 1)).toHaveCount(1);
  });

  test.describe("スマホ", () => {
    test.use({ viewport: { width: 390, height: 844 }, hasTouch: true });

    test("覆いの上から始めた横のスワイプで記事を移る。縦に指で動かすとスクロールする。どちらでも覆いは外れない", async ({
      page,
      context,
    }) => {
      await openArticle(page, context, `${quote(1)}${filler(60)}`);
      await expectShown(page, 1);
      // 縦に指で動かす（本物のタッチの操作）
      const box = await cover(page, 1).boundingBox();
      if (box === null) throw new Error("覆いがない");
      const cdp = await context.newCDPSession(page);
      const x = Math.round(box.x + box.width / 2);
      const y = Math.round(box.y + box.height / 2);
      await cdp.send("Input.dispatchTouchEvent", { type: "touchStart", touchPoints: [{ x, y }] });
      for (let step = 1; step <= 10; step++) {
        await cdp.send("Input.dispatchTouchEvent", {
          type: "touchMove",
          touchPoints: [{ x, y: y - step * 20 }],
        });
      }
      await cdp.send("Input.dispatchTouchEvent", { type: "touchEnd", touchPoints: [] });
      await expect.poll(() => page.evaluate(() => window.scrollY)).toBeGreaterThan(100);
      await expect(cover(page, 1)).toHaveCount(1);
      await page.evaluate(() => window.scrollTo({ top: 0 }));

      /** 覆いの上で、指を横に払う（既定では、右へ払うと一覧に戻る。左は何もしない） */
      const flick = (from: number, to: number) =>
        cover(page, 1).evaluate(
          (element, { start, end }) => {
            const at = (x: number) =>
              new Touch({ identifier: 1, target: element, clientX: x, clientY: 300 });
            const fire = (type: string, touches: Touch[], changed: Touch[]) =>
              element.dispatchEvent(
                new TouchEvent(type, { bubbles: true, touches, changedTouches: changed }),
              );
            fire("touchstart", [at(start)], [at(start)]);
            fire("touchend", [], [at(end)]);
          },
          { start: from, end: to },
        );
      await flick(260, 100);
      await page.waitForTimeout(300);
      await expect(cover(page, 1)).toHaveCount(1);
      await flick(100, 260);
      await expect(page.locator(".article-list")).toBeVisible();
    });

    test("覆いをタップすると外れ、そのタップは中に届かない", async ({ page, context }) => {
      await openArticle(page, context, quote(1));
      await expectShown(page, 1);
      const inner = await frameOf(page, 1);
      const box = await cover(page, 1).boundingBox();
      if (box === null) throw new Error("覆いがない");
      await page.touchscreen.tap(box.x + box.width / 2, box.y + 20);
      await expect(cover(page, 1)).toHaveCount(0);
      expect(await innerClicks(inner)).toBe(0);
      await page.touchscreen.tap(box.x + box.width / 2, box.y + 20);
      await expect.poll(() => innerClicks(inner)).toBe(1);
    });
  });

  test("ウィジェットの中を押したあとも、キーボードの操作が効く。押した操作は取り消さず、スクロールしない", async ({
    page,
    context,
  }) => {
    await openArticle(
      page,
      context,
      `${filler(3)}${quote(1)}${filler(60, 3)}`,
      { "*": "render:240" },
      (server, feedId) =>
        server.deliver(feedId, {
          title: "次の記事",
          summary: "要約",
          content: filler(5),
          publishedAt: 0,
        }),
    );
    await post(page, 1).scrollIntoViewIfNeeded();
    await expectShown(page, 1);
    const inner = await frameOf(page, 1);
    await cover(page, 1).click();
    const top = await scrollTopOf(page);
    await page.frameLocator(`.article-view .x-post iframe`).locator("#inner").click();
    await expect.poll(() => innerClicks(inner)).toBe(1);
    // フォーカスは本文に戻り、スクロールしない
    await expect
      .poll(() => page.evaluate(() => document.activeElement?.className ?? ""))
      .toContain("content");
    expect(await scrollTopOf(page)).toBe(top);
    await page.keyboard.press("j");
    await expect(page.locator(".article-view h1")).toHaveText("次の記事");
    await page.keyboard.press("k");
    await expect(page.locator(".article-view h1")).toHaveText("X の投稿を引いた記事");
    await page.keyboard.press("Escape");
    await expect(page.locator(".article-view h1")).toHaveCount(0);
  });

  test("ウィジェットでないところへ移ったときは、フォーカスを動かさない", async ({
    page,
    context,
  }) => {
    await openArticle(page, context, quote(1));
    await expectShown(page, 1);
    const save = page.locator(".article-view").getByRole("button", { name: "Save" });
    await save.focus();
    // ほかの窓やタブへ移った
    await page.evaluate(() => window.dispatchEvent(new Event("blur")));
    await expect(save).toBeFocused();
  });

  test("iframe は Tab キーの順に入らない。Tab で進むと、覆い、Open on X、後ろのリンクの順に移る", async ({
    page,
    context,
  }) => {
    await openArticle(
      page,
      context,
      `<p><a href="https://example.com/before">前のリンク</a></p>${quote(1)}${quote(2)}` +
        `<p><a href="https://example.com/after">後ろのリンク</a></p>`,
      { [postId(1)]: "render:240", [postId(2)]: "manual" },
    );
    await expectShown(page, 1);
    await expect(post(page, 2).locator("iframe")).toHaveCount(1);
    for (const n of [1, 2]) {
      await expect(post(page, n).locator("iframe")).toHaveAttribute("tabindex", "-1");
    }
    const body = page.locator(".article-view .body");
    await body.getByRole("link", { name: "前のリンク" }).focus();
    // 出たウィジェットは覆い → Open on X、読み込み中（覆いがない）は Open on X、の順に進み、本文に戻されない
    const order = [
      cover(page, 1),
      post(page, 1).getByRole("link", { name: "Open on X" }),
      // 読み込み中は元の引用を出しているので、引用の中のリンクにも止まる
      post(page, 2).getByRole("link", { name: "日付" }),
      post(page, 2).getByRole("link", { name: "Open on X" }),
      body.getByRole("link", { name: "後ろのリンク" }),
    ];
    for (const next of order) {
      await page.keyboard.press("Tab");
      await expect(next).toBeFocused();
    }
  });

  test("覆いを指やマウスで押したときは、Open on X にフォーカスを移さず、スクロールしない", async ({
    page,
    context,
  }) => {
    // 背の高いウィジェット。Open on X は画面の外にある
    await openArticle(page, context, `${quote(1)}${filler(40)}`, { "*": "render:1400" });
    await expectShown(page, 1);
    const link = post(page, 1).getByRole("link", { name: "Open on X" });
    await expect(link).not.toBeInViewport();
    const top = await scrollTopOf(page);
    const box = await cover(page, 1).boundingBox();
    if (box === null) throw new Error("覆いがない");
    await page.mouse.click(box.x + box.width / 2, box.y + 100);
    await expect(cover(page, 1)).toHaveCount(0);
    await page.waitForTimeout(300);
    await expect(link).not.toBeFocused();
    expect(await scrollTopOf(page)).toBe(top);
  });
});
