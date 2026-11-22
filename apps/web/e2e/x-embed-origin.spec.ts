import { type ChildProcess, spawn } from "node:child_process";
import { readFileSync } from "node:fs";
import { copyFile, mkdtemp, rm } from "node:fs/promises";
import { request as httpRequest } from "node:http";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { expect, type Page, test } from "@playwright/test";
import { xEmbedPageHeaders } from "../security-headers";
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

function spawnServer(env: Record<string, string>, server = SERVER): Running {
  const child = spawn(process.execPath, [server], {
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
  const collect = (chunk: Buffer) => {
    output += chunk.toString();
  };
  child.stdout?.on("data", collect);
  child.stderr?.on("data", collect);
  return { process: child, output: () => output };
}

/** コンテナのサーバーを、本番と同じく環境変数で設定して動かす。受け始めるまで待つ */
async function startServer(env: Record<string, string>, server = SERVER): Promise<Running> {
  const running = spawnServer(env, server);
  try {
    await expect
      .poll(
        () => {
          // 起動に失敗したら（ポートが埋まっている、など）、待たずに落とす
          if (running.process.exitCode !== null) {
            throw new Error(`server exited:\n${running.output()}`);
          }
          return running.output();
        },
        { timeout: 20_000 },
      )
      .toContain("sendo-reader is listening");
  } catch (error) {
    running.process.kill("SIGKILL");
    throw error;
  }
  return running;
}

async function stopServer(running: Running): Promise<void> {
  if (running.process.exitCode !== null || running.process.signalCode !== null) return;
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

/** reader を開き、Service Worker が受け持つまで待つ */
async function openControlled(page: Page): Promise<void> {
  await page.goto(READER);
  await page.evaluate(() => navigator.serviceWorker.ready);
  await expect
    .poll(() => page.evaluate(() => navigator.serviceWorker.controller !== null))
    .toBe(true);
}

/**
 * 前に出して新しい版を確かめさせ、新しい Service Worker に替わるのを待ってから、もう一度前に出して
 * 読み込み直させる（docs/decisions/ui.md の 5）
 */
async function switchToNewVersion(page: Page): Promise<void> {
  await page.evaluate(() => {
    Object.assign(window, { controllerChanged: false });
    navigator.serviceWorker.addEventListener("controllerchange", () => {
      Object.assign(window, { controllerChanged: true });
    });
  });
  await bringToFront(page);
  await expect
    .poll(
      () =>
        page.evaluate(
          () => (window as unknown as { controllerChanged: boolean }).controllerChanged,
        ),
      { timeout: 15_000 },
    )
    .toBe(true);
  await Promise.all([page.waitForEvent("load"), bringToFront(page)]);
}

let running: Running | null = null;

test.beforeEach(async ({ context }) => {
  embedRequests = 0;
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

test.afterEach(async () => {
  if (running) await stopServer(running);
  running = null;
});

test("設定なしから設定ありに替えると、Service Worker が受け持つ画面にも frame-src と <meta> が届く", async ({
  page,
}) => {
  running = await startServer({});
  await openControlled(page);
  expect(await metaOrigin(page)).toBeNull();
  expect(await framed(page)).toBe(false);

  // 同じ dist で、設定ありのサーバーに替える
  await stopServer(running);
  running = await startServer({ X_EMBED_ORIGIN: EMBED });
  await switchToNewVersion(page);
  expect(await metaOrigin(page)).toBe(EMBED);
  expect(await framed(page)).toBe(true);

  // サーバーを止めて読み込み直すと、Service Worker が、取り直した index.html を返す。
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
  await openControlled(page);
  expect(await metaOrigin(page)).toBe(EMBED);
  expect(await framed(page)).toBe(true);

  await stopServer(running);
  running = await startServer({});
  await switchToNewVersion(page);
  expect(await metaOrigin(page)).toBeNull();
  expect(await framed(page)).toBe(false);

  await stopServer(running);
  running = null;
  await page.reload();
  expect(await metaOrigin(page)).toBeNull();
  expect(await framed(page)).toBe(false);
});

/** コンテナのサーバーに、Host を決めて送る */
function send(host: string, path: string): Promise<{ status: number; csp: string; body: string }> {
  return new Promise((resolve, reject) => {
    const request = httpRequest(`http://127.0.0.1:${PORT}${path}`, {
      setHost: false,
      headers: { host },
    });
    request.on("response", (response) => {
      const chunks: Buffer[] = [];
      response.on("data", (chunk: Buffer) => chunks.push(chunk));
      response.on("end", () =>
        resolve({
          status: response.statusCode ?? 0,
          csp: String(response.headers["content-security-policy"] ?? ""),
          body: Buffer.concat(chunks).toString(),
        }),
      );
    });
    request.on("error", reject);
    request.end();
  });
}

test("コンテナは、バンドルに取り込んだ隔離フレームのページを、隔離フレームのホスト名でだけ返す", async () => {
  // バンドルだけを別の場所に写して動かす（隣に x-embed/ がなくても返すこと＝バンドルから返していること）
  const directory = await mkdtemp(path.join(tmpdir(), "sendo-reader-server-"));
  await copyFile(SERVER, path.join(directory, "server.mjs"));
  running = await startServer({ X_EMBED_ORIGIN: EMBED }, path.join(directory, "server.mjs"));
  const html = readFileSync(
    fileURLToPath(new URL("../x-embed/index.html", import.meta.url)),
    "utf8",
  );
  const script = readFileSync(
    fileURLToPath(new URL("../x-embed/embed.js", import.meta.url)),
    "utf8",
  );
  for (const path of ["/", "/?from=reader"]) {
    const page = await send("embed.test", path);
    expect(page.status, path).toBe(200);
    expect(page.body, path).toBe(html);
    expect(page.csp).toBe(xEmbedPageHeaders()["Content-Security-Policy"]);
  }
  const embed = await send("embed.test", "/embed.js?v=1");
  expect(embed.status).toBe(200);
  expect(embed.body).toBe(script);
  // reader のホスト名では返さない
  expect((await send(`localhost:${PORT}`, "/embed.js")).body).not.toBe(script);
  await stopServer(running);
  running = null;
  await rm(directory, { recursive: true, force: true });
});

test("コンテナは、形の合わない X_EMBED_ORIGIN では、理由を出して起動しない", async () => {
  for (const value of ["http://localhost:5174", "https://embed.test/x", "https://*.test"]) {
    const server = spawnServer({ X_EMBED_ORIGIN: value });
    const code = await new Promise<number | null>((resolve) =>
      server.process.once("exit", resolve),
    );
    expect(code, value).toBe(1);
    expect(server.output(), value).toContain("X_EMBED_ORIGIN");
    expect(server.output(), value).not.toContain("sendo-reader is listening");
  }
});
