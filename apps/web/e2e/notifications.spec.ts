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

test("ログアウトすると、この端末の登録を外し、sendo の登録もセッションと一緒に消える", async ({
  page,
  context,
}) => {
  const server = new FakeSendo();
  await routeFakeSendo(context, server);
  await stubPush(context);
  await openNotifications(page);
  await turnOnButton(page).click();
  await expect(page.getByText("この端末で通知を受けています。")).toBeVisible();

  await page.goto("/");
  await page.getByRole("button", { name: "Sign out", exact: true }).click();
  await expect(page.getByRole("button", { name: "Google でログイン" })).toBeVisible();
  await expect.poll(async () => (await stubState(page))?.subscription ?? null).toBeNull();
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
