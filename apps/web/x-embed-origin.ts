/**
 * X の投稿の隔離フレームのオリジン（docs/decisions/embeds.md の 3）。
 *
 * 設定（環境変数 X_EMBED_ORIGIN）で受け取り、reader のコンテナのサーバー（server/）が起動するときに、
 * reader の index.html に <meta> で埋め、CSP の frame-src に入れ、sw.js の中の index.html の版の印を
 * 書き換える。手元の Vite の dev サーバーと preview も、同じ関数を通す（vite.config.ts）。画面は
 * <meta> から読む（src/lib/x-embed.ts）。
 *
 * ブラウザでも Node でも動く（node:* を使わない）。
 */

/** 画面に隔離フレームのオリジンを渡す <meta> の名前 */
export const X_EMBED_ORIGIN_META = "sendo-x-embed-origin";

/** 開発のときだけ（dev サーバーと preview）受け付ける http のホスト名 */
const DEVELOPMENT_HOSTNAMES = new Set(["localhost", "127.0.0.1"]);

/** ホスト名に使ってよい文字（ASCII の英小文字・数字・ハイフン・点） */
const HOSTNAME = /^[a-z0-9](?:[a-z0-9.-]*[a-z0-9])?$/;

export type XEmbedOriginOptions = {
  /** 開発用の http://localhost と http://127.0.0.1 を受け付けるか（dev サーバーと preview だけ） */
  allowDevelopment: boolean;
};

/**
 * 値が隔離フレームのオリジンの形なら、そのオリジン（https://embed.example など。末尾の / なし）。
 * 形が合わなければ null。
 *
 * - https で、パス・クエリ・ハッシュ・認証情報がない
 * - ホスト名は、英小文字・数字・ハイフン・点だけ（* などの記号、末尾の点、IPv6 は受けない）
 * - 開発用には、http の localhost と 127.0.0.1（ホスト名は完全一致。ポートは問わない）
 */
export function toXEmbedOrigin(value: string, options: XEmbedOriginOptions): string | null {
  // URL として読むと消えてしまう、空のクエリ・ハッシュ・認証情報の印も受けない
  if (/[?#@\\\s]/.test(value)) return null;
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    return null;
  }
  if (url.username !== "" || url.password !== "" || url.pathname !== "/") return null;
  if (!HOSTNAME.test(url.hostname)) return null;
  if (url.protocol === "https:") return url.origin;
  if (url.protocol === "http:" && options.allowDevelopment) {
    return DEVELOPMENT_HOSTNAMES.has(url.hostname) ? url.origin : null;
  }
  return null;
}

/** 要求の Host が、隔離フレームのホスト名か。大文字・小文字、ポート、末尾の点によらない */
export function isXEmbedHost(host: string | null | undefined, origin: string): boolean {
  if (!host) return false;
  let hostname: string;
  try {
    hostname = new URL(`http://${host}`).hostname;
  } catch {
    return false;
  }
  return hostname.replace(/\.$/, "") === new URL(origin).hostname;
}

function escapeAttribute(text: string): string {
  return text
    .replace(/&/g, "&amp;")
    .replace(/"/g, "&quot;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");
}

/** index.html の </head> の前に、隔離フレームのオリジンの <meta> を足す。足せなければ投げる */
export function withXEmbedMeta(html: string, origin: string): string {
  const parts = html.split("</head>");
  if (parts.length !== 2) {
    throw new Error("index.html に </head> が 1 つだけあるはずが、見つからない");
  }
  const meta = `<meta name="${X_EMBED_ORIGIN_META}" content="${escapeAttribute(origin)}">`;
  return `${parts[0]}${meta}</head>${parts[1]}`;
}

/** sw.js の precache の一覧の中の、index.html の項目（Workbox の generateSW の出力の形） */
const INDEX_REVISION = /\{url:"index\.html",revision:"[0-9a-f]+"\}/g;

/**
 * sw.js の precache の一覧の、index.html の revision を替える。Service Worker は、sw.js が変わると
 * 新しい版として取り込み、index.html を取り直す（docs/decisions/ui.md の 5）。
 * 書き換える場所がちょうど 1 つ見つからなければ投げる（Workbox の出力の形が変わった、など）
 */
export function withIndexRevision(sw: string, revision: string): string {
  const found = sw.match(INDEX_REVISION) ?? [];
  if (found.length !== 1) {
    throw new Error(
      `sw.js の precache の一覧に、index.html の revision がちょうど 1 つあるはずが、${found.length} 個だった`,
    );
  }
  return sw.replace(INDEX_REVISION, `{url:"index.html",revision:"${revision}"}`);
}

/** 書き換えたあとの index.html と、付ける CSP から、index.html の版の印を作る */
export async function indexRevision(html: string, csp: string): Promise<string> {
  const bytes = new TextEncoder().encode(`${csp}\n${html}`);
  const digest = new Uint8Array(await crypto.subtle.digest("SHA-256", bytes));
  return Array.from(digest.slice(0, 16), (byte) => byte.toString(16).padStart(2, "0")).join("");
}

/**
 * 設定があるときの index.html と sw.js を作る。どちらかを書き換えられなければ投げる
 * （設定があるのに、効かないまま動かさない）
 */
export async function applyXEmbedOrigin(
  files: { indexHtml: string; sw: string },
  origin: string,
  csp: string,
): Promise<{ indexHtml: string; sw: string }> {
  const indexHtml = withXEmbedMeta(files.indexHtml, origin);
  const sw = withIndexRevision(files.sw, await indexRevision(indexHtml, csp));
  return { indexHtml, sw };
}
