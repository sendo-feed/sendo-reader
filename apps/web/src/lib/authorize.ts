/**
 * OAuth の許可の画面（/oauth/authorize。docs/decisions/account.md の 5）の、ログインをまたぐ
 * クエリの受け渡し。
 *
 * sendo のログインの returnTo は 1024 文字までで、認可のクエリは入りきらないことがある。そこで、
 * ログインに回す前にクエリをそのタブの sessionStorage に置き、returnTo=/oauth/authorize で戻った
 * ときに取り出す。置いたクエリは取り出したら消し、古いもの（ログインの画面にいられる 10 分を
 * 過ぎたもの）は使わない。
 */

const KEY = "sendo-reader:oauth-authorize";
const MAX_AGE_MS = 10 * 60 * 1000;

/** ログインに回す前に、今のクエリを置く */
export function saveAuthorizeQuery(query: string, now = Date.now()): void {
  try {
    sessionStorage.setItem(KEY, JSON.stringify({ query, savedAt: now }));
  } catch {
    // 置けなければ、戻ったときにクエリがなく、やり直してもらうことになる
  }
}

/**
 * 許可の画面で使うクエリ。URL にあればそれを使い、なければ（ログインから戻ってきたとき）置いた
 * クエリを取り出す。どちらの場合も、置いたクエリは消す。使えるクエリがなければ null
 */
export function takeAuthorizeQuery(search: string, now = Date.now()): string | null {
  let saved: string | null = null;
  try {
    saved = sessionStorage.getItem(KEY);
    sessionStorage.removeItem(KEY);
  } catch {
    // 読めなければ、置いていないことにする
  }
  if (search !== "" && search !== "?") return search;
  if (saved === null) return null;
  try {
    const parsed = JSON.parse(saved) as { query?: unknown; savedAt?: unknown };
    if (typeof parsed.query !== "string" || typeof parsed.savedAt !== "number") return null;
    if (now - parsed.savedAt > MAX_AGE_MS || parsed.savedAt > now) return null;
    return parsed.query;
  } catch {
    return null;
  }
}
