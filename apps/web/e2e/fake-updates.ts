import { createHash } from "node:crypto";
import { createServer, type IncomingMessage } from "node:http";
import type { Duplex } from "node:stream";

/**
 * 偽の sendo の通知（WebSocket の /api/v1/sync/updates）。画面のワーカーは vite preview の中継
 * （SENDO_DEV_URL）を通って、ここにつなぐ。HTTP の /api は、これまでどおり Playwright が偽の sendo
 * に答えさせる（fake-sendo.ts）
 */
export const FAKE_UPDATES_PORT = 8798;

export type UpdatesConnection = {
  request: IncomingMessage;
  /** sendo からの知らせを送る */
  send(text: string): void;
  /** sendo の側から閉じる */
  close(code: number): void;
  /** ブラウザが閉じるフレームを送ってきたら、そのコード */
  closedByBrowser: Promise<number>;
};

export type FakeUpdates = {
  connections: UpdatesConnection[];
  stop(): Promise<void>;
};

const GUID = "258EAFA5-E914-47DA-95CA-C5AB0DC85B11";

function frame(opcode: number, payload: Buffer): Buffer {
  if (payload.length >= 126) throw new Error("短いフレームだけを送る");
  return Buffer.concat([Buffer.from([0x80 | opcode, payload.length]), payload]);
}

export async function startFakeUpdates(): Promise<FakeUpdates> {
  const connections: UpdatesConnection[] = [];
  const sockets = new Set<Duplex>();
  const server = createServer((_request, response) => {
    response.writeHead(404);
    response.end();
  });
  server.on("upgrade", (request: IncomingMessage, socket: Duplex) => {
    sockets.add(socket);
    socket.on("error", () => socket.destroy());
    socket.on("close", () => sockets.delete(socket));
    if (!request.url?.startsWith("/api/v1/sync/updates")) {
      socket.end("HTTP/1.1 404 Not Found\r\nContent-Length: 0\r\n\r\n");
      return;
    }
    const accept = createHash("sha1")
      .update(`${request.headers["sec-websocket-key"]}${GUID}`)
      .digest("base64");
    socket.write(
      `HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Accept: ${accept}\r\n\r\n`,
    );
    // ブラウザから届くのは、閉じるフレームと pong だけ。閉じるフレームなら、コードを覚えて閉じる
    // （ブラウザのフレームはマスクしてある。長さ 2 の本文の前に、4 バイトの鍵が付く）
    const closedByBrowser = new Promise<number>((resolve) => {
      socket.on("data", (chunk: Buffer) => {
        if (((chunk[0] ?? 0) & 0x0f) !== 0x8) return;
        const mask = chunk.subarray(2, 6);
        const body = chunk.subarray(6, 8).map((byte, i) => byte ^ (mask[i] ?? 0));
        resolve(body.length === 2 ? ((body[0] ?? 0) << 8) | (body[1] ?? 0) : 1005);
        socket.end(frame(0x8, Buffer.from(body)));
      });
    });
    connections.push({
      request,
      closedByBrowser,
      send: (text) => socket.write(frame(0x1, Buffer.from(text))),
      close: (code) => socket.end(frame(0x8, Buffer.from([code >> 8, code & 0xff]))),
    });
  });
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(FAKE_UPDATES_PORT, "127.0.0.1", resolve);
  });
  return {
    connections,
    stop: () =>
      new Promise((resolve) => {
        for (const socket of sockets) socket.destroy();
        server.close(() => resolve());
      }),
  };
}
