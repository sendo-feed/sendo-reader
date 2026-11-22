/**
 * コンテナ版の reader のサーバーの設定を読む（docs/decisions/container.md の 4）。
 */
import { toXEmbedOrigin } from "../x-embed-origin";

export type Env = Readonly<Record<string, string | undefined>>;

/** 中継の先は、http か https のオリジン（パス、クエリ、ユーザー名なし）だけを受ける */
export function parseSendoUrl(value: string | undefined): string {
  const text = value?.trim() || "http://sendo:8787";
  const url = new URL(text);
  if (
    (url.protocol !== "http:" && url.protocol !== "https:") ||
    url.username !== "" ||
    url.password !== "" ||
    url.pathname !== "/" ||
    url.search !== "" ||
    url.hash !== ""
  ) {
    throw new Error(`SENDO_URL must be an http(s) origin: ${text}`);
  }
  return url.origin;
}

/**
 * X の投稿の隔離フレームのオリジン（docs/decisions/embeds.md の 3）。なければ null。
 * コンテナは https だけを受け付ける（開発用の http は、手元の Vite の dev サーバーと preview だけ）
 */
export function parseXEmbedOrigin(value: string | undefined): string | null {
  const text = value?.trim() ?? "";
  if (text === "") return null;
  const origin = toXEmbedOrigin(text, { allowDevelopment: false });
  if (origin === null) {
    throw new Error(
      `X_EMBED_ORIGIN must be an https origin without a path, query, hash or credentials: ${text}`,
    );
  }
  return origin;
}

export function parsePort(value: string | undefined): number {
  const text = value?.trim() || "8080";
  const port = Number(text);
  if (!/^\d+$/.test(text) || port < 1 || port > 65535) {
    throw new RangeError(`invalid PORT: ${text}`);
  }
  return port;
}
