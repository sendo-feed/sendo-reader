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
  const api = createSendoApi({
    baseUrl: "https://sendo.test/api/v1",
    token: () => "t",
    fetch: fetcher,
  });
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

  test("届かなければ network。トークンはエラーの文言に入れない", async () => {
    const api = createSendoApi({
      baseUrl: "https://sendo.test/api/v1",
      token: () => "sendo_secret",
      fetch: async () => {
        throw new TypeError("fetch failed");
      },
    });
    const error = await api.sync(null).catch((e: unknown) => e);
    expect((error as ApiError).kind).toBe("network");
    expect(String((error as ApiError).message)).not.toContain("sendo_secret");
  });
});

describe("リクエストの組み立て", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  test("トークンを Bearer で付け、カーソルはそのまま送る", async () => {
    const seen: Request[] = [];
    const api = createSendoApi({
      baseUrl: "https://sendo.test/api/v1/",
      token: () => "sendo_abc",
      fetch: async (input) => {
        seen.push(input as Request);
        return new Response(
          JSON.stringify({ cursor: "c2", hasMore: false, folders: [], feeds: [], articles: [] }),
        );
      },
    });
    await api.sync("c1+/=");
    expect(seen[0]?.url).toBe("https://sendo.test/api/v1/sync?cursor=c1%2B%2F%3D");
    expect(seen[0]?.headers.get("authorization")).toBe("Bearer sendo_abc");
  });

  test("ブラウザでは、同じオリジンのパス（/api/v1）を今の場所から解決する", async () => {
    vi.stubGlobal("location", { href: "https://reader.example/assets/worker.js" });
    const seen: string[] = [];
    const api = createSendoApi({
      baseUrl: "/api/v1",
      token: () => null,
      fetch: async (input) => {
        seen.push((input as Request).url);
        return new Response(JSON.stringify({ items: [] }));
      },
    });
    await api.verifyToken("sendo_x");
    expect(seen).toEqual(["https://reader.example/api/v1/folders"]);
  });

  test("トークンを確かめるときは、渡したトークンを使う", async () => {
    const seen: (string | null)[] = [];
    const api = createSendoApi({
      baseUrl: "https://sendo.test/api/v1",
      token: () => "sendo_old",
      fetch: async (input) => {
        seen.push((input as Request).headers.get("authorization"));
        return new Response(JSON.stringify({ items: [] }));
      },
    });
    await api.verifyToken("sendo_new");
    expect(seen).toEqual(["Bearer sendo_new"]);
  });
});
