import { type BrowserContext, expect, type Page, test } from "@playwright/test";
import { FakeSendo, routeFakeSendo, signIn } from "./fake-sendo";

/**
 * この端末で通知を受ける（docs/decisions/notifications.md の 1〜4）を、本番のビルドと本番の CSP で確かめる。
 *
 * Playwright の Chromium は、プッシュサービスにつながらないので pushManager.subscribe が断られる。
 * そこで、ページの PushManager の subscribe ／ getSubscription と、Notification の許可を差し替える
 * （登録は localStorage に置き、読み込み直しても残す）。Service Worker と sendo とのやり取りは本物を使う
 */

/** 通知の許可が要るテストは、通知を出せる Chromium（headless shell ではない）で動かす */
test.use({ channel: "chromium" });

const STATE_KEY = "e2e:push";

interface StubState {
  permission: NotificationPermission;
  /** requestPermission で利用者が選ぶ答え */
  answer: NotificationPermission;
  subscription: { endpoint: string; key: string } | null;
  /** 許可を求めた数（requestPermission と、許可が決まる前の subscribe） */
  requests: number;
}

async function stubPush(
  context: BrowserContext,
  initial: Partial<Pick<StubState, "permission" | "answer">> = {},
): Promise<void> {
  const state: StubState = {
    permission: initial.permission ?? "default",
    answer: initial.answer ?? "granted",
    subscription: null,
    requests: 0,
  };
  await context.addInitScript(
    ({ key, state }) => {
      if (location.origin !== "http://localhost:4173") return;
      const read = (): StubState =>
        (JSON.parse(localStorage.getItem(key) ?? "null") as StubState | null) ?? state;
      const write = (next: StubState) => localStorage.setItem(key, JSON.stringify(next));
      const toBytes = (text: string) =>
        Uint8Array.from(
          atob(
            text.replace(/-/g, "+").replace(/_/g, "/") + "=".repeat((4 - (text.length % 4)) % 4),
          ),
          (char) => char.charCodeAt(0),
        );
      const toText = (bytes: Uint8Array) =>
        btoa(String.fromCharCode(...bytes))
          .replace(/\+/g, "-")
          .replace(/\//g, "_")
          .replace(/=+$/, "");
      const toSubscription = (stored: NonNullable<StubState["subscription"]>) => ({
        endpoint: stored.endpoint,
        options: { applicationServerKey: toBytes(stored.key).buffer, userVisibleOnly: true },
        toJSON: () => ({
          endpoint: stored.endpoint,
          expirationTime: null,
          keys: { p256dh: "BFakeDeviceKey", auth: "fake-auth" },
        }),
        unsubscribe: async () => {
          const next = read();
          if (next.subscription?.endpoint === stored.endpoint) next.subscription = null;
          write(next);
          return true;
        },
      });
      Object.defineProperty(Notification, "permission", {
        configurable: true,
        get: () => read().permission,
      });
      Notification.requestPermission = async () => {
        const next = read();
        next.requests += 1;
        next.permission = next.answer;
        write(next);
        return next.permission;
      };
      PushManager.prototype.getSubscription = async () => {
        const stored = read().subscription;
        return (stored === null ? null : toSubscription(stored)) as PushSubscription | null;
      };
      PushManager.prototype.subscribe = async (options) => {
        const next = read();
        // 本物の Chromium と同じく、通知を出す約束（userVisibleOnly）のない登録は断る
        if (options?.userVisibleOnly !== true) {
          throw new DOMException("userVisibleOnly でない", "NotAllowedError");
        }
        // 許可が決まっていなければ、本物は許可の窓を出す（許可を求めた数に数える）
        if (next.permission === "default") {
          next.requests += 1;
          next.permission = next.answer;
          write(next);
        }
        if (next.permission !== "granted") {
          throw new DOMException("許可されていない", "NotAllowedError");
        }
        const key = options.applicationServerKey;
        next.subscription = {
          endpoint: `https://push.example/${crypto.randomUUID()}`,
          key: toText(new Uint8Array(key as ArrayBuffer)),
        };
        write(next);
        return toSubscription(next.subscription) as unknown as PushSubscription;
      };
    },
    { key: STATE_KEY, state },
  );
}

const stubState = (page: Page) =>
  page.evaluate(
    (key) => JSON.parse(localStorage.getItem(key) ?? "null") as StubState | null,
    STATE_KEY,
  );

async function openNotifications(page: Page): Promise<void> {
  await page.goto("/settings");
  await signIn(page);
  await page.getByRole("tab", { name: "Notifications", exact: true }).click();
}

const turnOnButton = (page: Page) =>
  page.getByRole("button", { name: "Turn on notifications", exact: true });
const turnOffButton = (page: Page) =>
  page.getByRole("button", { name: "Turn off notifications", exact: true });

test("Turn on notifications で許可すると、sendo に登録ができ、Turn off で消える", async ({
  page,
  context,
}) => {
  const server = new FakeSendo();
  await routeFakeSendo(context, server);
  await stubPush(context);
  await openNotifications(page);
  await expect(page.getByText("この端末では通知を受けていません。")).toBeVisible();

  await turnOnButton(page).click();
  await expect(page.getByText("この端末で通知を受けています。")).toBeVisible();
  const registered = [...server.pushRegistrations.values()];
  expect(registered).toHaveLength(1);
  const subscribed = (await stubState(page))?.subscription;
  expect(registered[0]).toEqual({
    endpoint: subscribed?.endpoint,
    keys: { p256dh: "BFakeDeviceKey", auth: "fake-auth" },
  });
  // 登録は、sendo の公開鍵で作る
  expect(subscribed?.key).toBe(server.pushPublicKey);

  await turnOffButton(page).click();
  await expect(page.getByText("この端末では通知を受けていません。")).toBeVisible();
  expect(server.pushRegistrations.size).toBe(0);
  expect((await stubState(page))?.subscription).toBeNull();
});

test("通知を許可したら、手元の未読の数が変わっていなくても、バッジを書き直す", async ({
  page,
  context,
}) => {
  const server = new FakeSendo();
  const feed = server.subscribe({ url: "https://blog.example/feed.xml", title: "Blog" });
  for (const title of ["記事 1", "記事 2", "記事 3"]) server.deliver(feed.id, { title });
  await routeFakeSendo(context, server);
  await stubPush(context);
  // バッジに書いた数を、呼んだ順に覚える
  await context.addInitScript(() => {
    const calls: unknown[] = [];
    Object.assign(window, { badgeCalls: calls });
    Object.defineProperty(Navigator.prototype, "setAppBadge", {
      configurable: true,
      value: (contents: number) => {
        calls.push(contents);
        return Promise.resolve();
      },
    });
    Object.defineProperty(Navigator.prototype, "clearAppBadge", {
      configurable: true,
      value: () => {
        calls.push("clear");
        return Promise.resolve();
      },
    });
  });
  const badgeCalls = () =>
    page.evaluate(() => [...(window as unknown as { badgeCalls: unknown[] }).badgeCalls]);
  await openNotifications(page);
  await expect.poll(async () => (await badgeCalls()).at(-1)).toBe(3);
  await expect(turnOnButton(page)).toBeEnabled();
  const before = (await badgeCalls()).length;

  await turnOnButton(page).click();
  await expect(page.getByText("この端末で通知を受けています。")).toBeVisible();
  const after = await badgeCalls();
  expect(after.length).toBeGreaterThan(before);
  expect(after.at(-1)).toBe(3);
});

test("拒むと登録せず、どうすれば許可できるかを日本語で出す", async ({ page, context }) => {
  const server = new FakeSendo();
  await routeFakeSendo(context, server);
  await stubPush(context, { answer: "denied" });
  await openNotifications(page);
  await turnOnButton(page).click();
  await expect(page.getByText("通知が拒否されています。", { exact: false })).toBeVisible();
  await expect(page.getByText("サイトの設定で通知を許可してから", { exact: false })).toBeVisible();
  expect(server.pushRegistrations.size).toBe(0);
  expect((await stubState(page))?.subscription ?? null).toBeNull();
});

test("起動しただけ、画面を開いただけでは、許可を求めない", async ({ page, context }) => {
  const server = new FakeSendo();
  await routeFakeSendo(context, server);
  await stubPush(context);
  await openNotifications(page);
  await expect(turnOnButton(page)).toBeEnabled();
  await page.reload();
  await page.getByRole("tab", { name: "Notifications", exact: true }).click();
  await expect(turnOnButton(page)).toBeEnabled();
  await page.goto("/");
  await expect(page.getByRole("button", { name: "Sign out", exact: true })).toBeVisible();
  // 起動したときの送り直し（登録のロックを取る）が済むのを待つ。登録のないところで登録を作ろうと
  // すれば、許可を求めたことになる
  await page.waitForTimeout(300);
  await page.evaluate(() => navigator.locks.request("sendo-reader:push", async () => {}));
  const state = await stubState(page);
  expect(state?.requests ?? 0).toBe(0);
  expect(state?.subscription ?? null).toBeNull();
});

test("起動したら、残っている登録を sendo に送り直す", async ({ page, context }) => {
  const server = new FakeSendo();
  await routeFakeSendo(context, server);
  await stubPush(context);
  await openNotifications(page);
  await turnOnButton(page).click();
  await expect(page.getByText("この端末で通知を受けています。")).toBeVisible();

  // sendo が登録を忘れた（セッションに結んだ登録は、ほかの理由でも消える）
  server.pushRegistrations.clear();
  await page.reload();
  await expect.poll(() => server.pushRegistrations.size).toBe(1);
  // 起動したことで許可を求め直さない
  expect((await stubState(page))?.requests).toBe(1);
});

test("ログアウトすると、この端末の登録を外し、出ている通知と覚えた tag も消す。sendo の登録はセッションと一緒に消える", async ({
  page,
  context,
}) => {
  const server = new FakeSendo();
  await routeFakeSendo(context, server);
  await stubPush(context);
  // Service Worker が通知を出せるように、ブラウザーの許可も与える
  await context.grantPermissions(["notifications"], { origin: "http://localhost:4173" });
  await openNotifications(page);
  await turnOnButton(page).click();
  await expect(page.getByText("この端末で通知を受けています。")).toBeVisible();
  await deliverPush(context, page, bellPush("article-1", "Publickey", "前の人の記事"));
  await expect.poll(async () => (await shownNotifications(page)).length).toBe(1);

  await page.goto("/");
  await page.getByRole("button", { name: "Sign out", exact: true }).click();
  await expect(page.getByRole("button", { name: "Google でログイン" })).toBeVisible();
  await expect.poll(async () => (await stubState(page))?.subscription ?? null).toBeNull();
  await expect.poll(() => shownNotifications(page)).toEqual([]);
  expect(await rememberedTags(page)).toEqual([]);
  expect(server.pushRegistrations.size).toBe(0);
  expect(server.requests).not.toContain("DELETE /push/registration");
});

test("Web Push を使えない Sendo では使えないと出し、登録が残っていれば外す操作を出す", async ({
  page,
  context,
}) => {
  const server = new FakeSendo();
  await routeFakeSendo(context, server);
  await stubPush(context);
  await openNotifications(page);
  await turnOnButton(page).click();
  await expect(page.getByText("この端末で通知を受けています。")).toBeVisible();

  server.push = "unavailable";
  await page.reload();
  await page.getByRole("tab", { name: "Notifications", exact: true }).click();
  await expect(page.getByText("この Sendo では通知を使えません。")).toBeVisible();
  await turnOffButton(page).click();
  await expect(turnOffButton(page)).toHaveCount(0);
  expect((await stubState(page))?.subscription).toBeNull();

  // Web Push に対応する前の Sendo（404）も同じ
  server.push = "unsupported";
  await page.reload();
  await page.getByRole("tab", { name: "Notifications", exact: true }).click();
  await expect(page.getByText("この Sendo では通知を使えません。")).toBeVisible();
  await expect(turnOnButton(page)).toHaveCount(0);
});

test("Sendo に届かなければ、確かめられないことと Retry を出し、押すと確かめ直す", async ({
  page,
  context,
}) => {
  const server = new FakeSendo();
  await routeFakeSendo(context, server);
  await stubPush(context);
  let offline = true;
  server.onRequest = async (path) => {
    if (offline && path === "GET /push") throw new TypeError("offline");
  };
  await openNotifications(page);
  await expect(page.getByText("通知を使えるかを確かめられませんでした。")).toBeVisible();
  offline = false;
  await page.getByRole("button", { name: "Retry", exact: true }).click();
  await expect(turnOnButton(page)).toBeEnabled();
});

test("sendo に送れなければ、作った登録を外し、もう一度押せる", async ({ page, context }) => {
  const server = new FakeSendo();
  await routeFakeSendo(context, server);
  await stubPush(context);
  await openNotifications(page);
  await expect(turnOnButton(page)).toBeEnabled();
  let failing = true;
  server.onRequest = async (path) => {
    if (failing && path === "PUT /push/registration") throw new TypeError("offline");
  };
  await turnOnButton(page).click();
  await expect(
    page.getByText("通知の登録を Sendo に送れませんでした。", { exact: false }),
  ).toBeVisible();
  expect((await stubState(page))?.subscription).toBeNull();
  failing = false;
  await turnOnButton(page).click();
  await expect(page.getByText("この端末で通知を受けています。")).toBeVisible();
  expect(server.pushRegistrations.size).toBe(1);
});

/** Service Worker に push を届ける（DevTools の Push と同じ道。プッシュサービスは通らない） */
async function deliverPush(context: BrowserContext, page: Page, payload: unknown): Promise<void> {
  // ready は取り込みの途中（activating）でも返る。その間に届けた push は落ちることがあるので、
  // 取り込みが済む（activated）まで待つ
  await page.evaluate(async () => {
    const worker = (await navigator.serviceWorker.ready).active;
    if (worker === null || worker.state === "activated") return;
    await new Promise<void>((resolve) => {
      worker.addEventListener("statechange", () => {
        if (worker.state === "activated") resolve();
      });
    });
  });
  const cdp = await context.newCDPSession(page);
  const registrations: { registrationId: string; scopeURL: string }[] = [];
  cdp.on("ServiceWorker.workerRegistrationUpdated", (event) => {
    registrations.push(...event.registrations);
  });
  await cdp.send("ServiceWorker.enable");
  await expect.poll(() => registrations.length).toBeGreaterThan(0);
  const registration = registrations.find((r) => r.scopeURL === "http://localhost:4173/");
  if (registration === undefined) throw new Error("Service Worker の登録が見つからない");
  await cdp.send("ServiceWorker.deliverPushMessage", {
    origin: "http://localhost:4173",
    registrationId: registration.registrationId,
    data: typeof payload === "string" ? payload : JSON.stringify(payload),
  });
  await cdp.detach();
}

/** 出ている reader の通知 */
const shownNotifications = (page: Page) =>
  page.evaluate(async () => {
    const registration = await navigator.serviceWorker.ready;
    return (await registration.getNotifications()).map((n) => ({
      title: n.title,
      body: n.body,
      tag: n.tag,
    }));
  });

/**
 * Service Worker が IndexedDB に覚えた通知（docs/decisions/notifications.md の 8・10）。まだなければ、
 * src/lib/notification-store.ts と同じ版と形で作る（版を付けずに開くと、表のない版 1 ができ、
 * Service Worker が表を作れなくなる）
 */
const rememberedTags = (page: Page) =>
  page.evaluate(
    () =>
      new Promise<unknown[]>((resolve, reject) => {
        const request = indexedDB.open("sendo-reader-notifications", 1);
        request.onupgradeneeded = () => {
          request.result.createObjectStore("tags", { keyPath: "tag" });
        };
        request.onerror = () => reject(request.error);
        request.onsuccess = () => {
          const db = request.result;
          const all = db.transaction("tags").objectStore("tags").getAll();
          all.onsuccess = () => {
            db.close();
            resolve(all.result);
          };
          all.onerror = () => reject(all.error);
        };
      }),
  );

/** sendo の決定（notifications.md の 14）の形の push */
function bellPush(articleId: string, title: string, body: string) {
  return {
    web_push: 8030,
    notification: {
      title,
      body,
      navigate: `https://reader.example/?article=${articleId}`,
      tag: `bell:bell-1:${articleId}`,
      data: { bellId: "bell-1", articleId, count: 1 },
    },
    app_badge: 3,
    mutable: true,
  };
}

/** 本番の CSP（Trusted Types を含む）で止められたことを、ページのコンソールから集める */
function watchCspViolations(page: Page): string[] {
  const violations: string[] = [];
  page.on("console", (message) => {
    const text = message.text();
    if (/Content Security Policy|Trusted Type/i.test(text)) violations.push(text);
  });
  return violations;
}

test.describe("push を受けたとき", () => {
  test.beforeEach(async ({ context }) => {
    await context.grantPermissions(["notifications"], { origin: "http://localhost:4173" });
  });

  test("フィード名とタイトルの通知を、reader を開いていても出す。<b> も文字のまま出し、覚えるのは tag と時刻だけ", async ({
    page,
    context,
  }) => {
    const server = new FakeSendo();
    await routeFakeSendo(context, server);
    const violations = watchCspViolations(page);
    await page.goto("/");
    await signIn(page);
    await expect(page.getByRole("button", { name: "Sign out", exact: true })).toBeVisible();

    const before = Date.now();
    await deliverPush(
      context,
      page,
      bellPush("article-1", "Publickey", "<b>Azure</b> の東日本リージョンで障害"),
    );
    await expect
      .poll(() => shownNotifications(page))
      .toEqual([
        {
          title: "Publickey",
          body: "<b>Azure</b> の東日本リージョンで障害",
          tag: "bell:bell-1:article-1",
        },
      ]);
    const remembered = await rememberedTags(page);
    expect(remembered).toEqual([{ tag: "bell:bell-1:article-1", at: expect.any(Number) }]);
    expect((remembered[0] as { at: number }).at).toBeGreaterThanOrEqual(before);
    expect(violations).toEqual([]);
  });

  test("形に合わない中身なら、Sendo とだけ書いた通知を出し、tag は覚えない", async ({
    page,
    context,
  }) => {
    const server = new FakeSendo();
    await routeFakeSendo(context, server);
    await page.goto("/");
    await signIn(page);
    await deliverPush(context, page, { notification: { title: 1, tag: "bell:b:a" } });
    await expect
      .poll(() => shownNotifications(page))
      .toEqual([{ title: "Sendo", body: "", tag: "" }]);
    await deliverPush(context, page, "{not json");
    await expect.poll(async () => (await shownNotifications(page)).length).toBe(2);
    expect(await rememberedTags(page)).toEqual([]);
  });
});

const serviceWorker = async (context: BrowserContext) =>
  context.serviceWorkers()[0] ?? (await context.waitForEvent("serviceworker"));

/**
 * Service Worker に、通知を押したこと（notificationclick）か、利用者が消したこと（notificationclose）を
 * 届ける。Playwright は OS の通知を押せないので、出ている通知でその知らせを起こす（利用者の操作では
 * ないので、Service Worker は新しい窓を開けず、前にも出せない。開いている画面で開く道を確かめる）。
 * 消したときは、本物と同じく、通知を閉じてから知らせる
 */
async function notificationEvent(
  context: BrowserContext,
  type: "notificationclick" | "notificationclose",
  tag: string,
): Promise<void> {
  const worker = await serviceWorker(context);
  await worker.evaluate(
    async ({ type, tag }) => {
      const scope = self as unknown as {
        registration: { getNotifications(filter: { tag: string }): Promise<Notification[]> };
        dispatchEvent(event: Event): boolean;
      };
      const [notification] = await scope.registration.getNotifications({ tag });
      if (notification === undefined) throw new Error(`通知が出ていない：${tag}`);
      if (type === "notificationclose") notification.close();
      const NotificationEventClass = (
        self as unknown as {
          NotificationEvent: new (type: string, init: { notification: Notification }) => Event;
        }
      ).NotificationEvent;
      scope.dispatchEvent(new NotificationEventClass(type, { notification }));
    },
    { type, tag },
  );
}

const clickNotification = (context: BrowserContext, tag: string) =>
  notificationEvent(context, "notificationclick", tag);

/**
 * Service Worker の clients.openWindow を、開こうとした URL を覚えるものに替える（Playwright が起こした
 * 知らせは利用者の操作ではないので、本物は窓を開けない）。覚えた URL を返す関数を返す
 */
async function recordOpenWindow(context: BrowserContext): Promise<() => Promise<string[]>> {
  const worker = await serviceWorker(context);
  await worker.evaluate(() => {
    const opened: string[] = [];
    const scope = self as unknown as {
      clients: { openWindow(url: string): Promise<null> };
      openedWindows: string[];
    };
    scope.openedWindows = opened;
    scope.clients.openWindow = async (url) => {
      opened.push(url);
      return null;
    };
  });
  return () =>
    worker.evaluate(() => [...(self as unknown as { openedWindows: string[] }).openedWindows]);
}

test.describe("通知を押したとき", () => {
  test.beforeEach(async ({ context }) => {
    await context.grantPermissions(["notifications"], { origin: "http://localhost:4173" });
  });

  test("開いている画面で、押した通知の記事を開く。押していない通知は残り、その記事は開かない", async ({
    page,
    context,
  }) => {
    const server = new FakeSendo();
    const feed = server.subscribe({
      url: "https://www.publickey1.jp/atom.xml",
      title: "Publickey",
    });
    const first = server.deliver(feed.id, { title: "Azure の東日本リージョンで障害" });
    const second = server.deliver(feed.id, { title: "Rust 1.92 が出た" });
    await routeFakeSendo(context, server);
    await page.goto("/");
    await signIn(page);
    await expect(page.locator(".article-list").getByText("Rust 1.92 が出た")).toBeVisible();

    await deliverPush(
      context,
      page,
      bellPush(first.id, "Publickey", "Azure の東日本リージョンで障害"),
    );
    await deliverPush(context, page, bellPush(second.id, "Publickey", "Rust 1.92 が出た"));
    await expect.poll(async () => (await shownNotifications(page)).length).toBe(2);

    await clickNotification(context, `bell:bell-1:${first.id}`);
    await expect(page).toHaveURL(new RegExp(`\\?article=${first.id}$`));
    await expect(
      page.getByRole("heading", { name: "Azure の東日本リージョンで障害", exact: true }),
    ).toBeVisible();
    // 押した通知は閉じて覚えから外し、押していない通知は残す
    await expect
      .poll(async () => (await shownNotifications(page)).map((n) => n.tag))
      .toEqual([`bell:bell-1:${second.id}`]);
    expect(await rememberedTags(page)).toEqual([
      { tag: `bell:bell-1:${second.id}`, at: expect.any(Number) },
    ]);
    // 読み込み直さずに移った（履歴が増え、戻ると一覧）
    await page.goBack();
    await expect(page).not.toHaveURL(/article=/);
  });

  test("読み込み直すと消えるものを出している画面（Settings）では、記事へ移らない", async ({
    page,
    context,
  }) => {
    const server = new FakeSendo();
    const feed = server.subscribe({
      url: "https://www.publickey1.jp/atom.xml",
      title: "Publickey",
    });
    const article = server.deliver(feed.id, { title: "Azure の東日本リージョンで障害" });
    await routeFakeSendo(context, server);
    await page.goto("/settings");
    await signIn(page);
    await deliverPush(context, page, bellPush(article.id, "Publickey", "Azure"));
    await expect.poll(async () => (await shownNotifications(page)).length).toBe(1);
    const openedWindows = await recordOpenWindow(context);
    await clickNotification(context, `bell:bell-1:${article.id}`);
    await expect.poll(async () => (await shownNotifications(page)).length).toBe(0);
    // 選べる画面がないので、記事の URL を新しい窓で開く
    await expect.poll(openedWindows).toEqual([`/?article=${article.id}`]);
    // Service Worker の待つ時間（0.5 秒）を過ぎても、Settings のまま
    await page.waitForTimeout(800);
    await expect(page).toHaveURL(/\/settings$/);
  });

  test("利用者が消した通知は、覚えから外す", async ({ page, context }) => {
    const server = new FakeSendo();
    await routeFakeSendo(context, server);
    await page.goto("/");
    await signIn(page);
    await deliverPush(context, page, bellPush("article-1", "Publickey", "Azure"));
    await deliverPush(context, page, bellPush("article-2", "Publickey", "Rust"));
    await expect.poll(async () => (await rememberedTags(page)).length).toBe(2);
    await notificationEvent(context, "notificationclose", "bell:bell-1:article-1");
    await expect
      .poll(() => rememberedTags(page))
      .toEqual([{ tag: "bell:bell-1:article-2", at: expect.any(Number) }]);
  });

  test("まだ手元に届いていない記事は、記事の画面のまま同期を待ってから出す。同期しても届かなければ、ないと出す", async ({
    page,
    context,
  }) => {
    const server = new FakeSendo();
    const feed = server.subscribe({
      url: "https://www.publickey1.jp/atom.xml",
      title: "Publickey",
    });
    server.deliver(feed.id, { title: "前からある記事" });
    await routeFakeSendo(context, server);
    await page.goto("/");
    await signIn(page);
    await expect(page.locator(".article-list").getByText("前からある記事")).toBeVisible();

    // sendo は受信箱に配ってから通知を送る。画面の同期はまだ
    const fresh = server.deliver(feed.id, { title: "通知で届いた記事" });
    let release = () => {};
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    server.onRequest = async (path) => {
      if (path === "GET /sync") await gate;
    };
    await deliverPush(context, page, bellPush(fresh.id, "Publickey", "通知で届いた記事"));
    await expect.poll(async () => (await shownNotifications(page)).length).toBe(1);
    await clickNotification(context, `bell:bell-1:${fresh.id}`);
    await expect(page.getByText("記事を同期しています…")).toBeVisible();
    release();
    await expect(
      page.getByRole("heading", { name: "通知で届いた記事", exact: true }),
    ).toBeVisible();
    await expect(page).toHaveURL(new RegExp(`\\?article=${fresh.id}$`));
    server.onRequest = null;

    // 受信箱から消えた記事
    await deliverPush(context, page, bellPush("gone", "Publickey", "消えた記事"));
    await expect.poll(async () => (await shownNotifications(page)).length).toBe(1);
    await clickNotification(context, "bell:bell-1:gone");
    await expect(page.getByText("この記事は手元にありません。")).toBeVisible();
    await expect(page).toHaveURL(/\?article=gone$/);
  });

  test("選んでいるワークスペースの範囲の外の記事は開かず、開かなかったことを知らせる", async ({
    page,
    context,
  }) => {
    const server = new FakeSendo();
    server.workspacesSupported = true;
    const publicSpace = server.createWorkspace("Public");
    const privateSpace = server.createWorkspace("Personal");
    const ordinary = server.subscribe({
      url: "https://public.example/feed",
      title: "Public feed",
      workspaceId: publicSpace.id,
    });
    const personal = server.subscribe({
      url: "https://private.example/feed",
      title: "Hidden feed",
      workspaceId: privateSpace.id,
    });
    server.deliver(ordinary.id, { title: "Public article" });
    const hidden = server.deliver(personal.id, { title: "Hidden article" });
    await routeFakeSendo(context, server);
    await page.goto("/");
    await signIn(page);
    const list = page.locator(".article-list");
    await expect(list.getByText("Hidden article")).toBeVisible();
    const nav = page.getByRole("navigation", { name: "Feeds", exact: true });
    await nav.getByRole("button", { name: /^Workspaces:/ }).click();
    const dialog = page.getByRole("dialog", { name: "Workspaces", exact: true });
    await dialog.getByRole("button", { name: "Only Public", exact: true }).click();
    await dialog.getByRole("button", { name: "Close", exact: true }).click();
    await expect(list.getByText("Hidden article")).toHaveCount(0);

    await deliverPush(context, page, bellPush(hidden.id, "Hidden feed", "Hidden article"));
    await expect.poll(async () => (await shownNotifications(page)).length).toBe(1);
    await clickNotification(context, `bell:bell-1:${hidden.id}`);
    await expect(
      page.getByText(
        "通知の記事は、選んでいるワークスペースに入っていないため、開きませんでした。",
      ),
    ).toBeVisible();
    await expect(page).not.toHaveURL(/article=/);
    await expect(page.getByRole("heading", { name: "Hidden article" })).toHaveCount(0);

    // 範囲の中の記事で、まだ手元に届いていないものは、範囲を決める前に同期を待つ
    const fresh = server.deliver(ordinary.id, { title: "Fresh public article" });
    let release = () => {};
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    server.onRequest = async (path) => {
      if (path === "GET /sync") await gate;
    };
    await deliverPush(context, page, bellPush(fresh.id, "Public feed", "Fresh public article"));
    await expect.poll(async () => (await shownNotifications(page)).length).toBe(1);
    await clickNotification(context, `bell:bell-1:${fresh.id}`);
    await expect(page.getByText("記事を同期しています…")).toBeVisible();
    release();
    await expect(
      page.getByRole("heading", { name: "Fresh public article", exact: true }),
    ).toBeVisible();
    await expect(page).toHaveURL(new RegExp(`\\?article=${fresh.id}$`));
  });
});

test.describe("消えた通知で見分ける（iPhone と iPad のホーム画面のアプリを真似る）", () => {
  test.beforeEach(async ({ context }) => {
    await context.grantPermissions(["notifications"], { origin: "http://localhost:4173" });
    // ホーム画面のアプリ（navigator.standalone）で、触れる画面
    await context.addInitScript(() => {
      Object.defineProperty(Navigator.prototype, "standalone", { get: () => true });
      Object.defineProperty(Navigator.prototype, "maxTouchPoints", { get: () => 5 });
    });
  });

  function changeVisibility(page: Page, visibility: DocumentVisibilityState): Promise<void> {
    return page.evaluate((value) => {
      Object.defineProperty(document, "visibilityState", { configurable: true, get: () => value });
      document.dispatchEvent(new Event("visibilitychange"));
    }, visibility);
  }

  /** 通知センターから通知が消えた（押されても、iOS では notificationclick も notificationclose も来ない） */
  const dismiss = (page: Page, tag: string) =>
    page.evaluate(async (tag) => {
      const registration = await navigator.serviceWorker.ready;
      for (const notification of await registration.getNotifications({ tag })) notification.close();
    }, tag);

  test("裏にある間に 1 件だけ消えたら、前に出たときにその記事を開く。2 件以上なら開かない", async ({
    page,
    context,
  }) => {
    const server = new FakeSendo();
    const feed = server.subscribe({
      url: "https://www.publickey1.jp/atom.xml",
      title: "Publickey",
    });
    const first = server.deliver(feed.id, { title: "Azure の東日本リージョンで障害" });
    const second = server.deliver(feed.id, { title: "Rust 1.92 が出た" });
    const third = server.deliver(feed.id, { title: "Go 1.27 が出た" });
    await routeFakeSendo(context, server);
    await page.goto("/");
    await signIn(page);
    await expect(page.locator(".article-list").getByText("Rust 1.92 が出た")).toBeVisible();
    for (const article of [first, second, third]) {
      await deliverPush(context, page, bellPush(article.id, "Publickey", article.title ?? ""));
    }
    await expect.poll(async () => (await rememberedTags(page)).length).toBe(3);

    await changeVisibility(page, "hidden");
    await dismiss(page, `bell:bell-1:${second.id}`);
    await changeVisibility(page, "visible");
    await expect(page).toHaveURL(new RegExp(`\\?article=${second.id}$`));
    await expect(
      page.getByRole("heading", { name: "Rust 1.92 が出た", exact: true }),
    ).toBeVisible();
    await expect.poll(async () => (await rememberedTags(page)).length).toBe(2);

    // 2 件まとめて消えたら、どれも開かずに覚えから外す
    await changeVisibility(page, "hidden");
    await dismiss(page, `bell:bell-1:${first.id}`);
    await dismiss(page, `bell:bell-1:${third.id}`);
    await changeVisibility(page, "visible");
    await expect.poll(async () => (await rememberedTags(page)).length).toBe(0);
    await expect(page).toHaveURL(new RegExp(`\\?article=${second.id}$`));
  });
});

test.describe("ベルを付けたときの勧め", () => {
  const bell = (page: Page, name: string) =>
    page.getByRole("main").getByRole("button", { name: `Bell: ${name}`, exact: true });
  const suggestion = (page: Page) => page.getByText("この端末で通知を受けますか？");

  function seed() {
    const server = new FakeSendo();
    server.subscribe({ url: "https://blog.example/feed.xml", title: "Blog" });
    server.subscribe({ url: "https://news.example/rss", title: "News" });
    return server;
  }

  /** GET /push を受けるのを待つ（確かめ終える前は勧めを出さないので、出ないことを確かめる前に待つ） */
  async function pushChecked(server: FakeSendo, before: number) {
    await expect
      .poll(() => server.requests.filter((r) => r.startsWith("GET /push")).length)
      .toBeGreaterThan(before);
  }
  const pushChecks = (server: FakeSendo) =>
    server.requests.filter((r) => r.startsWith("GET /push")).length;

  test("この端末で受けていなければ、ベルを付けたときに勧め、Turn on notifications で登録する", async ({
    page,
    context,
  }) => {
    const server = seed();
    await routeFakeSendo(context, server);
    await stubPush(context);
    await page.goto("/manage");
    await signIn(page);
    await bell(page, "Blog").click();
    await expect(suggestion(page)).toBeVisible();
    // ベルの表示は、勧めを待たずに変わっている
    await expect(bell(page, "Blog")).toHaveAttribute("aria-pressed", "true");
    await page.getByRole("button", { name: "Turn on notifications", exact: true }).click();
    await expect(suggestion(page)).toHaveCount(0);
    expect(server.pushRegistrations.size).toBe(1);
    expect((await stubState(page))?.requests).toBe(1);

    // 受けていれば勧めない
    const before = pushChecks(server);
    await bell(page, "News").click();
    await pushChecked(server, before);
    await expect(suggestion(page)).toHaveCount(0);
  });

  test("Dismiss で閉じたら、読み込み直すまで出さない", async ({ page, context }) => {
    const server = seed();
    await routeFakeSendo(context, server);
    await stubPush(context);
    await page.goto("/manage");
    await signIn(page);
    await bell(page, "Blog").click();
    await expect(suggestion(page)).toBeVisible();
    await page.getByRole("button", { name: "Dismiss", exact: true }).click();
    await expect(suggestion(page)).toHaveCount(0);
    await bell(page, "News").click();
    await expect(bell(page, "News")).toHaveAttribute("aria-pressed", "true");
    await page.waitForTimeout(300);
    await expect(suggestion(page)).toHaveCount(0);

    await page.reload();
    await bell(page, "News").click();
    await bell(page, "News").click();
    await expect(suggestion(page)).toBeVisible();
    // 起動しただけ、勧めを出しただけでは、許可を求めない
    expect((await stubState(page))?.requests ?? 0).toBe(0);
  });

  test("許可を拒否していたら、勧めない", async ({ page, context }) => {
    const server = seed();
    await routeFakeSendo(context, server);
    await stubPush(context, { permission: "denied", answer: "denied" });
    await page.goto("/manage");
    await signIn(page);
    const before = pushChecks(server);
    await bell(page, "Blog").click();
    await pushChecked(server, before);
    await page.waitForTimeout(300);
    await expect(suggestion(page)).toHaveCount(0);
  });

  test("Web Push を使えない Sendo では、勧めない", async ({ page, context }) => {
    const server = seed();
    server.push = "unavailable";
    await routeFakeSendo(context, server);
    await stubPush(context);
    await page.goto("/manage");
    await signIn(page);
    const before = pushChecks(server);
    await bell(page, "Blog").click();
    await pushChecked(server, before);
    await page.waitForTimeout(300);
    await expect(suggestion(page)).toHaveCount(0);
  });

  test("iPhone と iPad の Safari でホーム画面に追加していなければ、追加の仕方を勧める", async ({
    page,
    context,
  }) => {
    const server = seed();
    await routeFakeSendo(context, server);
    await context.addInitScript(() => {
      Object.defineProperty(Navigator.prototype, "standalone", { get: () => false });
      Reflect.deleteProperty(window, "PushManager");
      Reflect.deleteProperty(window, "Notification");
    });
    await page.goto("/manage");
    await signIn(page);
    await bell(page, "Blog").click();
    await expect(
      page.getByText("通知は、ホーム画面に追加したアプリでだけ受けられます。", { exact: false }),
    ).toBeVisible();
    await expect(page.getByRole("button", { name: "Turn on notifications" })).toHaveCount(0);

    // Settings にも同じ案内を出す
    await page.goto("/settings");
    await page.getByRole("tab", { name: "Notifications", exact: true }).click();
    await expect(
      page
        .getByRole("tabpanel")
        .getByText("通知は、ホーム画面に追加したアプリでだけ受けられます。", { exact: false }),
    ).toBeVisible();
  });
});
