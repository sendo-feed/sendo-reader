/**
 * 読み込み直すと消えるものを出している画面のパス（docs/decisions/ui.md の 5）。画面（自動の読み込み直し、
 * 新しい版の知らせ）と Service Worker（押された通知の記事を開かせる画面を選ぶ。
 * docs/decisions/push-receive.md の 3）の両方が見るので、画面だけの API を使わない。
 */

/** OAuth の許可の画面（docs/decisions/account.md の 5） */
export const AUTHORIZE_PATH = "/oauth/authorize";

/**
 * 設定（発行したトークン）、購読の管理（入力中のフォーム・取り込み結果）、ブックマークレットからの追加、
 * OAuth の許可
 */
const KEEP_PATHS: readonly string[] = ["/settings", "/manage", "/add", AUTHORIZE_PATH];

/**
 * いまの画面を読み込み直してよいか。読み込み直すと消えるものを出している画面（上のパス）と、出している
 * 間（held。lib/reload-guard.svelte.ts の印。開いている Save a URL の窓など）は false。自動の読み込み
 * 直し（main.ts の canReload）、新しい版の知らせ（App.svelte）、通知から記事を開くか（Service Worker と
 * lib/notification-open.ts）が、これで決める。パスはここに、パスで分からないものは reloadGuard の印で足す
 */
export function canReloadPage(pathname: string, held: boolean): boolean {
  return !KEEP_PATHS.includes(pathname) && !held;
}
