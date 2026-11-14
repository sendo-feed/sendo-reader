import { connectReader, type ReaderClient } from "@sendo-reader/core/web";
import workerUrl from "../db.worker.ts?worker&url";
import { trustedScriptUrl } from "./trusted";

/** 手元の DB と同期を持つワーカーを起こし、その窓口を返す */
export function startReader(): ReaderClient {
  const worker = new Worker(trustedScriptUrl(workerUrl), { type: "module", name: "sendo-reader" });
  return connectReader(worker);
}
