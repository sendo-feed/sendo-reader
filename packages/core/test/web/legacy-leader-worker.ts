/// <reference lib="webworker" />

/**
 * やり取りの版の番号の決まりより前の版の、代表のワーカーの名乗り方だけを真似る
 * （docs/decisions/local-first.md の 5）。代表のロックを取り、番号を付けずに名乗る。
 * 届いた頼みには答えず、ページに知らせる（タブが頼みを送らなかったことを確かめるため）。
 *
 * ページから：{ type: "post", message } で、その形のままほかのワーカーに送る。
 * ページへ：{ type: "leading" } で代表になったこと、{ type: "received", message } で届いた頼み。
 */
const scope = self as unknown as DedicatedWorkerGlobalScope;
const namespace = scope.name;
const workerId = crypto.randomUUID();
const peers = new BroadcastChannel(`${namespace}:peers`);

void navigator.locks.request(`${namespace}:leader`, async () => {
  peers.addEventListener("message", (event: MessageEvent<{ type: string }>) => {
    if (event.data.type === "hello") peers.postMessage({ type: "leader", leaderId: workerId });
    if (event.data.type === "call") scope.postMessage({ type: "received", message: event.data });
  });
  scope.addEventListener("message", (event: MessageEvent<{ type: "post"; message: unknown }>) => {
    peers.postMessage(event.data.message);
  });
  peers.postMessage({ type: "leader", leaderId: workerId });
  scope.postMessage({ type: "leading" });
  await new Promise(() => {});
});
