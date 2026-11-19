/**
 * 画面の応答に付けるセキュリティのヘッダー（docs/decisions/local-first.md）。
 *
 * ページに他人の JS が入ると、ページを開いている間はセッションで API を使われ、手元のデータも
 * 読まれるので、CSP を厳しくする。設定した X の埋め込みは、別オリジンのフレームに限る。
 * 本番は reader のコンテナのサーバー、手元は Vite の dev サーバーと preview が付ける。
 */

/** 本番の CSP。埋め込みのオリジンは実際の構成に応じて足す */
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

/** フレームの配信元だけを CSP とビルドに渡す。未設定なら投稿リンクを出す。 */
export function xEmbedOrigin(value: string | undefined): string {
  if (!value) return "";
  const url = new URL(value);
  if (
    url.protocol !== "https:" ||
    /[*;,]/.test(url.hostname) ||
    url.username !== "" ||
    url.password !== "" ||
    url.pathname !== "/" ||
    url.search !== "" ||
    url.hash !== ""
  ) {
    throw new Error("SENDO_X_EMBED_ORIGIN には、HTTPS のオリジンを指定してください");
  }
  return url.origin;
}

export const X_EMBED_ORIGIN_FILE = "x-embed-origin.json";

/** ビルド済みの画面と同じ配信元を preview とコンテナで使う。 */
export function embedOriginFromBuild(contents: string): string {
  const value: unknown = JSON.parse(contents);
  if (typeof value !== "string") throw new Error("埋め込みのビルド設定が文字列ではありません");
  return xEmbedOrigin(value);
}

export function contentSecurityPolicy(
  mode: "production" | "development",
  embedOrigin = "",
): string {
  const directives = mode === "production" ? productionDirectives : developmentDirectives;
  return Object.entries({
    ...directives,
    "frame-src": embedOrigin ? [embedOrigin] : [],
  })
    .filter(([, values]) => values.length > 0)
    .map(([name, values]) => `${name} ${values.join(" ")}`)
    .join("; ");
}

export function securityHeaders(
  mode: "production" | "development",
  embedOrigin = "",
): Record<string, string> {
  return {
    "Content-Security-Policy": contentSecurityPolicy(mode, embedOrigin),
    "X-Content-Type-Options": "nosniff",
    // 記事のリンクを開いたときに、reader の URL を相手のサイトに送らない
    "Referrer-Policy": "no-referrer",
    "Permissions-Policy": "camera=(), microphone=(), geolocation=(), payment=(), usb=()",
  };
}
