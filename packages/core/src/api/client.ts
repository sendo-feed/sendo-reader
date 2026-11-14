import createClient from "openapi-fetch";
import type { paths } from "./schema.gen";
import type { SyncResponse } from "./sync-contract";

/** sendo の API の失敗を、扱い方ごとに分けたもの */
export type ApiErrorKind =
  /** 届かなかった（オフライン、タイムアウトなど）。あとでやり直す */
  | "network"
  /** トークンがない、または取り消された。ログインし直す */
  | "unauthorized"
  /** 差分を出せないほどカーソルが古い。最初から同期し直す */
  | "cursor_expired"
  /** 相手がない（404） */
  | "not_found"
  /** ぶつかった（409） */
  | "conflict"
  /** リクエストが正しくない（そのほかの 4xx）。やり直しても変わらない */
  | "invalid"
  /** サーバーの不具合（5xx、429）。あとでやり直す */
  | "server";

export class ApiError extends Error {
  constructor(
    readonly kind: ApiErrorKind,
    message: string,
    readonly status?: number,
    readonly code?: string,
  ) {
    super(message);
    this.name = "ApiError";
  }
}

export interface SendoApiOptions {
  /** API の入口。画面では同じオリジンの "/api/v1"（reader Worker が sendo に中継する） */
  baseUrl: string;
  /** アクセストークン。ないときは null */
  token: () => string | null;
  fetch?: typeof fetch;
}

export type SendoApi = ReturnType<typeof createSendoApi>;

export function createSendoApi(options: SendoApiOptions) {
  const doFetch = options.fetch ?? ((input, init) => globalThis.fetch(input, init));
  const baseUrl = resolveBase(options.baseUrl.replace(/\/+$/, ""));

  /**
   * トークンを付けて送る（リクエストにすでに付いていれば、それを使う）。
   * 届かなかったら ApiError("network") にする。トークンはエラーの文言に入れない。
   */
  async function send(request: Request): Promise<Response> {
    const token = options.token();
    if (token !== null && !request.headers.has("authorization")) {
      request.headers.set("authorization", `Bearer ${token}`);
    }
    try {
      return await doFetch(request);
    } catch (error) {
      throw new ApiError("network", `sendo に届かなかった：${String(error)}`);
    }
  }

  /** 生成した型付きのクライアント。操作の送信などで使う */
  const client = createClient<paths>({ baseUrl, fetch: send });

  return {
    client,

    /** 差分を 1 ページ取る（docs/decisions/sync.md）。cursor が null なら最初の同期 */
    async sync(cursor: string | null): Promise<SyncResponse> {
      const url = new URL(`${baseUrl}/sync`);
      if (cursor !== null) url.searchParams.set("cursor", cursor);
      const response = await send(new Request(url));
      if (!response.ok) throw await toApiError(response);
      return (await response.json()) as SyncResponse;
    },

    /** トークンが使えるかを確かめる。使えなければ ApiError("unauthorized") */
    async verifyToken(token: string): Promise<void> {
      const { error, response } = await client.GET("/folders", {
        headers: { authorization: `Bearer ${token}` },
      });
      if (error !== undefined || !response.ok) throw classify(response.status, error);
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

/** 失敗した応答を ApiError にする（本文は sendo の共通のエラーの形） */
export async function toApiError(response: Response): Promise<ApiError> {
  let body: unknown;
  try {
    body = await response.json();
  } catch {
    // 本文が JSON でなければ、状態コードだけで分ける
  }
  return classify(response.status, body);
}

function classify(status: number, body: unknown): ApiError {
  const error = (body as { error?: { code?: unknown; message?: unknown } } | undefined)?.error;
  const code = typeof error?.code === "string" ? error.code : undefined;
  const message = typeof error?.message === "string" ? error.message : `HTTP ${status}`;
  const kind: ApiErrorKind =
    status === 401
      ? "unauthorized"
      : status === 410 && code === "cursor_expired"
        ? "cursor_expired"
        : status === 404
          ? "not_found"
          : status === 409
            ? "conflict"
            : status === 429 || status >= 500
              ? "server"
              : "invalid";
  return new ApiError(kind, message, status, code);
}
