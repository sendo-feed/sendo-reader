import { describe, expect, test } from "vitest";
import type { SyncStatus } from "../src/sync/scheduler";
import {
  GOING_AWAY_DELAY_MS,
  RECONNECT_DELAYS_MS,
  SESSION_CHECK_DELAY_MS,
  STABLE_CONNECTION_MS,
  SyncUpdates,
  syncUpdatesUrl,
  TRY_AGAIN_LATER_DELAY_MS,
  type WebSocketLike,
} from "../src/sync/updates";

class FakeSocket implements WebSocketLike {
  onopen: ((event: unknown) => void) | null = null;
  onmessage: ((event: { data: unknown }) => void) | null = null;
  onclose: ((event: { code: number }) => void) | null = null;
  onerror: ((event: unknown) => void) | null = null;
  closedWith: number | null = null;

  close(code?: number): void {
    this.closedWith = code ?? 1005;
  }
  open(): void {
    this.onopen?.({});
  }
  send(data: unknown): void {
    this.onmessage?.({ data });
  }
  /** サーバーが閉じた（または、つながらなかった） */
  end(code: number): void {
    this.onerror?.({});
    this.onclose?.({ code });
  }
}

function status(patch: Partial<SyncStatus> = {}): SyncStatus {
  return {
    signedIn: true,
    user: { id: "u1", email: "a@example.com" },
    syncing: false,
    lastSyncedAt: null,
    error: null,
    pending: 0,
    logoutPending: false,
    savedPageError: null,
    ...patch,
  };
}

function setup(options: { connectThrows?: boolean } = {}) {
  let now = 0;
  const timers: { fn: () => void; at: number; id: number }[] = [];
  let nextId = 1;
  const sockets: FakeSocket[] = [];
  const calls = { sync: 0, checkSession: 0 };
  const updates = new SyncUpdates({
    connect: () => {
      if (options.connectThrows) throw new SyntaxError("bad url");
      const socket = new FakeSocket();
      sockets.push(socket);
      return socket;
    },
    requestSync: () => {
      calls.sync += 1;
    },
    checkSession: () => {
      calls.checkSession += 1;
    },
    now: () => now,
    random: () => 0,
    setTimeout: (fn, ms) => {
      const id = nextId++;
      timers.push({ fn, at: now + ms, id });
      return id;
    },
    clearTimeout: (handle) => {
      const index = timers.findIndex((timer) => timer.id === handle);
      if (index >= 0) timers.splice(index, 1);
    },
  });
  /** ms だけ時間を進め、そのあいだの予定を動かす */
  const advance = (ms: number) => {
    now += ms;
    for (;;) {
      timers.sort((a, b) => a.at - b.at);
      const next = timers[0];
      if (next === undefined || next.at > now) break;
      timers.shift();
      next.fn();
    }
  };
  /** 次の予定までの時間 */
  const nextDelay = () => {
    const at = Math.min(...timers.map((timer) => timer.at));
    return Number.isFinite(at) ? at - now : null;
  };
  const last = () => {
    const socket = sockets.at(-1);
    if (socket === undefined) throw new Error("つないでいない");
    return socket;
  };
  return { updates, sockets, calls, advance, nextDelay, last };
}

describe("sendo の通知", () => {
  test("ログインしたらつなぎ、開いたときと sync_required を受けたときに同期を頼む", () => {
    const { updates, sockets, calls, last } = setup();
    updates.update(status({ signedIn: false, user: null }));
    expect(sockets).toHaveLength(0);

    updates.update(status());
    expect(sockets).toHaveLength(1);
    last().open();
    expect(updates.connected).toBe(true);
    expect(calls.sync).toBe(1);

    last().send(JSON.stringify({ type: "sync_required" }));
    expect(calls.sync).toBe(2);
    // 知らない形や、こわれた知らせでは同期しない
    last().send(JSON.stringify({ type: "something_new" }));
    last().send("not json");
    last().send(new Uint8Array([1]));
    expect(calls.sync).toBe(2);

    // 同期の様子が変わっても、つなぎ直さない
    updates.update(status({ syncing: true }));
    updates.update(status({ lastSyncedAt: 1 }));
    expect(sockets).toHaveLength(1);
  });

  test("ログアウトしたときと、同期が 401 を返したときは閉じ、ログインし直したらつなぐ", () => {
    const { updates, sockets, calls, advance, nextDelay } = setup();
    updates.update(status());
    sockets[0]?.open();
    updates.update(status({ signedIn: false, user: null }));
    expect(sockets[0]?.closedWith).toBe(1000);
    expect(nextDelay()).toBeNull();

    updates.update(status());
    expect(sockets).toHaveLength(2);
    updates.update(status({ error: "unauthorized" }));
    expect(sockets[1]?.closedWith).toBe(1000);
    advance(RECONNECT_DELAYS_MS.at(-1) ?? 0);
    expect(sockets).toHaveLength(2);

    updates.update(status());
    expect(sockets).toHaveLength(3);
    // 閉じた接続のあとの知らせは受けない
    sockets[0]?.send(JSON.stringify({ type: "sync_required" }));
    expect(calls.sync).toBe(1);
  });

  test("つながらなければ、間を延ばしながらつなぎ直す", () => {
    const { updates, sockets, advance, nextDelay, last } = setup();
    updates.update(status());
    for (const delay of [...RECONNECT_DELAYS_MS, RECONNECT_DELAYS_MS.at(-1) ?? 0]) {
      // 101 の前に断られたときも、ブラウザからは 1006 に見える
      last().end(1006);
      expect(nextDelay()).toBe(delay);
      advance(delay);
    }
    expect(sockets).toHaveLength(RECONNECT_DELAYS_MS.length + 2);
  });

  test("長く開いていた接続が切れたら、つなぎ直しの間を最初に戻す", () => {
    const { updates, advance, nextDelay, last } = setup();
    updates.update(status());
    last().end(1006);
    advance(nextDelay() ?? 0);
    last().end(1006);
    expect(nextDelay()).toBe(RECONNECT_DELAYS_MS[1]);
    advance(nextDelay() ?? 0);

    last().open();
    advance(STABLE_CONNECTION_MS);
    last().end(1006);
    expect(nextDelay()).toBe(RECONNECT_DELAYS_MS[0]);
  });

  test("1001 は数秒待ってつなぎ直す", () => {
    const { updates, sockets, advance, nextDelay, last } = setup();
    updates.update(status());
    last().open();
    last().end(1001);
    expect(nextDelay()).toBe(GOING_AWAY_DELAY_MS);
    advance(GOING_AWAY_DELAY_MS);
    expect(sockets).toHaveLength(2);
  });

  test("1008 はすぐにはつなぎ直さず、確かめの同期が終わるのを待つ。401 なら止め、通れば間を空けてつなぐ", () => {
    const { updates, sockets, calls, advance, nextDelay, last } = setup();
    updates.update(status());
    last().open();
    last().end(1008);
    expect(calls.checkSession).toBe(1);
    // 確かめの同期が終わるまでは、どれだけ待っても、オンラインに戻っても、つながない
    expect(nextDelay()).toBeNull();
    advance(RECONNECT_DELAYS_MS.at(-1) ?? 0);
    updates.online();
    expect(sockets).toHaveLength(1);

    // 確かめの同期が 401：ログインし直すまでつながない
    updates.update(status({ syncing: true }));
    updates.update(status({ error: "unauthorized" }));
    advance(RECONNECT_DELAYS_MS.at(-1) ?? 0);
    expect(sockets).toHaveLength(1);

    // ログインし直したらつなぐ。もう一度 1008 で、同期が通れば間を空けてつなぐ
    updates.update(status());
    expect(sockets).toHaveLength(2);
    last().end(1008);
    updates.update(status({ syncing: true }));
    expect(nextDelay()).toBeNull();
    updates.update(status({ lastSyncedAt: 10 }));
    expect(nextDelay()).toBe(SESSION_CHECK_DELAY_MS);
    // 間を空けている間も、オンラインに戻ったことでは縮めない
    updates.online();
    expect(sockets).toHaveLength(2);
    advance(SESSION_CHECK_DELAY_MS);
    expect(sockets).toHaveLength(3);
  });

  test("1008 のときに走っていた同期は確かめにせず、その次の同期を待つ", () => {
    const { updates, sockets, advance, nextDelay, last } = setup();
    updates.update(status());
    last().open();
    updates.update(status({ syncing: true }));
    last().end(1008);
    // 閉じる前から走っていた同期が終わっても、まだつながない
    updates.update(status({ lastSyncedAt: 1 }));
    expect(nextDelay()).toBeNull();
    // 確かめの同期が始まって終われば、間を空けてつなぐ
    updates.update(status({ syncing: true, lastSyncedAt: 1 }));
    updates.update(status({ lastSyncedAt: 2 }));
    advance(nextDelay() ?? 0);
    expect(sockets).toHaveLength(2);
  });

  test("1013 は 1 分以上空けてつなぎ直す。オンラインに戻っても縮めない", () => {
    const { updates, sockets, advance, nextDelay, last } = setup();
    updates.update(status());
    last().end(1013);
    expect(nextDelay()).toBe(TRY_AGAIN_LATER_DELAY_MS);
    updates.online();
    expect(sockets).toHaveLength(1);
    expect(nextDelay()).toBe(TRY_AGAIN_LATER_DELAY_MS);
    advance(TRY_AGAIN_LATER_DELAY_MS - 1);
    expect(sockets).toHaveLength(1);
    advance(1);
    expect(sockets).toHaveLength(2);
  });

  test("オンラインに戻ったら、待たずにつなぎ直す。つないでいる間は何もしない", () => {
    const { updates, sockets, nextDelay, last } = setup();
    updates.update(status());
    last().end(1006);
    last().end(1006);
    expect(nextDelay()).not.toBeNull();
    updates.online();
    expect(sockets).toHaveLength(2);
    expect(nextDelay()).toBeNull();
    updates.online();
    expect(sockets).toHaveLength(2);
  });

  test("つなぐ前に投げても、間を空けてやり直す", () => {
    const { updates, nextDelay } = setup({ connectThrows: true });
    updates.update(status());
    expect(nextDelay()).toBe(RECONNECT_DELAYS_MS[0]);
  });

  test("止めたら閉じ、つなぎ直さない", () => {
    const { updates, sockets, advance, nextDelay, last } = setup();
    updates.update(status());
    last().end(1006);
    advance(nextDelay() ?? 0);
    updates.stop();
    expect(sockets[1]?.closedWith).toBe(1000);
    expect(nextDelay()).toBeNull();
    updates.update(status({ lastSyncedAt: 5 }));
    updates.online();
    expect(sockets).toHaveLength(2);
  });
});

describe("通知の入口の URL", () => {
  test.each([
    [
      "/api/v1",
      "https://reader.example/assets/db.worker.js",
      "wss://reader.example/api/v1/sync/updates",
    ],
    ["/api/v1/", "http://localhost:5173/", "ws://localhost:5173/api/v1/sync/updates"],
    [
      "https://sendo.test/api/v1",
      "https://reader.example/",
      "wss://sendo.test/api/v1/sync/updates",
    ],
  ])("%s を %s から開く", (baseUrl, location, expected) => {
    expect(syncUpdatesUrl(baseUrl, location)).toBe(expected);
  });
});
