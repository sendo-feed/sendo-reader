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
  /** requestPermission を呼んだ数 */
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
        const key = options?.applicationServerKey;
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
  expect((await stubState(page))?.requests ?? 0).toBe(0);
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
  await page.evaluate(() => navigator.serviceWorker.ready);
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

/** Service Worker が IndexedDB に覚えた通知（docs/decisions/notifications.md の 8・10） */
const rememberedTags = (page: Page) =>
  page.evaluate(
    () =>
      new Promise<unknown[]>((resolve, reject) => {
        const request = indexedDB.open("sendo-reader-notifications");
        request.onerror = () => reject(request.error);
        request.onsuccess = () => {
          const db = request.result;
          if (!db.objectStoreNames.contains("tags")) {
            db.close();
            resolve([]);
            return;
          }
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
