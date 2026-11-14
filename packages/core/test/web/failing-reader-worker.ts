/// <reference lib="webworker" />
import { runReaderWorker } from "../../src/web/worker";
import { bridgeFetch } from "./fake-bridge";

// DB を開けないワーカー（OPFS が使えない、など）。名前空間は reader-worker.ts と同じにする
const namespace = (self as unknown as DedicatedWorkerGlobalScope).name;
runReaderWorker({
  namespace,
  baseUrl: "https://sendo.test/api/v1",
  fetch: bridgeFetch(`${namespace}:fake-sendo`),
  openDatabase: () => Promise.reject(new Error("OPFS を開けない")),
});
