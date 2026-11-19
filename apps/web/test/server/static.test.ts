import { gunzipSync } from "node:zlib";
import { beforeAll, describe, expect, test } from "vitest";
import { securityHeaders } from "../../security-headers";
import { type Assets, serveAsset } from "../../server/static";
import { fixtureAssets, INDEX_HTML } from "./helpers";

const SCRIPT = `console.log(${JSON.stringify("x".repeat(2000))});`;

let assets: Assets;
beforeAll(async () => {
  assets = await fixtureAssets({
    "index.html": INDEX_HTML,
    "sw.js": SCRIPT,
    "assets/index-abc.js": SCRIPT,
    "assets/sqlite3-abc.wasm": new Uint8Array(4000),
    "favicon.svg": "<svg/>",
    ".hidden": "secret",
  });
});

function get(path: string, headers: Record<string, string> = {}, method = "GET") {
  return serveAsset(new Request(`http://reader.example${path}`, { method, headers }), assets);
}

describe("静的なファイル", () => {
  test("/ には index.html を返す", async () => {
    const response = get("/");
    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toBe("text/html; charset=utf-8");
    expect(await response.text()).toBe(INDEX_HTML);
  });

  test.each(["/settings", "/feeds/abc", "/oauth/authorize", "/assets/missing.js"])(
    "ないパス %s には index.html を返す（SPA）",
    async (path) => {
      const response = get(path);
      expect(response.status).toBe(200);
      expect(await response.text()).toBe(INDEX_HTML);
    },
  );

  test("ドットで始まるファイルは、画面のファイルとして返さない", async () => {
    expect(await get("/.hidden").text()).toBe(INDEX_HTML);
  });

  test("すべての応答に、本番のセキュリティのヘッダーを付ける", () => {
    for (const response of [get("/"), get("/assets/index-abc.js"), get("/", {}, "POST")]) {
      for (const [name, value] of Object.entries(securityHeaders("production"))) {
        expect(response.headers.get(name)).toBe(value);
      }
    }
  });

  test("キャッシュは毎回確かめさせ、変わっていなければ 304 を返す", async () => {
    const first = get("/sw.js");
    expect(first.headers.get("cache-control")).toBe("public, max-age=0, must-revalidate");
    const etag = first.headers.get("etag");
    expect(etag).toMatch(/^"[\w-]+"$/);

    const second = get("/sw.js", { "if-none-match": `W/${etag}` });
    expect(second.status).toBe(304);
    expect(await second.text()).toBe("");
    expect(second.headers.get("content-security-policy")).not.toBeNull();
  });

  test("ブラウザが受けられれば圧縮する（br を先に）", async () => {
    const br = get("/assets/index-abc.js", { "accept-encoding": "gzip, deflate, br" });
    expect(br.headers.get("content-encoding")).toBe("br");
    expect(br.headers.get("vary")).toBe("accept-encoding");

    const gzip = get("/assets/index-abc.js", { "accept-encoding": "gzip, br;q=0" });
    expect(gzip.headers.get("content-encoding")).toBe("gzip");
    expect(gunzipSync(new Uint8Array(await gzip.arrayBuffer())).toString()).toBe(SCRIPT);
    // 圧縮の形ごとに ETag を分ける
    expect(gzip.headers.get("etag")).not.toBe(br.headers.get("etag"));

    const identity = get("/assets/index-abc.js");
    expect(identity.headers.get("content-encoding")).toBeNull();
    expect(await identity.text()).toBe(SCRIPT);
  });

  test("wasm は application/wasm で返し、圧縮もする", () => {
    const response = get("/assets/sqlite3-abc.wasm", { "accept-encoding": "gzip" });
    expect(response.headers.get("content-type")).toBe("application/wasm");
    expect(response.headers.get("content-encoding")).toBe("gzip");
  });

  test("HEAD には本文を返さない", async () => {
    const response = get("/", {}, "HEAD");
    expect(response.status).toBe(200);
    expect(response.headers.get("content-length")).toBe(String(INDEX_HTML.length));
    expect(await response.text()).toBe("");
  });

  test("GET と HEAD のほかは 405", () => {
    const response = get("/settings", {}, "POST");
    expect(response.status).toBe(405);
    expect(response.headers.get("allow")).toBe("GET, HEAD");
  });
});
