import { type BrowserContext, expect, type Frame, type Page, test } from "@playwright/test";
import { FakeSendo, routeFakeSendo } from "./fake-sendo";
import { type RunningPreview, startPreview } from "./x-embed-preview";

/**
 * X の投稿の隔離フレームのページ（x-embed/。docs/decisions/embeds.md の 2）を、ブラウザーで確かめる。
 * 手元の preview に、開発用の隔離フレームのオリジン（http://127.0.0.1）を設定して配らせ、reader の
 * 画面（http://localhost。本番と同じ CSP で frame-src にそのオリジンが入る）から、本番と同じ属性の
 * iframe で開く。X（platform.twitter.com）は、外へ出さずに context.route で偽物にする
 */

const PORT = 4187;
const READER = `http://localhost:${PORT}/`;
const EMBED = `http://127.0.0.1:${PORT}`;
const ID = "1234567890123456789";

let preview: RunningPreview | null = null;
test.beforeAll(async () => {
  preview = await startPreview(PORT, { X_EMBED_ORIGIN: EMBED });
});
test.afterAll(async () => {
  await preview?.stop();
});

/** 偽の widgets.js。createTweet の Promise は、テストが __settle で決める */
const FAKE_WIDGETS = `
window.__createTweetCalls = [];
window.twttr = {
  ready(fn) { setTimeout(() => fn(window.twttr), 0); },
  widgets: {
    createTweet(id, container, options) {
      window.__createTweetCalls.push({ id, options, inContainer: container.id });
      const tweet = document.createElement("div");
      tweet.className = "twitter-tweet";
      tweet.style.margin = "10px 0";
      const frame = document.createElement("iframe");
      frame.src = "https://platform.twitter.com/embed/Tweet.html?id=" + id;
      frame.style.display = "block";
      frame.style.border = "0";
      frame.style.height = "200px";
      tweet.append(frame);
      container.append(tweet);
      return new Promise((resolve, reject) => {
        window.__settle = (how) =>
          how === "element" ? resolve(tweet) : how === "reject" ? reject(new Error("x")) : resolve(undefined);
      });
    },
  },
};
`;

type Widgets = "fake" | "missing-twttr" | "unreachable";

/** X への要求（外へは出さない）。widgets.js の答え方は、テストごとに決める */
async function routeX(context: BrowserContext, widgets: Widgets): Promise<string[]> {
  const requested: string[] = [];
  await context.route("https://platform.twitter.com/**", (route) => {
    const url = route.request().url();
    requested.push(url);
    if (url.startsWith("https://platform.twitter.com/widgets.js")) {
      if (widgets === "unreachable") return route.abort("failed");
      return route.fulfill({
        contentType: "text/javascript",
        body: widgets === "fake" ? FAKE_WIDGETS : "/* twttr を作らない */",
      });
    }
    return route.fulfill({ contentType: "text/html", body: "<!doctype html><p>tweet</p>" });
  });
  return requested;
}

/** すべての文書（隔離フレームの中も）の CSP の違反を集める */
async function collectViolations(context: BrowserContext): Promise<void> {
  await context.addInitScript(() => {
    const found: string[] = [];
    Object.assign(window, { cspViolations: found });
    document.addEventListener("securitypolicyviolation", (event) => {
      found.push(`${event.violatedDirective} ${event.blockedURI}`);
    });
  });
}

/** reader の画面を開き、本番と同じ属性の iframe で隔離フレームを開く。親が受けたメッセージを集める */
async function openFrame(page: Page, hash: string, hello = true): Promise<Frame> {
  await page.goto(READER);
  await page.evaluate(
    ({ src, hello }) => {
      const received: unknown[] = [];
      Object.assign(window, { xPostMessages: received });
      const frame = document.createElement("iframe");
      window.addEventListener("message", (event) => {
        if (event.source === frame.contentWindow) received.push(event.data);
      });
      frame.setAttribute(
        "sandbox",
        "allow-scripts allow-same-origin allow-popups allow-popups-to-escape-sandbox",
      );
      frame.setAttribute("allow", "fullscreen");
      frame.setAttribute("referrerpolicy", "no-referrer");
      frame.title = "X の投稿";
      frame.width = "550";
      frame.addEventListener("load", () => {
        if (hello)
          frame.contentWindow?.postMessage({ type: "sendo:x-post:hello" }, new URL(src).origin);
      });
      frame.src = src;
      document.body.append(frame);
    },
    { src: `${EMBED}/${hash}`, hello },
  );
  await expect.poll(() => page.frames().some((frame) => frame.url().startsWith(EMBED))).toBe(true);
  const frame = page.frames().find((candidate) => candidate.url().startsWith(EMBED));
  if (frame === undefined) throw new Error("隔離フレームがない");
  await frame.waitForLoadState("load");
  return frame;
}

function messages(page: Page): Promise<unknown[]> {
  return page.evaluate(() => (window as unknown as { xPostMessages: unknown[] }).xPostMessages);
}

function settle(frame: Frame, how: "element" | "undefined" | "reject"): Promise<void> {
  return frame.evaluate((value) => {
    (window as unknown as { __settle: (how: string) => void }).__settle(value);
  }, how);
}

async function createTweetCalled(frame: Frame): Promise<void> {
  await expect
    .poll(() =>
      frame.evaluate(
        () =>
          (window as unknown as { __createTweetCalls?: unknown[] }).__createTweetCalls?.length ?? 0,
      ),
    )
    .toBe(1);
}

test.beforeEach(async ({ context }) => {
  await routeFakeSendo(context, new FakeSendo());
  await collectViolations(context);
});

test("ID の投稿を、決めた引数で createTweet に渡し、要素で解決したら高さを知らせる", async ({
  page,
  context,
}) => {
  const requested = await routeX(context, "fake");
  const frame = await openFrame(page, `#id=${ID}&theme=dark`);
  await createTweetCalled(frame);

  expect(
    await frame.evaluate(
      () => (window as unknown as { __createTweetCalls: unknown[] }).__createTweetCalls,
    ),
  ).toEqual([
    {
      id: ID,
      options: { dnt: true, lang: "ja", conversation: "none", theme: "dark" },
      inContainer: "post",
    },
  ]);
  expect(requested[0]).toBe("https://platform.twitter.com/widgets.js");
  expect(
    await frame.evaluate(() =>
      document.querySelector('meta[name="twitter:widgets:csp"]')?.getAttribute("content"),
    ),
  ).toBe("on");
  expect(await frame.evaluate(() => document.documentElement.style.colorScheme)).toBe("dark");

  // 解決の前には、高さを送らない（入れ物には、もう高さがある）
  await page.waitForTimeout(300);
  expect(await messages(page)).toEqual([]);

  await settle(frame, "element");
  // 高さは、余白を含めた入れ物の高さ（ウィジェットの 200px と、上下の余白 10px ずつ）
  await expect.poll(() => messages(page)).toEqual([{ type: "sendo:x-post:rendered", height: 220 }]);

  // 解決のあとで高さが変わったら、もう一度送る。縮んだときも送る
  await frame.evaluate(() => {
    const tweet = document.querySelector<HTMLIFrameElement>(".twitter-tweet iframe");
    if (tweet) tweet.style.height = "260px";
  });
  await expect
    .poll(() => messages(page))
    .toEqual([
      { type: "sendo:x-post:rendered", height: 220 },
      { type: "sendo:x-post:rendered", height: 280 },
    ]);
  await frame.evaluate(() => {
    const tweet = document.querySelector<HTMLIFrameElement>(".twitter-tweet iframe");
    if (tweet) tweet.style.height = "150px";
  });
  await expect
    .poll(async () => (await messages(page)).at(-1))
    .toEqual({
      type: "sendo:x-post:rendered",
      height: 170,
    });

  // X の iframe も動き、reader の画面にも隔離フレームにも、CSP の違反は出ない
  expect(
    requested.some((url) => url.startsWith("https://platform.twitter.com/embed/Tweet.html")),
  ).toBe(true);
  for (const each of page.frames().filter((candidate) => !candidate.url().startsWith("https://"))) {
    expect(
      await each.evaluate(() => (window as unknown as { cspViolations: string[] }).cspViolations),
      each.url(),
    ).toEqual([]);
  }
});

test("テーマが light なら、color-scheme も light にする", async ({ page, context }) => {
  await routeX(context, "fake");
  const frame = await openFrame(page, `#id=${ID}&theme=light`);
  await createTweetCalled(frame);
  expect(await frame.evaluate(() => document.documentElement.style.colorScheme)).toBe("light");
});

test("挨拶より先に結果が出たら、挨拶を受けてから送る", async ({ page, context }) => {
  await routeX(context, "fake");
  const frame = await openFrame(page, `#id=${ID}&theme=light`, false);
  await createTweetCalled(frame);
  await settle(frame, "element");
  await page.waitForTimeout(300);
  expect(await messages(page)).toEqual([]);

  await page.evaluate((origin) => {
    document
      .querySelector("iframe")
      ?.contentWindow?.postMessage({ type: "sendo:x-post:hello" }, origin);
  }, EMBED);
  await expect.poll(() => messages(page)).toEqual([{ type: "sendo:x-post:rendered", height: 220 }]);
});

test("親でない窓からの挨拶と、形の違うメッセージは無視する", async ({ page, context }) => {
  await routeX(context, "fake");
  const frame = await openFrame(page, `#id=${ID}&theme=light`, false);
  await createTweetCalled(frame);
  await settle(frame, "element");

  // 親から、形の違うメッセージ
  await page.evaluate((origin) => {
    const target = document.querySelector("iframe")?.contentWindow;
    for (const data of [
      "sendo:x-post:hello",
      { type: "hello" },
      null,
      { type: ["sendo:x-post:hello"] },
    ]) {
      target?.postMessage(data, origin);
    }
  }, EMBED);
  // 親でない窓（隔離フレームの中の X の iframe）から、挨拶
  const x = page
    .frames()
    .find((candidate) => candidate.url().startsWith("https://platform.twitter.com"));
  await x?.evaluate(() => {
    window.parent.postMessage({ type: "sendo:x-post:hello" }, "*");
  });
  await page.waitForTimeout(300);
  expect(await messages(page)).toEqual([]);
});

for (const [name, widgets, how] of [
  ["widgets.js が読めない", "unreachable", null],
  ["twttr がない", "missing-twttr", null],
  ["Promise が undefined で解決した", "fake", "undefined"],
  ["Promise が reject した", "fake", "reject"],
] as const) {
  test(`${name}ときは、failed を送る`, async ({ page, context }) => {
    await routeX(context, widgets);
    const frame = await openFrame(page, `#id=${ID}&theme=light`);
    if (how !== null) {
      await createTweetCalled(frame);
      await settle(frame, how);
    }
    await expect.poll(() => messages(page)).toEqual([{ type: "sendo:x-post:failed" }]);
  });
}

for (const hash of [
  `#id=&theme=light`,
  `#id=12a&theme=light`,
  `#id=123456789012345678901&theme=light`,
  `#id=${ID}`,
  `#id=${ID}&theme=auto`,
  `#theme=light`,
  "",
]) {
  test(`ハッシュの形が合わない（${hash || "なし"}）ときは、widgets.js を読み込まず、何も送らない`, async ({
    page,
    context,
  }) => {
    const requested = await routeX(context, "fake");
    await openFrame(page, hash);
    await page.waitForTimeout(500);
    expect(requested).toEqual([]);
    expect(await messages(page)).toEqual([]);
  });
}

test("フレームの中で開かれていなければ、widgets.js を読み込まない", async ({ page, context }) => {
  const requested = await routeX(context, "fake");
  await page.goto(`${EMBED}/#id=${ID}&theme=light`);
  await page.waitForTimeout(500);
  expect(requested).toEqual([]);
});
