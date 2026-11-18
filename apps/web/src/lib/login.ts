import type { ReaderClient } from "@sendo-reader/core/web";
import { bookmarkletLoginRetryPath, bookmarkletReturnTo } from "./bookmarklet";
import { router } from "./router.svelte";

/**
 * Google でのログイン（docs/decisions/local-first.md の 6）。sendo のログインの入口へページごと
 * 移り、sendo がセッションのクッキーを置いて戻す。入口は /api の下なので、reader Worker（手元では
 * Vite の proxy）が sendo に中継し、Service Worker は横取りしない（vite.config.ts）。
 */
const LOGIN_PATH = "/api/v1/auth/google/login";

/** sendo が受ける returnTo の長さの上限。超えたら sendo は / に戻す */
const MAX_RETURN_TO = 1024;

/** ログインのあとに戻るパス。今の場所から、ログインの失敗の印を除いたもの */
export function currentReturnTo(): string {
  const url = new URL(location.href);
  const captured = bookmarkletReturnTo(url);
  if (captured !== null) return captured;
  url.searchParams.delete("login_error");
  const path = url.pathname + url.search;
  return path.length <= MAX_RETURN_TO ? path : "/";
}

/**
 * Google でログインする。ログアウトを sendo に送れていなければ先に送り（送れなければ投げる）、
 * sendo のログインの入口へ移る。
 */
export async function startSignIn(
  client: ReaderClient,
  returnTo = currentReturnTo(),
): Promise<void> {
  await client.prepareSignIn();
  goToSignIn(returnTo);
}

/**
 * sendo のログインの入口へ移る。手元のデータを使わない画面（OAuth の許可の画面）から使う。
 * reader の画面からは、送れていないログアウトを先に送る startSignIn を使う
 */
export function goToSignIn(returnTo: string): void {
  location.assign(`${LOGIN_PATH}?${new URLSearchParams({ returnTo })}`);
}

/** sendo がログインに失敗して戻すときの理由（sendo の src/api/login.ts）と、画面に出す文 */
const LOGIN_ERRORS: Record<string, string> = {
  invalid_request:
    "ログインを続けられませんでした。始めたときと違うブラウザか、時間がたちました。もう一度ログインしてください。",
  access_denied: "Google のログインをやめました。",
  provider_error: "Google とのやり取りに失敗しました。少し待ってからやり直してください。",
  invalid_id_token: "Google のログインを確かめられませんでした。もう一度ログインしてください。",
  email_not_verified: "Google でメールアドレスが確認されていないので、ログインできません。",
  not_allowed:
    "このメールアドレスでは使えません。sendo で許可された Google アカウントでログインしてください。",
};

/**
 * sendo がログインに失敗して戻した印（?login_error=<理由>）を読み、画面に出す文にする。
 * 印は URL から消す（読み込み直したときに、また出さないように）。印がなければ null。
 */
export function takeLoginError(): string | null {
  const url = new URL(location.href);
  const code = url.searchParams.get("login_error");
  if (code === null) return null;
  url.searchParams.delete("login_error");
  const capture = url.pathname === "/" ? bookmarkletLoginRetryPath() : null;
  router.replace(capture ?? url.href);
  return LOGIN_ERRORS[code] ?? "ログインできませんでした。";
}
