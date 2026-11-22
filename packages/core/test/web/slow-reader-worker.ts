/// <reference lib="webworker" />
import { openWebDatabase } from "../../src/web/database";
import { runReaderWorker } from "../../src/web/worker";
import { bridgeFetch } from "./fake-bridge";

// DB を開くのに時間のかかるワーカー（本番で wasm を読み込み、DB を開く間を真似る）。開き始めたら
// ページに { type: "opening" } を送る。名前空間は reader-worker.ts と同じにする
const scope = self as unknown as DedicatedWorkerGlobalScope;
const namespace = scope.name;
runReaderWorker({
  // 通知（WebSocket）は使わない（偽の sendo は HTTP だけに答える）
  webSocket: null,
  namespace,
  baseUrl: "https://sendo.test/api/v1",
  fetch: bridgeFetch(`${namespace}:fake-sendo`),
  openDatabase: async (name) => {
    scope.postMessage({ type: "opening" });
    await new Promise((resolve) => setTimeout(resolve, 300));
    return openWebDatabase(name);
  },
});
