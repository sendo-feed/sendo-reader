/// <reference lib="webworker" />
import { runReaderWorker } from "../../src/web/worker";
import { bridgeFetch } from "./fake-bridge";

// ワーカーの名前を、テストごとの名前空間にする（DB、代表のロック、チャンネルを分ける）
const namespace = (self as unknown as DedicatedWorkerGlobalScope).name;
const testingUpdates = namespace.endsWith(":updates");
if (testingUpdates) {
  const events = new BroadcastChannel(`${namespace}:updates`);
  class NotificationSocket extends EventTarget {
    constructor(url: URL) {
      super();
      events.postMessage(url.href);
      queueMicrotask(() => this.dispatchEvent(new Event("open")));
    }

    close() {
      this.dispatchEvent(new Event("close"));
    }
  }
  Object.defineProperty(globalThis, "WebSocket", { value: NotificationSocket });
}

runReaderWorker({
  namespace,
  baseUrl: testingUpdates ? "/api/v1" : "https://sendo.test/api/v1",
  fetch: bridgeFetch(`${namespace}:fake-sendo`),
});
