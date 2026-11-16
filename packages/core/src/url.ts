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

/** 解決の基準にする、実在しないオリジン。2 つで試して、絶対 URL を見分ける */
const PROBE_ORIGINS = ["https://a.invalid", "https://b.invalid"] as const;

/**
 * sendo が配った画像の URL（記事の thumbnailUrl、フィードの iconUrl）を、<img src> に入れてよいか
 * 確かめる（docs/decisions/images.md の 1）。同じオリジンを指すものだけを通し、そうでなければ
 * null にする。通すときは、受け取った文字列をそのまま返す（書き換えない。中身も読まない）。
 *
 * 文字列の形（/ で始まる、など）では決めない。ブラウザは \ を / と同じに扱い、タブや改行を
 * 取り除いてから解決するので、/\evil.example/a のように、形はパスでも別のオリジンを指す値がある。
 * ブラウザと同じ決まり（URL）で解決し、解決した先のオリジンが、基準にしたオリジンと同じかを見る。
 * 基準を 2 つ試すのは、絶対 URL（基準を無視する）を通さないため。
 */
export function toSameOriginUrl(raw: string | null | undefined): string | null {
  if (raw === null || raw === undefined || raw === "") return null;
  for (const origin of PROBE_ORIGINS) {
    let url: URL;
    try {
      url = new URL(raw, `${origin}/`);
    } catch {
      return null;
    }
    if (url.origin !== origin) return null;
  }
  return raw;
}
