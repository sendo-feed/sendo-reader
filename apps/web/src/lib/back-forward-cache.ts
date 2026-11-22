/** ページの出入り（pagehide ／ pageshow）を聞ける相手。本番は window */
export interface PageTransitionTarget {
  addEventListener(
    type: "pagehide" | "pageshow",
    listener: (event: { readonly persisted: boolean }) => void,
  ): void;
}

export interface BackForwardCacheEnvironment {
  window: PageTransitionTarget;
  /** DB のワーカーを止め、代表のロックと DB（OPFS）を離す */
  release: () => void;
  /** ページを読み込み直す */
  reload: () => void;
}

/**
 * ページが bfcache（戻る・進むのためのページのキャッシュ）に入るときに、DB のワーカーを止める。
 * Safari は、ワーカーごとページを止めて残すので、代表のロックを持ったまま答えなくなり、次に開いた
 * ページのワーカーがロックを待ち続ける（Loading… で止まる）。止めておけば、代表のタブを閉じたときと
 * 同じく、待っているタブが代表を引き継ぐ（docs/decisions/local-first.md の 5）。
 * bfcache から戻ったときは、ワーカーがいないので、読み込み直す。
 * ロックを持つページを bfcache に入れないブラウザ（Chromium）では、persisted が true にならない
 * ので、何もしない。
 */
export function releaseOnBackForwardCache(env: BackForwardCacheEnvironment): void {
  let released = false;
  env.window.addEventListener("pagehide", (event) => {
    if (!event.persisted || released) return;
    released = true;
    env.release();
  });
  env.window.addEventListener("pageshow", (event) => {
    if (event.persisted && released) env.reload();
  });
}
