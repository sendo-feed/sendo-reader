import { createHash } from "node:crypto";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import path from "node:path";
import type { Duplex } from "node:stream";
import { serve } from "@hono/node-server";
import { createReaderServer } from "../../server/app";
import { loadAssets } from "../../server/assets";
import type { Assets } from "../../server/static";
import { createUpgradeRelay, type UpgradeRelayOptions } from "../../server/websocket";

/** 画面のビルドに見立てたファイルを置き、読み込む */
export async function fixtureAssets(files: Record<string, string | Uint8Array>): Promise<Assets> {
  const directory = await mkdtemp(path.join(tmpdir(), "sendo-reader-dist-"));
  try {
    for (const [name, content] of Object.entries(files)) {
      const file = path.join(directory, name);
      await mkdir(path.dirname(file), { recursive: true });
      await writeFile(file, content);
    }
    return await loadAssets(directory);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}

/** 偽の sendo が受けたリクエスト */
export type ReceivedRequest = {
  method: string;
  url: string;
  headers: IncomingMessage["headers"];
  rawHeaders: string[];
  body: Buffer;
};

export type FakeSendo = {
  origin: string;
  received: ReceivedRequest[];
  close: () => Promise<void>;
};

/** 本物の HTTP で答える偽の sendo。答え方は handler で決める。onUpgrade は WebSocket の Upgrade */
export async function startFakeSendo(
  handler: (request: ReceivedRequest, response: ServerResponse) => void | Promise<void>,
  onUpgrade?: (request: IncomingMessage, socket: Duplex, head: Buffer) => void,
): Promise<FakeSendo> {
  const received: ReceivedRequest[] = [];
  const server = createServer(async (req, res) => {
    const chunks: Buffer[] = [];
    for await (const chunk of req) chunks.push(chunk as Buffer);
    const request: ReceivedRequest = {
      method: req.method ?? "",
      url: req.url ?? "",
      headers: req.headers,
      rawHeaders: req.rawHeaders,
      body: Buffer.concat(chunks),
    };
    received.push(request);
    await handler(request, res);
  });
  const upgraded = new Set<Duplex>();
  if (onUpgrade !== undefined) {
    server.on("upgrade", (request: IncomingMessage, socket: Duplex, head: Buffer) => {
      upgraded.add(socket);
      socket.on("error", () => socket.destroy());
      onUpgrade(request, socket, head);
    });
  }
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address() as AddressInfo;
  return {
    origin: `http://127.0.0.1:${port}`,
    received,
    close: () =>
      new Promise((resolve) => {
        for (const socket of upgraded) socket.destroy();
        server.closeAllConnections();
        server.close(() => resolve());
      }),
  };
}

/** WebSocket のハンドシェイクを受け、101 を返す（偽の sendo の側） */
export function acceptWebSocket(request: IncomingMessage, socket: Duplex): void {
  const accept = createHash("sha1")
    .update(`${request.headers["sec-websocket-key"]}258EAFA5-E914-47DA-95CA-C5AB0DC85B11`)
    .digest("base64");
  socket.write(
    `HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Accept: ${accept}\r\n\r\n`,
  );
}

/** サーバーから送る、マスクしない短いテキストのフレーム */
export function textFrame(text: string): Buffer {
  const payload = Buffer.from(text);
  if (payload.length >= 126) throw new Error("短いフレームだけを作る");
  return Buffer.concat([Buffer.from([0x81, payload.length]), payload]);
}

/** サーバーから送る、閉じるフレーム */
export function closeFrame(code: number): Buffer {
  return Buffer.from([0x88, 2, code >> 8, code & 0xff]);
}

export type RunningReader = { origin: string; close: () => Promise<void> };

/** reader のサーバーを、本番と同じく @hono/node-server で動かす */
export async function startReader(
  assets: Assets,
  sendoOrigin: string,
  relayOptions: UpgradeRelayOptions = {},
): Promise<RunningReader> {
  const app = createReaderServer({ assets, sendoOrigin });
  const { server, port } = await new Promise<{ server: ReturnType<typeof serve>; port: number }>(
    (resolve) => {
      const started = serve({ fetch: app.fetch, port: 0, hostname: "127.0.0.1" }, (info) =>
        resolve({ server: started, port: info.port }),
      );
    },
  );
  const relay = createUpgradeRelay(sendoOrigin, relayOptions);
  server.on("upgrade", relay.handle);
  return {
    origin: `http://127.0.0.1:${port}`,
    close: () =>
      new Promise((resolve) => {
        relay.closeAll();
        if ("closeAllConnections" in server) server.closeAllConnections();
        server.close(() => resolve());
      }),
  };
}

export const INDEX_HTML = "<!doctype html><title>Sendo</title>";
