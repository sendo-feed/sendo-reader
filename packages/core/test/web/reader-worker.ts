/// <reference lib="webworker" />
import { runReaderWorker } from "../../src/web/worker";
import { bridgeFetch } from "./fake-bridge";

// ワーカーの名前を、テストごとの名前空間にする（DB、代表のロック、チャンネルを分ける）
const namespace = (self as unknown as DedicatedWorkerGlobalScope).name;
runReaderWorker({
  namespace,
  baseUrl: "https://sendo.test/api/v1",
  fetch: bridgeFetch(`${namespace}:fake-sendo`),
});
