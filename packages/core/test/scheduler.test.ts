import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import {
  PERIODIC_SYNC_MS,
  RETRY_DELAYS_MS,
  SyncScheduler,
  type SyncStatus,
  WRITE_DEBOUNCE_MS,
} from "../src/sync/scheduler";
import { TOKEN } from "./fake-sendo";
import { setup } from "./helpers";

const syncCalls = (requests: string[]) => requests.filter((r) => r.startsWith("GET /sync")).length;

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
    server.failNext("network", "network");
    scheduler.requestNow();
    await vi.advanceTimersByTimeAsync(0);
    expect(statuses.at(-1)?.error).toBe("network");

    await vi.advanceTimersByTimeAsync(RETRY_DELAYS_MS[0]);
    expect(syncCalls(server.requests)).toBe(2);
    expect(statuses.at(-1)?.error).toBe("network");

    await vi.advanceTimersByTimeAsync(RETRY_DELAYS_MS[1] - 1);
    expect(syncCalls(server.requests)).toBe(2);
    await vi.advanceTimersByTimeAsync(1);
    expect(syncCalls(server.requests)).toBe(3);
    expect(statuses.at(-1)?.error).toBeNull();
  });

  test("トークンが使えなくなったら止め、ログインし直したら再開する", async () => {
    const { server, core, scheduler, statuses } = await scheduled();
    server.token = "sendo_rotated";
    scheduler.requestNow();
    await vi.advanceTimersByTimeAsync(0);
    expect(statuses.at(-1)?.error).toBe("unauthorized");

    await vi.advanceTimersByTimeAsync(PERIODIC_SYNC_MS * 2);
    expect(syncCalls(server.requests)).toBe(1);

    await core.signIn("sendo_rotated");
    scheduler.requestNow();
    await vi.advanceTimersByTimeAsync(0);
    expect(syncCalls(server.requests)).toBe(2);
    expect(statuses.at(-1)?.error).toBeNull();
    expect(TOKEN).not.toBe("sendo_rotated");
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

  test("止めたら、予定していた同期もしない", async () => {
    const { server, scheduler } = await scheduled();
    scheduler.requestSoon();
    scheduler.stop();
    await vi.advanceTimersByTimeAsync(PERIODIC_SYNC_MS);
    expect(syncCalls(server.requests)).toBe(0);
  });
});
