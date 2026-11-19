import { expect, test } from "@playwright/test";
import { FakeSendo, routeFakeSendo, signIn, USER } from "./fake-sendo";

test("Chrome のブックマークレットから候補を見つけてフィードを購読する", async ({
  page,
  context,
}) => {
  const server = new FakeSendo();
  const site = "https://blog.example/article?lang=ja#part";
  const feed = "https://blog.example/feed.xml";
  server.discoverable.set(site, [{ url: feed, title: "Blog" }]);
  server.fetchable.set(feed, "Blog");
  await routeFakeSendo(context, server);
  await context.route("https://blog.example/**", (route) => route.fulfill({ body: "Article" }));

  await page.goto("/manage");
  await signIn(page);
  // ブックマークレットは、Add feed の窓の下で案内する。ボタンをブックマークバーへドラッグして入れる
  await page.getByRole("button", { name: "Add feed" }).first().click();
  const dialog = page.getByRole("dialog", { name: "Add feed" });
  await expect(dialog.getByRole("heading", { name: "Bookmarklet" })).toBeVisible();
  const drag = dialog.getByRole("link", { name: "Add to Sendo" });
  const bookmarklet = await drag.getAttribute("href");
  expect(bookmarklet).toMatch(/^javascript:/);
  // この画面で押しても動かない。ドラッグして使うことを伝える
  await drag.click();
  await expect(dialog.getByRole("status")).toHaveText(
    "このボタンは、ブックマークバーへドラッグして使います。",
  );
  await expect(page).toHaveURL(/\/manage$/);
  // ドラッグできないときは、同じ文字列をコピーできる
  await dialog.getByText("ドラッグできないとき").click();
  await expect(dialog.getByRole("textbox", { name: "Bookmarklet URL" })).toHaveValue(
    bookmarklet ?? "",
  );

  await page.goto(site);
  await page.evaluate((script) => location.assign(script), bookmarklet ?? "");
  await expect(page.getByRole("heading", { name: "Add to Sendo" })).toBeVisible();
  await expect(page.getByText(site, { exact: true })).toBeVisible();
  expect(server.requests).not.toContain("POST /feeds");

  await page.getByRole("button", { name: "Subscribe to a feed" }).click();
  await expect(page.getByLabel("Website or feed URL")).toHaveValue(site);
  await page.getByRole("button", { name: "Find", exact: true }).click();
  await expect(page.getByRole("radio", { name: /Blog/ })).toBeChecked();
  await page.getByRole("button", { name: "Subscribe", exact: true }).click();
  await expect(page.getByText("Blog を購読しました。")).toBeVisible();
  expect(server.requests).toContain("POST /feeds");
});

test("未ログインでも長い投稿 URL を引き継ぎ、確認して Saved に登録できる", async ({
  page,
  context,
}) => {
  const server = new FakeSendo();
  const post = `https://x.com/example/status/123?view=${"a".repeat(1450)}#text`;
  await routeFakeSendo(context, server);
  await page.goto(`/add#url=${encodeURIComponent(post)}`);
  server.loginUser = null;
  await signIn(page);
  await expect(page.getByRole("alert")).toContainText("このメールアドレスでは使えません。");
  await expect(page).toHaveURL(/\/add\?capture=[0-9a-f-]+$/);
  server.loginUser = USER;
  await signIn(page);
  await expect(page).toHaveURL(/\/add\?capture=[0-9a-f-]+$/);
  await expect(page.getByRole("heading", { name: "Add to Sendo" })).toBeVisible();
  await expect(page.locator("main .url")).toHaveText(post);
  expect(
    server.requests.find((request) => request.startsWith("GET /auth/google/login")),
  ).not.toContain("x.com");
  expect(server.requests).not.toContain("PUT /saved");

  await page.getByRole("button", { name: "Subscribe to a feed" }).click();
  await page.getByRole("button", { name: "Find", exact: true }).click();
  await expect(page.getByText("その URL を取得できませんでした。")).toBeVisible();
  await page.getByRole("button", { name: "Save for later" }).click();
  await expect(page.getByRole("link", { name: post })).toHaveAttribute("href", post);
  await expect(page).toHaveURL(/\/starred$/);
});

test("iPhone のショートカットを作る文を、このサイトの URL を埋めて出す", async ({
  page,
  context,
}) => {
  await routeFakeSendo(context, new FakeSendo());
  await page.goto("/manage");
  await signIn(page);
  await page.getByRole("button", { name: "Add feed" }).first().click();
  await page.getByRole("button", { name: "Set up iPhone shortcut" }).click();
  const dialog = page.getByRole("dialog", { name: "iPhone shortcut" });
  await expect(dialog.getByRole("heading", { name: "作り方" })).toBeVisible();
  // Siri に渡す文に、このサイトの追加画面の URL を埋める
  const prompt = await dialog.getByRole("textbox", { name: "Shortcut prompt" }).inputValue();
  const prefix = `${new URL(page.url()).origin}/add#url=`;
  expect(prompt).toContain(`「${prefix}」`);
  // ショートカットが組み立てる URL（前半 ＋ エンコードした URL）で、追加画面に来られる
  const site = "https://blog.example/post?a=1&b=2#part";
  await page.goto(prefix + encodeURIComponent(site));
  await expect(page.getByRole("heading", { name: "Add to Sendo" })).toBeVisible();
  await expect(page.getByText(site, { exact: true })).toBeVisible();
});
