/// <reference lib="webworker" />
import { PROTOCOL_VERSION } from "../../src/web/protocol";
import { runReaderWorker } from "../../src/web/worker";
import { bridgeFetch } from "./fake-bridge";

// やり取りの版の番号だけが違うワーカー（版の違うタブ）。名前空間は reader-worker.ts と同じにする
const namespace = (self as unknown as DedicatedWorkerGlobalScope).name;
runReaderWorker({
  // 通知（WebSocket）は使わない（偽の sendo は HTTP だけに答える）
  webSocket: null,
  namespace,
  baseUrl: "https://sendo.test/api/v1",
  fetch: bridgeFetch(`${namespace}:fake-sendo`),
  protocolVersion: PROTOCOL_VERSION + 1,
});
