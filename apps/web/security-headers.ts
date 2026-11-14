/**
 * 画面の応答に付けるセキュリティのヘッダー（docs/decisions/local-first.md）。
 *
 * アクセストークンをページの JS から読める場所に置く間は、XSS で盗まれないように CSP を厳しくする。
 * 本番は、ビルドで dist/_headers に書き出し、Workers Static Assets が付ける。
 * 手元は、Vite の dev サーバーが付ける。
 */

/** 本番の CSP。ほかのオリジンへの通信と、インラインのスクリプトを許さない */
const productionDirectives: Record<string, string[]> = {
  "default-src": ["'none'"],
  // SQLite の wasm をコンパイルするのに 'wasm-unsafe-eval' が要る
  "script-src": ["'self'", "'wasm-unsafe-eval'"],
  "worker-src": ["'self'"],
  "connect-src": ["'self'"],
  "img-src": ["'self'", "data:"],
  "style-src": ["'self'"],
  "manifest-src": ["'self'"],
  "base-uri": ["'none'"],
  "form-action": ["'none'"],
  "frame-ancestors": ["'none'"],
  "object-src": ["'none'"],
  "require-trusted-types-for": ["'script'"],
  // Svelte がテンプレートを作るときのポリシーだけを許す
  "trusted-types": ["svelte-trusted-html"],
};

/**
 * 手元の CSP。Vite は CSS を <style> で差し込むので 'unsafe-inline' を許し、
 * エラーの表示が innerHTML を使うので Trusted Types は強制しない。
 */
const developmentDirectives: Record<string, string[]> = {
  ...productionDirectives,
  "style-src": ["'self'", "'unsafe-inline'"],
  "require-trusted-types-for": [],
  "trusted-types": [],
};

export function contentSecurityPolicy(mode: "production" | "development"): string {
  const directives = mode === "production" ? productionDirectives : developmentDirectives;
  return Object.entries(directives)
    .filter(([, values]) => values.length > 0)
    .map(([name, values]) => `${name} ${values.join(" ")}`)
    .join("; ");
}

export function securityHeaders(mode: "production" | "development"): Record<string, string> {
  return {
    "Content-Security-Policy": contentSecurityPolicy(mode),
    "X-Content-Type-Options": "nosniff",
    // 記事のリンクを開いたときに、reader の URL を相手のサイトに送らない
    "Referrer-Policy": "no-referrer",
    "Permissions-Policy": "camera=(), microphone=(), geolocation=(), payment=(), usb=()",
  };
}

/** Workers Static Assets の _headers の形にする（すべてのパスに付ける） */
export function renderHeadersFile(): string {
  const lines = Object.entries(securityHeaders("production")).map(
    ([name, value]) => `  ${name}: ${value}`,
  );
  return ["/*", ...lines, ""].join("\n");
}
