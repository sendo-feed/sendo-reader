/**
 * 画面の応答に付けるセキュリティのヘッダー（docs/decisions/local-first.md）。
 *
 * ページに他人の JS が入ると、ページを開いている間はセッションで API を使われ、手元のデータも
 * 読まれるので、CSP を厳しくする（ほかのオリジンへの通信と、インラインのスクリプトを許さない）。
 * 本番は、reader のコンテナのサーバー（server/static.ts）が、画面のすべての応答に付ける。
 * 手元は、Vite の dev サーバーと preview が付ける。
 *
 * X の投稿の隔離フレームのオリジンが設定してあるときだけ、frame-src にそのオリジンを 1 つ足す
 * （docs/decisions/embeds.md の 2）。ほかのディレクティブは変えない。
 */

export type SecurityHeadersOptions = {
  /** X の投稿の隔離フレームのオリジン（x-embed-origin.ts で確かめたもの）。未設定なら null */
  xEmbedOrigin?: string | null;
};

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
  // Svelte がテンプレートを作るときのポリシーと、ワーカーの URL を自分のオリジンに限るポリシー
  // （src/lib/reader.ts）だけを許す
  "trusted-types": ["svelte-trusted-html", "sendo-worker"],
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

export function contentSecurityPolicy(
  mode: "production" | "development",
  options: SecurityHeadersOptions = {},
): string {
  const directives: Record<string, string[]> = {
    ...(mode === "production" ? productionDirectives : developmentDirectives),
  };
  if (options.xEmbedOrigin) directives["frame-src"] = [options.xEmbedOrigin];
  return Object.entries(directives)
    .filter(([, values]) => values.length > 0)
    .map(([name, values]) => `${name} ${values.join(" ")}`)
    .join("; ");
}

export function securityHeaders(
  mode: "production" | "development",
  options: SecurityHeadersOptions = {},
): Record<string, string> {
  return {
    "Content-Security-Policy": contentSecurityPolicy(mode, options),
    "X-Content-Type-Options": "nosniff",
    // 記事のリンクを開いたときに、reader の URL を相手のサイトに送らない
    "Referrer-Policy": "no-referrer",
    "Permissions-Policy": "camera=(), microphone=(), geolocation=(), payment=(), usb=()",
  };
}

/**
 * X の投稿の隔離フレームのページ（x-embed/）の応答のヘッダー（docs/decisions/embeds.md の 2）。
 * reader の CSP とは別のもの。X の widgets.js と、それが作る X の iframe だけを許す。
 *
 * - img-src、connect-src、style-src は要らない（画像と通信は、どれも X の iframe の中から出る）
 * - Trusted Types は入れない（widgets.js が止まる）
 * - frame-ancestors は付けない（ほかのサイトが iframe に入れることは受け入れる）
 * - 許すのは platform.twitter.com のホストだけで、パスまでは絞らない（X が置き場を変えると、黙って出なくなる）
 */
export function xEmbedPageHeaders(): Record<string, string> {
  return {
    "Content-Security-Policy":
      "default-src 'none'; script-src 'self' https://platform.twitter.com; frame-src https://platform.twitter.com; base-uri 'none'; form-action 'none'",
    "X-Content-Type-Options": "nosniff",
    "Referrer-Policy": "no-referrer",
    "Permissions-Policy": securityHeaders("production")["Permissions-Policy"] ?? "",
  };
}
