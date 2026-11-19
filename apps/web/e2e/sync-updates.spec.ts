import { createHash } from "node:crypto";
import { once } from "node:events";
import { readFile } from "node:fs/promises";
import { request as httpRequest } from "node:http";
import { createServer } from "node:https";
import type { Duplex } from "node:stream";
import { expect, test } from "@playwright/test";
import { SYNC_UPDATES_PATH } from "../sendo-paths";
import { FakeSendo, routeFakeSendo, USER } from "./fake-sendo";

test.use({ ignoreHTTPSErrors: true });

test("本番の CSP でワーカーが WSS を開き、通知で差分同期する", async ({
  baseURL,
  context,
  page,
}) => {
  if (!baseURL) throw new Error("missing Vite preview origin");
  const preview = new URL(baseURL);
  // この証明書と鍵は、ループバック上のテストでだけ使う。
  const [key, cert] = await Promise.all([
    readFile(new URL("./certs/localhost.key.pem", import.meta.url)),
    readFile(new URL("./certs/localhost.cert.pem", import.meta.url)),
  ]);
  // Vite preview の本番ビルドと CSP を、HTTPS のオリジンからそのまま返す。
  const https = createServer({ key, cert }, (request, response) => {
    const upstream = httpRequest(
      { hostname: preview.hostname, port: preview.port, path: request.url, method: request.method },
      (reply) => {
        response.writeHead(reply.statusCode ?? 502, reply.rawHeaders);
        reply.pipe(response);
      },
    );
    upstream.on("error", () => response.destroy());
    upstream.end();
  });
  let peer: Duplex | undefined;
  https.on("upgrade", (request, socket) => {
    const key = request.headers["sec-websocket-key"];
    const protocol = request.headers["sec-websocket-protocol"];
    if (
      request.url !== SYNC_UPDATES_PATH ||
      typeof key !== "string" ||
      typeof protocol !== "string"
    ) {
      socket.destroy();
      return;
    }
    const accept = createHash("sha1")
      .update(`${key}258EAFA5-E914-47DA-95CA-C5AB0DC85B11`)
      .digest("base64");
    socket.write(
      `HTTP/1.1 101 Switching Protocols\r\nConnection: Upgrade\r\nUpgrade: websocket\r\nSec-WebSocket-Accept: ${accept}\r\nSec-WebSocket-Protocol: ${protocol}\r\n\r\n`,
    );
    socket.on("error", () => socket.destroy());
    socket.resume();
    peer = socket;
  });
  https.listen(0, "127.0.0.1");
  try {
    await once(https, "listening");
    const address = https.address();
    if (!address || typeof address === "string") throw new Error("missing HTTPS address");
    const origin = `https://127.0.0.1:${address.port}`;
    const sendo = new FakeSendo();
    const feed = sendo.subscribe({ url: "https://example.com/updates.xml" });
    const session = sendo.createSession(USER);
    await context.addCookies([
      { name: "__Host-sendo_session", value: session, url: origin, secure: true },
    ]);
    await routeFakeSendo(context, sendo);
    const response = await page.goto(origin);
    expect(response?.headers()["content-security-policy"]).toMatch(/connect-src 'self'(?:;|$)/);
    await expect
      .poll(() => sendo.requests.filter((request) => request.startsWith("GET /sync")).length)
      .toBeGreaterThanOrEqual(2);
    expect(peer).toBeDefined();

    sendo.deliver(feed.id, { title: "通知を受け取った記事" });
    const payload = Buffer.from('{"type":"sync_required"}');
    // WebSocket の短いテキストフレームを 1 件だけ送る。
    peer?.write(Buffer.concat([Buffer.from([0x81, payload.length]), payload]));
    await expect(page.getByText("通知を受け取った記事", { exact: true })).toBeVisible();
  } finally {
    peer?.destroy();
    await new Promise<void>((resolve) => https.close(() => resolve()));
  }
});
