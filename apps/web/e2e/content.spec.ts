import { readFile } from "node:fs/promises";
import { type BrowserContext, expect, type Page, test } from "@playwright/test";
import { FakeSendo, routeFakeSendo, signIn } from "./fake-sendo";

/**
 * 記事の本文（sendo の docs/decisions/content.md）。記事を開いたら、本文を取って要約の代わりに
 * 出す。本文は信頼できない HTML として扱い、本番と同じ CSP（vite preview）のまま、スクリプトが
 * 動かないこと、画面が崩れないことを確かめる。
 */

/** CSP の違反を集める */
async function collectCspViolations(page: Page): Promise<() => Promise<string[]>> {
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

const LONG_LINE = `const text = "${"とても長い行 ".repeat(40)}";`;
const CODE = `function less(a, b) {\n  return a < b && b > 0;\n}\n${LONG_LINE}`;
const escapeHtml = (text: string) =>
  text.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");

/** sendo がサニタイズしたあとの形の本文 */
function fullContent(server: FakeSendo): string {
  const image = escapeHtml(server.imageUrl("https://blog.example/figure.png"));
  const broken = escapeHtml(server.imageUrl("https://blog.example/broken.png"));
  const cells = Array.from({ length: 30 }, (_, i) => `<td>列${i}の値</td>`).join("");
  return [
    "<h2>はじめに</h2>",
    '<p>本文の <strong>強調</strong> と <a href="https://example.com/next?a=1&amp;b=2" rel="noopener noreferrer nofollow">リンク</a>。</p>',
    `<figure><img src="${image}" alt="図の代わりの文" width="1600" height="800"><figcaption>図の説明</figcaption></figure>`,
    `<p>壊れた画像の前<img src="${broken}" alt="壊れた画像">壊れた画像の後</p>`,
    "<blockquote><p>引用した文</p></blockquote>",
    `<pre><code>${escapeHtml(CODE)}</code></pre>`,
    `<table><thead><tr><th colspan="30">広い表</th></tr></thead><tbody><tr>${cells}</tr></tbody></table>`,
    '<ol start="3"><li>三つめ</li><li>四つめ</li></ol>',
  ].join("");
}

function seed() {
  const server = new FakeSendo();
  const blog = server.subscribe({ url: "https://blog.example/feed.xml", title: "Blog" });
  const news = server.subscribe({ url: "https://news.example/feed.xml", title: "News" });
  const t = Date.now();
  const full = server.deliver(blog.id, {
    title: "全文のある記事",
    summary: "全文のある記事の要約",
    content: fullContent(server),
    publishedAt: t - 1000,
  });
  const summaryOnly = server.deliver(news.id, {
    title: "要約だけの記事",
    summary: "要約だけの記事の要約",
    publishedAt: t - 2000,
  });
  server.imageStatusFor.set("https://blog.example/broken.png", 502);
  return { server, blog, news, full, summaryOnly };
}

/**
 * オフラインにする。ブラウザをオフラインにしても、テストが横取りしている /api への通信は偽の
 * sendo に届くので、偽の sendo の側でも、届かないことにする
 */
async function setOffline(context: BrowserContext, server: FakeSendo, offline: boolean) {
  server.onRequest = offline ? () => Promise.reject(new TypeError("offline")) : null;
  await context.setOffline(offline);
}

async function open(page: Page, title: string): Promise<void> {
  await page.locator(".article-list .item", { hasText: title }).click();
  await expect(page.getByRole("heading", { level: 1 })).toHaveText(title);
}

test("全文のある記事は、本文を出す。画像、リンク、コード、表、引用が崩れない", async ({
  page,
  context,
}) => {
  const { server } = seed();
  const violations = await collectCspViolations(page);
  await routeFakeSendo(context, server);
  await context.route("https://example.com/**", (route) =>
    route.fulfill({ contentType: "text/html", body: "<title>next</title>" }),
  );
  await page.goto("/");
  await signIn(page);
  await open(page, "全文のある記事");

  const view = page.locator(".article-view");
  const body = view.locator(".body");
  await expect(body.getByRole("heading", { level: 2 })).toHaveText("はじめに");
  // 要約の代わりに出す
  await expect(view.locator(".summary")).toHaveCount(0);
  // 文字の間の空白は、そのまま
  await expect(body.locator("p").first()).toHaveText("本文の 強調 と リンク。");
  await expect(body.locator("strong")).toHaveText("強調");
  await expect(body.locator("blockquote")).toHaveText("引用した文");
  await expect(body.locator("ol")).toHaveAttribute("start", "3");

  // 画像：中継の URL のまま出る。読み込む前から場所を取り、幅に収める
  const figure = body.locator("figure img");
  await expect(figure).toHaveAttribute("alt", "図の代わりの文");
  await expect(figure).toHaveAttribute("loading", "lazy");
  await expect(figure).toHaveAttribute("width", "1600");
  await expect(figure).toHaveAttribute("height", "800");
  await expect.poll(() => figure.evaluate((img: HTMLImageElement) => img.naturalWidth)).toBe(1);
  const size = await figure.evaluate((img) => {
    const box = img.getBoundingClientRect();
    return { width: box.width, parent: img.parentElement?.clientWidth ?? 0 };
  });
  expect(size.width).toBeLessThanOrEqual(size.parent);
  expect(size.width).toBeGreaterThan(100);
  // 場所は、width ／ height の属性の比で取る（テストの画像は 1×1 なので、読み込む前の比を見る）
  expect(await figure.evaluate((img) => getComputedStyle(img).aspectRatio)).toBe("auto 1600 / 800");
  // 読めなかった画像は、壊れた画像の印を出さない
  await expect(body.locator("img")).toHaveCount(1);
  await expect(body.getByText("壊れた画像の前壊れた画像の後")).toBeVisible();

  // コード：空白と改行はそのまま。長い行は、コードの中で横に動かす
  const pre = body.locator("pre");
  expect(await pre.evaluate((element) => element.textContent)).toBe(CODE);
  expect(await pre.evaluate((element) => element.scrollWidth > element.clientWidth)).toBe(true);
  // 表：広い表は、表の中で横に動かす
  const table = body.locator(".table-scroll");
  await expect(table.locator("th")).toHaveAttribute("colspan", "30");
  await expect(table.locator("td")).toHaveCount(30);
  expect(await table.evaluate((element) => element.scrollWidth > element.clientWidth)).toBe(true);
  // 記事の画面そのものは、横にあふれない
  expect(await view.evaluate((element) => element.scrollWidth <= element.clientWidth)).toBe(true);

  // リンクは、新しいタブで開く（読んでいた場所を失わない）
  const link = body.getByRole("link", { name: "リンク" });
  await expect(link).toHaveAttribute("target", "_blank");
  await expect(link).toHaveAttribute("rel", "noopener noreferrer nofollow");
  const before = page.url();
  const [popup] = await Promise.all([context.waitForEvent("page"), link.click()]);
  await popup.waitForLoadState();
  expect(popup.url()).toBe("https://example.com/next?a=1&b=2");
  expect(await popup.evaluate(() => window.opener)).toBeNull();
  await popup.close();
  expect(page.url()).toBe(before);
  await expect(body.getByRole("heading", { level: 2 })).toBeVisible();

  expect(await violations()).toEqual([]);
});

test("X の引用は投稿リンクを表示し、設定した隔離フレームを自動で開く", async ({
  page,
  context,
}) => {
  const { server, blog } = seed();
  server.deliver(blog.id, {
    title: "X の投稿を引用した記事",
    summary: "記事の要約",
    content:
      '<p>投稿の紹介</p><blockquote data-embed="x"><a href="https://twitter.com/user/status/123"></a></blockquote><p>記事の続き</p>',
  });
  await routeFakeSendo(context, server);
  const setting = process.env.SENDO_X_EMBED_ORIGIN;
  const embed = setting ? new URL(setting) : null;
  let waitForWidget: Promise<void> | undefined;
  if (embed) {
    const assets = new URL("../x-embed/", import.meta.url);
    const rawHeaders = await readFile(new URL("_headers", assets), "utf8");
    const csp = /^ {2}Content-Security-Policy: (.+)$/m.exec(rawHeaders)?.[1] ?? "";
    await context.route(`${embed.origin}/**`, async (route) => {
      const script = new URL(route.request().url()).pathname === "/embed.js";
      await route.fulfill({
        contentType: script ? "text/javascript" : "text/html",
        body: await readFile(new URL(script ? "embed.js" : "index.html", assets), "utf8"),
        headers: { "content-security-policy": csp },
      });
    });
    await context.route("https://platform.twitter.com/widgets.js", async (route) => {
      await waitForWidget;
      await route.fulfill({
        contentType: "text/javascript",
        body: `window.twttr = {
          ready: async (callback) => callback({
            widgets: { createTweet: async (id, container, options) => {
              if (id !== "123" || options.dnt !== true) return;
              const post = document.createElement("section");
              post.style.height = "1200px";
              post.textContent = "公式埋め込みの代わり";
              container.append(post);
              return post;
            } }
          })
        };`,
      });
    });
  }
  await page.goto("/");
  await signIn(page);
  await open(page, "X の投稿を引用した記事");

  const view = page.locator(".article-view");
  await expect(view.getByRole("link", { name: "X で開く" })).toHaveAttribute(
    "href",
    "https://x.com/user/status/123",
  );
  const frame = view.locator("iframe");
  if (embed && embed.hostname !== new URL(page.url()).hostname) {
    await expect(frame).toHaveAttribute("src", `${embed.origin}/#123`);
    await expect(frame).toHaveAttribute("sandbox", "allow-scripts allow-same-origin");
    await expect(frame).toHaveAttribute("referrerpolicy", "no-referrer");
    await expect(frame).toHaveAttribute("height", "1216");
    await expect(frame.contentFrame().getByText("公式埋め込みの代わり")).toBeVisible();

    const top = 300;
    await view.evaluate((element, offset) => element.scrollTo({ top: offset }), top);
    await page.waitForFunction((offset) => history.state?.article?.top === offset, top);
    const widget = Promise.withResolvers<void>();
    waitForWidget = widget.promise;
    try {
      await page.reload({ waitUntil: "domcontentloaded" });
      await expect(frame).toHaveAttribute("height", "0");
      expect(await view.evaluate((element) => element.scrollTop)).toBeLessThan(top);
    } finally {
      widget.resolve();
    }
    await expect.poll(() => view.evaluate((element) => element.scrollTop)).toBe(top);
  } else {
    await expect(frame).toHaveCount(0);
  }
});

test("要約だけの記事と、本文が配られる前からある記事は、今までどおり要約を出す", async ({
  page,
  context,
}) => {
  const { server, blog } = seed();
  // sendo を更新する前に取り込んだ記事（hasContent が false）
  server.deliver(blog.id, { title: "前からある記事", summary: "前からある記事の要約" });
  const errors: string[] = [];
  page.on("pageerror", (error) => errors.push(error.message));
  await routeFakeSendo(context, server);
  await page.goto("/");
  await signIn(page);
  const view = page.locator(".article-view");

  for (const title of ["要約だけの記事", "前からある記事"]) {
    await open(page, title);
    await expect(view.locator(".summary")).toHaveText(`${title}の要約`);
    await expect(view.locator(".body")).toHaveCount(0);
    await expect(view.locator(".content-note")).toHaveCount(0);
  }
  // 本文のない記事の本文は、取りにいかない
  const withContent = [...server.inbox.values()].filter((row) => row.content !== null);
  expect(server.contentRequests.every((id) => withContent.some((row) => row.id === id))).toBe(true);
  expect(errors).toEqual([]);
});

test("sendo に本文がなかった（no_content）ら、要約を出す", async ({ page, context }) => {
  const { server, full } = seed();
  server.contentGone.add(full.id);
  await routeFakeSendo(context, server);
  await page.goto("/");
  await signIn(page);
  await open(page, "全文のある記事");
  const view = page.locator(".article-view");
  await expect(view.locator(".summary")).toHaveText("全文のある記事の要約");
  await expect(view.locator(".body")).toHaveCount(0);
  await expect(view.locator(".content-note")).toHaveCount(0);
});

test("手元にある本文は、オフラインでも出る。手元になければ要約を出し、つながったら本文に替える", async ({
  page,
  context,
}) => {
  const { server, blog } = seed();
  // 既読の記事の本文は、先に取っておかない（開いたときに取る）
  const later = server.deliver(blog.id, {
    title: "あとで開く記事",
    summary: "あとで開く記事の要約",
    content: "<p>あとで開く記事の本文</p>",
    publishedAt: Date.now() - 5000,
  });
  server.setArticleState(later.id, { read: true });
  await routeFakeSendo(context, server);
  await page.goto("/");
  await signIn(page);
  const view = page.locator(".article-view");
  // 既読の記事も一覧に出す
  await page.locator(".article-list").getByRole("button", { name: "Unread only" }).click();
  await open(page, "全文のある記事");
  await expect(view.locator(".body h2")).toHaveText("はじめに");
  await page.evaluate(() => navigator.serviceWorker.ready);
  await page.reload();
  await expect
    .poll(() => page.evaluate(() => navigator.serviceWorker.controller !== null))
    .toBe(true);

  await setOffline(context, server, true);
  server.contentRequests.length = 0;
  await page.reload();
  await expect(page.getByRole("heading", { level: 1 })).toHaveText("全文のある記事");
  await expect(view.locator(".body h2")).toHaveText("はじめに");
  await expect(view.locator(".summary")).toHaveCount(0);

  // 手元に本文のない記事は、要約を出して、つながったら読めると伝える
  await open(page, "あとで開く記事");
  await expect(view.locator(".summary")).toHaveText("あとで開く記事の要約");
  await expect(view.locator(".content-note")).toContainText("つながったら読めます");
  expect(server.contentRequests).toEqual([]);

  await setOffline(context, server, false);
  await expect(view.locator(".body")).toHaveText("あとで開く記事の本文");
  expect(server.contentRequests).toEqual([later.id]);
  await expect(view.locator(".summary")).toHaveCount(0);
  await expect(view.locator(".content-note")).toHaveCount(0);
});

test("未読の新しい記事の本文は、開く前に取っておき、オフラインでも読める", async ({
  page,
  context,
}) => {
  const { server, full } = seed();
  await routeFakeSendo(context, server);
  await page.goto("/");
  await signIn(page);
  await expect(page.locator(".article-list .item")).toHaveCount(2);
  await expect.poll(() => server.contentRequests).toEqual([full.id]);
  // 本文の中の画像は、表示するまで取らない
  expect(server.imageRequests).toEqual([]);

  await setOffline(context, server, true);
  await open(page, "全文のある記事");
  await expect(page.locator(".article-view .body h2")).toHaveText("はじめに");
});

test("悪意のある本文でも、スクリプトは動かず、画面のスタイルと操作は壊れない", async ({
  page,
  context,
}) => {
  const server = new FakeSendo();
  const feed = server.subscribe({ url: "https://evil.example/feed.xml", title: "Evil" });
  const image = escapeHtml(server.imageUrl("https://evil.example/a.png"));
  // sendo のサニタイズをすり抜けたとして、そのまま届く
  server.deliver(feed.id, {
    title: "悪意のある記事",
    summary: "要約",
    content: [
      "<script>window.pwned = 'script'</script>",
      "<style>body { display: none !important } .toolbar { display: none !important }</style>",
      '<link rel="stylesheet" href="https://evil.example/x.css">',
      '<base href="https://evil.example/"><meta http-equiv="refresh" content="0;url=https://evil.example/">',
      `<img src="${image}" onerror="window.pwned = 'onerror'" onload="window.pwned = 'onload'" style="position:fixed;inset:0;width:100vw;height:100vh">`,
      "<img src=x onerror=\"window.pwned = 'img'\">",
      '<img src="https://evil.example/track.png"><img src="//evil.example/track.png">',
      "<svg onload=\"window.pwned = 'svg'\"><script>window.pwned = 'svg-script'</script></svg>",
      '<iframe src="https://evil.example/" srcdoc="<script>parent.pwned = 1</script>"></iframe>',
      '<form action="https://evil.example/"><input name="q" autofocus onfocus="window.pwned = \'focus\'"><button>送る</button></form>',
      "<a href=\"javascript:window.pwned = 'href'\">押すな</a>",
      '<a href="data:text/html,<script>opener.pwned = 1</script>">これも</a>',
      '<p id="app" class="toolbar article-view" style="position:fixed;inset:0;z-index:9999;background:red" onclick="window.pwned = \'click\'">段落</p>',
      '<div onmouseover="window.pwned = \'over\'" contenteditable="true" hidden>残る文字</div>',
      "<details open ontoggle=\"window.pwned = 'toggle'\">閉じない</details>",
      "<object data=\"javascript:window.pwned = 'object'\"></object><embed src=\"javascript:window.pwned = 'embed'\">",
      "<math><mtext><script>window.pwned = 'math'</script></mtext></math>",
    ].join(""),
  });
  const violations = await collectCspViolations(page);
  const dialogs: string[] = [];
  page.on("dialog", (dialog) => {
    dialogs.push(dialog.message());
    void dialog.dismiss();
  });
  await routeFakeSendo(context, server);
  await page.goto("/");
  await signIn(page);
  await open(page, "悪意のある記事");

  const view = page.locator(".article-view");
  const body = view.locator(".body");
  await expect(body.getByText("段落")).toBeVisible();
  await expect(body.getByText("残る文字")).toBeVisible();
  await expect.poll(() => body.locator("img").count()).toBe(1);
  await body.getByText("段落").click();
  await body.getByText("押すな").click();
  await body.getByText("残る文字").hover();

  // 通すと決めた要素と属性だけが、画面にある
  const found = await body.evaluate((root) => {
    const tags = new Set<string>();
    const attributes = new Set<string>();
    for (const element of root.querySelectorAll("*")) {
      tags.add(element.localName);
      for (const attribute of element.attributes) attributes.add(attribute.name);
    }
    return { tags: [...tags].sort(), attributes: [...attributes].sort() };
  });
  expect(found.tags).toEqual(["div", "img", "p"]);
  expect(found.attributes).toEqual(["alt", "class", "decoding", "loading", "src"]);
  // class は、reader が付けたものだけ（本文の class は使わない）
  expect(await body.locator(".toolbar, .article-view, #app").count()).toBe(0);
  await expect(page.locator("#app")).toHaveCount(1);

  // スクリプトは動いていない
  expect(
    await page.evaluate(() => (window as unknown as { pwned?: unknown }).pwned),
  ).toBeUndefined();
  expect(dialogs).toEqual([]);
  // ほかのオリジンへは、何も取りにいこうとしていない（CSP で止まる前に、出していない）
  expect(await violations()).toEqual([]);

  // 画面のスタイルと操作は、そのまま
  await expect(view.locator(".toolbar")).toBeVisible();
  const paragraph = await body.getByText("段落").evaluate((element) => {
    const style = getComputedStyle(element);
    return { position: style.position, background: style.backgroundColor };
  });
  expect(paragraph).toEqual({ position: "static", background: "rgba(0, 0, 0, 0)" });
  expect(await body.locator("img").evaluate((img) => getComputedStyle(img).position)).toBe(
    "static",
  );
  await view.getByRole("button", { name: "Save" }).click();
  await expect(view.getByRole("button", { name: "Unsave" })).toBeVisible();
});

test.describe("スマホ", () => {
  test.use({ viewport: { width: 390, height: 844 }, hasTouch: true });

  test("表やコードを横に動かす指の動きは、記事のスワイプとして扱わない", async ({
    page,
    context,
  }) => {
    const { server } = seed();
    await routeFakeSendo(context, server);
    await page.goto("/");
    await signIn(page);
    await open(page, "全文のある記事");
    const view = page.locator(".article-view");
    await expect(view.locator(".body h2")).toHaveText("はじめに");

    /** selector の要素の上で、指を右へ払う（既定では、記事を右へスワイプすると一覧に戻る） */
    const flickRight = (selector: string) =>
      view.locator(selector).evaluate((element) => {
        const at = (x: number) =>
          new Touch({ identifier: 1, target: element, clientX: x, clientY: 300 });
        const fire = (type: string, touches: Touch[], changed: Touch[]) =>
          element.dispatchEvent(
            new TouchEvent(type, { bubbles: true, touches, changedTouches: changed }),
          );
        fire("touchstart", [at(100)], [at(100)]);
        fire("touchend", [], [at(260)]);
      });

    for (const selector of [".body td >> nth=0", ".body pre code"]) {
      await flickRight(selector);
      await page.waitForTimeout(200);
      await expect(page.getByRole("heading", { level: 1 })).toHaveText("全文のある記事");
    }
    // 横に動かせないところでは、これまでどおり一覧に戻る
    await flickRight(".body blockquote");
    await expect(page.locator(".article-list")).toBeVisible();
    await expect(page).toHaveURL(/\/$/);
  });
});
