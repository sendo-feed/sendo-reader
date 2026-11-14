import { mount } from "svelte";
import App from "./App.svelte";
import { readerContext } from "./lib/context";
import { startReader } from "./lib/reader";
import { ReaderState } from "./lib/state.svelte";
import { trustedScriptUrl } from "./lib/trusted";
import "./app.css";

const target = document.getElementById("app");
if (!target) throw new Error("#app が見つからない");

const state = new ReaderState(startReader());
mount(App, { target, context: readerContext(state) });
void state.init();

// タブが前に出たら、しばらく同期していなければ同期してもらう
document.addEventListener("visibilitychange", () => {
  if (document.visibilityState === "visible") state.client.notifyVisible();
});

// アプリの外枠と SQLite の wasm を Service Worker でキャッシュし、ネットワークがなくても起動する
// （docs/decisions/ui.md）。手元の dev サーバーでは使わない
if (import.meta.env.PROD && "serviceWorker" in navigator) {
  void navigator.serviceWorker.register(trustedScriptUrl("/sw.js"), { scope: "/" });
}
