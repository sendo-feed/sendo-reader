import { request as httpRequest, type IncomingHttpHeaders } from "node:http";
import { afterEach, beforeAll, describe, expect, test } from "vitest";
import { contentSecurityPolicy, securityHeaders } from "../../security-headers";
import { withXEmbedOrigin } from "../../server/assets";
import { parseXEmbedOrigin } from "../../server/config";
import type { Assets } from "../../server/static";
import { X_EMBED_ORIGIN_META } from "../../x-embed-origin";
import {
  type FakeSendo,
  fixtureAssets,
  type RunningReader,
  startFakeSendo,
  startReader,
} from "./helpers";

/**
 * X の投稿の隔離フレームのオリジン（docs/decisions/embeds.md の 3）。設定の確かめ、ホスト名の振り分け、
 * reader の CSP、index.html と sw.js の書き換えを、本物の HTTP で確かめる
 */

const ORIGIN = "https://embed.example";
const INDEX = "<!doctype html><html><head><title>Sendo</title></head><body></body></html>";
/** Workbox の generateSW が出力する precache の一覧の形 */
const SW =
  'self.x=[{url:"manifest.webmanifest",revision:"b5e4d4f396d67e7a1e14a25c33a5efa9"},' +
  '{url:"index.html",revision:"0c2a02240a51df2b98c6e69fb36d965c"},' +
  '{url:"assets/index-abc.js",revision:null}];';

let built: Assets;
beforeAll(async () => {
  built = await fixtureAssets({
    "index.html": INDEX,
    "sw.js": SW,
    "manifest.webmanifest": "{}",
    "assets/index-abc.js": "console.log(1)",
  });
});

const running: Array<FakeSendo | RunningReader> = [];
afterEach(async () => {
  await Promise.all(running.splice(0).map((item) => item.close()));
});

/** 設定を読んで、本番の main.ts と同じ順で組み立てて動かす */
async function start(value: string | undefined) {
  const sendo = await startFakeSendo((_request, response) => {
    response.writeHead(200, { "content-type": "application/json" });
    response.end('{"from":"sendo"}');
  });
  const xEmbedOrigin = parseXEmbedOrigin(value);
  const assets =
    xEmbedOrigin === null
      ? built
      : await withXEmbedOrigin(
          built,
          xEmbedOrigin,
          contentSecurityPolicy("production", { xEmbedOrigin }),
        );
  const reader = await startReader(assets, sendo.origin, { xEmbedOrigin });
  running.push(sendo, reader);
  return { sendo, reader };
}

type Answer = { status: number; headers: IncomingHttpHeaders; body: string };

/** Host を決めて、reader に送る（手前のリバースプロキシが Host を書き換えずに渡した形） */
function send(
  origin: string,
  path: string,
  host: string,
  options: { method?: string; headers?: Record<string, string> } = {},
): Promise<Answer> {
  return new Promise((resolve, reject) => {
    const request = httpRequest(`${origin}${path}`, {
      method: options.method ?? "GET",
      setHost: false,
      headers: { host, ...options.headers },
    });
    request.on("response", (response) => {
      const chunks: Buffer[] = [];
      response.on("data", (chunk: Buffer) => chunks.push(chunk));
      response.on("end", () =>
        resolve({
          status: response.statusCode ?? 0,
          headers: response.headers,
          body: Buffer.concat(chunks).toString(),
        }),
      );
    });
    request.on("error", reject);
    request.end();
  });
}

describe("X_EMBED_ORIGIN", () => {
  test("なければ、未設定", () => {
    expect(parseXEmbedOrigin(undefined)).toBeNull();
    expect(parseXEmbedOrigin("  ")).toBeNull();
  });

  test.each([
    ["https://embed.example", "https://embed.example"],
    ["https://embed.example/", "https://embed.example"],
    [" https://embed.example ", "https://embed.example"],
    ["https://x-embed.reader.example:8443", "https://x-embed.reader.example:8443"],
  ])("%s を受ける", (value, origin) => {
    expect(parseXEmbedOrigin(value)).toBe(origin);
  });

  test.each([
    // コンテナは https だけ。開発用の http も受けない
    "http://localhost:5174",
    "http://127.0.0.1",
    // https でも、コンテナのヘルスチェック（127.0.0.1）や手元のホスト名と重なるものは受けない
    "https://localhost",
    "https://127.0.0.1",
    "https://embed.example/.",
    "https://a..b",
    "http://embed.example",
    "ftp://embed.example",
    "https://embed.example/x-embed",
    "https://embed.example/?",
    "https://embed.example/?a=1",
    "https://embed.example/#",
    "https://embed.example#id=1",
    "https://user@embed.example",
    "https://user:pass@embed.example",
    "https://*.example",
    "https://embed_example.com",
    "https://embed.example.",
    "https://[::1]",
    "embed.example",
    "not a url",
  ])("%s は受けず、起動しない", (value) => {
    expect(() => parseXEmbedOrigin(value)).toThrow(/X_EMBED_ORIGIN/);
  });
});

describe("隔離フレームのホスト名への要求", () => {
  test.each([
    "/",
    "/index.html",
    "/embed.js",
    "/api/v1/me",
    "/api/v1/sync/updates",
    "/oauth/token",
    "/oauth/authorize",
    "/mcp",
    "/healthz",
    "/settings",
    "/sw.js",
    "/manifest.webmanifest",
    "/assets/index-abc.js",
  ])("%s は 404。sendo へ中継せず、reader の画面も返さない", async (path) => {
    const { sendo, reader } = await start(ORIGIN);
    const answer = await send(reader.origin, path, "embed.example");
    expect(answer.status).toBe(404);
    expect(answer.body).not.toContain("Sendo");
    expect(answer.body).not.toContain("from");
    expect(sendo.received).toEqual([]);
  });

  test("HEAD も 404。GET ／ HEAD のほかは 405", async () => {
    const { sendo, reader } = await start(ORIGIN);
    expect((await send(reader.origin, "/", "embed.example", { method: "HEAD" })).status).toBe(404);
    for (const method of ["POST", "PUT", "DELETE", "PATCH", "OPTIONS"]) {
      const answer = await send(reader.origin, "/api/v1/auth/logout", "embed.example", { method });
      expect(answer.status, method).toBe(405);
      expect(answer.headers.allow).toBe("GET, HEAD");
    }
    expect(sendo.received).toEqual([]);
  });

  test.each([
    "embed.example",
    "EMBED.Example",
    "embed.example:443",
    "embed.example:8080",
    "embed.example.",
    "Embed.Example.:443",
  ])("Host が %s でも、隔離フレームのホスト名として扱う", async (host) => {
    const { sendo, reader } = await start(ORIGIN);
    expect((await send(reader.origin, "/api/v1/me", host)).status).toBe(404);
    expect((await send(reader.origin, "/", host)).body).not.toContain("Sendo");
    expect(sendo.received).toEqual([]);
  });

  test.each(["reader.example", "embed.example.reader.example", "x-embed.example", "example"])(
    "ほかのホスト名（%s）は、今までどおり reader の画面と sendo への中継",
    async (host) => {
      const { sendo, reader } = await start(ORIGIN);
      const page = await send(reader.origin, "/settings", host);
      expect(page.status).toBe(200);
      expect(page.body).toContain("<title>Sendo</title>");
      const api = await send(reader.origin, "/api/v1/me", host);
      expect(api.body).toBe('{"from":"sendo"}');
      expect(sendo.received).toHaveLength(1);
    },
  );

  test("WebSocket の Upgrade は、sendo のパスでも断る", async () => {
    const { sendo, reader } = await start(ORIGIN);
    const status = await new Promise<number>((resolve, reject) => {
      const request = httpRequest(`${reader.origin}/api/v1/sync/updates`, {
        setHost: false,
        headers: {
          host: "embed.example",
          connection: "Upgrade",
          upgrade: "websocket",
          "sec-websocket-version": "13",
          "sec-websocket-key": "dGhlIHNhbXBsZSBub25jZQ==",
        },
      });
      request.on("upgrade", (response, socket) => {
        socket.destroy();
        resolve(response.statusCode ?? 0);
      });
      request.on("response", (response) => {
        response.resume();
        resolve(response.statusCode ?? 0);
      });
      request.on("error", reject);
      request.end();
    });
    expect(status).toBe(404);
    expect(sendo.received).toEqual([]);
  });
});

describe("reader の画面", () => {
  test("設定があるとき、CSP に frame-src が 1 つ入り、ほかのディレクティブは変わらない", async () => {
    const { reader } = await start(ORIGIN);
    for (const path of ["/", "/settings", "/assets/index-abc.js", "/sw.js"]) {
      const answer = await send(reader.origin, path, "reader.example");
      expect(answer.headers["content-security-policy"], path).toBe(
        `${contentSecurityPolicy("production")}; frame-src ${ORIGIN}`,
      );
    }
  });

  test("設定があるとき、index.html に <meta> が 1 つ入り、sw.js の index.html の revision が替わる", async () => {
    const { reader } = await start(ORIGIN);
    const page = await send(reader.origin, "/", "reader.example");
    expect(page.body.split(X_EMBED_ORIGIN_META)).toHaveLength(2);
    expect(page.body).toContain(`<meta name="${X_EMBED_ORIGIN_META}" content="${ORIGIN}"></head>`);
    // SPA の代わりの index.html も同じ
    expect((await send(reader.origin, "/feeds/abc", "reader.example")).body).toBe(page.body);

    const sw = (await send(reader.origin, "/sw.js", "reader.example")).body;
    const revision = /\{url:"index\.html",revision:"([0-9a-f]+)"\}/.exec(sw)?.[1];
    expect(revision).toMatch(/^[0-9a-f]{32}$/);
    expect(revision).not.toBe("0c2a02240a51df2b98c6e69fb36d965c");
    // ほかのファイルの revision は変えない
    expect(sw.replace(/\{url:"index\.html",revision:"[0-9a-f]+"\}/, "")).toBe(
      SW.replace(/\{url:"index\.html",revision:"[0-9a-f]+"\}/, ""),
    );
  });

  test("index.html と sw.js の ETag も、書き換えたあとの中身で変わる（304 を返さない）", async () => {
    const before = await start(undefined);
    const old = await send(before.reader.origin, "/sw.js", "reader.example");
    const after = await start(ORIGIN);
    const changed = await send(after.reader.origin, "/sw.js", "reader.example", {
      headers: { "if-none-match": String(old.headers.etag) },
    });
    expect(changed.status).toBe(200);
    expect(changed.headers.etag).not.toBe(old.headers.etag);
  });

  test("設定の値を変えると revision も変わり、同じ値なら起動し直しても同じ", async () => {
    const revision = async (value: string) => {
      const { reader } = await start(value);
      const sw = (await send(reader.origin, "/sw.js", "reader.example")).body;
      return /\{url:"index\.html",revision:"([0-9a-f]+)"\}/.exec(sw)?.[1];
    };
    const first = await revision(ORIGIN);
    expect(await revision(ORIGIN)).toBe(first);
    expect(await revision("https://other.example")).not.toBe(first);
  });

  test("値は、HTML の属性としてエスケープして埋める", async () => {
    // 確かめを通った値には記号が入らないが、埋める関数そのものもエスケープする
    const assets = await withXEmbedOrigin(built, 'https://a"><script>', "default-src 'none'");
    const html = new TextDecoder().decode(assets.get("/index.html")?.identity.body);
    expect(html).toContain('content="https://a&quot;&gt;&lt;script&gt;"');
    expect(html).not.toContain("<script>");
  });

  test("未設定なら、今と同じ（CSP に frame-src がなく、index.html と sw.js は 1 バイトも変わらない）", async () => {
    const { sendo, reader } = await start(undefined);
    const page = await send(reader.origin, "/", "embed.example");
    expect(page.status).toBe(200);
    expect(page.body).toBe(INDEX);
    expect(page.headers["content-security-policy"]).toBe(
      securityHeaders("production")["Content-Security-Policy"],
    );
    expect(page.headers["content-security-policy"]).not.toContain("frame-src");
    expect((await send(reader.origin, "/sw.js", "embed.example")).body).toBe(SW);
    expect((await send(reader.origin, "/api/v1/me", "embed.example")).body).toBe(
      '{"from":"sendo"}',
    );
    expect(sendo.received).toHaveLength(1);
  });
});

describe("書き換える場所が見つからないとき", () => {
  test.each([
    ["sw.js に index.html の項目がない", { "index.html": INDEX, "sw.js": "self.x=[];" }],
    [
      "sw.js に index.html の項目が 2 つある",
      {
        "index.html": INDEX,
        "sw.js": '[{url:"index.html",revision:"aa"},{url:"index.html",revision:"bb"}]',
      },
    ],
    [
      "Workbox の出力の形が変わった",
      { "index.html": INDEX, "sw.js": '[{"url":"index.html","revision":"aa"}]' },
    ],
    ["sw.js がない", { "index.html": INDEX }],
    [
      "index.html に </head> がない",
      { "index.html": "<!doctype html><title>Sendo</title>", "sw.js": SW },
    ],
  ])("%s なら、設定があると起動しない", async (_name, files) => {
    const assets = await fixtureAssets(files);
    await expect(
      withXEmbedOrigin(assets, ORIGIN, contentSecurityPolicy("production")),
    ).rejects.toThrow();
  });
});
