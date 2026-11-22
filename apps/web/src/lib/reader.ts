import { connectReader, type ReaderClient } from "@sendo-reader/core/web";
import workerUrl from "../db.worker.ts?worker&url";
import { trustedScriptUrl } from "./trusted";

/** 手元の DB と同期を持つワーカー */
export interface StartedReader {
  client: ReaderClient;
  /** ワーカーを止める。代表のロックと DB を離し、そのあと client は答えない */
  stop: () => void;
}

/** 手元の DB と同期を持つワーカーを起こし、その窓口を返す */
export function startReader(): StartedReader {
  const worker = new Worker(trustedScriptUrl(workerUrl), { type: "module", name: "sendo-reader" });
  return { client: connectReader(worker), stop: () => worker.terminate() };
}
