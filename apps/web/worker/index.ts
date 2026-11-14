/**
 * reader Worker の入口。
 *
 * 静的なファイル（画面）は Workers Static Assets が返す。wrangler.jsonc の run_worker_first で、
 * /api だけがここに来るようにしてあり、Service binding で sendo に中継する。ブラウザからは
 * 同じオリジンに見えるので、CORS は要らない（docs/decisions/ui.md）。
 */
export default {
  fetch(request, env) {
    return handleRequest(request, env);
  },
} satisfies ExportedHandler<Env>;

export function handleRequest(request: Request, env: Pick<Env, "SENDO" | "ASSETS">) {
  const { pathname } = new URL(request.url);
  if (pathname === "/api" || pathname.startsWith("/api/")) {
    return env.SENDO.fetch(request);
  }
  return env.ASSETS.fetch(request);
}
