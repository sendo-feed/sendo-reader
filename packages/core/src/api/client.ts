import createClient from "openapi-fetch";
import type { SyncPage } from "../sync/page";
import { ApiError, errorFromBody, toApiError } from "./errors";
import type { paths } from "./schema.gen";
import { type MarkReadUpToCursorRequest, toSyncPage } from "./sync-contract";

export { ApiError, type ApiErrorKind, errorFromBody, toApiError } from "./errors";

/** 1 つのリクエストを待つ上限。止まった通信で同期がいつまでも終わらないようにする */
export const REQUEST_TIMEOUT_MS = 30_000;

export interface SendoApiOptions {
  /** API の入口。画面では同じオリジンの "/api/v1"（reader Worker が sendo に中継する） */
  baseUrl: string;
  /** アクセストークン。ないときは null */
  token: () => string | null;
  fetch?: typeof fetch;
  timeoutMs?: number;
}

export type SendoApi = ReturnType<typeof createSendoApi>;

export function createSendoApi(options: SendoApiOptions) {
  const doFetch = options.fetch ?? ((input, init) => globalThis.fetch(input, init));
  const baseUrl = resolveBase(options.baseUrl.replace(/\/+$/, ""));
  const timeoutMs = options.timeoutMs ?? REQUEST_TIMEOUT_MS;

  /**
   * トークンを付けて送る（リクエストにすでに付いていれば、それを使う）。届かない、時間切れ、
   * 中断は ApiError("network") にする。トークンはエラーの文言に入れない。
   *
   * 中断の合図（ログアウトしたら、そのログインで始めたリクエストを止める）は、Request には
   * 入れずに別に受け取り、自分の AbortController に直接つないで、終わるまで持っておく。
   * Request の signal や AbortSignal.any の引き継ぎは、Node（undici）では弱い参照でつながって
   * いて、途中のオブジェクトが回収されると中断が届かないことがある（Node 24 で確かめた）。
   */
  async function send(request: Request, signal: AbortSignal | undefined): Promise<Response> {
    const token = options.token();
    const headers = new Headers(request.headers);
    if (token !== null && !headers.has("authorization")) {
      headers.set("authorization", `Bearer ${token}`);
    }
    const controller = new AbortController();
    const onAbort = () => controller.abort(signal?.reason);
    if (signal?.aborted === true) onAbort();
    else signal?.addEventListener("abort", onAbort, { once: true });
    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      controller.abort(new DOMException(`${timeoutMs}ms`, "TimeoutError"));
    }, timeoutMs);
    try {
      return await doFetch(new Request(request, { headers }), { signal: controller.signal });
    } catch (error) {
      const reason =
        signal?.aborted === true
          ? "中断した"
          : timedOut
            ? `${timeoutMs}ms 待っても応答がなかった`
            : String(error);
      throw new ApiError("network", `sendo に届かなかった：${reason}`);
    } finally {
      clearTimeout(timer);
      signal?.removeEventListener("abort", onAbort);
    }
  }

  /**
   * 生成した型付きのクライアント。中断の合図を結び付けて、呼び出しごとに作る
   * （openapi-fetch は Request しか渡さないので、合図をここで結び付ける）
   */
  function client(signal?: AbortSignal) {
    return createClient<paths>({ baseUrl, fetch: (request) => send(request, signal) });
  }

  return {
    client,

    /** 差分を 1 ページ取る（docs/decisions/sync.md）。cursor が null なら最初の同期 */
    async sync(cursor: string | null, signal?: AbortSignal): Promise<SyncPage> {
      const url = new URL(`${baseUrl}/sync`);
      if (cursor !== null) url.searchParams.set("cursor", cursor);
      const response = await send(new Request(url), signal);
      if (!response.ok) throw await toApiError(response);
      let body: unknown;
      try {
        body = await response.json();
      } catch {
        throw new ApiError("server", "sendo の同期の応答が JSON でない", response.status);
      }
      return toSyncPage(body);
    },

    /**
     * まとめて既読にする。cursor（同期済みの範囲）までに受信箱に入っていた記事だけを既読にする
     * （sync.md の 6）。sendo の OpenAPI に入るまでの仮の形（sync-contract.ts）。
     */
    async markReadUpToCursor(request: MarkReadUpToCursorRequest, signal?: AbortSignal) {
      const response = await send(
        new Request(`${baseUrl}/articles/mark-read`, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ ...request.scope, cursor: request.cursor }),
        }),
        signal,
      );
      if (!response.ok) throw await toApiError(response);
      await response.body?.cancel();
    },

    /** トークンが使えるかを確かめる。使えなければ ApiError("unauthorized") */
    async verifyToken(token: string, signal?: AbortSignal): Promise<void> {
      const { error, response } = await client(signal).GET("/folders", {
        headers: { authorization: `Bearer ${token}` },
      });
      if (error !== undefined || !response.ok) throw errorFromBody(response.status, error);
    },
  };
}

/**
 * 画面では "/api/v1" のような同じオリジンのパスを渡す。ワーカーの中でも同じオリジンになるよう、
 * 今の場所（location）から絶対 URL にする。
 */
function resolveBase(baseUrl: string): string {
  if (!baseUrl.startsWith("/")) return baseUrl;
  const here = (globalThis as { location?: { href: string } }).location?.href;
  if (here === undefined)
    throw new Error(`相対の baseUrl（${baseUrl}）は、ブラウザの中でだけ使える`);
  return new URL(baseUrl, here).href.replace(/\/+$/, "");
}
