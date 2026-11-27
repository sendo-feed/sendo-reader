import { leaderLockName } from "@sendo-reader/core/web";
import { trimImageCache } from "@sendo-reader/core/web/image-cache";
import { mount } from "svelte";
import App from "./App.svelte";
import { showUnreadBadge } from "./lib/app-badge";
import { watchAppUpdate } from "./lib/app-update";
import { watchBackForwardCache } from "./lib/back-forward-cache";
import { readerContext } from "./lib/context";
import { articlePath } from "./lib/notification";
import {
  markAutoReload,
  noteNotificationOpen,
  takeAutoReloadMark,
  watchNotificationOpens,
} from "./lib/notification-open";
import { forgetTag, listTags } from "./lib/notification-store";
import { pushDevice } from "./lib/push-device";
import { startReader } from "./lib/reader";
import { reloadGuard } from "./lib/reload-guard.svelte";
import { AUTHORIZE_PATH, canReloadPage } from "./lib/reload-paths";
import { router } from "./lib/router.svelte";
import { registerServiceWorker } from "./lib/service-worker";
import { ReaderState } from "./lib/state.svelte";
import { updateNotice } from "./lib/update-notice.svelte";
import Authorize from "./routes/Authorize.svelte";
import "./app.css";
// 表示の好み（テーマ、文字の大きさ）を、画面を出す前に当てる
import { prefs } from "./lib/prefs.svelte";

const target = document.getElementById("app");
if (!target) throw new Error("#app が見つからない");

/** 画面が前に出て、自動で読み込み直すかが決まったら呼ぶ（消えた通知を比べる） */
let onVisible: (reloading: boolean) => void = () => {};

if (location.pathname === AUTHORIZE_PATH) {
  // OAuth の許可の画面は、sendo のセッションだけで動き、手元のデータを使わない
  // （docs/decisions/account.md の 5）。DB のワーカーも起こさない
  mount(Authorize, { target });
} else {
  // 戻る・進むで、ブラウザに位置を戻させない。狭い画面では、一覧と記事が同じページを動かすので、
  // 一覧の位置は画面の側で戻す（routes/Reader.svelte。docs/decisions/ui.md の 6）
  history.scrollRestoration = "manual";
  const reader = startReader();
  // reader の外へ移る前と bfcache に入るときにワーカーを止め、bfcache から戻ったら読み込み直す。
  // Safari は、ワーカーごとページを止めて残すので、代表のロックを持ったまま、次に開いたページを
  // 待たせる（lib/back-forward-cache.ts）
  const page = watchBackForwardCache({
    window,
    locks: navigator.locks,
    leaderLock: leaderLockName(),
    release: reader.stop,
    reload: () => location.reload(),
    assign: (url) => location.assign(url),
    onStalled: () => {
      state.leaveStalled = true;
    },
  });
  const state = new ReaderState(reader.client, page.leave);
  // 設定の正は手元の DB（docs/decisions/settings.md）。つないで、読み直す
  prefs.connect(state.client);
  // インストールしたアプリのアイコンに、未読の数を出す。Badging API のないブラウザーでは何もしない
  const refreshBadge =
    "setAppBadge" in navigator ? showUnreadBadge(state.client, navigator, document) : () => {};
  // この端末で通知を受ける操作（docs/decisions/notifications.md の 1〜4）。送る前に、セッションの
  // ユーザーが手元のユーザーと同じかを確かめ、違えば同期に切り替えを任せる
  pushDevice.connect({
    user: () => state.user,
    onAccountChanged: () => void state.client.syncNow().catch(() => {}),
    // 通知を許可したときと、ログアウトとユーザーの切り替えで登録を外したときに書き直す
    // （docs/decisions/notifications.md の 4・11）
    refreshBadge,
  });
  // ログアウトとユーザーの切り替えで、この端末の登録を外す（どのタブで起きても届く）
  state.client.onCleared(() => void pushDevice.forget());
  mount(App, { target, context: readerContext(state) });
  // 起動したら、登録があれば送り直す（sendo は登録をセッションに結ぶ。docs/decisions/notifications.md の 3）。
  // 起動が版の違うタブのために止まったら、止まりが解けてログインしていると分かったときに送る
  state.onceSignedIn(() => void pushDevice.resend());
  void state.init();
  // 画像のキャッシュが上限（100MB）を超えていたら、古いものから捨てる（docs/decisions/images.md
  // の 3）。起動してしばらくしてからと、そのあとは一定の間隔で見る（画面の表示は待たせない）
  const trim = () => void trimImageCache().catch(() => {});
  setTimeout(trim, 10_000);
  setInterval(trim, 10 * 60_000);

  // 押された通知の記事を、この画面で開く（docs/decisions/notifications.md の 7・8）。記事の URL を
  // 開いたときと同じ道で開く
  const opens = watchNotificationOpens({
    serviceWorker: navigator.serviceWorker ?? null,
    shownTags: async () => {
      const registration = await navigator.serviceWorker?.getRegistration("/");
      return ((await registration?.getNotifications()) ?? []).map((n) => n.tag);
    },
    listTags,
    forgetTag,
    now: () => Date.now(),
    visibility: () => document.visibilityState,
    takeAutoReloadMark,
    vanishedOpens:
      (navigator as Navigator & { standalone?: boolean }).standalone === true &&
      navigator.maxTouchPoints > 1,
    canOpen: () => canReloadPage(location.pathname, reloadGuard.held),
    open: (articleId) => {
      noteNotificationOpen(articleId);
      router.navigate(articlePath(articleId));
    },
  });
  onVisible = opens.onVisible;

  // タブが前に出たら、しばらく同期していなければ同期してもらう
  document.addEventListener("visibilitychange", () => {
    if (document.visibilityState === "visible") state.client.notifyVisible();
  });
}

// アプリの外枠と SQLite の wasm を Service Worker でキャッシュし、ネットワークがなくても起動する
// （docs/decisions/ui.md）。新しい版に替わったら、画面が裏にある間か、次に前に出たときに
// 読み込み直し、前に出ている間は知らせる。手元の dev サーバーでは使わない
if (import.meta.env.PROD) {
  const container = navigator.serviceWorker;
  watchAppUpdate({
    serviceWorker: container
      ? {
          get controller() {
            return container.controller;
          },
          addEventListener: (type, listener) => container.addEventListener(type, listener),
          register: () => registerServiceWorker(container),
        }
      : null,
    version: __APP_VERSION__,
    fetch: (path, init) => fetch(path, init),
    document,
    // 自動で読み込み直す前に印を置く（読み込み直したあとの起動を、前に出たときと同じに扱う。
    // docs/decisions/notifications.md の 8）
    reload: () => {
      markAutoReload();
      location.reload();
    },
    // 読み込み直すと消えるものを出している画面では、ほかの画面に移ってから切り替える
    canReload: () => canReloadPage(location.pathname, reloadGuard.held),
    setInterval: (fn, ms) => setInterval(fn, ms),
    // 前に出ている間は読み込み直さないので、画面で知らせる（App.svelte）
    onNotice: (notice) => updateNotice.show(notice),
    onVisible: (reloading) => onVisible(reloading),
  });
}
