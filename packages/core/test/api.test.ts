import { afterEach, describe, expect, test, vi } from "vitest";
import { ApiError } from "../src";
import { createSendoApi } from "../src/api/client";

function respond(status: number, body?: unknown): typeof fetch {
  return async () =>
    new Response(body === undefined ? null : JSON.stringify(body), {
      status,
      headers: { "content-type": "application/json" },
    });
}

async function syncError(fetcher: typeof fetch): Promise<ApiError> {
  const api = createSendoApi({ baseUrl: "https://sendo.test/api/v1", fetch: fetcher });
  const error = await api.sync(null).catch((e: unknown) => e);
  if (!(error instanceof ApiError)) throw new Error("ApiError が投げられなかった");
  return error;
}

describe("sendo の API の失敗の分け方", () => {
  test.each([
    [401, { error: { code: "unauthorized", message: "no" } }, "unauthorized"],
    [400, { error: { code: "invalid_cursor", message: "old" } }, "cursor_invalid"],
    [400, { error: { code: "sync_incomplete", message: "x" } }, "invalid"],
    [410, { error: { code: "gone", message: "gone" } }, "invalid"],
    [404, { error: { code: "not_found", message: "x" } }, "not_found"],
    [409, { error: { code: "folder_exists", message: "x" } }, "conflict"],
    [400, { error: { code: "invalid_request", message: "x" } }, "invalid"],
    [429, undefined, "server"],
    [500, undefined, "server"],
    [503, "not json", "server"],
  ] as const)("%i %j → %s", async (status, body, kind) => {
    const error = await syncError(respond(status, body));
    expect(error.kind).toBe(kind);
    expect(error.status).toBe(status);
  });

  test("届かなければ network", async () => {
    const api = createSendoApi({
      baseUrl: "https://sendo.test/api/v1",
      fetch: async () => {
        throw new TypeError("fetch failed");
      },
    });
    const error = await api.sync(null).catch((e: unknown) => e);
    expect((error as ApiError).kind).toBe("network");
  });

  test.each([
    [{ user: { id: "", email: "a@example.com" } }],
    [{ user: { id: "u1" } }],
    [{ id: "u1", email: "a@example.com" }],
    [null],
  ])("/me の応答の形が違えば server（%j）", async (body) => {
    const api = createSendoApi({ baseUrl: "https://sendo.test/api/v1", fetch: respond(200, body) });
    const error = await api.me().catch((e: unknown) => e);
    expect((error as ApiError).kind).toBe("server");
  });
});

describe("リクエストの組み立て", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  test("Authorization は付けず、カーソルはそのまま送る", async () => {
    const seen: Request[] = [];
    const api = createSendoApi({
      baseUrl: "https://sendo.test/api/v1/",
      fetch: async (input) => {
        seen.push(input as Request);
        return new Response(
          JSON.stringify({ cursor: "c2", hasMore: false, folders: [], feeds: [], articles: [] }),
        );
      },
    });
    await api.sync("c1+/=");
    expect(seen[0]?.url).toBe(
      "https://sendo.test/api/v1/sync?cursor=c1%2B%2F%3D&includeSaved=true&includeWorkspaces=true&includeBells=true",
    );
    expect(seen[0]?.headers.has("authorization")).toBe(false);
  });

  test("ブラウザでは、同じオリジンのパス（/api/v1）を今の場所から解決する", async () => {
    vi.stubGlobal("location", { href: "https://reader.example/assets/worker.js" });
    const seen: string[] = [];
    const api = createSendoApi({
      baseUrl: "/api/v1",
      fetch: async (input) => {
        seen.push((input as Request).url);
        return new Response(JSON.stringify({ user: { id: "u1", email: "a@example.com" } }));
      },
    });
    expect(await api.me()).toEqual({ id: "u1", email: "a@example.com" });
    expect(seen).toEqual(["https://reader.example/api/v1/me"]);
  });

  test("ログアウトは POST /auth/logout。204 なら成功", async () => {
    const seen: string[] = [];
    const api = createSendoApi({
      baseUrl: "https://sendo.test/api/v1",
      fetch: async (input) => {
        const request = input as Request;
        seen.push(`${request.method} ${request.url}`);
        return new Response(null, { status: 204 });
      },
    });
    await api.logout();
    expect(seen).toEqual(["POST https://sendo.test/api/v1/auth/logout"]);
  });
});
