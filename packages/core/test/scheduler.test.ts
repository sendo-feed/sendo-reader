import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import {
  PERIODIC_SYNC_MS,
  RETRY_DELAYS_MS,
  SyncScheduler,
  type SyncStatus,
  WRITE_DEBOUNCE_MS,
} from "../src/sync/scheduler";
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

  test("ログインしていなければ同期せず、その様子を知らせる", async () => {
    const { core, server, scheduler, statuses } = await scheduled();
    await core.signOut();
    server.requests.length = 0;
    scheduler.requestNow();
    await vi.advanceTimersByTimeAsync(0);
    expect(server.requests).toEqual([]);
    expect(statuses.at(-1)).toMatchObject({ signedIn: false, syncing: false });
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

  test("ログアウトを sendo に送れなかったら、次に同期を頼まれたときに送り直す", async () => {
    const { server, core, scheduler, statuses } = await scheduled();
    server.failNext("network");
    expect(await core.signOut()).toBe(false);
    expect(server.sessions.size).toBe(1);

    // オンラインに戻った
    scheduler.requestNow();
    await vi.advanceTimersByTimeAsync(0);
    expect(server.sessions.size).toBe(0);
    expect(statuses.at(-1)).toMatchObject({ signedIn: false, user: null });
  });

  test("ユーザーも知らせる", async () => {
    const { scheduler, statuses } = await scheduled();
    scheduler.requestNow();
    await vi.advanceTimersByTimeAsync(0);
    expect(statuses.at(-1)?.user).toEqual({ id: "user-1", email: "you@example.com" });
  });

  test("止めたら、予定していた同期もしない", async () => {
    const { server, scheduler } = await scheduled();
    scheduler.requestSoon();
    scheduler.stop();
    await vi.advanceTimersByTimeAsync(PERIODIC_SYNC_MS);
    expect(syncCalls(server.requests)).toBe(0);
  });
});
