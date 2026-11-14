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
   * 中断の合図は、呼び出す側がリクエストの signal に付ける（ログアウトしたら、そのログインで
   * 始めたリクエストを止める）。
   */
  async function send(request: Request): Promise<Response> {
    const token = options.token();
    const headers = new Headers(request.headers);
    if (token !== null && !headers.has("authorization")) {
      headers.set("authorization", `Bearer ${token}`);
    }
    const caller = request.signal;
    const signal = AbortSignal.any([caller, AbortSignal.timeout(timeoutMs)]);
    try {
      return await doFetch(new Request(request, { headers, signal }));
    } catch (error) {
      const reason = caller.aborted
        ? "中断した"
        : error instanceof DOMException && error.name === "TimeoutError"
          ? `${timeoutMs}ms 待っても応答がなかった`
          : String(error);
      throw new ApiError("network", `sendo に届かなかった：${reason}`);
    }
  }

  /** 生成した型付きのクライアント。操作の送信などで使う */
  const client = createClient<paths>({ baseUrl, fetch: send });

  return {
    client,

    /** 差分を 1 ページ取る（docs/decisions/sync.md）。cursor が null なら最初の同期 */
    async sync(cursor: string | null, signal?: AbortSignal): Promise<SyncPage> {
      const url = new URL(`${baseUrl}/sync`);
      if (cursor !== null) url.searchParams.set("cursor", cursor);
      const response = await send(new Request(url, signal === undefined ? {} : { signal }));
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
          ...(signal === undefined ? {} : { signal }),
        }),
      );
      if (!response.ok) throw await toApiError(response);
      await response.body?.cancel();
    },

    /** トークンが使えるかを確かめる。使えなければ ApiError("unauthorized") */
    async verifyToken(token: string, signal?: AbortSignal): Promise<void> {
      const { error, response } = await client.GET("/folders", {
        headers: { authorization: `Bearer ${token}` },
        ...(signal === undefined ? {} : { signal }),
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
