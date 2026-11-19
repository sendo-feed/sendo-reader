import type { IncomingMessage } from "node:http";
import { request as httpRequest } from "node:http";
import { connect } from "node:net";
import type { Duplex } from "node:stream";
import { afterEach, beforeAll, describe, expect, test } from "vitest";
import type { Assets } from "../../server/static";
import type { UpgradeRelayOptions } from "../../server/websocket";
import {
  acceptWebSocket,
  closeFrame,
  type FakeSendo,
  fixtureAssets,
  INDEX_HTML,
  type RunningReader,
  startFakeSendo,
  startReader,
  textFrame,
} from "./helpers";

let assets: Assets;
beforeAll(async () => {
  assets = await fixtureAssets({ "index.html": INDEX_HTML });
});

const running: Array<FakeSendo | RunningReader> = [];
afterEach(async () => {
  await Promise.all(running.splice(0).map((server) => server.close()));
});

type Upgraded = { request: IncomingMessage; socket: Duplex; head: Buffer };

/** WebSocket を受ける偽の sendo と、reader を動かす */
async function start(
  onUpgrade: (request: IncomingMessage, socket: Duplex, head: Buffer) => void,
  relayOptions: UpgradeRelayOptions = {},
) {
  const sendo = await startFakeSendo((_request, response) => {
    response.writeHead(404);
    response.end();
  }, onUpgrade);
  const reader = await startReader(assets, sendo.origin, relayOptions);
  running.push(sendo, reader);
  return { sendo, reader };
}

/** ブラウザに見立てて、Upgrade のリクエストを送る */
function upgradeRequest(
  origin: string,
  path: string,
  headers: Record<string, string> = {},
): Promise<
  | {
      kind: "upgrade";
      status: number;
      headers: IncomingMessage["headers"];
      socket: Duplex;
      head: Buffer;
    }
  | { kind: "response"; status: number; headers: IncomingMessage["headers"]; body: string }
> {
  return new Promise((resolve, reject) => {
    const request = httpRequest(`${origin}${path}`, {
      headers: {
        connection: "Upgrade",
        upgrade: "websocket",
        "sec-websocket-version": "13",
        "sec-websocket-key": "dGhlIHNhbXBsZSBub25jZQ==",
        ...headers,
      },
    });
    request.on("upgrade", (response, socket, head) =>
      resolve({
        kind: "upgrade",
        status: response.statusCode ?? 0,
        headers: response.headers,
        socket,
        head,
      }),
    );
    request.on("response", (response) => {
      const chunks: Buffer[] = [];
      response.on("data", (chunk: Buffer) => chunks.push(chunk));
      response.on("end", () =>
        resolve({
          kind: "response",
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

/** socket から、少なくとも length バイト読む。first は、すでに受けていたバイト列 */
function read(socket: Duplex, length: number, first: Buffer = Buffer.alloc(0)): Promise<Buffer> {
  return new Promise((resolve) => {
    let buffer = first;
    if (buffer.length >= length) {
      resolve(buffer);
      return;
    }
    const onData = (chunk: Buffer) => {
      buffer = Buffer.concat([buffer, chunk]);
      if (buffer.length >= length) {
        socket.off("data", onData);
        resolve(buffer);
      }
    };
    socket.on("data", onData);
  });
}

describe("WebSocket の中継", () => {
  test("Origin、Cookie、Sec-WebSocket-* をそのまま渡し、101 のあとは両方向をそのまま流す", async () => {
    const upgraded: Upgraded[] = [];
    const { reader } = await start((request, socket, head) => {
      upgraded.push({ request, socket, head });
      acceptWebSocket(request, socket);
      socket.write(textFrame('{"type":"sync_required"}'));
    });
    const result = await upgradeRequest(reader.origin, "/api/v1/sync/updates?x=1", {
      origin: "https://reader.example",
      cookie: "__Host-sendo_session=s1",
      "sec-websocket-protocol": "chat",
    });
    if (result.kind !== "upgrade") throw new Error(`101 にならなかった：${result.status}`);
    expect(result.status).toBe(101);
    expect(result.headers["sec-websocket-accept"]).toBe("s3pPLMBiTxaQ9kYGzzhZRbK+xOo=");

    const [sendoSide] = upgraded;
    if (sendoSide === undefined) throw new Error("sendo に届かなかった");
    expect(sendoSide.request.url).toBe("/api/v1/sync/updates?x=1");
    expect(sendoSide.request.headers.origin).toBe("https://reader.example");
    expect(sendoSide.request.headers.cookie).toBe("__Host-sendo_session=s1");
    expect(sendoSide.request.headers["sec-websocket-key"]).toBe("dGhlIHNhbXBsZSBub25jZQ==");
    expect(sendoSide.request.headers["sec-websocket-protocol"]).toBe("chat");
    expect(sendoSide.request.headers.upgrade).toBe("websocket");
    expect(sendoSide.request.headers["x-forwarded-for"]).toBeUndefined();

    // sendo からのフレームは、そのまま届く
    const frame = textFrame('{"type":"sync_required"}');
    expect(await read(result.socket, frame.length, result.head)).toEqual(frame);
    // ブラウザからのバイト列も、そのまま sendo に届く
    const fromBrowser = Buffer.from([0x88, 0x82, 1, 2, 3, 4, 0x03 ^ 1, 0xe8 ^ 2]);
    const received = read(sendoSide.socket, fromBrowser.length);
    result.socket.write(fromBrowser);
    expect(await received).toEqual(fromBrowser);

    // sendo が閉じるフレームを送って閉じたら、そのフレームが届き、ブラウザの側も閉じられる
    const close = closeFrame(1008);
    const ended = new Promise<Buffer>((resolve) => {
      let buffer = Buffer.alloc(0);
      result.socket.on("data", (chunk: Buffer) => {
        buffer = Buffer.concat([buffer, chunk]);
      });
      result.socket.on("end", () => resolve(buffer));
    });
    sendoSide.socket.end(close);
    expect(await ended).toEqual(close);
  });

  test("ブラウザの WebSocket で、知らせと閉じるコードがそのまま届く", async () => {
    let sendoSocket: Duplex | undefined;
    const { reader } = await start((request, socket) => {
      sendoSocket = socket;
      acceptWebSocket(request, socket);
      socket.write(textFrame('{"type":"sync_required"}'));
    });
    const ws = new WebSocket(`${reader.origin.replace("http", "ws")}/api/v1/sync/updates`);
    const message = await new Promise<string>((resolve, reject) => {
      ws.onmessage = (event) => resolve(String(event.data));
      ws.onerror = () => reject(new Error("つながらなかった"));
    });
    expect(JSON.parse(message)).toEqual({ type: "sync_required" });
    const code = new Promise<number>((resolve) => {
      ws.onclose = (event) => resolve(event.code);
    });
    sendoSocket?.end(closeFrame(1001));
    expect(await code).toBe(1001);
  });

  test("101 にならなかった応答は、状態と本文をそのまま返す", async () => {
    const { reader } = await start((_request, socket) => {
      socket.end(
        'HTTP/1.1 401 Unauthorized\r\nContent-Type: application/json\r\nContent-Length: 27\r\n\r\n{"error":{"code":"denied"}}',
      );
    });
    const result = await upgradeRequest(reader.origin, "/api/v1/sync/updates");
    expect(result).toMatchObject({
      kind: "response",
      status: 401,
      body: '{"error":{"code":"denied"}}',
    });
  });

  test("sendo のパスでない Upgrade は断り、sendo に送らない", async () => {
    const upgraded: Upgraded[] = [];
    const { reader } = await start((request, socket, head) => {
      upgraded.push({ request, socket, head });
      acceptWebSocket(request, socket);
    });
    for (const path of ["/", "/settings", "/apis/sync/updates", "/oauth/authorize"]) {
      const result = await upgradeRequest(reader.origin, path);
      expect(result).toMatchObject({ kind: "response", status: 400 });
    }
    expect(upgraded).toEqual([]);
  });

  test("URL として読めない Upgrade は 400 で断り、reader は止まらない", async () => {
    const upgraded: Upgraded[] = [];
    const { reader } = await start((request, socket, head) => {
      upgraded.push({ request, socket, head });
      acceptWebSocket(request, socket);
    });
    const { port } = new URL(reader.origin);
    const response = await new Promise<string>((resolve, reject) => {
      const socket = connect(Number(port), "127.0.0.1", () => {
        socket.write(
          "GET //[/api/v1/sync/updates HTTP/1.1\r\nHost: reader.example\r\nConnection: Upgrade\r\nUpgrade: websocket\r\nSec-WebSocket-Version: 13\r\nSec-WebSocket-Key: dGhlIHNhbXBsZSBub25jZQ==\r\n\r\n",
        );
      });
      let text = "";
      socket.on("data", (chunk: Buffer) => {
        text += chunk.toString();
      });
      socket.on("end", () => resolve(text));
      socket.on("error", reject);
    });
    expect(response.startsWith("HTTP/1.1 400 ")).toBe(true);
    expect(upgraded).toEqual([]);
    // reader は動き続けている
    expect((await fetch(`${reader.origin}/`)).status).toBe(200);
  });

  test("sendo に届かなければ 502", async () => {
    const reader = await startReader(assets, "http://127.0.0.1:9");
    running.push(reader);
    const result = await upgradeRequest(reader.origin, "/api/v1/sync/updates");
    expect(result).toMatchObject({ kind: "response", status: 502 });
  });

  test("sendo が Upgrade に答えなければ、504 で断り、sendo への接続も切る", async () => {
    let sendoClosed: Promise<void> | undefined;
    const { reader } = await start(
      (_request, socket) => {
        // 何も返さない
        sendoClosed = new Promise((resolve) => socket.on("end", () => resolve()));
      },
      { handshakeTimeoutMs: 200 },
    );
    const result = await upgradeRequest(reader.origin, "/api/v1/sync/updates");
    expect(result).toMatchObject({ kind: "response", status: 504 });
    await sendoClosed;
  });

  test("断る応答の本文が終わらなければ、504 で断る", async () => {
    const { reader } = await start(
      (_request, socket) => {
        // ヘッダーだけ返して、本文を送り終えない
        socket.write("HTTP/1.1 401 Unauthorized\r\nContent-Length: 100\r\n\r\n{");
      },
      { handshakeTimeoutMs: 200 },
    );
    const result = await upgradeRequest(reader.origin, "/api/v1/sync/updates");
    expect(result).toMatchObject({ kind: "response", status: 504 });
  });

  test("つながったあとは、待つ上限を過ぎても切らない", async () => {
    let sendoSocket: Duplex | undefined;
    const { reader } = await start(
      (request, socket) => {
        sendoSocket = socket;
        acceptWebSocket(request, socket);
      },
      { handshakeTimeoutMs: 100 },
    );
    const result = await upgradeRequest(reader.origin, "/api/v1/sync/updates");
    if (result.kind !== "upgrade") throw new Error("101 にならなかった");
    await new Promise((resolve) => setTimeout(resolve, 300));
    const frame = textFrame('{"type":"sync_required"}');
    const received = read(result.socket, frame.length, result.head);
    sendoSocket?.write(frame);
    expect(await received).toEqual(frame);
  });

  test("reader を止めたら、中継している接続も切る", async () => {
    const { reader } = await start((request, socket) => acceptWebSocket(request, socket));
    const result = await upgradeRequest(reader.origin, "/api/v1/sync/updates");
    if (result.kind !== "upgrade") throw new Error("101 にならなかった");
    const closed = new Promise<void>((resolve) => result.socket.on("close", () => resolve()));
    await reader.close();
    running.splice(running.indexOf(reader), 1);
    await closed;
  });
});
