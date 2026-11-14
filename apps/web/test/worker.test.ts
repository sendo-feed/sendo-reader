import { describe, expect, test } from "vitest";
import { handleRequest } from "../worker";

/** どちらに渡ったかを、応答の本文で見分けられる偽のバインディング */
function fakeEnv() {
  const received: { sendo: string[]; assets: string[] } = { sendo: [], assets: [] };
  const fetcher = (name: "sendo" | "assets") =>
    ({
      fetch: async (input: Request | string | URL) => {
        const request = input instanceof Request ? input : new Request(input);
        received[name].push(new URL(request.url).pathname);
        return new Response(name);
      },
      connect: () => {
        throw new Error("not used");
      },
    }) as unknown as Fetcher;
  return { env: { SENDO: fetcher("sendo"), ASSETS: fetcher("assets") }, received };
}

describe("reader Worker", () => {
  test.each(["/api", "/api/v1/feeds", "/api/v1/sync?cursor=abc"])(
    "%s は sendo に中継する",
    async (path) => {
      const { env, received } = fakeEnv();
      const response = await handleRequest(new Request(`https://reader.example${path}`), env);
      expect(await response.text()).toBe("sendo");
      expect(received.assets).toEqual([]);
    },
  );

  test.each(["/", "/index.html", "/apis", "/feeds/api/v1"])(
    "%s は静的なファイルとして返す",
    async (path) => {
      const { env, received } = fakeEnv();
      const response = await handleRequest(new Request(`https://reader.example${path}`), env);
      expect(await response.text()).toBe("assets");
      expect(received.sendo).toEqual([]);
    },
  );

  test("中継では、メソッド・ヘッダー・本文をそのまま渡す", async () => {
    let forwarded: Request | undefined;
    const env = {
      SENDO: {
        fetch: async (request: Request) => {
          forwarded = request;
          return new Response(null, { status: 204 });
        },
      } as unknown as Fetcher,
      ASSETS: {} as Fetcher,
    };
    await handleRequest(
      new Request("https://reader.example/api/v1/articles/a1", {
        method: "PATCH",
        headers: { authorization: "Bearer sendo_test", "content-type": "application/json" },
        body: JSON.stringify({ read: true }),
      }),
      env,
    );
    expect(forwarded?.method).toBe("PATCH");
    expect(forwarded?.headers.get("authorization")).toBe("Bearer sendo_test");
    expect(await forwarded?.json()).toEqual({ read: true });
  });
});
