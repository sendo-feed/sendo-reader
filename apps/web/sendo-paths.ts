/**
 * コンテナ版の reader のサーバーが sendo に中継するパス（docs/decisions/container.md の 3）。
 * ここにないパスには、画面の静的なファイルか index.html を返す。
 *
 * 同じ一覧を、Service Worker がページの移動を横取りしないパスと、手元の Vite の dev サーバーが sendo の
 * pnpm dev に中継するパスにも使う（vite.config.ts）。ブラウザでこれらのパスを開いたときに、
 * Service Worker が index.html を返さず、sendo に届くようにする。
 *
 * 画面のルート（src/lib/router.svelte.ts）は、ここと重ねない。/oauth/authorize は画面（許可の画面）で、
 * /oauth/token と /oauth/register は sendo。sendo が外に出すパスを足したら、ここにも足す。
 */

/** このパスそのものだけを中継する */
const EXACT_PATHS = [
  "/api",
  "/mcp",
  "/.well-known/oauth-protected-resource/mcp",
  "/.well-known/oauth-authorization-server",
  "/oauth/token",
  "/oauth/register",
  "/accounts/ClientLogin",
  "/healthz",
] as const;

/** この下のパスをすべて中継する（/ で終える） */
const PATH_PREFIXES = ["/api/", "/reader/api/0/"] as const;

/** パス（URL の pathname。クエリを含めない）が sendo のものか */
export function isSendoPath(pathname: string): boolean {
  return (
    (EXACT_PATHS as readonly string[]).includes(pathname) ||
    PATH_PREFIXES.some((prefix) => pathname.startsWith(prefix))
  );
}

function escapeRegExp(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\/]/g, "\\$&");
}

/**
 * Service Worker の navigateFallbackDenylist に渡す正規表現。Workbox はパスとクエリをつないだ文字列
 * （pathname + search）と比べるので、そのものだけのパスは、後ろにクエリが続いてもよいようにする
 */
export const SENDO_NAVIGATION_DENYLIST: RegExp[] = [
  ...EXACT_PATHS.map((path) => new RegExp(`^${escapeRegExp(path)}(?:\\?|$)`)),
  ...PATH_PREFIXES.map((prefix) => new RegExp(`^${escapeRegExp(prefix)}`)),
];
