import type { FakeSendo } from "../fake-sendo";

/**
 * ワーカーの中から、テストのページにある偽の sendo に話すための橋渡し。どのタブ（ワーカー）から
 * 話しても、同じ 1 つの偽の sendo が答える（タブを引き継いでも、サーバーの状態は続く）。
 */

type BridgeRequest = {
  kind: "request";
  id: string;
  method: string;
  url: string;
  headers: [string, string][];
  body: string | null;
};
type BridgeResponse =
  | { kind: "response"; id: string; status: number; headers: [string, string][]; body: string }
  | { kind: "error"; id: string; message: string };

/** テストのページで、偽の sendo を答えさせる。やめるときは返した関数を呼ぶ */
export function serveFakeSendo(server: FakeSendo, channelName: string): () => void {
  const channel = new BroadcastChannel(channelName);
  channel.onmessage = async (event: MessageEvent<BridgeRequest | BridgeResponse>) => {
    const message = event.data;
    if (message.kind !== "request") return;
    try {
      const init: RequestInit = { method: message.method, headers: message.headers };
      if (message.body !== null) init.body = message.body;
      const response = await server.fetch(new Request(message.url, init));
      channel.postMessage({
        kind: "response",
        id: message.id,
        status: response.status,
        headers: [...response.headers],
        body: await response.text(),
      } satisfies BridgeResponse);
    } catch (error) {
      channel.postMessage({ kind: "error", id: message.id, message: String(error) });
    }
  };
  return () => channel.close();
}

/** ワーカーの中で使う fetch。テストのページの偽の sendo に送る */
export function bridgeFetch(channelName: string): typeof fetch {
  const channel = new BroadcastChannel(channelName);
  const waiting = new Map<string, (message: BridgeResponse) => void>();
  channel.onmessage = (event: MessageEvent<BridgeRequest | BridgeResponse>) => {
    const message = event.data;
    if (message.kind === "request") return;
    waiting.get(message.id)?.(message);
    waiting.delete(message.id);
  };
  return async (input, init) => {
    const request = new Request(input, init);
    const id = crypto.randomUUID();
    const body = request.body === null ? null : await request.text();
    const answer = new Promise<BridgeResponse>((resolve) => waiting.set(id, resolve));
    channel.postMessage({
      kind: "request",
      id,
      method: request.method,
      url: request.url,
      headers: [...request.headers],
      body,
    } satisfies BridgeRequest);
    const message = await Promise.race([
      answer,
      new Promise<never>((_, reject) => {
        request.signal.addEventListener("abort", () => reject(request.signal.reason), {
          once: true,
        });
      }),
    ]);
    if (message.kind === "error") throw new TypeError(message.message);
    return new Response(message.status === 204 ? null : message.body, {
      status: message.status,
      headers: message.headers,
    });
  };
}
