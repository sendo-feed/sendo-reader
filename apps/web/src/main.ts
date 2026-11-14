import { mount } from "svelte";
import App from "./App.svelte";
import { readerContext } from "./lib/context";
import { startReader } from "./lib/reader";
import { ReaderState } from "./lib/state.svelte";
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
