import { PERIODIC_SYNC_MS, RETRY_DELAYS_MS } from "../sync/scheduler";

const CONNECT_TIMEOUT_MS = 10_000;

interface SyncUpdatesOptions {
  baseUrl: string;
  session: AbortSignal;
  sessionProtocol(signal: AbortSignal): Promise<string | null | undefined>;
  onOpen(): void;
  onUpdate(): void;
}

/** 代表のワーカーが持つ、差分同期を始めるための接続。 */
export function startSyncUpdates(options: SyncUpdatesOptions): () => void {
  const url = new URL(options.baseUrl, location.href);
  if (
    options.session.aborted ||
    url.origin !== location.origin ||
    (url.protocol !== "http:" && url.protocol !== "https:")
  ) {
    return () => {};
  }
  url.protocol = url.protocol === "https:" ? "wss:" : "ws:";
  url.pathname = `${url.pathname.replace(/\/+$/, "")}/sync/updates`;
  url.search = "";
  url.hash = "";

  const lifetime = new AbortController();
  let socket: WebSocket | undefined;
  let retry: ReturnType<typeof setTimeout> | undefined;
  let failures = 0;

  function retryLater(delay: number): void {
    if (!lifetime.signal.aborted) retry = setTimeout(() => void connect(), delay);
  }

  function retryAfterFailure(): void {
    const delay = RETRY_DELAYS_MS[Math.min(failures, RETRY_DELAYS_MS.length - 1)];
    failures += 1;
    retryLater(delay ?? PERIODIC_SYNC_MS);
  }

  async function connect(): Promise<void> {
    retry = undefined;
    try {
      const protocol = await options.sessionProtocol(lifetime.signal);
      if (lifetime.signal.aborted) return;
      if (protocol === null) {
        retryAfterFailure();
        return;
      }
      const connection = new WebSocket(url, protocol);
      socket = connection;
      const deadline = setTimeout(() => connection.close(), CONNECT_TIMEOUT_MS);
      connection.addEventListener("open", () => {
        clearTimeout(deadline);
        if (lifetime.signal.aborted) return;
        failures = 0;
        options.onOpen();
      });
      connection.addEventListener("message", ({ data }) => {
        if (lifetime.signal.aborted || typeof data !== "string") return;
        try {
          if (JSON.parse(data)?.type === "sync_required") options.onUpdate();
        } catch {
          // 通知の形式が違うときも、定期同期で追いつく。
        }
      });
      connection.addEventListener(
        "close",
        () => {
          clearTimeout(deadline);
          socket = undefined;
          retryAfterFailure();
        },
        { once: true },
      );
    } catch {
      retryAfterFailure();
    }
  }

  function stop(): void {
    if (lifetime.signal.aborted) return;
    options.session.removeEventListener("abort", stop);
    lifetime.abort();
    clearTimeout(retry);
    socket?.close();
  }

  options.session.addEventListener("abort", stop, { once: true });
  void connect();
  return stop;
}
