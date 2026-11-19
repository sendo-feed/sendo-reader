import { afterEach, beforeEach, expect, test, vi } from "vitest";
import { PERIODIC_SYNC_MS, RETRY_DELAYS_MS } from "../src/sync/scheduler";
import { startSyncUpdates } from "../src/web/sync-updates";

class TestSocket extends EventTarget {
  static sockets: TestSocket[] = [];

  constructor(readonly url: URL) {
    super();
    TestSocket.sockets.push(this);
  }

  close() {
    this.dispatchEvent(new Event("close"));
  }

  open() {
    this.dispatchEvent(new Event("open"));
  }

  message(data: string) {
    this.dispatchEvent(new MessageEvent("message", { data }));
  }
}

let stop: (() => void) | undefined;
let session: AbortController;

beforeEach(() => {
  TestSocket.sockets = [];
  session = new AbortController();
  vi.useFakeTimers();
  vi.stubGlobal("location", new URL("https://reader.example:8080/"));
  vi.stubGlobal("WebSocket", TestSocket);
});

afterEach(() => {
  stop?.();
  stop = undefined;
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

test("初回と再接続で同期し、通知を読む。停止したら再接続しない", async () => {
  const onOpen = vi.fn();
  const onUpdate = vi.fn();
  const available = vi.fn().mockResolvedValue(true);
  stop = startSyncUpdates({
    baseUrl: "/api/v1",
    session: session.signal,
    available,
    onOpen,
    onUpdate,
  });
  await vi.advanceTimersByTimeAsync(0);

  const first = TestSocket.sockets[0];
  if (!first) throw new Error("missing connection");
  expect(first.url.href).toBe("wss://reader.example:8080/api/v1/sync/updates");
  first.open();
  first.message("invalid");
  first.message('{"type":"other"}');
  first.message('{"type":"sync_required"}');
  expect(onOpen).toHaveBeenCalledTimes(1);
  expect(onUpdate).toHaveBeenCalledTimes(1);

  first.close();
  await vi.advanceTimersByTimeAsync(RETRY_DELAYS_MS[0]);
  expect(available).toHaveBeenCalledTimes(2);
  TestSocket.sockets[1]?.open();
  expect(onOpen).toHaveBeenCalledTimes(2);
  stop();
  TestSocket.sockets[1]?.message('{"type":"sync_required"}');
  await vi.advanceTimersByTimeAsync(PERIODIC_SYNC_MS);
  expect(TestSocket.sockets).toHaveLength(2);
  expect(onUpdate).toHaveBeenCalledTimes(1);
});

test("旧 Sendo では接続せず、次の確認で対応していれば接続する", async () => {
  const available = vi.fn().mockResolvedValueOnce(false).mockResolvedValue(true);
  stop = startSyncUpdates({
    baseUrl: "/api/v1",
    session: session.signal,
    available,
    onOpen: vi.fn(),
    onUpdate: vi.fn(),
  });
  await vi.advanceTimersByTimeAsync(PERIODIC_SYNC_MS - 1);
  expect(TestSocket.sockets).toHaveLength(0);
  await vi.advanceTimersByTimeAsync(1);
  expect(TestSocket.sockets).toHaveLength(1);
});

test("対応状況の確認中に止めた場合は、応答が来ても接続しない", async () => {
  const available = vi.fn(async () => {
    await new Promise((resolve) => setTimeout(resolve, 10));
    return true;
  });
  stop = startSyncUpdates({
    baseUrl: "/api/v1",
    session: session.signal,
    available,
    onOpen: vi.fn(),
    onUpdate: vi.fn(),
  });
  session.abort();
  await vi.advanceTimersByTimeAsync(PERIODIC_SYNC_MS);
  expect(available.mock.calls).toHaveLength(1);
  expect(TestSocket.sockets).toHaveLength(0);
});

test("別オリジンの WebSocket には接続しない", () => {
  const available = vi.fn().mockResolvedValue(true);
  stop = startSyncUpdates({
    baseUrl: "https://external.example/api/v1",
    session: session.signal,
    available,
    onOpen: vi.fn(),
    onUpdate: vi.fn(),
  });
  expect(available).not.toHaveBeenCalled();
});
