import { describe, expect, test } from "vitest";
import { type ApiError, createAccountApi } from "../src";
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
