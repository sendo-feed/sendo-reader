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
  await page.getByText("Add to Sendo", { exact: true }).click();
  const bookmarklet = await page.getByRole("textbox", { name: "Bookmarklet URL" }).inputValue();

  await page.goto(site);
  await page.evaluate((script) => location.assign(script), bookmarklet);
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
