import { type BrowserContext, expect, type Locator, type Page, test } from "@playwright/test";
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

test("要約だけの記事と、本文が配られる前からある記事は、今までどおり要約を出す", async ({
  page,
  context,
}) => {
  const { server, blog, full } = seed();
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
    // 開いたときの全文の取得が終わる（全文はないので、その旨が出る）のを待ってから確かめる
    await expect(view.getByRole("status")).toHaveText(
      "全文を取得できませんでした。元の記事で続きを読めます。",
    );
    await expect(view.locator(".summary")).toHaveText(`${title}の要約`);
    await expect(view.locator(".body")).toHaveCount(0);
    await expect(view.locator(".content-note", { hasText: "つながったら読めます" })).toHaveCount(0);
  }
  // 本文のない記事のフィード本文は、取りにいかない（本文のある記事は、全文が取れないので
  // 先読みでフィード本文を取る。3 件とも全文を頼み終えてから、フィード本文の取得を見る）
  // （開いたときにも全文を頼むので、数ではなく、どの記事を頼んだかで見る）
  await expect.poll(() => new Set(server.pageContentRequests).size).toBe(server.inbox.size);
  await expect.poll(() => server.contentRequests).toContain(full.id);
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
  // 開いたときの全文の取得が終わる（全文はないので、その旨が出る）のを待ってから確かめる
  await expect(view.getByRole("status")).toHaveText(
    "全文を取得できませんでした。元の記事で続きを読めます。",
  );
  await expect(view.locator(".summary")).toHaveText("全文のある記事の要約");
  await expect(view.locator(".body")).toHaveCount(0);
  await expect(view.locator(".content-note", { hasText: "つながったら読めます" })).toHaveCount(0);
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
  await expect(view.locator(".content-note", { hasText: "つながったら読めます" })).toHaveCount(0);
});

test("全文が取れない未読の記事は、開く前にフィード本文を取っておき、オフラインでも読める", async ({
  page,
  context,
}) => {
  const { server, full } = seed();
  await routeFakeSendo(context, server);
  await page.goto("/");
  await signIn(page);
  await expect(page.locator(".article-list .item")).toHaveCount(2);
  // 先に全文を頼み、取れなかったので、代わりにフィード本文を取る
  await expect.poll(() => server.contentRequests).toEqual([full.id]);
  expect(server.pageContentRequests).toContain(full.id);
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

/**
 * X の投稿の印（data-x-post）の付いた引用（docs/decisions/embeds.md の 1）。sendo が付けた印の形の
 * 本文を、そのまま届ける
 */
const X_POST_ID = "1234567890123456789";

async function openXPost(page: Page, context: BrowserContext, content: string) {
  const server = new FakeSendo();
  const feed = server.subscribe({ url: "https://blog.example/feed.xml", title: "Blog" });
  server.deliver(feed.id, { title: "X の投稿を引いた記事", summary: "要約", content });
  const violations = await collectCspViolations(page);
  /** reader のオリジンの外へ出たリクエスト */
  const outside: string[] = [];
  context.on("request", (request) => {
    if (new URL(request.url()).origin !== new URL(page.url() || "http://localhost").origin) {
      outside.push(request.url());
    }
  });
  await routeFakeSendo(context, server);
  await page.goto("/");
  await signIn(page);
  outside.length = 0;
  await open(page, "X の投稿を引いた記事");
  return { body: page.locator(".article-view .body"), violations, outside };
}

/** 「Open on X」のリンクが、ID から組み立てた行き先を、新しいタブで開く */
async function expectOpenOnX(page: Page, context: BrowserContext, body: Locator) {
  const link = body.getByRole("link", { name: "Open on X" });
  await expect(link).toBeVisible();
  await expect(link).toHaveAttribute("href", `https://x.com/i/web/status/${X_POST_ID}`);
  await expect(link).toHaveAttribute("target", "_blank");
  await expect(link).toHaveAttribute("rel", "noopener noreferrer nofollow");
  // 押せる。開いた先は、外へ出さずに偽物で返す
  await context.route("https://x.com/**", (route) =>
    route.fulfill({ contentType: "text/html", body: "<title>x</title>" }),
  );
  const [popup] = await Promise.all([page.waitForEvent("popup"), link.click()]);
  await expect(popup).toHaveURL(`https://x.com/i/web/status/${X_POST_ID}`);
  await popup.close();
}

test("X の投稿の引用（公式の形）は、引用をそのまま出し、その下に Open on X のリンクを出す", async ({
  page,
  context,
}) => {
  const { body, violations, outside } = await openXPost(
    page,
    context,
    `<p>前の段落</p><blockquote data-x-post="${X_POST_ID}"><p>投稿の文</p>— 名前 (@user) ` +
      `<a href="https://twitter.com/user/status/${X_POST_ID}?s=20">2026年11月1日</a></blockquote>` +
      "<blockquote><p>ふつうの引用</p></blockquote>",
  );
  const quote = body.locator(".x-post blockquote");
  await expect(quote).toHaveText(`投稿の文— 名前 (@user) 2026年11月1日`);
  // 引用の中のリンクは、そのまま
  await expect(quote.getByRole("link", { name: "2026年11月1日" })).toHaveAttribute(
    "href",
    `https://twitter.com/user/status/${X_POST_ID}?s=20`,
  );
  // 印のない引用は、今までどおり（リンクを足さない）
  await expect(body.locator("blockquote")).toHaveCount(2);
  await expect(body.locator("blockquote", { hasText: "ふつうの引用" })).not.toHaveAttribute(
    "class",
    /x-post/,
  );
  await expect(body.getByRole("link", { name: "Open on X" })).toHaveCount(1);
  // X を含め、外へは何も取りにいかない
  expect(outside).toEqual([]);
  expect(await violations()).toEqual([]);
  await expectOpenOnX(page, context, body);
});

test("文もリンクの文字も空の X の投稿の引用でも、Open on X のリンクが見えて押せる", async ({
  page,
  context,
}) => {
  const { body, violations, outside } = await openXPost(
    page,
    context,
    // fixture の B（文が空）の形
    `<p>前の段落</p><blockquote data-x-post="${X_POST_ID}"><p></p> — (@user) ` +
      `<a href="https://x.com/user/status/${X_POST_ID}"></a></blockquote><p>後の段落</p>`,
  );
  await expect(body.getByText("後の段落")).toBeVisible();
  await expect(body.getByRole("link", { name: "Open on X" })).toHaveCount(1);
  expect(outside).toEqual([]);
  expect(await violations()).toEqual([]);
  await expectOpenOnX(page, context, body);
});

test("リンクだけの X の投稿の引用も、本文として出し、Open on X のリンクを出す", async ({
  page,
  context,
}) => {
  // fixture の D の形。中に見える文字がなくても、要約に替えない
  const { body, outside } = await openXPost(
    page,
    context,
    `<blockquote data-x-post="${X_POST_ID}"><a href="https://x.com/user/status/${X_POST_ID}"></a></blockquote>`,
  );
  await expect(body.getByRole("link", { name: "Open on X" })).toBeVisible();
  // 本文が出たあとで、要約に替わっていない
  await expect(page.locator(".article-view .summary")).toHaveCount(0);
  expect(outside).toEqual([]);
  await expectOpenOnX(page, context, body);
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
