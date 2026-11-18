/** sendo の保存 URL の決まり（docs/decisions/saved.md）と同じ形にする。 */
export function normalizeSavedUrl(raw: string): string | null {
  const text = raw.trim();
  if (text.length === 0 || text.length > 2048) return null;
  let url: URL;
  try {
    url = new URL(text);
  } catch {
    return null;
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") return null;
  if (url.username || url.password || url.href.length > 2048) return null;
  return url.href;
}

export const SAVED_PAGE_LIMIT = 2000;
export const SAVED_TITLE_LIMIT = 300;
export const SAVED_ID_PATTERN = /^[0-9a-f]{64}$/;

/** オフラインで保存したときも、sendo が正規化した URL に付ける ID と揃える。 */
export async function savedPageId(url: string): Promise<string> {
  const hash = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(url));
  return Array.from(new Uint8Array(hash), (byte) => byte.toString(16).padStart(2, "0")).join("");
}
