import { once } from "node:events";
import { createServer, IncomingMessage, request, ServerResponse } from "node:http";
import { createConnection, Socket } from "node:net";
import type { Duplex } from "node:stream";
import { afterEach, expect, test } from "vitest";
import { SYNC_UPDATES_PATH } from "../../sendo-paths";
import { createSyncUpdatesProxy } from "../../server/sync-updates";

const stops: Array<() => Promise<void>> = [];

afterEach(async () => {
  for (const stop of stops.splice(0).reverse()) await stop();
});

async function listen(server: ReturnType<typeof createServer>): Promise<string> {
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("missing address");
  stops.push(() => new Promise<void>((resolve) => server.close(() => resolve())));
  return `http://127.0.0.1:${address.port}`;
}

const headers = {
  connection: "Upgrade",
  upgrade: "websocket",
  origin: "https://reader.example",
  cookie: "__Host-sendo_session=example",
  "sec-websocket-key": "dGhlIHNhbXBsZSBub25jZQ==",
  "sec-websocket-protocol": "sendo-sync.dXNlci0x",
  "sec-websocket-version": "13",
  "sec-fetch-mode": "websocket",
  "x-forwarded-host": "ignored.example",
};

function mockSendo(userId = "user-1") {
  return createServer((req, res) => {
    expect(req.url).toBe("/api/v1/me");
    expect(req.headers.cookie).toBe(headers.cookie);
    expect(req.headers.authorization).toBeUndefined();
    res.setHeader("content-type", "application/json");
    res.end(JSON.stringify({ user: { id: userId } }));
  });
}

async function startReader(sendoOrigin: string, preserveHost = false) {
  const proxy = createSyncUpdatesProxy(sendoOrigin, { preserveHost });
  const server = createServer({ shouldUpgradeCallback: proxy.shouldUpgrade }, (_req, res) =>
    res.end("ordinary HTTP"),
  );
  server.prependListener("request", proxy.trackRequest);
  server.on("upgrade", proxy.handle);
  const url = await listen(server);
  stops.push(async () => proxy.stop());
  return { url, proxy };
}

function connect(url: string): Promise<{ response: IncomingMessage; socket?: Duplex }> {
  return new Promise((resolve, reject) => {
    const outgoing = request(url, { headers });
    outgoing.on("error", reject);
    outgoing.on("upgrade", (response, socket) => {
      stops.push(async () => {
        socket.destroy();
      });
      resolve({ response, socket });
    });
    outgoing.on("response", (response) => {
      response.resume();
      response.on("end", () => resolve({ response }));
      response.on("error", reject);
    });
    outgoing.end();
  });
}

test.each([false, true])(
  "通知先だけで 101 と双方向のデータを中継する（Host を保つ: %s）",
  async (preserveHost) => {
    const sendo = mockSendo();
    const received = new Promise<IncomingMessage>((resolve) => {
      sendo.on("upgrade", (incoming, socket) => {
        resolve(incoming);
        socket.write(
          "HTTP/1.1 101 Switching Protocols\r\nConnection: Upgrade, X-Hop\r\nUpgrade: websocket\r\nSec-WebSocket-Accept: test\r\nSet-Cookie: first=1\r\nSet-Cookie: second=2\r\nX-Label: café\r\nX-Hop: upstream-only\r\n\r\n",
          "latin1",
        );
        socket.on("data", (data) => socket.write(data));
        stops.push(async () => {
          socket.destroy();
        });
      });
    });
    const sendoOrigin = await listen(sendo);
    const { url, proxy } = await startReader(sendoOrigin, preserveHost);

    const { response, socket } = await connect(`${url}${SYNC_UPDATES_PATH}?x=%2F`);
    expect(response.statusCode).toBe(101);
    expect(response.headers["sec-websocket-accept"]).toBe("test");
    expect(response.headers["sec-websocket-protocol"]).toBe(headers["sec-websocket-protocol"]);
    expect(response.headers["set-cookie"]).toEqual(["first=1", "second=2"]);
    expect(response.headers["x-label"]).toBe("café");
    expect(response.headers["x-hop"]).toBeUndefined();
    const forwarded = await received;
    expect(forwarded.url).toBe(`${SYNC_UPDATES_PATH}?x=%2F`);
    expect(forwarded.headers).toMatchObject({
      origin: headers.origin,
      cookie: headers.cookie,
      "sec-websocket-key": headers["sec-websocket-key"],
      "sec-fetch-mode": "websocket",
    });
    expect(forwarded.headers["x-forwarded-host"]).toBeUndefined();
    expect(forwarded.headers["sec-websocket-protocol"]).toBeUndefined();
    expect(forwarded.headers.host).toBe(new URL(preserveHost ? url : sendoOrigin).host);

    if (!socket) throw new Error("missing connection");
    const data = once(socket, "data");
    socket.write("socket data");
    expect(String((await data)[0])).toBe("socket data");
    const closed = once(socket, "close");
    proxy.stop();
    await closed;

    expect((await connect(`${url}/api/v1/other`)).response.statusCode).toBe(200);
  },
);

test("同期したユーザーと Upgrade のクッキーの持ち主が違えば中継しない", async () => {
  const sendo = mockSendo("user-2");
  let upgrades = 0;
  sendo.on("upgrade", (_request, socket) => {
    upgrades += 1;
    socket.destroy();
  });
  const { url } = await startReader(await listen(sendo));
  const result = await connect(`${url}${SYNC_UPDATES_PATH}`);
  expect(result.response.statusCode).toBe(403);
  expect(upgrades).toBe(0);
});

test("ソケットに通常の HTTP 応答が残っている間は Upgrade しない", () => {
  const proxy = createSyncUpdatesProxy("http://127.0.0.1");
  const socket = new Socket();
  const http = new IncomingMessage(socket);
  const first = new ServerResponse(http);
  const second = new ServerResponse(http);
  proxy.trackRequest(http, first);
  proxy.trackRequest(http, second);
  const upgrade = new IncomingMessage(socket);
  upgrade.url = SYNC_UPDATES_PATH;
  upgrade.method = "GET";
  upgrade.headers.upgrade = "websocket";
  expect(proxy.shouldUpgrade(upgrade)).toBe(false);
  first.emit("finish");
  expect(proxy.shouldUpgrade(upgrade)).toBe(false);
  second.emit("finish");
  expect(proxy.shouldUpgrade(upgrade)).toBe(true);
});

test("Sendo のハンドシェイク拒否は HTTP の状態コードで返す", async () => {
  const sendo = mockSendo();
  const body = Buffer.alloc(256 * 1024, "x");
  const upstream = new Promise<Duplex>((resolve) => {
    sendo.on("upgrade", (_incoming, socket) => {
      stops.push(async () => {
        socket.destroy();
      });
      socket.write(
        `HTTP/1.1 400 Bad Request\r\nConnection: close, x-session\r\nX-Session: ignored\r\nSec-WebSocket-Version: 13\r\nContent-Type: text/plain\r\nContent-Length: ${body.length}\r\n\r\n`,
      );
      resolve(socket);
    });
  });
  const { url } = await startReader(await listen(sendo));
  const response = await new Promise<IncomingMessage>((resolve, reject) => {
    const outgoing = request(`${url}${SYNC_UPDATES_PATH}`, { headers }, resolve);
    outgoing.on("error", reject);
    outgoing.end();
  });
  expect(response.statusCode).toBe(400);
  expect(response.headers["sec-websocket-version"]).toBe("13");
  expect(response.headers["x-session"]).toBeUndefined();

  // 本文を待つ間にも拒否のヘッダーが届いている。本文が届いたら最後まで流す。
  (await upstream).end(body);
  const chunks: Buffer[] = [];
  for await (const chunk of response) chunks.push(chunk);
  expect(Buffer.concat(chunks).equals(body)).toBe(true);
});

test("Sendo の応答を待つ間も、下流が送信を終えたら上流を切断する", async () => {
  const sendo = mockSendo();
  const incoming = new Promise<Duplex>((resolve) => {
    sendo.on("upgrade", (_incoming, socket) => {
      stops.push(async () => {
        socket.destroy();
      });
      socket.resume();
      resolve(socket);
    });
  });
  const { url } = await startReader(await listen(sendo));
  const address = new URL(url);
  const client = createConnection({ host: address.hostname, port: Number(address.port) });
  stops.push(async () => {
    client.destroy();
  });
  await once(client, "connect");
  const fields = Object.entries(headers).map(([name, value]) => `${name}: ${value}`);
  client.write(
    `GET ${SYNC_UPDATES_PATH} HTTP/1.1\r\nHost: ${address.host}\r\n${fields.join("\r\n")}\r\n\r\n`,
  );
  const upstream = await incoming;
  const ended = once(upstream, "end");
  client.end();
  await ended;
});
