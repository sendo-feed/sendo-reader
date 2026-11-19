import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import {
  PERIODIC_SYNC_MS,
  RETRY_DELAYS_MS,
  SyncScheduler,
  type SyncStatus,
  WRITE_DEBOUNCE_MS,
} from "../src/sync/scheduler";
import { USER } from "./fake-sendo";
import { setup } from "./helpers";

const syncCalls = (requests: string[]) => requests.filter((r) => r.startsWith("GET /sync")).length;
const meCalls = (requests: string[]) => requests.filter((r) => r === "GET /me").length;

async function scheduled() {
  const context = await setup();
  const statuses: SyncStatus[] = [];
  const scheduler = new SyncScheduler(context.core, {
    onStatus: (status) => statuses.push(status),
  });
  return { ...context, scheduler, statuses };
}

describe("同期の予定", () => {
  beforeEach(() => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "Date"] });
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  test("すぐ同期し、そのあとは一定の間隔で同期する", async () => {
    const { server, scheduler, statuses } = await scheduled();
    scheduler.requestNow();
    await vi.advanceTimersByTimeAsync(0);
    expect(syncCalls(server.requests)).toBe(1);
    expect(statuses.at(-1)).toMatchObject({ syncing: false, error: null, signedIn: true });
    expect(statuses.at(-1)?.lastSyncedAt).not.toBeNull();

    await vi.advanceTimersByTimeAsync(PERIODIC_SYNC_MS - 1);
    expect(syncCalls(server.requests)).toBe(1);
    await vi.advanceTimersByTimeAsync(1);
    expect(syncCalls(server.requests)).toBe(2);
  });

  test("続けて書き込んでも、少し待ってからまとめて 1 回送る", async () => {
    const { server, core, scheduler, statuses } = await scheduled();
    const feed = server.subscribe({ url: "https://example.com/feed.xml" });
    const article = server.deliver(feed.id);
    await core.sync();
    server.requests.length = 0;

    for (const read of [true, false, true]) {
      await core.setRead(article.id, read);
      scheduler.requestSoon();
    }
    await vi.advanceTimersByTimeAsync(0);
    expect(statuses.at(-1)?.pending).toBe(1);
    await vi.advanceTimersByTimeAsync(WRITE_DEBOUNCE_MS);
    expect(server.requests.filter((r) => r.startsWith("PATCH"))).toHaveLength(1);
    expect(statuses.at(-1)?.pending).toBe(0);
  });

  test("届かなければ、間隔を延ばしながらやり直す", async () => {
    const { server, scheduler, statuses } = await scheduled();
    server.requests.length = 0;
    // 同期のたびに、最初に /me で確かめる。それが 2 回届かない
    server.failNext("network", "network");
    scheduler.requestNow();
    await vi.advanceTimersByTimeAsync(0);
    expect(statuses.at(-1)?.error).toBe("network");

    await vi.advanceTimersByTimeAsync(RETRY_DELAYS_MS[0]);
    expect(meCalls(server.requests)).toBe(2);
    expect(statuses.at(-1)?.error).toBe("network");

    await vi.advanceTimersByTimeAsync(RETRY_DELAYS_MS[1] - 1);
    expect(meCalls(server.requests)).toBe(2);
    await vi.advanceTimersByTimeAsync(1);
    expect(meCalls(server.requests)).toBe(3);
    expect(syncCalls(server.requests)).toBe(1);
    expect(statuses.at(-1)?.error).toBeNull();
  });

  test("同期中や失敗後に通知が来ても、再試行を前倒ししない", async () => {
    const { server, scheduler } = await scheduled();
    server.onRequest = async (path) => {
      if (path !== "GET /sync") return;
      server.onRequest = null;
      scheduler.requestForUpdate();
      server.failNext(503);
    };
    await scheduler.syncNow();
    expect(scheduler.status.error).toBe("server");

    scheduler.requestForUpdate();
    await vi.advanceTimersByTimeAsync(RETRY_DELAYS_MS[0] - 1);
    expect(syncCalls(server.requests)).toBe(1);
    server.onRequest = async (path) => {
      if (path !== "GET /sync") return;
      server.onRequest = null;
      scheduler.requestForUpdate();
    };
    await vi.advanceTimersByTimeAsync(1);
    expect(syncCalls(server.requests)).toBe(2);
    expect(scheduler.status.error).toBeNull();

    await vi.advanceTimersByTimeAsync(WRITE_DEBOUNCE_MS);
    expect(syncCalls(server.requests)).toBe(3);
  });

  test("保存の拒否を、後続の同期が失敗しても通知して保持する", async () => {
    const { server, core, scheduler } = await scheduled();
    server.maxSavedPages = 0;
    await core.savePage("https://example.com/page");
    server.onRequest = async (path) => {
      if (path !== "GET /sync") return;
      server.onRequest = null;
      server.failNext("network");
    };

    await scheduler.syncNow();
    expect(scheduler.status).toMatchObject({ error: "network", savedPageError: "limit" });
    expect(await core.listSavedPages()).toEqual([]);
    await scheduler.syncNow();
    expect(scheduler.status).toMatchObject({ error: null, savedPageError: "limit" });

    server.maxSavedPages = 1;
    await core.savePage("https://example.com/page");
    scheduler.requestSoon(true);
    expect(scheduler.status.savedPageError).toBeNull();
    scheduler.stop();
  });

  test("セッションが切れたら止め、ログインし直したら再開する", async () => {
    const { server, core, scheduler, statuses } = await scheduled();
    server.expireSession();
    server.requests.length = 0;
    scheduler.requestNow();
    await vi.advanceTimersByTimeAsync(0);
    expect(statuses.at(-1)).toMatchObject({ signedIn: true, error: "unauthorized" });

    await vi.advanceTimersByTimeAsync(PERIODIC_SYNC_MS * 2);
    expect(meCalls(server.requests)).toBe(1);
    expect(syncCalls(server.requests)).toBe(0);

    // 同じユーザーでログインし直して、タブが戻ってきた
    server.signInAs();
    expect(await core.restoreSession()).toBe(true);
    scheduler.requestNow();
    await vi.advanceTimersByTimeAsync(0);
    expect(syncCalls(server.requests)).toBe(1);
    expect(statuses.at(-1)?.error).toBeNull();
  });

  test("同期している間に頼まれたら、終わってからもう一度同期する", async () => {
    const { server, scheduler } = await scheduled();
    let release = () => {};
    const held = new Promise<void>((resolve) => {
      release = resolve;
    });
    server.onRequest = async (path) => {
      if (path.startsWith("GET /sync")) {
        server.onRequest = null;
        await held;
      }
    };
    const first = scheduler.syncNow();
    await vi.advanceTimersByTimeAsync(0);
    scheduler.requestNow();
    await vi.advanceTimersByTimeAsync(0);
    expect(syncCalls(server.requests)).toBe(1);

    release();
    await first;
    await vi.advanceTimersByTimeAsync(0);
    expect(syncCalls(server.requests)).toBe(2);
  });

  test("ログインしていなければ同期せず（ログアウトだけを送り）、その様子を知らせる", async () => {
    const { core, server, scheduler, statuses } = await scheduled();
    await core.signOut();
    server.requests.length = 0;
    scheduler.requestNow();
    await vi.advanceTimersByTimeAsync(0);
    expect(server.requests).toEqual(["POST /auth/logout"]);
    expect(statuses.at(-1)).toMatchObject({
      signedIn: false,
      syncing: false,
      logoutPending: false,
    });

    // 送り終えたら、もう何も送らない
    scheduler.requestNow();
    await vi.advanceTimersByTimeAsync(PERIODIC_SYNC_MS * 2);
    expect(server.requests).toEqual(["POST /auth/logout"]);
  });

  test("送っていない操作を残してログアウトしたら、その数も 0 に戻す", async () => {
    const { server, core, scheduler, statuses } = await scheduled();
    const feed = server.subscribe({ url: "https://example.com/feed.xml" });
    const article = server.deliver(feed.id);
    await core.sync();
    await core.setStarred(article.id, true);
    scheduler.requestSoon();
    await vi.advanceTimersByTimeAsync(0);
    expect(statuses.at(-1)?.pending).toBe(1);

    await core.signOut();
    scheduler.requestNow();
    await vi.advanceTimersByTimeAsync(0);
    expect(statuses.at(-1)).toMatchObject({ signedIn: false, pending: 0 });
    expect(scheduler.status.pending).toBe(0);
  });

  test("ログアウトを sendo に送れなかったら、間隔を延ばしながら送り直す", async () => {
    const { server, core, scheduler, statuses } = await scheduled();
    await core.signOut();
    // sendo が少しの間、答えない（ブラウザはオンラインのまま）
    server.failNext(503, 503);
    scheduler.requestNow();
    await vi.advanceTimersByTimeAsync(0);
    expect(statuses.at(-1)).toMatchObject({ signedIn: false, user: null, logoutPending: true });
    expect(server.sessions.size).toBe(1);

    await vi.advanceTimersByTimeAsync(RETRY_DELAYS_MS[0]);
    expect(server.sessions.size).toBe(1);
    await vi.advanceTimersByTimeAsync(RETRY_DELAYS_MS[1]);
    expect(server.sessions.size).toBe(0);
    expect(statuses.at(-1)).toMatchObject({ logoutPending: false });
  });

  test("ユーザーも知らせる", async () => {
    const { scheduler, statuses } = await scheduled();
    scheduler.requestNow();
    await vi.advanceTimersByTimeAsync(0);
    expect(statuses.at(-1)?.user).toEqual({ id: "user-1", email: "you@example.com" });
  });

  test("ログインして同期を始めるときに、ユーザーも一緒に知らせる（ログインしているのにユーザーがない様子を出さない）", async () => {
    const { server, core } = await setup({ signIn: false });
    const statuses: SyncStatus[] = [];
    const scheduler = new SyncScheduler(core, { onStatus: (status) => statuses.push(status) });
    scheduler.requestNow();
    await vi.advanceTimersByTimeAsync(0);
    server.signInAs();
    await core.restoreSession();
    scheduler.requestNow();
    await vi.advanceTimersByTimeAsync(0);
    const signedIn = statuses.filter((status) => status.signedIn);
    expect(signedIn.length).toBeGreaterThan(0);
    for (const status of signedIn) expect(status.user).toEqual(USER);
  });

  test("止めたら、予定していた同期もしない", async () => {
    const { server, scheduler } = await scheduled();
    scheduler.requestSoon();
    scheduler.stop();
    await vi.advanceTimersByTimeAsync(PERIODIC_SYNC_MS);
    expect(syncCalls(server.requests)).toBe(0);
  });
});
