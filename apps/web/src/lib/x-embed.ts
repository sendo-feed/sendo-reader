/**
 * X の投稿の隔離フレームのオリジン（docs/decisions/embeds.md の 3）。
 *
 * reader のコンテナのサーバー（手元では Vite の dev サーバーと preview）が、設定があるときだけ
 * index.html に <meta name="sendo-x-embed-origin"> で埋める。CSP の frame-src と同じ応答から来るので、
 * 食い違わない。通信は待たない。
 */
import { toXEmbedOrigin, X_EMBED_ORIGIN_META } from "../../x-embed-origin";

/**
 * 隔離フレームのオリジン。未設定なら null。
 *
 * <meta> の値も確かめ直し、形が合わない、または reader と同じホスト名なら、未設定として扱う
 * （同じホスト名では、隔離にならない）
 */
export function xEmbedOrigin(
  doc: Pick<Document, "querySelector"> = document,
  here: Pick<Location, "hostname"> = location,
): string | null {
  const value = doc.querySelector(`meta[name="${X_EMBED_ORIGIN_META}"]`)?.getAttribute("content");
  if (!value) return null;
  const origin = toXEmbedOrigin(value, { allowDevelopment: true });
  if (origin === null) return null;
  return new URL(origin).hostname === here.hostname.toLowerCase() ? null : origin;
}
