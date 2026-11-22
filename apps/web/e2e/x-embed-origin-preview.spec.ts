import { readFileSync } from "node:fs";
import { createServer, request as httpRequest, type IncomingHttpHeaders } from "node:http";
import type { AddressInfo } from "node:net";
import { fileURLToPath } from "node:url";
import { expect, test } from "@playwright/test";
import { xEmbedPageHeaders } from "../security-headers";
import { type RunningPreview, startPreview } from "./x-embed-preview";

/**
 * 手元の Vite の preview も、コンテナと同じ設定（X_EMBED_ORIGIN）を、同じ処理（値の確かめ、Host での
 * 振り分け、index.html と sw.js の書き換え）に通す（docs/decisions/embeds.md の 3）。開発用の
 * http://127.0.0.1 を、reader（localhost）と違うホスト名として使う。sendo の代わりに、受けた要求を
 * 数える偽のサーバーに中継させる
 */

const PORT = 4186;
const EMBED = `http://127.0.0.1:${PORT}`;
const BUILT_SW = readFileSync(fileURLToPath(new URL("../dist/sw.js", import.meta.url)), "utf8");

type Answer = { status: number; headers: IncomingHttpHeaders; body: string };

/** preview に、Host を決めて送る */
function send(host: string, path: string, method = "GET"): Promise<Answer> {
  return new Promise((resolve, reject) => {
    // preview は 127.0.0.1 で待ち受ける（vite.config.ts）。Host は、引数で決める
    const request = httpRequest(`http://127.0.0.1:${PORT}${path}`, {
      method,
      setHost: false,
      headers: { host },
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

/** WebSocket の Upgrade を送り、返った状態を読む */
function upgrade(host: string, path: string): Promise<number> {
  return new Promise((resolve, reject) => {
    // preview は 127.0.0.1 で待ち受ける（vite.config.ts）。Host は、引数で決める
    const request = httpRequest(`http://127.0.0.1:${PORT}${path}`, {
      setHost: false,
      headers: {
        host,
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
}

test("preview も、X_EMBED_ORIGIN を、コンテナと同じ処理に通す", async () => {
  // 偽の sendo。受けた要求（Upgrade を含む）を数える
  const received: string[] = [];
  const sendo = createServer((req, res) => {
    received.push(`${req.method} ${req.url}`);
    res.writeHead(200, { "content-type": "application/json" });
    res.end('{"from":"sendo"}');
  });
  sendo.on("upgrade", (req, socket) => {
    received.push(`UPGRADE ${req.url}`);
    socket.destroy();
  });
  await new Promise<void>((resolve) => sendo.listen(0, "127.0.0.1", resolve));
  const sendoPort = (sendo.address() as AddressInfo).port;

  let preview: RunningPreview | null = null;
  try {
    preview = await startPreview(PORT, {
      X_EMBED_ORIGIN: EMBED,
      SENDO_DEV_URL: `http://127.0.0.1:${sendoPort}`,
    });

    // reader のホスト名：CSP に frame-src、index.html に <meta>、sw.js の revision が替わる
    const page = await send(`localhost:${PORT}`, "/");
    expect(page.headers["content-security-policy"]).toContain(`; frame-src ${EMBED}`);
    expect(page.body).toContain(`<meta name="sendo-x-embed-origin" content="${EMBED}">`);
    expect((await send(`localhost:${PORT}`, "/feeds/abc")).body).toBe(page.body);
    const sw = (await send(`localhost:${PORT}`, "/sw.js")).body;
    const revision = (source: string) =>
      /\{url:"index\.html",revision:"([0-9a-f]+)"\}/.exec(source)?.[1];
    expect(revision(sw)).toMatch(/^[0-9a-f]{32}$/);
    expect(revision(sw)).not.toBe(revision(BUILT_SW));
    // sendo のパスは、今までどおり中継する
    expect((await send(`localhost:${PORT}`, "/api/v1/me")).body).toBe('{"from":"sendo"}');
    expect(received).toEqual(["GET /api/v1/me"]);

    // 隔離フレームのホスト名：sendo に中継せず、reader の画面も返さない
    received.length = 0;
    // 返すのは、隔離フレームのページ（/ と /embed.js）だけ
    const framePage = await send(`127.0.0.1:${PORT}`, "/");
    expect(framePage.status).toBe(200);
    expect(framePage.body).toContain('<script src="/embed.js" defer></script>');
    expect(framePage.headers["content-security-policy"]).toBe(
      xEmbedPageHeaders()["Content-Security-Policy"],
    );
    expect((await send(`127.0.0.1:${PORT}`, "/embed.js")).status).toBe(200);
    for (const path of ["/index.html", "/api/v1/me", "/settings", "/sw.js"]) {
      const answer = await send(`127.0.0.1:${PORT}`, path);
      expect(answer.status, path).toBe(404);
      expect(answer.body, path).not.toContain("<title>Sendo</title>");
    }
    expect((await send(`127.0.0.1:${PORT}`, "/api/v1/auth/logout", "POST")).status).toBe(405);
    expect(await upgrade(`127.0.0.1:${PORT}`, "/api/v1/sync/updates")).toBe(404);
    expect(received).toEqual([]);
  } finally {
    await preview?.stop();
    await new Promise<void>((resolve) => sendo.close(() => resolve()));
  }
});
