import { connectReader, type ReaderClient } from "@sendo-reader/core/web";
import workerUrl from "../db.worker.ts?worker&url";

interface TrustedTypePolicyFactory {
  createPolicy(
    name: string,
    rules: { createScriptURL: (input: string) => string },
  ): { createScriptURL(input: string): unknown };
}

/**
 * ワーカーの URL を、自分のオリジンのものだけに限る Trusted Types のポリシー
 * （本番の CSP で強制している。apps/web/security-headers.ts）
 */
const policy = (
  globalThis as { trustedTypes?: TrustedTypePolicyFactory }
).trustedTypes?.createPolicy("sendo-worker", {
  createScriptURL: (input) => {
    const url = new URL(input, location.href);
    if (url.origin !== location.origin) {
      throw new TypeError("ほかのオリジンのワーカーは読み込まない");
    }
    return url.href;
  },
});

/** 手元の DB と同期を持つワーカーを起こし、その窓口を返す */
export function startReader(): ReaderClient {
  const scriptUrl = policy === undefined ? workerUrl : policy.createScriptURL(workerUrl);
  const worker = new Worker(scriptUrl as string, { type: "module", name: "sendo-reader" });
  return connectReader(worker);
}
