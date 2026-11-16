import { request as httpRequest } from "node:http";
import { gzipSync } from "node:zlib";
import { afterEach, beforeAll, describe, expect, test } from "vitest";
import type { Assets } from "../../server/static";
import {
  type FakeSendo,
  fixtureAssets,
  INDEX_HTML,
  type RunningReader,
  startFakeSendo,
  startReader,
} from "./helpers";

let assets: Assets;
beforeAll(async () => {
  assets = await fixtureAssets({ "index.html": INDEX_HTML });
});

const running: Array<FakeSendo | RunningReader> = [];
afterEach(async () => {
  await Promise.all(running.splice(0).map((server) => server.close()));
});

async function start(handler: Parameters<typeof startFakeSendo>[0]) {
  const sendo = await startFakeSendo(handler);
  const reader = await startReader(assets, sendo.origin);
  running.push(sendo, reader);
  return { sendo, reader };
}

const ok = (_request: unknown, response: import("node:http").ServerResponse) => {
  response.writeHead(200, { "content-type": "application/json" });
  response.end('{"ok":true}');
};

describe("sendo への中継", () => {
  test("メソッド、パス、クエリ、本文、ヘッダーをそのまま渡す", async () => {
    const { sendo, reader } = await start(ok);
    const body = JSON.stringify({ url: "https://example.com/feed" });
    const response = await fetch(`${reader.origin}/api/v1/feeds?x=1&y=%2F`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        cookie: "__Host-sendo_session=abc",
        origin: "https://reader.example.com",
        "sec-fetch-site": "same-origin",
        authorization: "Bearer sendo_token",
        "x-custom": "kept",
      },
      body,
    });
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ ok: true });

    const [received] = sendo.received;
    expect(received?.method).toBe("POST");
    expect(received?.url).toBe("/api/v1/feeds?x=1&y=%2F");
    expect(received?.body.toString()).toBe(body);
    expect(received?.headers).toMatchObject({
      "content-type": "application/json",
      cookie: "__Host-sendo_session=abc",
      origin: "https://reader.example.com",
      "sec-fetch-site": "same-origin",
      authorization: "Bearer sendo_token",
      "x-custom": "kept",
    });
  });

  test("X-Forwarded-* を足さず、接続だけのヘッダーは渡さない", async () => {
    const { sendo, reader } = await start(ok);
    // fetch は Connection を送らせないので、node:http で送る
    await new Promise<void>((resolve, reject) => {
      const req = httpRequest(
        `${reader.origin}/mcp`,
        {
          method: "POST",
          headers: { connection: "keep-alive, x-hop", "x-hop": "dropped", te: "trailers" },
        },
        (res) => res.resume().on("end", resolve),
      );
      req.on("error", reject);
      req.end("{}");
    });
    const headers = sendo.received[0]?.headers ?? {};
    expect(Object.keys(headers).filter((name) => name.startsWith("x-forwarded-"))).toEqual([]);
    expect(headers["x-hop"]).toBeUndefined();
    expect(headers.te).toBeUndefined();
    // Host は中継の先のもの。sendo は URL のオリジンを PUBLIC_URL に置き換える
    expect(headers.host).toBe(new URL(sendo.origin).host);
    expect(headers["accept-encoding"]).toBe("identity");
  });

  test.each([
    ["GET", "/.well-known/oauth-authorization-server"],
    ["GET", "/.well-known/oauth-protected-resource/mcp"],
    ["POST", "/oauth/token"],
    ["POST", "/oauth/register"],
    ["POST", "/accounts/ClientLogin"],
    ["GET", "/reader/api/0/user-info"],
    ["GET", "/healthz"],
  ])("%s %s は sendo に届く", async (method, path) => {
    const { sendo, reader } = await start(ok);
    const response = await fetch(`${reader.origin}${path}`, {
      method,
      ...(method === "POST" ? { body: "a=1" } : {}),
    });
    expect(response.status).toBe(200);
    expect(sendo.received.map((request) => request.url)).toEqual([path]);
  });

  test("画面のパスは sendo に届かない（/oauth/authorize は画面）", async () => {
    const { sendo, reader } = await start(ok);
    for (const path of ["/", "/oauth/authorize?client_id=x", "/settings"]) {
      const response = await fetch(`${reader.origin}${path}`);
      expect(await response.text()).toBe(INDEX_HTML);
    }
    expect(sendo.received).toEqual([]);
  });

  test("複数の Set-Cookie をそのまま返す", async () => {
    const { reader } = await start((_request, response) => {
      response.writeHead(204, [
        ["set-cookie", "__Host-sendo_login=; Path=/; Max-Age=0; Secure; HttpOnly"],
        ["set-cookie", "__Host-sendo_session=abc; Path=/; Secure; HttpOnly; SameSite=Lax"],
      ]);
      response.end();
    });
    const response = await fetch(`${reader.origin}/api/v1/auth/logout`, { method: "POST" });
    expect(response.status).toBe(204);
    expect(response.headers.getSetCookie()).toEqual([
      "__Host-sendo_login=; Path=/; Max-Age=0; Secure; HttpOnly",
      "__Host-sendo_session=abc; Path=/; Secure; HttpOnly; SameSite=Lax",
    ]);
  });

  test("リダイレクトは追わずに返す", async () => {
    const { sendo, reader } = await start((_request, response) => {
      response.writeHead(302, { location: "https://accounts.google.com/o/oauth2/v2/auth?x=1" });
      response.end();
    });
    const response = await fetch(`${reader.origin}/api/v1/auth/google/login?returnTo=%2F`, {
      redirect: "manual",
    });
    expect(response.status).toBe(302);
    expect(response.headers.get("location")).toBe(
      "https://accounts.google.com/o/oauth2/v2/auth?x=1",
    );
    expect(sendo.received).toHaveLength(1);
  });

  test("応答の本文を溜めずに流す", async () => {
    let finish = () => {};
    const finished = new Promise<void>((resolve) => {
      finish = resolve;
    });
    const { reader } = await start(async (_request, response) => {
      response.writeHead(200, { "content-type": "text/event-stream" });
      response.write("data: first\n\n");
      await finished;
      response.end("data: last\n\n");
    });
    const response = await fetch(`${reader.origin}/mcp`, { method: "POST", body: "{}" });
    const reader_ = response.body?.getReader();
    const first = await reader_?.read();
    // sendo がまだ終えていないうちに、最初の部分が届く
    expect(new TextDecoder().decode(first?.value)).toBe("data: first\n\n");
    finish();
    let rest = "";
    for (;;) {
      const chunk = await reader_?.read();
      if (!chunk || chunk.done) break;
      rest += new TextDecoder().decode(chunk.value);
    }
    expect(rest).toBe("data: last\n\n");
  });

  test("大きな本文も、そのまま渡す", async () => {
    const { sendo, reader } = await start(ok);
    const body = new Uint8Array(2 * 1024 * 1024).map((_, i) => i % 251);
    await fetch(`${reader.origin}/api/v1/opml`, {
      method: "POST",
      headers: { "content-type": "text/x-opml" },
      body,
    });
    expect(Buffer.compare(sendo.received[0]?.body ?? Buffer.alloc(0), Buffer.from(body))).toBe(0);
  });

  test("圧縮しないよう頼んでも圧縮して返されたら、戻した本文に合うヘッダーにする", async () => {
    const { reader } = await start((_request, response) => {
      const body = gzipSync('{"ok":true}');
      response.writeHead(200, {
        "content-type": "application/json",
        "content-encoding": "gzip",
        "content-length": String(body.byteLength),
      });
      response.end(body);
    });
    const response = await fetch(`${reader.origin}/api/v1/me`);
    expect(response.headers.get("content-encoding")).toBeNull();
    expect(await response.json()).toEqual({ ok: true });
  });

  test("sendo に届かなければ 502 を、sendo のエラーの形で返す", async () => {
    const sendo = await startFakeSendo(ok);
    await sendo.close();
    const reader = await startReader(assets, sendo.origin);
    running.push(reader);
    const response = await fetch(`${reader.origin}/api/v1/me`);
    expect(response.status).toBe(502);
    expect(await response.json()).toEqual({
      error: { code: "bad_gateway", message: "could not reach sendo" },
    });
  });
});
