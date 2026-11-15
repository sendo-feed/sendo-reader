import { mount } from "svelte";
import App from "./App.svelte";
import { AUTHORIZE_PATH } from "./lib/authorize";
import { readerContext } from "./lib/context";
import { startReader } from "./lib/reader";
import { ReaderState } from "./lib/state.svelte";
import { trustedScriptUrl } from "./lib/trusted";
import Authorize from "./routes/Authorize.svelte";
import "./app.css";
// 表示の好み（テーマ、文字の大きさ）を、画面を出す前に当てる
import "./lib/prefs.svelte";

const target = document.getElementById("app");
if (!target) throw new Error("#app が見つからない");

if (location.pathname === AUTHORIZE_PATH) {
  // OAuth の許可の画面は、sendo のセッションだけで動き、手元のデータを使わない
  // （docs/decisions/account.md の 5）。DB のワーカーも起こさない
  mount(Authorize, { target });
} else {
  const state = new ReaderState(startReader());
  mount(App, { target, context: readerContext(state) });
  void state.init();

  // タブが前に出たら、しばらく同期していなければ同期してもらう
  document.addEventListener("visibilitychange", () => {
    if (document.visibilityState === "visible") state.client.notifyVisible();
  });
}

// アプリの外枠と SQLite の wasm を Service Worker でキャッシュし、ネットワークがなくても起動する
// （docs/decisions/ui.md）。手元の dev サーバーでは使わない
if (import.meta.env.PROD && "serviceWorker" in navigator) {
  void navigator.serviceWorker.register(trustedScriptUrl("/sw.js"), { scope: "/" });
}
