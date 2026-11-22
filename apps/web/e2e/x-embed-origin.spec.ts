import { type ChildProcess, spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { expect, type Page, test } from "@playwright/test";
import { FakeSendo, routeFakeSendo } from "./fake-sendo";

/**
 * X の投稿の隔離フレームのオリジン（docs/decisions/embeds.md の 3）を、本番のコンテナのサーバー
 * （dist-server/server.mjs。pnpm build で作る）で確かめる。設定を変えて起動し直すと、すでに
 * Service Worker が受け持っている画面にも、新しい版への切り替え（docs/decisions/ui.md の 5）で、
 * CSP の frame-src と <meta> が届く。
 *
 * 隔離フレームのオリジン（https://embed.test）への通信は、外へ出さずに context.route で返す
 */

const PORT = 4181;
const READER = `http://localhost:${PORT}/`;
const EMBED = "https://embed.test";
const SERVER = fileURLToPath(new URL("../dist-server/server.mjs", import.meta.url));
const DIST = fileURLToPath(new URL("../dist", import.meta.url));

type Running = { process: ChildProcess; output: () => string };

/** コンテナのサーバーを、本番と同じく環境変数で設定して動かす。受け始めるまで待つ */
async function startServer(env: Record<string, string>): Promise<Running> {
  const child = spawn(process.execPath, [SERVER], {
    env: {
      PATH: process.env.PATH ?? "",
      PORT: String(PORT),
      HOST: "127.0.0.1",
      DIST_DIR: DIST,
      // sendo の API は、テストの中の偽の sendo が答える（中継の先には届かない）
      SENDO_URL: "http://127.0.0.1:9",
      ...env,
    },
    stdio: ["ignore", "pipe", "pipe"],
  });
  let output = "";
  child.stdout?.on("data", (chunk: Buffer) => {
    output += chunk.toString();
  });
  child.stderr?.on("data", (chunk: Buffer) => {
    output += chunk.toString();
  });
  const running = { process: child, output: () => output };
  await expect.poll(() => output, { timeout: 10_000 }).toContain("sendo-reader is listening");
  return running;
}

async function stopServer(running: Running): Promise<void> {
  if (running.process.exitCode !== null) return;
  const exited = new Promise((resolve) => running.process.once("exit", resolve));
  running.process.kill("SIGTERM");
  await exited;
}

/** 隔離フレームのオリジンへの要求の数（CSP に止められると、要求そのものが出ない） */
let embedRequests = 0;

/**
 * 隔離フレームのオリジンの iframe を足し、CSP に止められずに中身が読み込まれたかを返す。
 * 止められたときは、要求が出ず、frame-src の違反が起きる
 */
async function framed(page: Page): Promise<boolean> {
  const before = embedRequests;
  const violated = await page.evaluate(
    (src) =>
      new Promise<boolean>((resolve) => {
        document.addEventListener("securitypolicyviolation", (event) => {
          if (event.blockedURI.startsWith(src)) resolve(true);
        });
        const frame = document.createElement("iframe");
        frame.addEventListener("load", () => setTimeout(() => resolve(false), 300));
        frame.src = `${src}/`;
        document.body.append(frame);
      }),
    EMBED,
  );
  return !violated && embedRequests > before;
}

function metaOrigin(page: Page): Promise<string | null> {
  return page.evaluate(
    () =>
      document.querySelector('meta[name="sendo-x-embed-origin"]')?.getAttribute("content") ?? null,
  );
}

/** 画面を前に出したことにする（新しい版を確かめ、替わっていれば読み込み直すきっかけ） */
function bringToFront(page: Page): Promise<void> {
  return page.evaluate(() => {
    document.dispatchEvent(new Event("visibilitychange"));
  });
}

test.describe("隔離フレームのオリジンの設定", () => {
  let running: Running | null = null;
  test.afterEach(async () => {
    if (running) await stopServer(running);
    running = null;
  });

  test.beforeEach(async ({ context }) => {
    await routeFakeSendo(context, new FakeSendo());
    // 隔離フレームのオリジンの中身（このサブ Issue では、まだページを配らない）
    await context.route(`${EMBED}/**`, (route) => {
      embedRequests += 1;
      return route.fulfill({
        contentType: "text/html",
        body: "<!doctype html><title>embed</title><p>embed</p>",
      });
    });
  });

  test("設定なしから設定ありに替えると、Service Worker が受け持つ画面にも frame-src と <meta> が届く", async ({
    page,
  }) => {
    running = await startServer({});
    await page.goto(READER);
    await page.evaluate(() => navigator.serviceWorker.ready);
    await page.reload();
    await expect
      .poll(() => page.evaluate(() => navigator.serviceWorker.controller !== null))
      .toBe(true);
    expect(await metaOrigin(page)).toBeNull();
    expect(await framed(page)).toBe(false);

    // 同じ dist で、設定ありのサーバーに替える
    await stopServer(running);
    running = await startServer({ X_EMBED_ORIGIN: EMBED });
    await page.reload();
    // 読み込み直しても、Service Worker が前の版の index.html を返すので、まだ届いていない
    expect(await metaOrigin(page)).toBeNull();

    // 前に出すと、新しい版を確かめて取り込み、もう一度前に出たときに読み込み直す
    await expect
      .poll(
        async () => {
          await bringToFront(page).catch(() => {});
          return await metaOrigin(page).catch(() => null);
        },
        { timeout: 15_000 },
      )
      .toBe(EMBED);
    expect(await framed(page)).toBe(true);

    // サーバーを止めて読み込み直すと、Service Worker が取り直した index.html を返す。
    // その応答の CSP（取り直したときのヘッダー）が効いている
    await stopServer(running);
    running = null;
    await page.reload();
    expect(await page.evaluate(() => navigator.serviceWorker.controller !== null)).toBe(true);
    expect(await metaOrigin(page)).toBe(EMBED);
    expect(await framed(page)).toBe(true);
  });

  test("設定ありから設定なしに替えると、同じ時点で frame-src と <meta> が消える", async ({
    page,
  }) => {
    running = await startServer({ X_EMBED_ORIGIN: EMBED });
    await page.goto(READER);
    await page.evaluate(() => navigator.serviceWorker.ready);
    await page.reload();
    await expect
      .poll(() => page.evaluate(() => navigator.serviceWorker.controller !== null))
      .toBe(true);
    expect(await metaOrigin(page)).toBe(EMBED);
    expect(await framed(page)).toBe(true);

    await stopServer(running);
    running = await startServer({});
    await expect
      .poll(
        async () => {
          await bringToFront(page).catch(() => {});
          return await metaOrigin(page).catch(() => "pending");
        },
        { timeout: 15_000 },
      )
      .toBeNull();
    expect(await framed(page)).toBe(false);

    await stopServer(running);
    running = null;
    await page.reload();
    expect(await metaOrigin(page)).toBeNull();
    expect(await framed(page)).toBe(false);
  });
});

test("コンテナは、形の合わない X_EMBED_ORIGIN では、理由を出して起動しない", async () => {
  for (const value of ["http://localhost:5174", "https://embed.test/x", "https://*.test"]) {
    const child = spawn(process.execPath, [SERVER], {
      env: {
        PATH: process.env.PATH ?? "",
        PORT: String(PORT),
        DIST_DIR: DIST,
        X_EMBED_ORIGIN: value,
      },
      stdio: ["ignore", "pipe", "pipe"],
    });
    let output = "";
    child.stdout?.on("data", (chunk: Buffer) => {
      output += chunk.toString();
    });
    child.stderr?.on("data", (chunk: Buffer) => {
      output += chunk.toString();
    });
    const code = await new Promise<number | null>((resolve) => child.once("exit", resolve));
    expect(code, value).toBe(1);
    expect(output, value).toContain("X_EMBED_ORIGIN");
    expect(output, value).not.toContain("sendo-reader is listening");
  }
});
