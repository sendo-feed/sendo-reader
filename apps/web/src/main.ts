import { trimImageCache } from "@sendo-reader/core/web/image-cache";
import { mount } from "svelte";
import App from "./App.svelte";
import { watchAppUpdate } from "./lib/app-update";
import { AUTHORIZE_PATH } from "./lib/authorize";
import { readerContext } from "./lib/context";
import { startReader } from "./lib/reader";
import { ReaderState } from "./lib/state.svelte";
import { trustedScriptUrl } from "./lib/trusted";
import Authorize from "./routes/Authorize.svelte";
import "./app.css";
// 表示の好み（テーマ、文字の大きさ）を、画面を出す前に当てる
import { prefs } from "./lib/prefs.svelte";

const target = document.getElementById("app");
if (!target) throw new Error("#app が見つからない");

if (location.pathname === AUTHORIZE_PATH) {
  // OAuth の許可の画面は、sendo のセッションだけで動き、手元のデータを使わない
  // （docs/decisions/account.md の 5）。DB のワーカーも起こさない
  mount(Authorize, { target });
} else {
  const state = new ReaderState(startReader());
  // 設定の正は手元の DB（docs/decisions/settings.md）。つないで、読み直す
  prefs.connect(state.client);
  mount(App, { target, context: readerContext(state) });
  void state.init();

  // 画像のキャッシュが上限（100MB）を超えていたら、古いものから捨てる（docs/decisions/images.md
  // の 3）。起動してしばらくしてからと、そのあとは一定の間隔で見る（画面の表示は待たせない）
  const trim = () => void trimImageCache().catch(() => {});
  setTimeout(trim, 10_000);
  setInterval(trim, 10 * 60_000);

  // タブが前に出たら、しばらく同期していなければ同期してもらう
  document.addEventListener("visibilitychange", () => {
    if (document.visibilityState === "visible") state.client.notifyVisible();
  });
}

// アプリの外枠と SQLite の wasm を Service Worker でキャッシュし、ネットワークがなくても起動する
// （docs/decisions/ui.md）。新しい版に替わったら、画面が裏にある間か、次に前に出たときに
// 読み込み直す。手元の dev サーバーでは使わない
if (import.meta.env.PROD && "serviceWorker" in navigator) {
  watchAppUpdate({
    container: navigator.serviceWorker,
    register: () => navigator.serviceWorker.register(trustedScriptUrl("/sw.js"), { scope: "/" }),
    document,
    reload: () => location.reload(),
    // 設定の画面（発行したアクセストークンを一度だけ出す）と、OAuth の許可の画面では、
    // 読み込み直さない。ほかの画面に移ってから切り替える
    canReload: () => location.pathname !== "/settings" && location.pathname !== AUTHORIZE_PATH,
    setInterval: (fn, ms) => setInterval(fn, ms),
  });
}
