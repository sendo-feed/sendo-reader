import { ApiError, type PushRegistration, type PushStatus } from "@sendo-reader/core";
import { afterEach, describe, expect, test, vi } from "vitest";
import { AccountChangedError } from "../src/lib/account";
import {
  browserSupport,
  checkDevice,
  decodeBase64Url,
  forgetDevice,
  type PushEnvironment,
  type PushSubscriptionLike,
  resendOnStartup,
  type ServiceWorkerInstallLike,
  type ServiceWorkerReadiness,
  turnOff,
  turnOn,
  waitForServiceWorker,
} from "../src/lib/push";

// account.ts のアカウントの窓口は、読み込むときに同じオリジンの API の場所を決める
vi.hoisted(() => {
  Object.assign(globalThis, { location: { href: "https://reader.test/" } });
});

/** P-256 の非圧縮の点（65 バイト）の base64url の形をした、鍵 2 つ */
const KEY = `B${"A".repeat(86)}`;
const OTHER_KEY = `B${"Q".repeat(86)}`;

/** ブラウザーの登録のにせもの。toJSON は PushSubscription.toJSON() の形 */
function subscription(key: string, endpoint = "https://push.example/a"): PushSubscriptionLike {
  return {
    options: { applicationServerKey: decodeBase64Url(key).buffer },
    toJSON: () => ({ endpoint, expirationTime: null, keys: { p256dh: "BKey", auth: "secret" } }),
    unsubscribe: async () => true,
  };
}

/**
 * にせものの環境。起きたことを順に events に覚える。sendo の答えと、ブラウザーの登録・許可の様子は、
 * テストが options で決める
 */
function setup(
  options: {
    support?: PushEnvironment["support"];
    permission?: NotificationPermission;
    /** requestPermission が返す答え。Error なら投げる */
    answer?: NotificationPermission | Error;
    readiness?: ServiceWorkerReadiness;
    subscription?: PushSubscriptionLike | null;
    /** subscribe で作る登録の endpoint。null なら断る */
    subscribeEndpoint?: string | null;
    /**
     * 最初のロックを先に取ったほかのタブが、済ませておく操作。subscribe は同じ鍵（KEY）の登録を
     * 作り、unsubscribe は登録を外す
     */
    otherTab?: "subscribe" | "unsubscribe";
    status?: PushStatus | Error;
    put?: Error;
    del?: Error;
    confirm?: Error;
    unsubscribe?: Error;
  } = {},
) {
  const events: string[] = [];
  let permission = options.permission ?? "default";
  let otherTab = options.otherTab;
  let current: PushSubscriptionLike | null = null;
  /** ブラウザーの登録にする（unsubscribe で外れる） */
  const install = (value: PushSubscriptionLike): PushSubscriptionLike => {
    const installed: PushSubscriptionLike = {
      ...value,
      unsubscribe: async () => {
        events.push(`unsubscribe ${value.toJSON().endpoint}`);
        if (options.unsubscribe !== undefined) throw options.unsubscribe;
        if (current === installed) current = null;
        return true;
      },
    };
    current = installed;
    return installed;
  };
  if (options.subscription) install(options.subscription);
  const put: PushRegistration[] = [];
  const env: PushEnvironment = {
    support: options.support ?? "supported",
    permission: () => permission,
    requestPermission: async () => {
      events.push("requestPermission");
      if (options.answer instanceof Error) throw options.answer;
      permission = options.answer ?? permission;
      return permission;
    },
    ready: async () => options.readiness ?? "ready",
    registration: async () => ({
      pushManager: {
        getSubscription: async () => {
          events.push("getSubscription");
          return current;
        },
        subscribe: async ({ userVisibleOnly, applicationServerKey }) => {
          events.push(`subscribe ${applicationServerKey.length}`);
          // 本物と同じく、通知を出す約束のない登録と、許可のない登録は断る
          if (!userVisibleOnly) throw new DOMException("userVisibleOnly でない", "NotAllowedError");
          if (permission !== "granted") throw new DOMException("許可がない", "NotAllowedError");
          if (options.subscribeEndpoint === null)
            throw new DOMException("断った", "NotAllowedError");
          return install(
            subscription(KEY, options.subscribeEndpoint ?? "https://push.example/new"),
          );
        },
      },
      getNotifications: async () => [{ close: () => events.push("close notification") }],
    }),
    lock: async (task) => {
      events.push("lock");
      if (otherTab === "subscribe") {
        events.push("other tab: subscribe");
        install(subscription(KEY, "https://push.example/other"));
      } else if (otherTab === "unsubscribe") {
        events.push("other tab: unsubscribe");
        current = null;
      }
      otherTab = undefined;
      return task();
    },
    sendo: {
      getPush: async () => {
        events.push("GET /push");
        if (options.status instanceof Error) throw options.status;
        return options.status ?? { available: true, publicKey: KEY };
      },
      putRegistration: async (registration) => {
        events.push("PUT /push/registration");
        if (options.put !== undefined) throw options.put;
        put.push(registration);
      },
      deleteRegistration: async () => {
        events.push("DELETE /push/registration");
        if (options.del !== undefined) throw options.del;
      },
      confirmUser: async () => {
        events.push("GET /me");
        if (options.confirm !== undefined) throw options.confirm;
      },
    },
    refreshBadge: () => events.push("refresh badge"),
    clearShownTags: async () => {
      events.push("clear tags");
    },
  };
  return { env, events, put, subscribed: () => current !== null };
}

describe("ブラウザーの見分け", () => {
  test.each([
    // iPhone と iPad の Safari の、ホーム画面のアプリでないタブ
    [
      { standalone: false, notification: false, serviceWorker: true, pushManager: false },
      "ios-home-screen",
    ],
    // standalone が false でも PushManager があれば（macOS の Safari のタブなど）、案内しない
    [
      { standalone: false, notification: true, serviceWorker: true, pushManager: true },
      "supported",
    ],
    [{ standalone: true, notification: true, serviceWorker: true, pushManager: true }, "supported"],
    [
      { standalone: undefined, notification: true, serviceWorker: true, pushManager: true },
      "supported",
    ],
    // standalone がない（iOS でない）ブラウザーで PushManager がなければ、使えない
    [
      { standalone: undefined, notification: true, serviceWorker: true, pushManager: false },
      "unsupported",
    ],
    [
      { standalone: undefined, notification: false, serviceWorker: true, pushManager: true },
      "unsupported",
    ],
    [
      { standalone: undefined, notification: true, serviceWorker: false, pushManager: true },
      "unsupported",
    ],
  ] as const)("%o は %s", (globals, expected) => {
    expect(browserSupport(globals)).toBe(expected);
  });
});

describe("この端末を確かめる", () => {
  test("iPhone と iPad の案内は、Web Push を使える Sendo でだけ出す", async () => {
    expect(await checkDevice(setup({ support: "ios-home-screen" }).env)).toEqual({
      kind: "ios-home-screen",
    });
    const unavailable = setup({ support: "ios-home-screen", status: { available: false } });
    expect(await checkDevice(unavailable.env)).toEqual({ kind: "unavailable", subscribed: false });
    const offline = setup({ support: "ios-home-screen", status: new ApiError("network", "x") });
    expect(await checkDevice(offline.env)).toEqual({ kind: "unreachable" });
  });

  test("使えないブラウザーには、sendo に聞かずに使えないと出す", async () => {
    const { env, events } = setup({ support: "unsupported" });
    expect(await checkDevice(env)).toEqual({ kind: "unsupported" });
    expect(events).toEqual([]);
  });

  test("Service Worker を登録できなかった、取り込みが redundant で終わったら、使えないブラウザー", async () => {
    expect(await checkDevice(setup({ readiness: "unsupported" }).env)).toEqual({
      kind: "unsupported",
    });
  });

  test.each([
    ["届かない", new ApiError("network", "x"), { kind: "unreachable" }],
    ["5xx", new ApiError("server", "x", 503), { kind: "unreachable" }],
    ["401 と 404 以外の 4xx", new ApiError("invalid", "x", 400), { kind: "unreachable" }],
    ["形の読めない応答", new SyntaxError("JSON"), { kind: "unreachable" }],
  ])("GET /api/v1/push が %s なら、使えるかが分からない", async (_name, failure, expected) => {
    expect(await checkDevice(setup({ status: failure }).env)).toEqual(expected);
  });

  test("401 なら、ログインし直すよう促す", async () => {
    const error = new ApiError("unauthorized", "x", 401);
    expect(await checkDevice(setup({ status: error }).env)).toEqual({
      kind: "unauthorized",
      error,
    });
  });

  test("Web Push を使えない Sendo（available が false か 404）では、受けている登録があれば外す操作を出す", async () => {
    expect(await checkDevice(setup({ status: { available: false } }).env)).toEqual({
      kind: "unavailable",
      subscribed: false,
    });
    const subscribed = setup({
      status: { available: false },
      permission: "granted",
      subscription: subscription(KEY),
    });
    expect(await checkDevice(subscribed.env)).toEqual({ kind: "unavailable", subscribed: true });
  });

  test("Service Worker の ready が上限までに返らなければ、確かめられない", async () => {
    expect(await checkDevice(setup({ readiness: "timeout" }).env)).toEqual({
      kind: "unreachable",
    });
  });

  test("受けているかは、ブラウザーの登録があり、許可が granted かで決める", async () => {
    expect(await checkDevice(setup().env)).toEqual({ kind: "off", publicKey: KEY });
    expect(await checkDevice(setup({ permission: "denied" }).env)).toEqual({
      kind: "denied",
      publicKey: KEY,
    });
    const on = setup({ permission: "granted", subscription: subscription(KEY) });
    expect(await checkDevice(on.env)).toEqual({ kind: "on" });
    // 許可してあっても、登録がなければ受けていない
    expect(await checkDevice(setup({ permission: "granted" }).env)).toEqual({
      kind: "off",
      publicKey: KEY,
    });
    // 登録が残っていても、許可が granted でなければ受けていない
    const revoked = setup({ permission: "default", subscription: subscription(KEY) });
    expect(await checkDevice(revoked.env)).toEqual({ kind: "off", publicKey: KEY });
  });

  test("登録はロックの中で読み、ほかのタブが作り終えた登録を見る", async () => {
    const { env, events } = setup({ permission: "granted", otherTab: "subscribe" });
    expect(await checkDevice(env)).toEqual({ kind: "on" });
    expect(events).toEqual(["GET /push", "lock", "other tab: subscribe", "getSubscription"]);
  });
});

describe("Turn on notifications", () => {
  test("押したら待たずに許可を求め、許可されたらロックの中で登録を作って送る", async () => {
    const { env, events, put, subscribed } = setup({ answer: "granted" });
    const result = turnOn(env, KEY);
    // 利用者の操作のすぐあとに求める（呼んだその場で、待ちを挟まない）
    expect(events).toEqual(["requestPermission"]);
    expect(await result).toEqual({ kind: "on" });
    expect(events).toEqual([
      "requestPermission",
      "refresh badge",
      "lock",
      "getSubscription",
      "subscribe 65",
      "GET /me",
      "PUT /push/registration",
    ]);
    expect(put).toEqual([
      { endpoint: "https://push.example/new", keys: { p256dh: "BKey", auth: "secret" } },
    ]);
    expect(subscribed()).toBe(true);
  });

  test("許可の窓を決めずに閉じたら、何もせずに戻す。拒んだら登録しない", async () => {
    const dismissed = setup({ answer: "default" });
    expect(await turnOn(dismissed.env, KEY)).toEqual({ kind: "dismissed" });
    expect(dismissed.events).toEqual(["requestPermission"]);
    const denied = setup({ answer: "denied" });
    expect(await turnOn(denied.env, KEY)).toEqual({ kind: "denied" });
    expect(denied.events).toEqual(["requestPermission"]);
  });

  test("許可を求めるのに失敗したら、ロックを取らずに受けられなかったと返す", async () => {
    const { env, events } = setup({ answer: new TypeError("requestPermission がない") });
    expect(await turnOn(env, KEY)).toEqual({ kind: "subscribe-failed" });
    expect(events).toEqual(["requestPermission"]);
  });

  test("ブラウザーが登録を断ったら、送らずに受けられなかったと返す", async () => {
    const { env, events } = setup({ answer: "granted", subscribeEndpoint: null });
    expect(await turnOn(env, KEY)).toEqual({ kind: "subscribe-failed" });
    expect(events).not.toContain("PUT /push/registration");
  });

  test("sendo に送れなかったら、作った登録を外す（もう一度押せる）", async () => {
    const failure = new ApiError("network", "x");
    const { env, subscribed } = setup({ answer: "granted", put: failure });
    expect(await turnOn(env, KEY)).toEqual({ kind: "send-failed", error: failure });
    expect(subscribed()).toBe(false);
  });

  test("セッションが別のユーザーなら、送らずに作った登録を外す", async () => {
    const failure = new AccountChangedError();
    const { env, events, subscribed } = setup({ answer: "granted", confirm: failure });
    expect(await turnOn(env, KEY)).toEqual({ kind: "send-failed", error: failure });
    expect(events).not.toContain("PUT /push/registration");
    expect(subscribed()).toBe(false);
  });

  test("残っていた登録の鍵が違えば、外して作り直してから送る", async () => {
    const { env, events } = setup({
      permission: "granted",
      answer: "granted",
      subscription: subscription(OTHER_KEY, "https://push.example/old"),
    });
    expect(await turnOn(env, KEY)).toEqual({ kind: "on" });
    expect(events.slice(3)).toEqual([
      "getSubscription",
      "unsubscribe https://push.example/old",
      "subscribe 65",
      "GET /me",
      "PUT /push/registration",
    ]);
  });

  test("ロックを待つ間に、ほかのタブが同じ鍵の登録を作っていたら、作らずにその登録を送る", async () => {
    const { env, events, put } = setup({ answer: "granted", otherTab: "subscribe" });
    expect(await turnOn(env, KEY)).toEqual({ kind: "on" });
    expect(events).toEqual([
      "requestPermission",
      "refresh badge",
      "lock",
      "other tab: subscribe",
      "getSubscription",
      "GET /me",
      "PUT /push/registration",
    ]);
    expect(put.map((r) => r.endpoint)).toEqual(["https://push.example/other"]);
  });
});

describe("Turn off notifications", () => {
  test("sendo の登録を外し、届かなくてもブラウザーの登録は外す", async () => {
    const { env, events, subscribed } = setup({
      permission: "granted",
      subscription: subscription(KEY),
      del: new ApiError("network", "x"),
    });
    await turnOff(env);
    expect(events).toEqual([
      "lock",
      "getSubscription",
      "GET /me",
      "DELETE /push/registration",
      "unsubscribe https://push.example/a",
    ]);
    expect(subscribed()).toBe(false);
  });
});

describe("起動したときの送り直し", () => {
  test("登録がなければ、何も聞かない", async () => {
    const { env, events } = setup({ permission: "granted" });
    await resendOnStartup(env);
    expect(events).toEqual(["lock", "getSubscription"]);
  });

  test("ロックを待つ間に、ほかのタブが登録を外したら、何もしない", async () => {
    const { env, events, put } = setup({
      permission: "granted",
      subscription: subscription(KEY),
      otherTab: "unsubscribe",
    });
    await resendOnStartup(env);
    expect(events).toEqual(["lock", "other tab: unsubscribe", "getSubscription"]);
    expect(put).toEqual([]);
  });

  test("許可が granted でなければ、GET /api/v1/push によらずに外す", async () => {
    const { env, events, subscribed } = setup({
      permission: "denied",
      subscription: subscription(KEY),
    });
    await resendOnStartup(env);
    expect(events).toEqual(["lock", "getSubscription", "unsubscribe https://push.example/a"]);
    expect(subscribed()).toBe(false);
  });

  test("使える Sendo なら、同じ登録を送り直す", async () => {
    const { env, put } = setup({ permission: "granted", subscription: subscription(KEY) });
    await resendOnStartup(env);
    expect(put.map((r) => r.endpoint)).toEqual(["https://push.example/a"]);
  });

  test("公開鍵が登録の鍵と違えば、外して作り直してから送る", async () => {
    const { env, events, put } = setup({
      permission: "granted",
      subscription: subscription(OTHER_KEY, "https://push.example/old"),
    });
    await resendOnStartup(env);
    expect(events).toEqual([
      "lock",
      "getSubscription",
      "GET /push",
      "unsubscribe https://push.example/old",
      "subscribe 65",
      "GET /me",
      "PUT /push/registration",
    ]);
    expect(put.map((r) => r.endpoint)).toEqual(["https://push.example/new"]);
  });

  test("作り直しを断られたら、外したまま（受けない状態）で、画面には何も返さない", async () => {
    const { env, subscribed } = setup({
      permission: "granted",
      subscription: subscription(OTHER_KEY),
      subscribeEndpoint: null,
    });
    await resendOnStartup(env);
    expect(subscribed()).toBe(false);
  });

  test("使えない Sendo、届かない、401 なら、送り直さず、外しもしない", async () => {
    for (const status of [
      { available: false } as const,
      new ApiError("network", "x"),
      new ApiError("unauthorized", "x", 401),
    ]) {
      const { env, events, subscribed } = setup({
        permission: "granted",
        subscription: subscription(KEY),
        status,
      });
      await resendOnStartup(env);
      expect(events).toEqual(["lock", "getSubscription", "GET /push"]);
      expect(subscribed()).toBe(true);
    }
  });

  test("セッションが別のユーザーなら、送らずに、ユーザーが替わったときと同じく外す", async () => {
    const { env, events, subscribed } = setup({
      permission: "granted",
      subscription: subscription(KEY),
      confirm: new AccountChangedError(),
    });
    await resendOnStartup(env);
    expect(events).not.toContain("PUT /push/registration");
    expect(events.slice(-4)).toEqual([
      "unsubscribe https://push.example/a",
      "close notification",
      "clear tags",
      "refresh badge",
    ]);
    expect(subscribed()).toBe(false);
  });

  test("ホーム画面に追加していない iPhone や、使えないブラウザーでは何もしない", async () => {
    for (const support of ["ios-home-screen", "unsupported"] as const) {
      const { env, events } = setup({ support, subscription: subscription(KEY) });
      await resendOnStartup(env);
      expect(events).toEqual([]);
    }
  });
});

describe("ログアウトとユーザーの切り替え", () => {
  test("登録を外し終えてから、通知を閉じ、覚えた tag を消し、バッジを手元の数で書き直す。sendo には送らない", async () => {
    const { env, events, subscribed } = setup({
      permission: "granted",
      subscription: subscription(KEY),
    });
    await forgetDevice(env);
    expect(events).toEqual([
      "lock",
      "getSubscription",
      "unsubscribe https://push.example/a",
      "close notification",
      "clear tags",
      "refresh badge",
    ]);
    expect(subscribed()).toBe(false);
  });

  test("unsubscribe() が投げても、通知を閉じ、tag を消し、バッジを書き直す", async () => {
    const { env, events } = setup({
      permission: "granted",
      subscription: subscription(KEY),
      unsubscribe: new DOMException("外せない", "InvalidStateError"),
    });
    await forgetDevice(env);
    expect(events.slice(-3)).toEqual(["close notification", "clear tags", "refresh badge"]);
  });
});

describe("Service Worker が動くのを待つ", () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  /** 取り込み中の版のにせもの。become で状態を変え、statechange を起こす */
  function installing(state: ServiceWorkerState) {
    const listeners: (() => void)[] = [];
    const worker = {
      state,
      addEventListener: (_type: "statechange", listener: () => void) => listeners.push(listener),
    };
    const become = (next: ServiceWorkerState) => {
      worker.state = next;
      for (const listener of listeners) listener();
    };
    return { worker, become };
  }

  /** 待ち始め、決まった答えを読めるようにする（決まっていなければ undefined） */
  function wait(ready: Promise<unknown>, registering: Promise<ServiceWorkerInstallLike> | null) {
    vi.useFakeTimers();
    let readiness: ServiceWorkerReadiness | undefined;
    void waitForServiceWorker(ready, registering).then((value) => {
      readiness = value;
    });
    return () => readiness;
  }

  const never = new Promise<never>(() => {});

  test("ready が返れば、動いている", async () => {
    let start = () => {};
    const ready = new Promise<void>((resolve) => {
      start = resolve;
    });
    const readiness = wait(
      ready,
      Promise.resolve({ active: null, installing: null, waiting: null }),
    );
    await vi.advanceTimersByTimeAsync(1_000);
    expect(readiness()).toBeUndefined();
    start();
    await vi.advanceTimersByTimeAsync(0);
    expect(readiness()).toBe("ready");
  });

  test("ready が返らなければ、ちょうど 10 秒で、確かめられないとする", async () => {
    // 手元の dev サーバーは登録しない
    const readiness = wait(never, null);
    await vi.advanceTimersByTimeAsync(9_999);
    expect(readiness()).toBeUndefined();
    await vi.advanceTimersByTimeAsync(1);
    expect(readiness()).toBe("timeout");
  });

  test("登録できなければ、上限を待たずに使えないとする", async () => {
    const readiness = wait(
      never,
      Promise.reject(new DOMException("登録できない", "SecurityError")),
    );
    await vi.advanceTimersByTimeAsync(0);
    expect(readiness()).toBe("unsupported");
  });

  test("動いている版がないまま、取り込みが redundant で終わったら、上限を待たずに使えないとする", async () => {
    const worker = installing("installing");
    const readiness = wait(
      never,
      Promise.resolve({ active: null, installing: worker.worker, waiting: null }),
    );
    await vi.advanceTimersByTimeAsync(1_000);
    expect(readiness()).toBeUndefined();
    worker.become("redundant");
    await vi.advanceTimersByTimeAsync(0);
    expect(readiness()).toBe("unsupported");

    // 登録の結果を受けたときに、もう redundant で終わっていた
    const finished = installing("redundant");
    const already = wait(
      never,
      Promise.resolve({ active: null, installing: null, waiting: finished.worker }),
    );
    await vi.advanceTimersByTimeAsync(0);
    expect(already()).toBe("unsupported");
  });

  test("動いている版があれば、新しい版の取り込みが redundant で終わっても、ready を待つ", async () => {
    const worker = installing("installing");
    const readiness = wait(
      never,
      Promise.resolve({ active: {}, installing: worker.worker, waiting: null }),
    );
    await vi.advanceTimersByTimeAsync(0);
    worker.become("redundant");
    await vi.advanceTimersByTimeAsync(9_999);
    expect(readiness()).toBeUndefined();
    await vi.advanceTimersByTimeAsync(1);
    expect(readiness()).toBe("timeout");
  });
});
