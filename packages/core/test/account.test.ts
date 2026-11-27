import { describe, expect, test } from "vitest";
import { type ApiError, AuthorizationError, createAccountApi } from "../src";
import { FakeSendo, USER } from "./fake-sendo";

function setup() {
  const server = new FakeSendo();
  server.signInAs();
  const account = createAccountApi({ baseUrl: "https://sendo.test/api/v1", fetch: server.fetch });
  return { server, account };
}

describe("アクセストークン", () => {
  test("発行すると中身を一度だけ受け取り、一覧には中身を載せない", async () => {
    const { server, account } = setup();
    const issued = await account.createToken({ name: "Reeder", purpose: "reader" });
    expect(issued.secret).toMatch(/^sendo_/);
    expect(issued.accessToken).toMatchObject({
      name: "Reeder",
      purpose: "reader",
      scopes: [],
      createdAt: server.now,
      lastUsedAt: null,
    });

    const tokens = await account.listTokens();
    expect(tokens).toEqual([issued.accessToken]);
    expect(JSON.stringify(tokens)).not.toContain(issued.secret);
  });

  test("MCP 用は範囲を送り、既定は読むだけ", async () => {
    const { account } = setup();
    const readOnly = await account.createToken({ name: "Claude Code", purpose: "mcp" });
    expect(readOnly.accessToken.scopes).toEqual(["read"]);
    const readWrite = await account.createToken({
      name: "Agent",
      purpose: "mcp",
      scopes: ["read", "write"],
    });
    expect(readWrite.accessToken.scopes).toEqual(["read", "write"]);
  });

  test("リーダーアプリ用には、範囲を渡しても送らない", async () => {
    const { account } = setup();
    const issued = await account.createToken({
      name: "Reeder",
      purpose: "reader",
      scopes: ["read", "write"],
    });
    expect(issued.accessToken.scopes).toEqual([]);
  });

  test("名前が正しくなければ invalid", async () => {
    const { account } = setup();
    const error = await account
      .createToken({ name: "   ", purpose: "reader" })
      .catch((e: unknown) => e);
    expect((error as ApiError).kind).toBe("invalid");
  });

  test("取り消すと一覧から消え、もうないものは not_found", async () => {
    const { account } = setup();
    const issued = await account.createToken({ name: "Reeder", purpose: "reader" });
    await account.revokeToken(issued.accessToken.id);
    expect(await account.listTokens()).toEqual([]);
    const error = await account.revokeToken(issued.accessToken.id).catch((e: unknown) => e);
    expect((error as ApiError).kind).toBe("not_found");
  });
});

describe("OAuth の許可", () => {
  test("一覧と取り消し", async () => {
    const { server, account } = setup();
    const grant = server.addGrant({
      clientId: "https://claude.ai/oauth/client.json",
      clientName: "Claude",
      scopes: ["read", "write"],
    });
    expect(await account.listGrants()).toEqual([
      {
        id: grant.id,
        clientId: "https://claude.ai/oauth/client.json",
        clientName: "Claude",
        clientKind: "metadata_document",
        scopes: ["read", "write"],
        createdAt: server.now,
        lastUsedAt: null,
      },
    ]);
    await account.revokeGrant(grant.id);
    expect(await account.listGrants()).toEqual([]);
  });
});

describe("セッション", () => {
  test("ログインしているユーザーを返す", async () => {
    const { account } = setup();
    expect(await account.me()).toEqual(USER);
  });

  test("セッションが切れていれば unauthorized、届かなければ network", async () => {
    const { server, account } = setup();
    server.failNext("network");
    expect(((await account.listTokens().catch((e: unknown) => e)) as ApiError).kind).toBe(
      "network",
    );
    server.expireSession();
    expect(((await account.listGrants().catch((e: unknown) => e)) as ApiError).kind).toBe(
      "unauthorized",
    );
  });

  test("中断できる", async () => {
    const { server, account } = setup();
    server.failNext("hang");
    const controller = new AbortController();
    const listing = account.listTokens(controller.signal);
    controller.abort();
    expect(((await listing.catch((e: unknown) => e)) as ApiError).kind).toBe("network");
  });
});

describe("OAuth の許可の画面", () => {
  const CLIENT = "https://agent.example/oauth/client.json";
  const query = (extra: Record<string, string> = {}) =>
    `?${new URLSearchParams({
      response_type: "code",
      client_id: CLIENT,
      redirect_uri: "https://agent.example/callback",
      scope: "read write",
      state: "xyz",
      ...extra,
    })}`;

  function withClient() {
    const context = setup();
    context.server.oauthClients.set(CLIENT, {
      name: "Agent",
      kind: "metadata_document",
      redirectUris: ["https://agent.example/callback"],
    });
    return context;
  }

  test("確かめると、画面に出すものを返す", async () => {
    const { account } = withClient();
    expect(await account.checkAuthorization(query())).toEqual({
      client: { id: CLIENT, name: "Agent", kind: "metadata_document", host: "agent.example" },
      redirectUri: "https://agent.example/callback",
      redirectHost: "agent.example",
      loopbackRedirect: false,
      scopes: ["read", "write"],
    });
  });

  test("許可すると認可コードの、拒否すると access_denied の戻る先を返す", async () => {
    const { server, account } = withClient();
    const approved = new URL(await account.decideAuthorization(query(), true));
    expect(approved.origin + approved.pathname).toBe("https://agent.example/callback");
    expect(approved.searchParams.get("code")).toMatch(/^code-/);
    expect(approved.searchParams.get("state")).toBe("xyz");
    expect(server.grants.size).toBe(1);

    const denied = new URL(await account.decideAuthorization(query(), false));
    expect(denied.searchParams.get("error")).toBe("access_denied");
    expect(server.grants.size).toBe(1);
  });

  test("クライアントか戻る先を確かめられなければ、戻る先のない AuthorizationError", async () => {
    const { account } = withClient();
    const unknown = await account
      .checkAuthorization(query({ client_id: "https://evil.example/client.json" }))
      .catch((e: unknown) => e);
    expect(unknown).toBeInstanceOf(AuthorizationError);
    expect(unknown).toMatchObject({ code: "invalid_client", redirectTo: null });
    const redirect = await account
      .checkAuthorization(query({ redirect_uri: "https://evil.example/callback" }))
      .catch((e: unknown) => e);
    expect(redirect).toMatchObject({ code: "invalid_redirect_uri", redirectTo: null });
  });

  test("クライアントに返す誤りなら、戻る先の付いた AuthorizationError", async () => {
    const { account } = withClient();
    const error = await account
      .checkAuthorization(query({ response_type: "token" }))
      .catch((e: unknown) => e);
    expect(error).toMatchObject({ code: "unsupported_response_type" });
    const back = new URL((error as AuthorizationError).redirectTo ?? "");
    expect(back.searchParams.get("error")).toBe("unsupported_response_type");
  });

  test("ログインしていなければ unauthorized、OAuth の設定がなければ oauth_disabled", async () => {
    const { server, account } = withClient();
    server.oauthEnabled = false;
    expect(await account.checkAuthorization(query()).catch((e: unknown) => e)).toMatchObject({
      kind: "not_found",
      code: "oauth_disabled",
    });
    server.expireSession();
    expect(await account.checkAuthorization(query()).catch((e: unknown) => e)).toMatchObject({
      kind: "unauthorized",
    });
  });

  test("sendo が返した戻る先が http ／ https でなければ、移らない", async () => {
    const account = createAccountApi({
      baseUrl: "https://sendo.test/api/v1",
      fetch: async (input) => {
        const url = new URL((input as Request).url);
        return url.pathname.endsWith("/decide")
          ? new Response(JSON.stringify({ redirectTo: "javascript:alert(1)" }))
          : new Response(
              JSON.stringify({
                error: { code: "invalid_request", message: "x" },
                redirectTo: "javascript:alert(1)",
              }),
              { status: 400 },
            );
      },
    });
    expect(await account.decideAuthorization("?", true).catch((e: unknown) => e)).toMatchObject({
      kind: "server",
    });
    expect(await account.checkAuthorization("?").catch((e: unknown) => e)).toMatchObject({
      redirectTo: null,
    });
  });
});

describe("Web Push", () => {
  const registration = {
    endpoint: "https://push.example/send/abc",
    keys: { p256dh: "BKey", auth: "secret" },
  };

  test("使える Sendo は公開鍵を返し、登録を今のセッションに置いて、外せる", async () => {
    const { server, account } = setup();
    expect(await account.getPush()).toEqual({
      available: true,
      publicKey: server.pushPublicKey,
    });
    await account.putPushRegistration(registration);
    // 同じ登録を送り直しても、1 つのまま
    await account.putPushRegistration(registration);
    expect([...server.pushRegistrations.values()]).toEqual([registration]);
    await account.deletePushRegistration();
    expect(server.pushRegistrations.size).toBe(0);
    // ないものを外しても成功する
    await account.deletePushRegistration();
  });

  test("使えない設定は available が false で、登録を送ると 501", async () => {
    const { server, account } = setup();
    server.push = "unavailable";
    expect(await account.getPush()).toEqual({ available: false });
    expect(await account.putPushRegistration(registration).catch((e: unknown) => e)).toMatchObject({
      status: 501,
    });
  });

  test("Web Push に対応する前の Sendo（404）は、使えないとする", async () => {
    const { server, account } = setup();
    server.push = "unsupported";
    expect(await account.getPush()).toEqual({ available: false });
  });

  test.each([
    ["available がない", {}],
    ["publicKey が文字でない", { available: true, publicKey: null }],
    ["publicKey が空", { available: true, publicKey: "" }],
    ["本体が null", null],
  ])("応答の形が読めない（%s）なら、server の失敗", async (_name, body) => {
    const account = createAccountApi({
      baseUrl: "https://sendo.test/api/v1",
      fetch: async () => new Response(JSON.stringify(body)),
    });
    expect(await account.getPush().catch((e: unknown) => e)).toMatchObject({ kind: "server" });
  });

  test("セッションが切れていれば unauthorized、5xx は server", async () => {
    const { server, account } = setup();
    server.expireSession();
    expect(await account.getPush().catch((e: unknown) => e)).toMatchObject({
      kind: "unauthorized",
    });
    server.signInAs();
    server.failNext(503);
    expect(await account.getPush().catch((e: unknown) => e)).toMatchObject({ kind: "server" });
  });
});
