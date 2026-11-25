/// <reference lib="webworker" />
import type { PeerMessage } from "../../src/web/protocol";
import { runReaderWorker } from "../../src/web/worker";
import { bridgeFetch } from "./fake-bridge";

// ワーカーの名前を、テストごとの名前空間にする（DB、代表のロック、チャンネルを分ける）
const scope = self as unknown as DedicatedWorkerGlobalScope;
const namespace = scope.name;
let dropResult = false;
scope.addEventListener("message", (event) => {
  if (event.data.type !== "dropWorkspaceResult") return;
  dropResult = true;
  scope.postMessage({ type: "droppingWorkspaceResult" });
});
const send = BroadcastChannel.prototype.postMessage;
BroadcastChannel.prototype.postMessage = function (message: PeerMessage) {
  if (
    dropResult &&
    this.name === `${namespace}:peers` &&
    message.type === "result" &&
    message.result.ok &&
    typeof message.result.value === "string"
  ) {
    dropResult = false;
    scope.postMessage({ type: "droppedWorkspaceResult", id: message.result.value });
    return;
  }
  send.call(this, message);
};
runReaderWorker({
  // 通知（WebSocket）は使わない（偽の sendo は HTTP だけに答える）
  webSocket: null,
  namespace,
  baseUrl: "https://sendo.test/api/v1",
  fetch: bridgeFetch(`${namespace}:fake-sendo`),
});
