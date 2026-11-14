interface TrustedTypePolicyFactory {
  createPolicy(
    name: string,
    rules: { createScriptURL: (input: string) => string },
  ): { createScriptURL(input: string): unknown };
}

/**
 * スクリプトの URL（ワーカー、Service Worker）を、自分のオリジンのものだけに限る Trusted Types の
 * ポリシー（本番の CSP で強制している。apps/web/security-headers.ts）
 */
const policy = (
  globalThis as { trustedTypes?: TrustedTypePolicyFactory }
).trustedTypes?.createPolicy("sendo-worker", {
  createScriptURL: (input) => {
    const url = new URL(input, location.href);
    if (url.origin !== location.origin) {
      throw new TypeError("ほかのオリジンのスクリプトは読み込まない");
    }
    return url.href;
  },
});

/** Worker や Service Worker に渡す URL。Trusted Types に対応したブラウザでは、ポリシーを通す */
export function trustedScriptUrl(url: string): string {
  return (policy === undefined ? url : policy.createScriptURL(url)) as string;
}
