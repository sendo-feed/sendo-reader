/** sendo の API の失敗を、扱い方ごとに分けたもの */
export type ApiErrorKind =
  /** 届かなかった（オフライン、タイムアウト、中断など）。あとでやり直す */
  | "network"
  /** トークンがない、または取り消された。ログインし直す */
  | "unauthorized"
  /** カーソルが読めない（古すぎて差分を出せない、形が変わった）。最初から同期し直す */
  | "cursor_invalid"
  /** 相手がない（404） */
  | "not_found"
  /** ぶつかった（409） */
  | "conflict"
  /** リクエストが正しくない（そのほかの 4xx）。やり直しても変わらない */
  | "invalid"
  /** サーバーの不具合（5xx、429、応答の形の誤り）。あとでやり直す */
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

/** 失敗した応答を ApiError にする（本文は sendo の共通のエラーの形） */
export async function toApiError(response: Response): Promise<ApiError> {
  let body: unknown;
  try {
    body = await response.json();
  } catch {
    // 本文が JSON でなければ、状態コードだけで分ける
  }
  return errorFromBody(response.status, body);
}

/** 失敗した応答の状態コードと本文から ApiError を作る */
export function errorFromBody(status: number, body: unknown): ApiError {
  const error = (body as { error?: { code?: unknown; message?: unknown } } | undefined)?.error;
  const code = typeof error?.code === "string" ? error.code : undefined;
  const message = typeof error?.message === "string" ? error.message : `HTTP ${status}`;
  const kind: ApiErrorKind =
    status === 401
      ? "unauthorized"
      : status === 400 && code === "invalid_cursor"
        ? "cursor_invalid"
        : status === 404
          ? "not_found"
          : status === 409
            ? "conflict"
            : status === 429 || status >= 500
              ? "server"
              : "invalid";
  return new ApiError(kind, message, status, code);
}
