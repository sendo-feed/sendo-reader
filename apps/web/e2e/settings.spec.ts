import { expect, test } from "@playwright/test";
import { FakeSendo, routeFakeSendo, signIn, USER } from "./fake-sendo";

test("トークンの説明が長くても、取り消すボタンは各行の右側にそろう", async ({ page, context }) => {
  const server = new FakeSendo();
  for (const [id, name, purpose] of [
    ["reader", "Reeder", "reader"],
    ["mcp", "長い名前".repeat(20), "mcp"],
  ] as const) {
    server.tokens.set(id, {
      id,
      name,
      purpose,
      scopes: ["read", "write"],
      createdAt: server.now,
      lastUsedAt: server.now,
      secret: `sendo_fake_${id}`,
    });
  }
  await routeFakeSendo(context, server);
  await page.goto("/settings");
  await signIn(page);
  await page.getByRole("tab", { name: "Connections", exact: true }).click();
  const rows = page.locator("li", {
    has: page.getByRole("button", { name: "取り消す", exact: true }),
  });
  await expect(rows).toHaveCount(2);

  for (const width of [1600, 390]) {
    await page.setViewportSize({ width, height: 900 });
    for (const row of await rows.all()) {
      const about = row.locator(".about");
      const button = row.getByRole("button");
      await expect(button).toBeVisible();
      const descriptionBox = await about.boundingBox();
      const buttonBox = await button.boundingBox();
      const rowBox = await row.boundingBox();
      if (descriptionBox === null || buttonBox === null || rowBox === null) {
        throw new Error("トークンの行が表示されていない");
      }
      expect(buttonBox.x).toBeGreaterThanOrEqual(descriptionBox.x + descriptionBox.width);
      expect(buttonBox.x + buttonBox.width).toBeCloseTo(rowBox.x + rowBox.width, 0);
      expect(buttonBox.y + buttonBox.height / 2).toBeCloseTo(rowBox.y + rowBox.height / 2, 0);
      expect(buttonBox.x + buttonBox.width).toBeLessThanOrEqual(width);
    }
  }
  // 確認のためボタンの文が長くなっても、説明を押しのけて右側に収まる
  const row = page.locator("li", { hasText: "長い名前" });
  await row.getByRole("button").click();
  const confirm = page.getByRole("button", { name: "本当に取り消す" });
  await expect(confirm).toBeVisible();
  const aboutBox = await row.locator(".about").boundingBox();
  const confirmBox = await confirm.boundingBox();
  expect(confirmBox?.x).toBeGreaterThanOrEqual((aboutBox?.x ?? 0) + (aboutBox?.width ?? 0));
});

test("設定の画面で、トークンを発行して一度だけ控え、取り消す", async ({ page, context }) => {
  const server = new FakeSendo();
  await routeFakeSendo(context, server);
  await context.grantPermissions(["clipboard-read", "clipboard-write"]);

  await page.goto("/");
  await signIn(page);
  await page.getByRole("link", { name: "Settings" }).click();
  await page.getByRole("tab", { name: "Connections", exact: true }).click();
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
  await page.getByRole("tab", { name: "Connections", exact: true }).click();
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
  await expect(page.getByRole("button", { name: "Sync now" })).toBeVisible();

  // 機能一覧などの裏の通信に左右されないよう、対象の読み込みだけを 1 回ずつ失敗させる
  const failures = new Set(["GET /tokens", "GET /oauth/grants"]);
  server.onRequest = async (path) => {
    if (failures.delete(path)) throw new TypeError("offline");
  };
  await page.getByRole("link", { name: "Settings" }).click();
  await page.getByRole("tab", { name: "Connections", exact: true }).click();
  await expect(page.getByRole("alert")).toHaveCount(2);
  await expect(page.getByRole("alert").first()).toContainText("sendo に届きません");

  await page.getByRole("button", { name: "Reload" }).first().click();
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
  await page.getByRole("tab", { name: "Connections", exact: true }).click();
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

test("設定をキーボードで切り替え、通信できなくてもプレビューと読む操作を変えられる", async ({
  page,
  context,
}) => {
  const server = new FakeSendo();
  const accountRequests: string[] = [];
  let offline = false;
  server.onRequest = async (path) => {
    if (path === "GET /tokens" || path === "GET /oauth/grants") accountRequests.push(path);
    if (offline) throw new TypeError("offline");
  };
  await routeFakeSendo(context, server);
  await page.goto("/settings");
  await signIn(page);

  const appearance = page.getByRole("tab", { name: "Appearance", exact: true });
  await expect(appearance).toHaveAttribute("aria-selected", "true");
  offline = true;
  await expect(page.getByText("PC・タブレット向けの設定です。", { exact: false })).toBeVisible();
  const preview = page.getByRole("article", { name: "記事のプレビュー" });
  const body = preview.locator(".body");
  const before = await body.evaluate((element) =>
    Number.parseFloat(getComputedStyle(element).fontSize),
  );
  await page.getByText("Dark", { exact: true }).click();
  await expect(page.locator("html")).toHaveAttribute("data-theme", "dark");
  await page.getByRole("slider", { name: "Text size" }).fill("4");
  await expect
    .poll(() => body.evaluate((element) => Number.parseFloat(getComputedStyle(element).fontSize)))
    .toBeGreaterThan(before);
  await expect(page.getByRole("slider", { name: "Text size" })).toHaveAttribute(
    "aria-valuetext",
    "Largest",
  );
  expect(accountRequests).toEqual([]);

  await appearance.focus();
  await appearance.press("ArrowRight");
  const reading = page.getByRole("tab", { name: "Reading", exact: true });
  await expect(reading).toBeFocused();
  await expect(reading).toHaveAttribute("aria-selected", "true");
  await expect(preview).toHaveCount(0);
  await page.getByLabel("Mark as read on scroll").uncheck();
  await page.getByLabel("List: swipe left").selectOption("none");
  expect(accountRequests).toEqual([]);

  offline = false;
  await reading.press("End");
  await expect(page.getByRole("tab", { name: "Connections", exact: true })).toBeFocused();
  await expect(page.getByText("発行したトークンはまだありません。")).toBeVisible();
  expect(accountRequests.sort()).toEqual(["GET /oauth/grants", "GET /tokens"]);
  await page.getByRole("tab", { name: "Connections", exact: true }).press("Home");
  await expect(appearance).toBeFocused();
  await expect(preview).toBeVisible();
  await appearance.press("ArrowRight");
  await expect(page.getByLabel("Mark as read on scroll")).not.toBeChecked();
  await expect(page.getByLabel("List: swipe left")).toHaveValue("none");
});

test("Connections を離れたら発行したトークンの中身を捨てる", async ({ page, context }) => {
  const server = new FakeSendo();
  await routeFakeSendo(context, server);
  await page.goto("/settings");
  await signIn(page);
  await page.getByRole("tab", { name: "Connections", exact: true }).click();
  await page.getByLabel("名前").fill("One-time token");
  await page.getByRole("button", { name: "発行する" }).click();
  const secret = page.locator(".secret");
  await expect(secret).toHaveText(/^sendo_/);
  const value = (await secret.textContent()) ?? "";
  await page.getByRole("tab", { name: "Reading", exact: true }).click();
  await expect(page.getByText(value, { exact: true })).toHaveCount(0);
  await page.getByRole("tab", { name: "Connections", exact: true }).click();
  await expect(page.locator("li", { hasText: "One-time token" })).toBeVisible();
  await expect(page.getByText(value, { exact: true })).toHaveCount(0);
  await expect(page.getByLabel("名前")).toHaveValue("");
});

test("幅 320px の画面でも各カテゴリを選べ、プレビューの文字を大きくできる", async ({
  page,
  context,
}) => {
  const server = new FakeSendo();
  await routeFakeSendo(context, server);
  await page.setViewportSize({ width: 320, height: 800 });
  await page.goto("/settings");
  await signIn(page);
  await page.getByRole("slider", { name: "Text size" }).fill("4");
  for (const category of ["Reading", "Connections", "Appearance"]) {
    const tab = page.getByRole("tab", { name: category, exact: true });
    await tab.click();
    await expect(tab).toHaveAttribute("aria-selected", "true");
    expect(await tab.evaluate((element) => element.scrollWidth <= element.clientWidth)).toBe(true);
    await expect(page.getByRole("tabpanel", { name: category, exact: true })).toBeVisible();
    expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(
      320,
    );
  }
  await expect(page.getByRole("article", { name: "記事のプレビュー" })).toBeVisible();
});
