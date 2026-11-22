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
 * - undefined：すぐに undefined で解決する（存在しない投稿）
 * - manual：テストが __settle で決めるまで、解決しない
 */
type How = `render:${number}` | "undefined" | "manual";

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
      return new Promise((resolve) => {
        window.__settle = (height) => {
          if (height === undefined) return resolve(undefined);
          tweet.style.height = height + "px";
          container.append(tweet);
          resolve(tweet);
        };
        window.__resize = (height) => { tweet.style.height = height + "px"; };
        if (how.startsWith("render:")) window.__settle(Number(how.slice(7)));
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
  extra: (server: FakeSendo, feedId: string) => void = () => {},
): Promise<Opened> {
  const server = new FakeSendo();
  const feed = server.subscribe({ url: "https://blog.example/feed.xml", title: "Blog" });
  const article = server.deliver(feed.id, {
    title: "X の投稿を引いた記事",
    summary: "要約",
    content,
  });
  extra(server, feed.id);
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
