/**
 * 記事やフィードの URL を、リンク（href）に入れてよい形にする。
 *
 * sendo は http ／ https の URL だけを返すが、記事のデータは信頼できないので、
 * 画面に出す前にもう一度確かめる（docs/decisions/ui.md の守る規約）。
 * `javascript:` や `data:` などは null にする。
 */
export function toSafeHttpUrl(raw: string | null | undefined): string | null {
  if (raw === null || raw === undefined) return null;
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    return null;
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") return null;
  return url.href;
}
