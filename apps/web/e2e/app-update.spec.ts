import { type ChildProcess, spawn } from "node:child_process";
import { cp, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { expect, type Page, test } from "@playwright/test";
import { FakeSendo, routeFakeSendo } from "./fake-sendo";

/**
 * 新しい版への切り替え（docs/decisions/ui.md の 5）を、本番のコンテナのサーバー
 * （dist-server/server.mjs。pnpm build で作る）で確かめる。画面のファイルを替えてサーバーを起動し直すと、
 * 開いている画面の Service Worker も新しい版に替わり、前に出たときに読み込み直す
 */

const PORT = 4183;
const READER = `http://localhost:${PORT}/`;
const SERVER = fileURLToPath(new URL("../dist-server/server.mjs", import.meta.url));
const DIST = fileURLToPath(new URL("../dist", import.meta.url));

type Running = { process: ChildProcess; output: () => string };

async function startServer(distDir: string): Promise<Running> {
  const child = spawn(process.execPath, [SERVER], {
    env: {
      PATH: process.env.PATH ?? "",
      PORT: String(PORT),
      HOST: "127.0.0.1",
      DIST_DIR: distDir,
      // sendo の API は、テストの中の偽の sendo が答える（中継の先には届かない）
      SENDO_URL: "http://127.0.0.1:9",
    },
    stdio: ["ignore", "pipe", "pipe"],
  });
  let output = "";
  const collect = (chunk: Buffer) => {
    output += chunk.toString();
  };
  child.stdout?.on("data", collect);
  child.stderr?.on("data", collect);
  try {
    await expect
      .poll(
        () => {
          // 起動に失敗したら（ポートが埋まっている、など）、待たずに落とす
          if (child.exitCode !== null) throw new Error(`server exited:\n${output}`);
          return output;
        },
        { timeout: 20_000 },
      )
      .toContain("sendo-reader is listening");
  } catch (error) {
    child.kill("SIGKILL");
    throw error;
  }
  return { process: child, output: () => output };
}

async function stopServer(running: Running): Promise<void> {
  if (running.process.exitCode !== null || running.process.signalCode !== null) return;
  const exited = new Promise((resolve) => running.process.once("exit", resolve));
  running.process.kill("SIGTERM");
  await exited;
}

/**
 * 画面のビルドの写しを、版の印を付けて作る。index.html に印を足し、sw.js の中の index.html の
 * revision を替える（index.html を替えた新しい版を、ビルドし直さずに作る）
 */
async function copyDist(directory: string, version: string): Promise<string> {
  const target = path.join(directory, version);
  await cp(DIST, target, { recursive: true });
  const index = path.join(target, "index.html");
  const html = await readFile(index, "utf8");
  await writeFile(
    index,
    html.replace("</head>", `<meta name="e2e-version" content="${version}"></head>`),
  );
  const sw = path.join(target, "sw.js");
  const source = await readFile(sw, "utf8");
  const revision = Buffer.from(version.padEnd(16, "0")).toString("hex").slice(0, 32);
  const replaced = source.replace(
    /\{url:"index\.html",revision:"[0-9a-f]+"\}/,
    `{url:"index.html",revision:"${revision}"}`,
  );
  if (replaced === source) throw new Error("sw.js の中に、index.html の revision が見つからない");
  await writeFile(sw, replaced);
  return target;
}

function version(page: Page): Promise<string | null> {
  return page.evaluate(
    () => document.querySelector('meta[name="e2e-version"]')?.getAttribute("content") ?? null,
  );
}

/** 画面を前に出したことにする（新しい版を確かめ、替わっていれば読み込み直すきっかけ） */
function bringToFront(page: Page): Promise<void> {
  return page.evaluate(() => {
    document.dispatchEvent(new Event("visibilitychange"));
  });
}

let directory = "";
let running: Running | null = null;

test.beforeEach(async ({ context }) => {
  directory = await mkdtemp(path.join(tmpdir(), "sendo-reader-app-update-"));
  await routeFakeSendo(context, new FakeSendo());
});

test.afterEach(async () => {
  if (running) await stopServer(running);
  running = null;
  await rm(directory, { recursive: true, force: true });
});

test("開いている画面も、新しい版の Service Worker に替わり、前に出たときに読み込み直す", async ({
  page,
}) => {
  const a = await copyDist(directory, "a");
  const b = await copyDist(directory, "b");
  running = await startServer(a);
  let loads = 0;
  page.on("load", () => {
    loads += 1;
  });
  await page.goto(READER);
  await page.evaluate(() => navigator.serviceWorker.ready);
  await expect
    .poll(() => page.evaluate(() => navigator.serviceWorker.controller !== null))
    .toBe(true);
  // 初めて入れたとき（受け持ち始めたとき）は、読み込み直さない
  await page.waitForTimeout(500);
  expect(loads).toBe(1);
  expect(await version(page)).toBe("a");

  await stopServer(running);
  running = await startServer(b);
  await page.evaluate(() => {
    Object.assign(window, { controllerChanged: false });
    navigator.serviceWorker.addEventListener("controllerchange", () => {
      Object.assign(window, { controllerChanged: true });
    });
  });
  // 前に出すと、新しい版を確かめて取り込み、待機させずに使い始める
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
  // 前に出ている間は、読み込み直さない。次に前に出たときに読み込み直す
  await page.waitForTimeout(500);
  expect(loads).toBe(1);
  expect(await version(page)).toBe("a");
  await Promise.all([page.waitForEvent("load"), bringToFront(page)]);
  expect(loads).toBe(2);
  expect(await version(page)).toBe("b");

  // サーバーを止めても、Service Worker が新しい版を返す
  await stopServer(running);
  running = null;
  await page.reload();
  expect(await version(page)).toBe("b");
});
