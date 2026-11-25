import { expect, type Page, test } from "@playwright/test";
import { FakeSendo, routeFakeSendo, signIn, USER } from "./fake-sendo";

function seedTokens(server: FakeSendo) {
  for (const [id, name, purpose] of [
    ["reader", "Reeder", "reader"],
    ["mcp", "Claude Code", "mcp"],
    ["unused", "Unused", "reader"],
  ] as const) {
    server.tokens.set(id, {
      id,
      name,
      purpose,
      scopes: purpose === "mcp" ? ["read", "write"] : [],
      createdAt: server.now,
      lastUsedAt: id === "unused" ? null : server.now,
      secret: `sendo_fake_${id}`,
    });
  }
}

async function openConnections(page: Page) {
  await page.goto("/settings");
  await signIn(page);
  await page.getByRole("tab", { name: "Connections", exact: true }).click();
}

test("長い名前と最大文字サイズでも一覧が収まり、選ぶまでは取り消しの操作を出さない", async ({
  page,
  context,
}) => {
  const server = new FakeSendo();
  seedTokens(server);
  const token = server.tokens.get("mcp");
  if (token) token.name = "長い名前".repeat(20);
  await routeFakeSendo(context, server);
  await page.goto("/settings");
  await signIn(page);
  await page.getByRole("slider", { name: "Text size" }).fill("4");
  await page.getByRole("tab", { name: "Connections", exact: true }).click();
  const table = page.getByRole("table", { name: "Access tokens", exact: true });
  await expect(table.locator("tbody tr")).toHaveCount(3);
  await expect(page.getByRole("button", { name: /Revoke/ })).toHaveCount(0);
  await expect(
    page.getByText("選んだトークンはすぐに使えなくなります。", { exact: false }),
  ).toHaveCount(0);
  await expect(page.getByRole("textbox")).toHaveCount(0);

  for (const width of [1600, 390, 320]) {
    await page.setViewportSize({ width, height: 900 });
    await expect(table.getByRole("checkbox", { name: "Select all access tokens" })).toBeVisible();
    const row = table.locator("tbody tr").filter({ hasText: "長い名前" });
    const checkbox = row.getByRole("checkbox");
    await expect(checkbox).toBeVisible();
    await checkbox.check();
    await expect(table.getByRole("checkbox", { name: "Select all access tokens" })).toBeChecked({
      indeterminate: true,
    });
    await expect(page.getByRole("button", { name: "Revoke 1…", exact: true })).toBeVisible();
    const nameBox = await row.locator(".name").boundingBox();
    const checkBox = await checkbox.boundingBox();
    expect(nameBox?.x).toBeGreaterThanOrEqual((checkBox?.x ?? 0) + (checkBox?.width ?? 0));
    expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(
      width,
    );
    await page.getByRole("button", { name: "Clear", exact: true }).click();
    if (width <= 390) {
      await page.evaluate(() => window.scrollTo(0, document.documentElement.scrollHeight));
      await expect(page.getByText(/^Version /)).toBeInViewport();
      await page.evaluate(() => window.scrollTo(0, 0));
    }
  }
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

  await page.getByRole("button", { name: "+ New token", exact: true }).click();
  await page.getByLabel("Name", { exact: true }).fill("Claude Code");
  await page.getByLabel("Use with").selectOption("mcp");
  await page.getByLabel("Access", { exact: true }).selectOption({ label: "Read & write" });
  await page.getByRole("button", { name: "Create token", exact: true }).click();

  const secret = page.locator(".secret");
  await expect(secret).toHaveText(/^sendo_/);
  const [token] = [...server.tokens.values()];
  expect(token).toMatchObject({ name: "Claude Code", purpose: "mcp", scopes: ["read", "write"] });
  const value = token?.secret ?? "";
  await expect(secret).toHaveText(value);
  await page.getByRole("button", { name: "Copy", exact: true }).click();
  await expect(page.getByRole("button", { name: "Copied", exact: true })).toBeVisible();
  expect(await page.evaluate(() => navigator.clipboard.readText())).toBe(value);

  // 閉じたら中身は画面から消え、一覧には中身を出さない。ブラウザのストレージにも置かない
  await page.getByRole("button", { name: "Done", exact: true }).click();
  await expect(page.getByText(value)).toHaveCount(0);
  const row = page
    .getByRole("table", { name: "Access tokens", exact: true })
    .locator("tbody tr", { hasText: "Claude Code" });
  await expect(row).toContainText("MCP · Read & write");
  const stored = await page.evaluate(
    () => JSON.stringify({ ...localStorage }) + JSON.stringify({ ...sessionStorage }),
  );
  expect(stored).not.toContain(value);

  // 選択しただけでは送らず、対象の名前と影響を出して確かめる
  await row.getByRole("checkbox").check();
  await page.getByRole("button", { name: "Revoke 1…", exact: true }).click();
  const confirmation = page.getByRole("dialog", { name: "Revoke tokens", exact: true });
  await expect(confirmation).toContainText("Claude Code");
  await expect(confirmation).toContainText("すぐに使えなくなります");
  expect(server.tokens.size).toBe(1);
  await confirmation.getByRole("button", { name: "Revoke 1", exact: true }).click();
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

  const grants = page.getByRole("table", { name: "Connected apps", exact: true });
  const agent = grants.locator("tbody tr", { hasText: "Agent" });
  await expect(agent).toContainText("agent.example");
  await expect(agent).toContainText("Read & write");
  // クライアントが名乗っただけの名前は、そうと分かるように、プレーンテキストで出す
  const registered = grants.locator("tbody tr", { hasText: "<img src=x" });
  await expect(registered).toContainText("クライアントが名乗った名前");
  await expect(page.locator("main img")).toHaveCount(0);

  await agent.getByRole("checkbox").check();
  await page.getByRole("button", { name: "Revoke 1…", exact: true }).click();
  const confirmation = page.getByRole("dialog", { name: "Revoke connections", exact: true });
  await expect(confirmation).toContainText("agent.example");
  await confirmation.getByRole("button", { name: "Revoke 1", exact: true }).click();
  await expect(grants.locator("tbody tr", { hasText: "Agent" })).toHaveCount(0);
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
  await page.getByRole("button", { name: "+ New token", exact: true }).click();
  await page.getByLabel("Name", { exact: true }).fill("Reeder");
  await page.getByRole("button", { name: "Create token", exact: true }).click();

  // 発行は送らず、同期が手元のユーザーを切り替え、設定の画面はそのアカウントで作り直す
  await expect(page.getByText("ログインしているアカウント：b@example.com")).toBeVisible();
  expect(server.tokens.size).toBe(0);
  await expect(page.getByRole("dialog")).toHaveCount(0);
  await page.getByRole("button", { name: "+ New token", exact: true }).click();
  await expect(page.getByLabel("Name", { exact: true })).toHaveValue("");
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
  const listCard = page.getByRole("region", { name: "List card", exact: true });
  const body = preview.locator(".body");
  const cardTitle = listCard.locator(".title");
  const title = "毎日の読む時間を、心地よく";
  await expect(cardTitle).toHaveText(title);
  await expect(preview.getByRole("heading", { name: title, exact: true })).toBeVisible();
  await expect(listCard.getByRole("link")).toHaveCount(0);
  const before = await body.evaluate((element) =>
    Number.parseFloat(getComputedStyle(element).fontSize),
  );
  const cardBefore = await cardTitle.evaluate((element) =>
    Number.parseFloat(getComputedStyle(element).fontSize),
  );
  await page.getByText("Dark", { exact: true }).click();
  await expect(page.locator("html")).toHaveAttribute("data-theme", "dark");
  await page.getByRole("slider", { name: "Text size" }).fill("4");
  await expect
    .poll(() => body.evaluate((element) => Number.parseFloat(getComputedStyle(element).fontSize)))
    .toBeGreaterThan(before);
  await expect
    .poll(() =>
      cardTitle.evaluate((element) => Number.parseFloat(getComputedStyle(element).fontSize)),
    )
    .toBeGreaterThan(cardBefore);
  expect((await preview.boundingBox())?.x).toBeGreaterThan((await listCard.boundingBox())?.x ?? 0);
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
  await expect(listCard).toHaveCount(0);
  await page.getByLabel("Mark as read on scroll").uncheck();
  await page.getByLabel("List: swipe left").selectOption("none");
  expect(accountRequests).toEqual([]);

  offline = false;
  await reading.press("End");
  const integrations = page.getByRole("tab", { name: "Integrations", exact: true });
  await expect(integrations).toBeFocused();
  await integrations.press("ArrowLeft");
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
  await page.getByRole("button", { name: "+ New token", exact: true }).click();
  await expect(page.getByLabel("Use with")).toHaveValue("reader");
  await expect(page.getByLabel("Use with").locator("option:checked")).toHaveText("REST API");
  await page.getByLabel("Name", { exact: true }).fill("One-time token");
  await page.getByRole("button", { name: "Create token", exact: true }).click();
  const secret = page.locator(".secret");
  await expect(secret).toHaveText(/^sendo_/);
  const value = (await secret.textContent()) ?? "";
  // ダイアログを開いたままブラウザで別の画面へ移る
  await page.goto("/");
  await expect(page.getByText(value, { exact: true })).toHaveCount(0);
  await page.goto("/settings");
  await page.getByRole("tab", { name: "Connections", exact: true }).click();
  await expect(
    page
      .getByRole("table", { name: "Access tokens", exact: true })
      .locator("tbody tr", { hasText: "One-time token" }),
  ).toContainText("REST API");
  expect([...server.tokens.values()][0]?.purpose).toBe("reader");
  await expect(page.getByText(value, { exact: true })).toHaveCount(0);
  await expect(page.getByRole("dialog")).toHaveCount(0);
  await page.getByRole("button", { name: "+ New token", exact: true }).click();
  await expect(page.getByLabel("Name", { exact: true })).toHaveValue("");
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
  for (const category of ["Reading", "Connections", "Integrations", "Appearance"]) {
    const tab = page.getByRole("tab", { name: category, exact: true });
    await tab.click();
    await expect(tab).toHaveAttribute("aria-selected", "true");
    expect(await tab.evaluate((element) => element.scrollWidth <= element.clientWidth)).toBe(true);
    await expect(page.getByRole("tabpanel", { name: category, exact: true })).toBeVisible();
    expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(
      320,
    );
  }
  const preview = page.getByRole("article", { name: "記事のプレビュー" });
  const listCard = page.getByRole("region", { name: "List card", exact: true });
  await expect(preview).toBeVisible();
  await expect(listCard).toBeVisible();
  const cardBox = await listCard.boundingBox();
  expect((await preview.boundingBox())?.y).toBeGreaterThan(
    (cardBox?.y ?? 0) + (cardBox?.height ?? 0),
  );
});

test("選択した複数のトークンだけを取り消し、一部失敗した分は選択を残して再試行する", async ({
  page,
  context,
}) => {
  const server = new FakeSendo();
  seedTokens(server);
  await routeFakeSendo(context, server);
  let fail = true;
  await context.route("**/api/v1/tokens/mcp", async (route) => {
    if (route.request().method() === "DELETE" && fail) {
      fail = false;
      await route.fulfill({
        status: 500,
        contentType: "application/json",
        body: JSON.stringify({ error: { code: "internal_error", message: "failed" } }),
      });
    } else await route.fallback();
  });
  await openConnections(page);
  const table = page.getByRole("table", { name: "Access tokens", exact: true });
  await expect(table.locator("tbody tr")).toHaveCount(3);
  await table.getByRole("checkbox", { name: "Select all access tokens" }).check();
  await page.getByRole("button", { name: "Revoke 3…", exact: true }).click();
  const confirmation = page.getByRole("dialog", { name: "Revoke tokens", exact: true });
  await expect(confirmation.locator("li")).toHaveCount(3);
  await confirmation.getByRole("button", { name: "Cancel", exact: true }).click();
  expect(server.tokens.size).toBe(3);
  await page.getByRole("button", { name: "Revoke 3…", exact: true }).click();
  await confirmation.getByRole("button", { name: "Revoke 3", exact: true }).click();
  await expect(confirmation.getByRole("alert")).toContainText("1件を取り消せませんでした");
  await expect(confirmation.locator("li")).toHaveText(["Claude Code"]);
  await expect(table.locator("tbody tr")).toHaveCount(1);
  expect([...server.tokens.keys()]).toEqual(["mcp"]);
  await confirmation.getByRole("button", { name: "Cancel", exact: true }).click();
  await expect(
    table.getByRole("checkbox", { name: "Select Claude Code", exact: true }),
  ).toBeChecked();
  await page.getByRole("button", { name: "Revoke 1…", exact: true }).click();
  await confirmation.getByRole("button", { name: "Revoke 1", exact: true }).click();
  await expect(page.getByText("発行したトークンはまだありません。")).toBeVisible();
  expect(server.tokens.size).toBe(0);
});

test("取り消しの途中でアカウントが替わったら、それ以降のトークンへ送らない", async ({
  page,
  context,
}) => {
  const server = new FakeSendo();
  seedTokens(server);
  await routeFakeSendo(context, server);
  await openConnections(page);
  const other = server.createSession({ id: "user-b", email: "b@example.com" });
  let changed = false;
  server.onRequest = async (path) => {
    if (path === "DELETE /tokens/reader" && !changed) {
      changed = true;
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
    }
  };
  await page.getByRole("checkbox", { name: "Select all access tokens" }).check();
  await page.getByRole("button", { name: "Revoke 3…", exact: true }).click();
  await page.getByRole("dialog").getByRole("button", { name: "Revoke 3", exact: true }).click();
  await expect(page.getByText("ログインしているアカウント：b@example.com")).toBeVisible();
  expect(server.requests.filter((path) => path.startsWith("DELETE /tokens/"))).toEqual([
    "DELETE /tokens/reader",
  ]);
  expect([...server.tokens.keys()]).toEqual(["mcp", "unused"]);
});

test("発行中は閉じる操作と二重送信を止め、閉じると発行内容を残さない", async ({
  page,
  context,
}) => {
  const server = new FakeSendo();
  await routeFakeSendo(context, server);
  await openConnections(page);
  let release: (() => void) | undefined;
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  server.onRequest = async (path) => {
    if (path === "POST /tokens") await gate;
  };
  await page.getByRole("button", { name: "+ New token", exact: true }).click();
  let dialog = page.getByRole("dialog", { name: "New token", exact: true });
  await dialog.getByLabel("Name", { exact: true }).fill("Pending");
  await dialog.getByRole("button", { name: "Create token", exact: true }).click();
  await expect(dialog.getByRole("button", { name: "Creating…", exact: true })).toBeDisabled();
  await expect(dialog.getByRole("button", { name: "Close", exact: true })).toBeDisabled();
  await dialog.press("Escape");
  await expect(dialog).toBeVisible();
  release?.();
  dialog = page.getByRole("dialog", { name: "Token created", exact: true });
  await expect(dialog.locator(".secret")).toHaveText(/^sendo_/);
  await dialog.press("Escape");
  await expect(page.locator(".secret")).toHaveCount(0);
  await expect(page.getByRole("button", { name: "+ New token", exact: true })).toBeFocused();
  await page.getByRole("button", { name: "+ New token", exact: true }).click();
  await expect(page.getByLabel("Name", { exact: true })).toHaveValue("");
  expect(server.requests.filter((path) => path === "POST /tokens")).toHaveLength(1);
});

test("すでに取り消された項目の404は一覧から外し、OAuthの許可も複数選んで取り消せる", async ({
  page,
  context,
}) => {
  const server = new FakeSendo();
  seedTokens(server);
  server.addGrant({ clientId: "https://a.example/client.json", clientName: "App A" });
  server.addGrant({ clientId: "https://b.example/client.json", clientName: "App B" });
  await routeFakeSendo(context, server);
  await openConnections(page);
  await expect(page.getByRole("checkbox", { name: "Select Unused", exact: true })).toBeVisible();
  server.tokens.delete("unused");
  await page.getByRole("checkbox", { name: "Select Unused", exact: true }).check();
  await page.getByRole("button", { name: "Revoke 1…", exact: true }).click();
  await page.getByRole("dialog").getByRole("button", { name: "Revoke 1", exact: true }).click();
  await expect(page.getByRole("checkbox", { name: "Select Unused", exact: true })).toHaveCount(0);
  const apps = page.getByRole("table", { name: "Connected apps", exact: true });
  await apps.getByRole("checkbox", { name: "Select all connected apps" }).check();
  await page.getByRole("button", { name: "Revoke 2…", exact: true }).click();
  const confirmation = page.getByRole("dialog", { name: "Revoke connections", exact: true });
  await expect(confirmation.locator("li")).toHaveCount(2);
  await confirmation.getByRole("button", { name: "Revoke 2", exact: true }).click();
  await expect(page.getByText("許可したクライアントはまだありません。")).toBeVisible();
  expect(server.grants.size).toBe(0);
  expect(server.tokens.size).toBe(2);
});

test("Reading の Offline で全文を置く量の上限を選べる。既定は 200MB で、この端末だけに残す。Off なら先に取らない", async ({
  page,
  context,
}) => {
  const server = new FakeSendo();
  const feed = server.subscribe({ url: "https://example.com/feed", title: "Blog" });
  await routeFakeSendo(context, server);
  await page.goto("/settings");
  await signIn(page);
  const openReading = () => page.getByRole("tab", { name: "Reading", exact: true }).click();
  await openReading();
  const limit = page.getByRole("combobox", { name: "Storage limit" });
  await expect(limit.locator("option:checked")).toHaveText("200MB");
  await expect(limit.locator("option")).toHaveText([
    "Off",
    "50MB",
    "100MB",
    "200MB",
    "500MB",
    "1GB",
  ]);
  // 記事がないので、使っている量は 0
  await expect(page.getByText(/^いま .+ を使っています。$/)).toHaveText(
    "いま 0KB を使っています。",
  );

  await limit.selectOption({ label: "Off" });
  // 書き込んだタブは閉じずに、別のタブで、手元に書き込み終わるまで確かめる
  const other = await context.newPage();
  await other.goto("/settings");
  const otherLimit = other.getByRole("combobox", { name: "Storage limit" });
  await expect(async () => {
    await other.reload();
    await other.getByRole("tab", { name: "Reading", exact: true }).click();
    await expect(otherLimit.locator("option:checked")).toHaveText("Off", { timeout: 1000 });
  }).toPass();
  await other.close();

  // Off のあとに全文のある記事が届いても、同期のあとに先に取らない
  const article = server.deliver(feed.id, { title: "届いた記事" });
  server.pageContents.set(article.id, "<p>全文</p>");
  const syncsAfter = (from: number) =>
    server.requests.slice(from).filter((request) => request.startsWith("GET /sync")).length;
  for (let round = 0; round < 2; round++) {
    // 起動したときの同期を 2 回分待つ（1 回めのあとの先読みが走り終わる間を取る）
    const from = server.requests.length;
    await page.reload();
    await expect.poll(() => syncsAfter(from)).toBeGreaterThan(0);
  }
  expect(server.pageContentRequests).toEqual([]);
  expect(server.contentRequests).toEqual([]);
  // 同期を終えても、上限は sendo に預けない
  expect(server.settingsRequests).toEqual([]);
  expect([...server.settings.keys()].filter((key) => key.includes("content"))).toEqual([]);
});

test("Offline の欄を開いている間に裏の先読みで本文が増えると、タブを替えずに使っている量が増える", async ({
  page,
  context,
}) => {
  const server = new FakeSendo();
  const feed = server.subscribe({ url: "https://example.com/feed", title: "Blog" });
  for (let i = 0; i < 3; i++) {
    const article = server.deliver(feed.id, { title: `記事 ${i}` });
    server.pageContents.set(article.id, `<p>${"全文".repeat(2000)}</p>`);
  }
  await routeFakeSendo(context, server);
  // 裏の先読みの取得を止めておき、欄を開いてから通す
  let release!: () => void;
  const blocked = new Promise<void>((resolve) => {
    release = resolve;
  });
  server.onRequest = (path) => (path.endsWith("/content") ? blocked : Promise.resolve());
  await page.goto("/settings");
  await signIn(page);
  await page.getByRole("tab", { name: "Reading", exact: true }).click();
  const used = page.getByText(/^いま .+ を使っています。$/);
  await expect(used).toHaveText("いま 0KB を使っています。");

  release();
  server.onRequest = null;
  await expect(used).not.toHaveText("いま 0KB を使っています。", { timeout: 10_000 });
  await expect(page.getByRole("tab", { name: "Reading", exact: true })).toHaveAttribute(
    "aria-selected",
    "true",
  );
});

declare global {
  interface Window {
    failSetContentStorageLimit: boolean;
  }
}

test("Offline の上限を変えられなかったら、選択欄が前の値に戻り、エラーを出す", async ({
  page,
  context,
}) => {
  const server = new FakeSendo();
  await routeFakeSendo(context, server);
  // ワーカーへの上限の変更だけを、失敗の応答に差し替える（ワーカーの中の失敗は、外から起こせない）
  await page.addInitScript(() => {
    window.failSetContentStorageLimit = false;
    window.Worker = class extends Worker {
      constructor(url: string | URL, options?: WorkerOptions) {
        super(url, options);
        const post = this.postMessage.bind(this);
        this.postMessage = (
          message: unknown,
          options: Transferable[] | StructuredSerializeOptions = [],
        ) => {
          const call = message as { type: string; method?: string; id?: number };
          if (
            window.failSetContentStorageLimit &&
            call.type === "call" &&
            call.method === "setContentStorageLimit"
          ) {
            const result = { ok: false, error: { name: "Error", message: "書き込めなかった" } };
            queueMicrotask(() =>
              this.dispatchEvent(
                new MessageEvent("message", { data: { type: "result", id: call.id, result } }),
              ),
            );
            return;
          }
          if (Array.isArray(options)) post(message, options);
          else post(message, options);
        };
      }
    };
  });
  await page.goto("/settings");
  await signIn(page);
  await page.getByRole("tab", { name: "Reading", exact: true }).click();
  const limit = page.getByRole("combobox", { name: "Storage limit" });
  await expect(limit.locator("option:checked")).toHaveText("200MB");

  await page.evaluate(() => {
    window.failSetContentStorageLimit = true;
  });
  await limit.selectOption({ label: "Off" });
  await expect(page.getByRole("alert")).toHaveText(
    "上限を変えられませんでした。もう一度お試しください。",
  );
  await expect(limit.locator("option:checked")).toHaveText("200MB");
  await expect(limit).toHaveValue(String(200 * 1024 * 1024));

  // 変えられたら、エラーを消す
  await page.evaluate(() => {
    window.failSetContentStorageLimit = false;
  });
  await limit.selectOption({ label: "Off" });
  await expect(limit.locator("option:checked")).toHaveText("Off");
  await expect(page.getByRole("alert")).toHaveCount(0);
});
