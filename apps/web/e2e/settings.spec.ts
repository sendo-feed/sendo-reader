import { expect, test } from "@playwright/test";
import { FakeSendo, routeFakeSendo, signIn, USER } from "./fake-sendo";

test("設定の画面で、トークンを発行して一度だけ控え、取り消す", async ({ page, context }) => {
  const server = new FakeSendo();
  await routeFakeSendo(context, server);
  await context.grantPermissions(["clipboard-read", "clipboard-write"]);

  await page.goto("/");
  await signIn(page);
  await page.getByRole("link", { name: "設定" }).click();
  await expect(page).toHaveURL(/\/settings$/);
  await expect(page.getByText("発行したトークンはまだありません。")).toBeVisible();

  await page.getByLabel("名前").fill("Claude Code");
  await page.getByLabel("用途").selectOption("mcp");
  await page.getByLabel("購読や既読などの変更も許す").check();
  await page.getByRole("button", { name: "発行する" }).click();

  const secret = page.locator(".secret");
  await expect(secret).toHaveText(/^sendo_/);
  const [token] = [...server.tokens.values()];
  expect(token).toMatchObject({ name: "Claude Code", purpose: "mcp", scopes: ["read", "write"] });
  const value = token?.secret ?? "";
  await expect(secret).toHaveText(value);
  await page.getByRole("button", { name: "コピー" }).click();
  await expect(page.getByRole("button", { name: "コピーしました" })).toBeVisible();
  expect(await page.evaluate(() => navigator.clipboard.readText())).toBe(value);

  // 閉じたら中身は画面から消え、一覧には中身を出さない。ブラウザのストレージにも置かない
  await page.getByRole("button", { name: "控えたので閉じる" }).click();
  await expect(page.getByText(value)).toHaveCount(0);
  const row = page.locator("li", { hasText: "Claude Code" });
  await expect(row).toContainText("MCP 用・読み書き");
  const stored = await page.evaluate(
    () => JSON.stringify({ ...localStorage }) + JSON.stringify({ ...sessionStorage }),
  );
  expect(stored).not.toContain(value);

  // 取り消すときは、もう一度押して確かめる
  await row.getByRole("button", { name: "取り消す" }).click();
  expect(server.tokens.size).toBe(1);
  await row.getByRole("button", { name: "本当に取り消す" }).click();
  await expect(page.getByText("発行したトークンはまだありません。")).toBeVisible();
  expect(server.tokens.size).toBe(0);
});

test("OAuth で許可したクライアントを見て、取り消す", async ({ page, context }) => {
  const server = new FakeSendo();
  server.addGrant({
    clientId: "https://agent.example/oauth/client.json",
    clientName: "Agent",
    scopes: ["read", "write"],
  });
  server.addGrant({
    clientId: "registered-client",
    clientName: "<img src=x onerror=alert(1)>",
    clientKind: "registered",
  });
  await routeFakeSendo(context, server);

  await page.goto("/settings");
  await signIn(page);
  await expect(page).toHaveURL(/\/settings$/);

  const agent = page.locator("li", { hasText: "Agent" });
  await expect(agent).toContainText("agent.example");
  await expect(agent).toContainText("読み書き");
  // クライアントが名乗っただけの名前は、そうと分かるように、プレーンテキストで出す
  const registered = page.locator("li", { hasText: "<img src=x" });
  await expect(registered).toContainText("クライアントが名乗った名前");
  await expect(page.locator("main img")).toHaveCount(0);

  await agent.getByRole("button", { name: "取り消す" }).click();
  await agent.getByRole("button", { name: "本当に取り消す" }).click();
  await expect(page.locator("li", { hasText: "Agent" })).toHaveCount(0);
  expect([...server.grants.values()].map((g) => g.clientId)).toEqual(["registered-client"]);
});

test("設定の画面は、sendo に届かなければその旨を出し、読み込み直せる", async ({
  page,
  context,
}) => {
  const server = new FakeSendo();
  await routeFakeSendo(context, server);
  await page.goto("/");
  await signIn(page);
  await expect(page.getByRole("button", { name: "今すぐ同期" })).toBeVisible();

  // トークンと許可の読み込みが、どちらも届かない
  server.failNext("network", "network");
  await page.getByRole("link", { name: "設定" }).click();
  await expect(page.getByRole("alert")).toHaveCount(2);
  await expect(page.getByRole("alert").first()).toContainText("sendo に届きません");

  await page.getByRole("button", { name: "読み込み直す" }).first().click();
  await expect(page.getByText("発行したトークンはまだありません。")).toBeVisible();
});

test("別のアカウントのセッションに替わっていたら、設定の操作は送らず、そのアカウントに切り替える", async ({
  page,
  context,
}) => {
  const server = new FakeSendo();
  await routeFakeSendo(context, server);
  await page.goto("/settings");
  await signIn(page);
  await expect(page.getByText(`ログインしているアカウント：${USER.email}`)).toBeVisible();
  await expect(page.getByText("発行したトークンはまだありません。")).toBeVisible();

  // 別のタブなどで、別のアカウントでログインし直した（ブラウザのクッキーが替わった）
  const other = server.createSession({ id: "user-b", email: "b@example.com" });
  await context.addCookies([
    {
      name: "__Host-sendo_session",
      value: other,
      url: "https://localhost/",
      secure: true,
      httpOnly: true,
      sameSite: "Lax",
    },
  ]);
  await page.getByLabel("名前").fill("Reeder");
  await page.getByRole("button", { name: "発行する" }).click();

  // 発行は送らず、同期が手元のユーザーを切り替え、設定の画面はそのアカウントで作り直す
  await expect(page.getByText("ログインしているアカウント：b@example.com")).toBeVisible();
  expect(server.tokens.size).toBe(0);
  await expect(page.getByLabel("名前")).toHaveValue("");
});
