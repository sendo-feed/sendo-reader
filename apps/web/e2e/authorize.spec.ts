import { type BrowserContext, expect, test } from "@playwright/test";
import { FakeSendo, routeFakeSendo, signIn, USER } from "./fake-sendo";

const AGENT = "https://agent.example/oauth/client.json";

/** 許可の画面の URL（クライアントが利用者を送ってくる形） */
function authorizeUrl(params: Record<string, string> = {}): string {
  return `/oauth/authorize?${new URLSearchParams({
    response_type: "code",
    client_id: AGENT,
    redirect_uri: "https://agent.example/callback",
    scope: "read write",
    state: "xyz",
    code_challenge: "c".repeat(43),
    code_challenge_method: "S256",
    ...params,
  })}`;
}

/** 偽の sendo と、許可したあとに戻る先（クライアントのページ）を用意する */
async function setup(context: BrowserContext) {
  const server = new FakeSendo();
  server.oauthClients.set(AGENT, {
    name: "Agent",
    kind: "metadata_document",
    redirectUris: ["https://agent.example/callback"],
  });
  await routeFakeSendo(context, server);
  for (const pattern of ["https://agent.example/**", "http://127.0.0.1:33418/**"]) {
    await context.route(pattern, (route) =>
      route.fulfill({ status: 200, contentType: "text/html", body: "<p>client</p>" }),
    );
  }
  return server;
}

/** ブラウザに sendo のセッションのクッキーを置く（Google でログインしてあることにする） */
async function signInBrowser(context: BrowserContext, server: FakeSendo) {
  await context.addCookies([
    {
      name: "__Host-sendo_session",
      value: server.createSession(USER),
      url: "https://localhost/",
      secure: true,
      httpOnly: true,
      sameSite: "Lax",
    },
  ]);
}

test("ログインしていなければログインに回し、戻ったら同じリクエストで許可の画面を出す。許可すると認可コードを持って戻る", async ({
  page,
  context,
}) => {
  const server = await setup(context);
  await page.goto(authorizeUrl());
  await page.getByRole("button", { name: "ログインして続ける" }).click();

  // ログインの returnTo は /oauth/authorize だけ。クエリは sessionStorage から戻し、使ったら消す
  await expect(
    page.getByRole("heading", { name: "sendo へのアクセスを許可しますか？" }),
  ).toBeVisible();
  await expect(page).toHaveURL(/\/oauth\/authorize\?.*state=xyz/);
  expect(await page.evaluate(() => sessionStorage.length)).toBe(0);
  const main = page.locator("main");
  await expect(main).toContainText("Agent");
  await expect(main).toContainText("agent.example");
  await expect(main).toContainText("購読、フォルダ、記事、未読の数を読む");
  await expect(main).toContainText("既読やスターを付けるなど、変更する");
  await expect(main).toContainText(USER.email);

  await page.getByRole("button", { name: "許可する" }).click();
  await page.waitForURL(/^https:\/\/agent\.example\/callback/);
  const back = new URL(page.url());
  expect(back.searchParams.get("code")).toMatch(/^code-/);
  expect(back.searchParams.get("state")).toBe("xyz");
  expect(back.searchParams.get("iss")).toBe("https://sendo.test");
  expect([...server.grants.values()]).toMatchObject([
    { clientId: AGENT, scopes: ["read", "write"] },
  ]);
});

test("拒否すると access_denied を持って戻る。許可の画面は、手元の同期を始めない", async ({
  page,
  context,
}) => {
  const server = await setup(context);
  // reader でもログインしている
  await page.goto("/");
  await signIn(page);
  await expect(page.getByRole("button", { name: "Sync now" })).toBeVisible();
  server.requests.length = 0;

  await page.goto(authorizeUrl());
  await page.getByRole("button", { name: "拒否する" }).click();
  await page.waitForURL(/^https:\/\/agent\.example\/callback/);
  expect(new URL(page.url()).searchParams.get("error")).toBe("access_denied");
  expect(server.grants.size).toBe(0);
  expect(server.requests.filter((r) => r.startsWith("GET /sync"))).toEqual([]);
});

test("名乗っただけの名前と、手元への戻る先には注意を出し、名前はプレーンテキストで出す", async ({
  page,
  context,
}) => {
  const server = await setup(context);
  server.oauthClients.set("registered-client", {
    name: "<img src=x onerror=alert(1)>",
    kind: "registered",
    redirectUris: ["http://127.0.0.1:33418/callback"],
  });
  await signInBrowser(context, server);

  await page.goto(
    authorizeUrl({
      client_id: "registered-client",
      redirect_uri: "http://127.0.0.1:33418/callback",
      scope: "read",
    }),
  );
  const main = page.locator("main");
  await expect(main).toContainText("<img src=x onerror=alert(1)>");
  await expect(main.locator("img")).toHaveCount(0);
  await expect(main).toContainText("アプリが名乗ったもので、sendo は確かめていません");
  await expect(main).toContainText("この端末で動いているほかのアプリも、許可を受け取れます");
  await expect(main).not.toContainText("変更する");
});

test("クライアントか戻る先を確かめられなければ、誤りを出してどこへも移らない", async ({
  page,
  context,
}) => {
  const server = await setup(context);
  await signInBrowser(context, server);

  await page.goto(authorizeUrl({ redirect_uri: "https://evil.example/callback" }));
  await expect(page.getByRole("alert")).toContainText("戻る先が、アプリに登録されたものと違います");
  await expect(page).toHaveURL(/\/oauth\/authorize\?/);
  await expect(page.getByRole("button", { name: "許可する" })).toHaveCount(0);

  // クライアントに返す誤りなら、sendo が返した先へ移る
  await page.goto(authorizeUrl({ response_type: "token" }));
  await page.waitForURL(/^https:\/\/agent\.example\/callback/);
  expect(new URL(page.url()).searchParams.get("error")).toBe("unsupported_response_type");
});

test("OAuth の設定がない、リクエストがないときは、その旨を出す", async ({ page, context }) => {
  const server = await setup(context);
  await signInBrowser(context, server);

  server.oauthEnabled = false;
  await page.goto(authorizeUrl());
  await expect(page.getByRole("alert")).toContainText("OAuth でつなぐ設定がされていません");

  await page.goto("/oauth/authorize");
  await expect(page.getByRole("alert")).toContainText("許可のリクエストがありません");
});

test("許可するアカウントが分からなければ、許可の操作を出さず、やり直せる", async ({
  page,
  context,
}) => {
  const server = await setup(context);
  await signInBrowser(context, server);
  // 確かめるのは届き、アカウント（/me）が届かない
  server.failNext(null, "network");
  await page.goto(authorizeUrl());
  await expect(page.getByRole("alert")).toContainText("sendo に届きません");
  await expect(page.getByRole("button", { name: "許可する" })).toHaveCount(0);

  await page.getByRole("button", { name: "やり直す" }).click();
  await expect(page.locator("main")).toContainText(USER.email);
  await expect(page.getByRole("button", { name: "許可する" })).toBeVisible();
});

test("画面を出したあとにアカウントが替わっていたら、送らずに出し直し、もう一度選んでもらう", async ({
  page,
  context,
}) => {
  const server = await setup(context);
  await signInBrowser(context, server);
  await page.goto(authorizeUrl());
  await expect(page.locator("main")).toContainText(USER.email);

  // 別のタブで、別のアカウントでログインし直した
  await context.addCookies([
    {
      name: "__Host-sendo_session",
      value: server.createSession({ id: "user-b", email: "b@example.com" }),
      url: "https://localhost/",
      secure: true,
      httpOnly: true,
      sameSite: "Lax",
    },
  ]);
  await page.getByRole("button", { name: "許可する" }).click();
  await expect(page.getByRole("alert")).toContainText("ログインしているアカウントが替わりました");
  await expect(page.locator("main")).toContainText("b@example.com");
  expect(server.grants.size).toBe(0);

  // 確かめてから、もう一度押す
  await page.getByRole("button", { name: "許可する" }).click();
  await page.waitForURL(/^https:\/\/agent\.example\/callback/);
  expect(server.grants.size).toBe(1);
});
