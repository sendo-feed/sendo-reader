import { describe, expect, test, vi } from "vitest";
import {
  type AppUpdateEnvironment,
  type AppUpdateNotice,
  canReloadPage,
  UPDATE_CHECK_INTERVAL_MS,
  updateReadyMessage,
  watchAppUpdate,
} from "../src/lib/app-update";

const A = { commit: "aaaaaaa", builtAt: "2026-11-24T00:00:00.000Z" };
const B = { ...A, builtAt: "2026-11-24T00:00:01.000Z" };
const C = { ...A, commit: "ccccccc" };

/** にせものの画面と Service Worker */
function setup(
  options: {
    controlled?: boolean;
    visible?: boolean;
    unsupported?: boolean;
    server?: typeof A;
    fetch?: (init: RequestInit) => Promise<Response>;
  } = {},
) {
  const listeners = new Map<string, () => void>();
  const listenable = (prefix: string) => ({
    addEventListener: (type: string, listener: () => void) => {
      listeners.set(`${prefix}:${type}`, listener);
    },
  });
  const state = {
    visibility: (options.visible ?? true) ? "visible" : "hidden",
    controller: !options.unsupported && (options.controlled ?? true) ? {} : null,
    canReload: true,
    reloads: 0,
    checks: 0,
    notices: [] as (AppUpdateNotice | null)[],
    server: options.server ?? A,
    offline: false,
    requests: [] as { path: string; init: RequestInit }[],
    tick: () => {},
    install: "unchanged" as "unchanged" | "installing" | "unavailable",
  };
  let installing: (EventTarget & { state: ServiceWorkerState }) | null = null;
  const registration = Object.assign(new EventTarget(), {
    update: async () => {
      state.checks += 1;
      if (state.install === "unavailable") throw new Error("sw.js に届かない");
      if (state.install === "installing" && installing === null) {
        installing = Object.assign(new EventTarget(), {
          state: "installing" as ServiceWorkerState,
        });
        registration.dispatchEvent(new Event("updatefound"));
      }
    },
  });
  const workerRegistration = {
    get installing() {
      return installing;
    },
    waiting: null,
    addEventListener: (type: string, listener: () => void) =>
      registration.addEventListener(type, listener),
    removeEventListener: (type: string, listener: () => void) =>
      registration.removeEventListener(type, listener),
    update: registration.update,
  };
  const env: AppUpdateEnvironment = {
    serviceWorker: options.unsupported
      ? null
      : {
          ...listenable("sw"),
          get controller() {
            return state.controller;
          },
          register: () => Promise.resolve(workerRegistration),
        },
    version: A,
    fetch: (path, init) => {
      state.requests.push({ path, init });
      if (state.offline) return Promise.reject(new Error("オフライン"));
      return options.fetch?.(init) ?? Promise.resolve(Response.json(state.server));
    },
    document: {
      ...listenable("doc"),
      get visibilityState() {
        return state.visibility;
      },
    },
    reload: () => {
      state.reloads += 1;
    },
    canReload: () => state.canReload,
    setInterval: (fn, ms) => {
      expect(ms).toBe(UPDATE_CHECK_INTERVAL_MS);
      state.tick = fn;
      return 0;
    },
    onNotice: (notice) => state.notices.push(notice),
  };
  watchAppUpdate(env);
  return {
    state,
    finishInstall(workerState: "activated" | "redundant") {
      if (installing === null) throw new Error("取り込み中の worker がない");
      const worker = installing;
      installing = null;
      worker.state = workerState;
      worker.dispatchEvent(new Event("statechange"));
    },
    /** 新しい版の Service Worker が、画面を受け持ち始めた */
    newVersion: () => {
      state.controller = {};
      listeners.get("sw:controllerchange")?.();
    },
    show: () => {
      state.visibility = "visible";
      listeners.get("doc:visibilitychange")?.();
    },
    hide: () => {
      state.visibility = "hidden";
      listeners.get("doc:visibilitychange")?.();
    },
  };
}

/** 版の取得、登録、取り込みの通知を待つ */
const settle = () => new Promise((resolve) => setTimeout(resolve, 0));

describe("アプリの新しい版への切り替え", () => {
  test("画面が前に出たときと、一定の間隔で、新しい版を確かめる", async () => {
    const app = setup();
    await settle();
    expect(app.state.checks).toBe(0);
    app.hide();
    expect(app.state.checks).toBe(0);
    app.show();
    await settle();
    expect(app.state.checks).toBe(1);
    app.state.tick();
    await settle();
    expect(app.state.checks).toBe(2);
    expect(app.state.reloads).toBe(0);
  });

  test("読んでいる最中には読み込み直さず、裏に回ったときに読み込み直す", async () => {
    const app = setup();
    await settle();
    app.newVersion();
    expect(app.state.reloads).toBe(0);
    app.hide();
    expect(app.state.reloads).toBe(1);
    // 1 度だけ
    app.show();
    expect(app.state.reloads).toBe(1);
  });

  test("裏にある間に新しい版に替わったら、すぐ読み込み直す", async () => {
    const app = setup({ visible: false });
    await settle();
    app.newVersion();
    expect(app.state.reloads).toBe(1);
  });

  test("初めて入れたときの受け持ちの始まりでは、読み込み直さない", async () => {
    const app = setup({ controlled: false, visible: false });
    await settle();
    app.newVersion();
    await settle();
    expect(app.state.reloads).toBe(0);
    // そのあとの版の切り替えでは、読み込み直す
    app.newVersion();
    expect(app.state.reloads).toBe(1);
  });

  test("読み込み直すと消えるものを出している画面では待ち、ほかの画面に移ってから切り替える", async () => {
    const app = setup();
    await settle();
    app.state.canReload = false;
    app.newVersion();
    app.hide();
    app.show();
    expect(app.state.reloads).toBe(0);
    app.state.canReload = true;
    app.hide();
    expect(app.state.reloads).toBe(1);
  });
});

describe("新しい版の知らせ", () => {
  test("前に出ている間に替わったら、読み込み直さずに知らせる。裏に回れば、今までどおり読み込み直す", async () => {
    const app = setup();
    await settle();
    app.newVersion();
    expect(app.state.notices).toEqual(["ready"]);
    expect(app.state.reloads).toBe(0);
    app.hide();
    expect(app.state.reloads).toBe(1);
    expect(app.state.notices).toEqual(["ready"]);
  });

  test("初めて入れたときの受け持ちの始まりでは、知らせない", async () => {
    const app = setup({ controlled: false });
    await settle();
    app.newVersion();
    expect(app.state.notices).toEqual([]);
  });

  test("読み込み直す前に、さらに新しい版に替わったら、また知らせる", async () => {
    const app = setup();
    await settle();
    app.newVersion();
    app.newVersion();
    expect(app.state.notices).toEqual(["ready", "ready"]);
    expect(app.state.reloads).toBe(0);
  });

  test("読み込み直すと消えるものを出している画面で替わったときも知らせる（出すかは画面が決める）", async () => {
    const app = setup();
    await settle();
    app.state.canReload = false;
    app.newVersion();
    expect(app.state.notices).toEqual(["ready"]);
    app.hide();
    expect(app.state.reloads).toBe(0);
  });

  test("読み込み直すと消えるものを出している画面（パスと、出している間の印）", () => {
    for (const path of ["/settings", "/manage", "/add", "/oauth/authorize"]) {
      expect(canReloadPage(path, false)).toBe(false);
    }
    for (const path of ["/", "/starred", "/feeds/1", "/search"]) {
      expect(canReloadPage(path, false)).toBe(true);
    }
    expect(canReloadPage("/", true)).toBe(false);
  });

  test("ホーム画面のアプリとブラウザーで、文を分ける", () => {
    expect(updateReadyMessage(true)).toBe(
      "新しい版があります。Reload を押すか、アプリを開き直すと切り替わります。",
    );
    expect(updateReadyMessage(false)).toBe(
      "新しい版があります。Reload を押すか、ページを読み込み直すと切り替わります。",
    );
  });
});

describe("/version.json との比較", () => {
  test("起動・前面・定期確認で、キャッシュを通さずに取る", async () => {
    const app = setup({ unsupported: true });
    await settle();
    app.show();
    await settle();
    app.state.tick();
    await settle();
    expect(app.state.requests).toEqual(
      Array.from({ length: 3 }, () => ({
        path: "/version.json",
        init: { cache: "no-store", signal: expect.any(AbortSignal) },
      })),
    );
    expect(app.state.notices).toEqual([]);
  });

  test("worker がなければ新版を知らせ、次に裏に回ったときに取り直してから再読み込みする", async () => {
    const app = setup({ unsupported: true, server: B });
    await settle();
    expect(app.state.notices).toEqual(["ready"]);
    expect(app.state.reloads).toBe(0);
    app.hide();
    expect(app.state.reloads).toBe(0);
    await settle();
    expect(app.state.requests).toHaveLength(2);
    expect(app.state.reloads).toBe(1);
  });

  test("待っている間にさらに版が変われば知らせ直し、画面の版に戻れば消す", async () => {
    const app = setup({ unsupported: true, server: B });
    await settle();
    app.state.tick();
    await settle();
    expect(app.state.notices).toEqual(["ready"]);

    app.state.server = C;
    app.show();
    await settle();
    expect(app.state.notices).toEqual(["ready", "ready"]);
    expect(app.state.reloads).toBe(0);

    app.state.server = A;
    app.hide();
    await settle();
    expect(app.state.notices).toEqual(["ready", "ready", null]);
    expect(app.state.reloads).toBe(0);
  });

  test("裏に回ったときにオフラインでも、前に戻ってさらに新版を取れたら再読み込みする", async () => {
    const app = setup({ unsupported: true, server: B });
    await settle();
    app.state.offline = true;
    app.hide();
    await settle();
    expect(app.state.reloads).toBe(0);

    app.state.offline = false;
    app.state.server = C;
    app.show();
    await settle();
    expect(app.state.reloads).toBe(1);
  });

  test("自動で読み込み直すための取得中に窓を開いたら、閉じるまで待つ", async () => {
    const app = setup({ unsupported: true, server: B });
    await settle();
    app.hide();
    app.state.canReload = false;
    await settle();
    expect(app.state.reloads).toBe(0);
    app.state.canReload = true;
    app.show();
    await settle();
    expect(app.state.reloads).toBe(1);
  });

  test.each([
    () => Promise.reject(new Error("オフライン")),
    async () => new Response(null, { status: 404 }),
    async () => new Response("<!doctype html>"),
    async () => Response.json({ commit: "aaaaaaa", builtAt: "不明" }),
    async () => Response.json({ commit: "" }),
  ])("版が取れなければ、初めて worker が受け持ったときも知らせない", async (fetch) => {
    const app = setup({ controlled: false, fetch });
    await settle();
    app.newVersion();
    await settle();
    expect(app.state.notices).toEqual([]);
    expect(app.state.reloads).toBe(0);
  });

  test("初めて worker が受け持った時点で画面とサーバーの版が違えば知らせる", async () => {
    const app = setup({ controlled: false });
    await settle();
    app.state.server = B;
    app.newVersion();
    await settle();
    expect(app.state.notices).toEqual(["ready"]);
  });

  test("worker が取り込み中は待ち、失敗を知らせたあとで取り込めたら Reload の知らせに替える", async () => {
    const app = setup();
    await settle();
    app.state.server = B;
    app.state.install = "installing";
    app.show();
    await settle();
    expect(app.state.notices).toEqual([]);

    app.finishInstall("redundant");
    await settle();
    expect(app.state.notices).toEqual(["failed"]);
    app.hide();
    expect(app.state.reloads).toBe(0);
    app.show();
    await settle();
    app.finishInstall("redundant");
    await settle();
    expect(app.state.notices).toEqual(["failed"]);

    app.show();
    await settle();
    app.finishInstall("activated");
    app.newVersion();
    await settle();
    app.state.tick();
    await settle();
    expect(app.state.notices).toEqual(["failed", "ready"]);
  });

  test("取り込み中に別の確認が重なり、版を取れなくなっても取り込みの失敗を知らせる", async () => {
    const app = setup();
    await settle();
    app.state.server = B;
    app.state.install = "installing";
    app.show();
    await settle();

    app.state.offline = true;
    app.state.tick();
    await settle();
    app.finishInstall("redundant");
    await settle();
    expect(app.state.notices).toEqual(["failed"]);
    expect(app.state.checks).toBe(1);
  });

  test("版の応答が止まっても、時間切れのあとで worker の更新を確かめる", async () => {
    vi.useFakeTimers();
    try {
      const app = setup({
        fetch: ({ signal }) =>
          new Promise((_resolve, reject) => {
            signal?.addEventListener("abort", () => reject(signal.reason), { once: true });
          }),
      });
      app.show();
      await vi.runAllTimersAsync();
      expect(app.state.checks).toBe(1);
    } finally {
      vi.useRealTimers();
    }
  });

  test("版の応答が遅い間に別の取得が失敗しても、遅れて届いた新版の取り込みを試す", async () => {
    let sendVersion: (response: Response) => void = () => {};
    const response = new Promise<Response>((resolve) => {
      sendVersion = resolve;
    });
    const fetch = vi
      .fn()
      .mockResolvedValueOnce(Response.json(A))
      .mockReturnValueOnce(response)
      .mockRejectedValueOnce(new Error("一時的に通信できない"));
    const app = setup({ fetch });
    await settle();
    app.state.install = "installing";
    app.show();
    app.state.tick();
    await settle();
    expect(app.state.checks).toBe(0);

    sendVersion(Response.json(B));
    await settle();
    app.finishInstall("redundant");
    await settle();
    expect(app.state.notices).toEqual(["failed"]);
  });

  test("B を取り込んでいる間に C を見つけたら、B の結果を使わずに C を取り込む", async () => {
    const app = setup();
    await settle();
    app.state.server = B;
    app.state.install = "installing";
    app.show();
    await settle();
    app.state.server = C;
    app.state.tick();
    await settle();
    expect(app.state.checks).toBe(1);

    app.finishInstall("redundant");
    await settle();
    expect(app.state.notices).toEqual([]);
    expect(app.state.checks).toBe(2);
    app.finishInstall("activated");
    app.newVersion();
    await settle();
    expect(app.state.notices).toEqual(["ready"]);
  });

  test("sw.js に届かなくても知らせず、取り込む worker がなかったときは Reload を知らせる", async () => {
    const app = setup();
    await settle();
    app.state.server = B;
    app.state.install = "unavailable";
    app.show();
    await settle();
    expect(app.state.notices).toEqual([]);
    app.state.install = "unchanged";
    app.show();
    await settle();
    expect(app.state.notices).toEqual(["ready"]);
  });
});
