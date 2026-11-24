import { type ChildProcess, spawn } from "node:child_process";
import { cp, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { expect, type Page, test } from "@playwright/test";
import { FakeSendo, routeFakeSendo, signIn } from "./fake-sendo";

/**
 * 新しい版への切り替え（docs/decisions/ui.md の 5）を、本番のコンテナのサーバー
 * （dist-server/server.mjs。pnpm build で作る）で確かめる。画面のファイルを替えてサーバーを起動し直すと、
 * 開いている画面の Service Worker も新しい版に替わり、前に出たときに読み込み直す。前に出ている間は、
 * 新しい版に替わったことを知らせる
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

/** 画面と Service Worker の両方が見分けられる版を、ビルドし直さずに作る */
async function copyDist(
  directory: string,
  version: string,
  brokenPrecache = false,
): Promise<string> {
  const target = path.join(directory, version);
  await cp(DIST, target, { recursive: true });
  const index = path.join(target, "index.html");
  const html = await readFile(index, "utf8");
  const sw = path.join(target, "sw.js");
  const source = await readFile(sw, "utf8");
  const revision = Buffer.from(version.padEnd(16, "0")).toString("hex").slice(0, 32);
  // コンテナは存在しない静的パスに index.html を返すので、integrity の不一致で取り込みを失敗させる
  const missing =
    ',{url:"missing.js",revision:"1",integrity:"sha256-47DEQpj8HBSa+/TImW+5JCeuQeRkm5NMpJWZG3hSuFU="}';
  let manifest = source.replace(
    /\{url:"index\.html",revision:"[0-9a-f]+"\}/,
    `{url:"index.html",revision:"${revision}"}${brokenPrecache ? missing : ""}`,
  );
  if (manifest === source) throw new Error("sw.js の中に、index.html の revision が見つからない");

  const versionFile = path.join(target, "version.json");
  const built = JSON.parse(await readFile(versionFile, "utf8")) as {
    commit: string;
    builtAt: string;
  };
  const entry = html.match(/src="\/(assets\/[^"]+\.js)"/)?.[1];
  if (entry === undefined) throw new Error("index.html の中に入口の JS が見つからない");
  const script = await readFile(path.join(target, entry), "utf8");
  // a はビルド時の版を使い、b 以降は同じコミットを別の日時にビルドした版を作る
  const builtAt = new Date(
    Date.parse(built.builtAt) + (version.charCodeAt(0) - 97) * 1000,
  ).toISOString();
  const asset = entry.replace(/\.js$/, `-${version}.js`);
  if (
    !script.includes(built.builtAt) ||
    !manifest.includes(entry) ||
    manifest.includes('"version.json"')
  ) {
    throw new Error("版の埋め込みか Service Worker の precache の内容が違う");
  }
  await writeFile(versionFile, JSON.stringify({ ...built, builtAt }));
  await writeFile(path.join(target, asset), script.replaceAll(built.builtAt, builtAt));
  await rm(path.join(target, entry));
  manifest = manifest.replaceAll(entry, asset);
  await writeFile(sw, manifest);
  await writeFile(
    index,
    html
      .replace(entry, asset)
      .replace("</head>", `<meta name="e2e-version" content="${version}"></head>`),
  );
  return target;
}

function version(page: Page): Promise<string | null> {
  return page.evaluate(
    () => document.querySelector('meta[name="e2e-version"]')?.getAttribute("content") ?? null,
  );
}

/** 画面を前に出したことにする（新しい版を確かめ、替わっていれば読み込み直すきっかけ） */
function changeVisibility(page: Page, visibility: "visible" | "hidden"): Promise<void> {
  return page.evaluate((value) => {
    Object.defineProperty(document, "visibilityState", { configurable: true, get: () => value });
    document.dispatchEvent(new Event("visibilitychange"));
  }, visibility);
}

function bringToFront(page: Page): Promise<void> {
  return changeVisibility(page, "visible");
}

function sendToBackground(page: Page): Promise<void> {
  return changeVisibility(page, "hidden");
}

/** 新しい版の知らせ */
function updateNotice(page: Page) {
  return page.getByRole("status").filter({ hasText: "新しい版があります" });
}

async function serveVersion(version: string, brokenPrecache = false): Promise<void> {
  const dist = await copyDist(directory, version, brokenPrecache);
  if (running) await stopServer(running);
  running = await startServer(dist);
}

/** 版 a の画面を開き、使えるなら Service Worker が受け持つまで待つ */
async function openVersionA(
  page: Page,
  url = READER,
  signedIn = false,
  serviceWorker = true,
): Promise<() => number> {
  await serveVersion("a");
  let loads = 0;
  page.on("load", () => {
    loads += 1;
  });
  await page.goto(url);
  if (signedIn) {
    await signIn(page);
    // ログインで、ページごと移って戻ってくる。戻った画面が出るまで待つ
    await expect(page.getByRole("link", { name: "Settings" })).toBeVisible();
  }
  if (serviceWorker) {
    await page.evaluate(() => navigator.serviceWorker.ready);
    await expect
      .poll(() => page.evaluate(() => navigator.serviceWorker.controller !== null))
      .toBe(true);
  }
  return () => loads;
}

/** サーバーを版 b に替え、画面を前に出して、Service Worker が版 b に替わるまで待つ */
async function switchToVersionB(page: Page): Promise<void> {
  await serveVersion("b");
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
  const loads = await openVersionA(page);
  // 初めて入れたとき（受け持ち始めたとき）は、読み込み直さず、知らせも出さない
  await page.waitForTimeout(500);
  expect(loads()).toBe(1);
  expect(await version(page)).toBe("a");
  await expect(updateNotice(page)).toHaveCount(0);

  await switchToVersionB(page);
  // 前に出ている間は、読み込み直さずに知らせる。次に前に出たときに読み込み直す
  await expect(updateNotice(page)).toBeVisible();
  await expect(updateNotice(page)).toContainText(
    "新しい版があります。Reload を押すか、ページを読み込み直すと切り替わります。",
  );
  // 広い画面では右下に出す（見出しの操作を覆わない）
  const box = await updateNotice(page).boundingBox();
  const viewport = page.viewportSize();
  if (box === null || viewport === null) throw new Error("知らせか画面の大きさが分からない");
  expect(viewport.width - (box.x + box.width)).toBeLessThan(40);
  expect(viewport.height - (box.y + box.height)).toBeLessThan(40);
  expect(box.y).toBeGreaterThan(viewport.height / 2);
  expect(loads()).toBe(1);
  expect(await version(page)).toBe("a");
  await Promise.all([page.waitForEvent("load"), bringToFront(page)]);
  expect(loads()).toBe(2);
  expect(await version(page)).toBe("b");
  await expect(updateNotice(page)).toHaveCount(0);

  // サーバーを止めても、Service Worker が新しい版を返す
  if (running) await stopServer(running);
  running = null;
  await page.reload();
  expect(await version(page)).toBe("b");
});

test("新しい版の知らせの Reload で、その場で新しい版に切り替わる", async ({ page }) => {
  const loads = await openVersionA(page);
  await switchToVersionB(page);
  await Promise.all([
    page.waitForEvent("load"),
    updateNotice(page).getByRole("button", { name: "Reload" }).click(),
  ]);
  expect(loads()).toBe(2);
  expect(await version(page)).toBe("b");
  await expect(updateNotice(page)).toHaveCount(0);
});

test("新しい版の知らせを閉じたら出し直さず、次に画面の表示が替わったときに自動で切り替わる", async ({
  page,
}) => {
  const loads = await openVersionA(page);
  await switchToVersionB(page);
  await updateNotice(page).getByRole("button", { name: "Dismiss" }).click();
  await expect(updateNotice(page)).toHaveCount(0);
  // 前に出したままなら、出し直さず、読み込み直さない
  await page.waitForTimeout(500);
  await expect(updateNotice(page)).toHaveCount(0);
  expect(loads()).toBe(1);
  expect(await version(page)).toBe("a");
  // 画面の表示が替わる（visibilitychange。裏に回る、前に出る）と、自動で読み込み直す
  await Promise.all([page.waitForEvent("load"), bringToFront(page)]);
  expect(await version(page)).toBe("b");
  await expect(updateNotice(page)).toHaveCount(0);
});

test("読み込み直すと消えるものを出している画面では知らせず、ほかの画面に移ったら知らせる", async ({
  page,
}) => {
  const loads = await openVersionA(page, READER, true);
  await page.getByRole("link", { name: "Settings" }).click();
  await expect(page).toHaveURL(/\/settings$/);
  // ログインで、ページごと移って戻ってきている。ここから数える
  const before = loads();
  await switchToVersionB(page);
  await page.waitForTimeout(500);
  await expect(updateNotice(page)).toHaveCount(0);
  expect(loads()).toBe(before);
  // 一覧に戻ると出る（読み込み直してはいない）
  await page.goBack();
  await expect(page).not.toHaveURL(/\/settings$/);
  await expect(updateNotice(page)).toBeVisible();
  expect(loads()).toBe(before);
  expect(await version(page)).toBe("a");
});

test("Save a URL の窓を開いている間は知らせず、閉じたら知らせる", async ({ page }) => {
  // 窓を開け閉めしても、画面の中で失敗しない（印を付ける effect が走り続けるなど）
  const errors: string[] = [];
  page.on("pageerror", (error) => errors.push(error.message));
  page.on("console", (message) => {
    if (message.type() === "error") errors.push(message.text());
  });
  const loads = await openVersionA(page, `${READER}starred`, true);
  const before = loads();
  await page.getByRole("button", { name: "Save a URL" }).click();
  const dialog = page.getByRole("dialog", { name: "Save a URL" });
  await dialog.getByLabel("Page URL").fill("https://example.com/typing");
  await switchToVersionB(page);
  await page.waitForTimeout(500);
  await expect(updateNotice(page)).toHaveCount(0);
  // 入力中の窓は、読み込み直して消さない
  await expect(dialog.getByLabel("Page URL")).toHaveValue("https://example.com/typing");
  expect(loads()).toBe(before);
  // 閉じたら、同じ画面のまま出る（読み込み直してはいない）
  await page.keyboard.press("Escape");
  await expect(dialog).toHaveCount(0);
  await expect(updateNotice(page)).toBeVisible();
  expect(loads()).toBe(before);
  expect(await version(page)).toBe("a");
  // 知らせを出している間も、見出しの Save a URL を押せる。開いている間は消え、閉じるとまた出る
  await page.getByRole("button", { name: "Save a URL" }).click();
  await expect(dialog).toBeVisible();
  await expect(updateNotice(page)).toHaveCount(0);
  await page.keyboard.press("Escape");
  await expect(updateNotice(page)).toBeVisible();
  expect(errors.filter((message) => /effect_update_depth_exceeded|svelte/i.test(message))).toEqual(
    [],
  );
});

test.describe("狭い画面", () => {
  test.use({ viewport: { width: 390, height: 780 } });

  test("知らせは下のバーの上に出し、下のバーとメニューの操作を覆わない", async ({ page }) => {
    const loads = await openVersionA(page, READER, false);
    await signIn(page);
    const tabs = page.getByRole("navigation", { name: "Main" });
    await expect(tabs).toBeVisible();
    const before = loads();
    await switchToVersionB(page);
    await expect(updateNotice(page)).toBeVisible();
    expect(loads()).toBe(before);

    // 下のバーのすぐ上にあり、重ならない
    const notice = await updateNotice(page).boundingBox();
    const bar = await tabs.boundingBox();
    if (notice === null || bar === null) throw new Error("知らせか下のバーの位置が分からない");
    const gap = bar.y - (notice.y + notice.height);
    expect(gap).toBeGreaterThanOrEqual(0);
    expect(gap).toBeLessThanOrEqual(24);

    // 下のバーのタブを押せる
    await tabs.getByRole("link", { name: "Saved" }).click();
    await expect(page).toHaveURL(/\/starred$/);

    // メニューを開くと、メニューの下のほうの操作を押せる（知らせより手前）
    await tabs.getByRole("button", { name: "Menu" }).click();
    await expect(page.getByRole("link", { name: "Settings" })).toBeVisible();
    const center = { x: notice.x + notice.width / 2, y: notice.y + notice.height / 2 };
    const covered = await page.evaluate(
      ({ x, y }) => document.elementFromPoint(x, y)?.closest(".update-ready") === null,
      center,
    );
    expect(covered).toBe(true);
    await page.getByRole("link", { name: "Settings" }).click();
    await expect(page).toHaveURL(/\/settings$/);
    expect(loads()).toBe(before);
  });
});

test.describe("Service Worker を使わない画面", () => {
  test.use({ serviceWorkers: "block" });

  async function detectVersionB(page: Page): Promise<void> {
    await serveVersion("b");
    await bringToFront(page);
    await expect(updateNotice(page).getByRole("button", { name: "Reload" })).toBeVisible();
    expect(await version(page)).toBe("a");
  }

  test("新版の知らせが出て、Reload でその場で切り替わる", async ({ page }) => {
    const loads = await openVersionA(page, READER, false, false);
    await detectVersionB(page);
    expect(loads()).toBe(1);
    await Promise.all([
      page.waitForEvent("load"),
      updateNotice(page).getByRole("button", { name: "Reload" }).click(),
    ]);
    expect(await version(page)).toBe("b");
    await expect(updateNotice(page)).toHaveCount(0);
  });

  test("裏に回ったら新版を取り直して自動で切り替わる", async ({ page }) => {
    await openVersionA(page, READER, false, false);
    await detectVersionB(page);
    await Promise.all([page.waitForEvent("load"), sendToBackground(page)]);
    expect(await version(page)).toBe("b");
  });

  test("閉じたあとにさらに新版が出たら知らせ直す", async ({ page }) => {
    const loads = await openVersionA(page, READER, false, false);
    await detectVersionB(page);
    await updateNotice(page).getByRole("button", { name: "Dismiss" }).click();
    await expect(updateNotice(page)).toHaveCount(0);

    await serveVersion("c");
    await bringToFront(page);
    await expect(updateNotice(page).getByRole("button", { name: "Reload" })).toBeVisible();
    expect(loads()).toBe(1);
    expect(await version(page)).toBe("a");
  });

  test("オフラインでは再読み込みせず、オンラインに戻ってから切り替わる", async ({
    page,
    context,
  }) => {
    const loads = await openVersionA(page, READER, false, false);
    await detectVersionB(page);
    await context.setOffline(true);
    const failed = page.waitForEvent("requestfailed", {
      predicate: (request) => request.url() === `${READER}version.json`,
    });
    await sendToBackground(page);
    await failed;
    expect(loads()).toBe(1);
    expect(await version(page)).toBe("a");

    await context.setOffline(false);
    await Promise.all([page.waitForEvent("load"), sendToBackground(page)]);
    expect(await version(page)).toBe("b");
  });

  for (const status of [404, 200]) {
    test(`版の要求に ${status === 404 ? "404" : "index.html"} が返れば知らせない`, async ({
      page,
    }) => {
      const errors: Error[] = [];
      page.on("pageerror", (error) => errors.push(error));
      if (status === 200) {
        const a = await copyDist(directory, "a");
        await rm(path.join(a, "version.json"));
        running = await startServer(a);
      } else {
        await page.route("**/version.json", (route) => route.fulfill({ status }));
        await serveVersion("a");
      }
      const response = page.waitForResponse(`${READER}version.json`);
      await page.goto(READER);
      const received = await response;
      expect(received.status()).toBe(status);
      await received.finished();
      await expect(page.getByText("Sendo", { exact: true })).toBeVisible();
      await expect(updateNotice(page)).toHaveCount(0);
      expect(errors).toEqual([]);
    });
  }
});

test("precache の取り込みに失敗した版では Reload を出さず、同じ版なら Dismiss 後も出し直さない", async ({
  page,
  context,
}) => {
  const loads = await openVersionA(page);
  await serveVersion("b", true);
  await bringToFront(page);
  const notice = updateNotice(page);
  await expect(notice).toContainText("新しい版がありますが、切り替えられませんでした。");
  await expect(notice.getByRole("button", { name: "Reload" })).toHaveCount(0);
  const box = await notice.boundingBox();
  const viewport = page.viewportSize();
  if (box === null || viewport === null) throw new Error("知らせか画面の大きさが分からない");
  expect(viewport.width - (box.x + box.width)).toBeLessThan(40);
  expect(viewport.height - (box.y + box.height)).toBeLessThan(40);
  await sendToBackground(page);
  expect(loads()).toBe(1);
  expect(await version(page)).toBe("a");
  await notice.getByRole("button", { name: "Dismiss" }).click();
  const retry = context.waitForEvent("request", {
    predicate: (request) => new URL(request.url()).pathname === "/missing.js",
  });
  await bringToFront(page);
  await retry;
  await expect(notice).toHaveCount(0);
  expect(loads()).toBe(1);

  // 同じ版の取り込みが次に成功したら、Reload の知らせに替わる
  await switchToVersionB(page);
  await expect(notice.getByRole("button", { name: "Reload" })).toBeVisible();
  expect(loads()).toBe(1);
});

test("取り込めた新版の知らせは、定期確認が来ても失敗の知らせに変わらない", async ({ page }) => {
  await page.clock.install();
  const loads = await openVersionA(page);
  await switchToVersionB(page);
  const notice = updateNotice(page);
  await expect(notice.getByRole("button", { name: "Reload" })).toBeVisible();
  const checked = page.waitForResponse(`${READER}version.json`);
  await page.clock.fastForward(60 * 60 * 1000);
  await (await checked).finished();
  await expect(notice.getByRole("button", { name: "Reload" })).toBeVisible();
  expect(loads()).toBe(1);
});

test("強制再読み込みで新版が出ていれば、あとから新版の worker が入っても知らせない", async ({
  page,
  context,
}) => {
  const loads = await openVersionA(page);
  await serveVersion("b");
  const session = await context.newCDPSession(page);
  await Promise.all([
    page.waitForEvent("load"),
    session.send("Page.reload", { ignoreCache: true }),
  ]);
  expect(await version(page)).toBe("b");
  // 本番どおり登録し、画面 b の入口が precache に入るまで待つ
  await expect
    .poll(() =>
      page.evaluate(async () => {
        const entry = document.querySelector<HTMLScriptElement>('script[type="module"][src]');
        return (
          entry !== null && (await caches.match(entry.src, { ignoreSearch: true })) !== undefined
        );
      }),
    )
    .toBe(true);
  await bringToFront(page);
  await expect(updateNotice(page)).toHaveCount(0);
  expect(loads()).toBe(2);
});
