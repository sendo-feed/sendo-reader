import { describe, expect, test } from "vitest";
import {
  type AppUpdateEnvironment,
  canReloadAt,
  updateReadyMessage,
  watchAppUpdate,
} from "../src/lib/app-update";

/** にせものの画面と Service Worker */
function setup(options: { controlled?: boolean; visible?: boolean } = {}) {
  const listeners = new Map<string, () => void>();
  const listenable = (prefix: string) => ({
    addEventListener: (type: string, listener: () => void) => {
      listeners.set(`${prefix}:${type}`, listener);
    },
  });
  const state = {
    visibility: (options.visible ?? true) ? "visible" : "hidden",
    controller: (options.controlled ?? true) ? {} : null,
    canReload: true,
    reloads: 0,
    checks: 0,
    /** 新しい版に替わったと画面に知らせた回数 */
    ready: 0,
    tick: () => {},
  };
  const env: AppUpdateEnvironment = {
    container: {
      ...listenable("sw"),
      get controller() {
        return state.controller;
      },
    },
    register: () =>
      Promise.resolve({
        update: () => {
          state.checks += 1;
          return Promise.resolve();
        },
      }),
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
    setInterval: (fn) => {
      state.tick = fn;
      return 0;
    },
    onUpdateReady: () => {
      state.ready += 1;
    },
  };
  watchAppUpdate(env);
  return {
    state,
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

/** 登録の完了を待つ */
const settle = () => new Promise((resolve) => setTimeout(resolve, 0));

describe("アプリの新しい版への切り替え", () => {
  test("画面が前に出たときと、一定の間隔で、新しい版を確かめる", async () => {
    const app = setup();
    await settle();
    expect(app.state.checks).toBe(0);
    app.hide();
    expect(app.state.checks).toBe(0);
    app.show();
    expect(app.state.checks).toBe(1);
    app.state.tick();
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
    expect(app.state.ready).toBe(1);
    expect(app.state.reloads).toBe(0);
    app.hide();
    expect(app.state.reloads).toBe(1);
    expect(app.state.ready).toBe(1);
  });

  test("初めて入れたときの受け持ちの始まりでは、知らせない", async () => {
    const app = setup({ controlled: false });
    await settle();
    app.newVersion();
    expect(app.state.ready).toBe(0);
  });

  test("読み込み直す前に、さらに新しい版に替わったら、また知らせる", async () => {
    const app = setup();
    await settle();
    app.newVersion();
    app.newVersion();
    expect(app.state.ready).toBe(2);
    expect(app.state.reloads).toBe(0);
  });

  test("読み込み直すと消えるものを出している画面で替わったときも知らせる（出すかは画面が決める）", async () => {
    const app = setup();
    await settle();
    app.state.canReload = false;
    app.newVersion();
    expect(app.state.ready).toBe(1);
    app.hide();
    expect(app.state.reloads).toBe(0);
  });

  test("読み込み直すと消えるものを出している画面のパス", () => {
    for (const path of ["/settings", "/manage", "/add", "/oauth/authorize"]) {
      expect(canReloadAt(path)).toBe(false);
    }
    for (const path of ["/", "/starred", "/feeds/1", "/search"]) {
      expect(canReloadAt(path)).toBe(true);
    }
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
