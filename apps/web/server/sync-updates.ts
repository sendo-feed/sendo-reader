import {
  request as httpRequest,
  type IncomingMessage,
  ServerResponse,
  STATUS_CODES,
} from "node:http";
import { request as httpsRequest } from "node:https";
import type { Socket } from "node:net";
import type { Duplex } from "node:stream";
import { SYNC_UPDATES_PATH } from "../sendo-paths";
import { forwardedRequestHeaders, forwardedResponseHeaders } from "./proxy";

const HANDSHAKE_TIMEOUT_MS = 10_000;
const MAX_PENDING_BYTES = 64 * 1024;

export function createSyncUpdatesProxy(sendoOrigin: string) {
  const sockets = new Set<Duplex>();
  const pendingHttp = new WeakMap<Socket, number>();

  // HTTP 応答が残っているソケットは、応答の順番を管理する Node に任せる。
  function trackRequest(request: IncomingMessage, response: ServerResponse): void {
    const socket = request.socket;
    pendingHttp.set(socket, (pendingHttp.get(socket) ?? 0) + 1);
    response.once("finish", () => {
      const remaining = (pendingHttp.get(socket) ?? 1) - 1;
      if (remaining === 0) pendingHttp.delete(socket);
      else pendingHttp.set(socket, remaining);
    });
  }

  function shouldUpgrade(request: IncomingMessage): boolean {
    const headers = request.headers;
    return (
      request.method === "GET" &&
      request.url?.split("?", 1)[0] === SYNC_UPDATES_PATH &&
      !pendingHttp.has(request.socket) &&
      headers.upgrade?.toLowerCase() === "websocket" &&
      headers["transfer-encoding"] === undefined &&
      (headers["content-length"] === undefined || headers["content-length"] === "0")
    );
  }

  function handle(request: IncomingMessage, downstream: Duplex, head: Buffer): void {
    // 接続先は運用者の設定から取る。ブラウザは接続先を選べない。
    const target = new URL(sendoOrigin);
    target.pathname = SYNC_UPDATES_PATH;
    target.search = new URL(request.url ?? SYNC_UPDATES_PATH, target).search;
    const send = target.protocol === "https:" ? httpsRequest : httpRequest;
    const headers = forwardedRequestHeaders(
      Object.entries(request.headers).filter(([name]) => !name.startsWith("x-forwarded-")),
      request.headers.connection,
    );
    headers.connection = "Upgrade";
    headers.upgrade = "websocket";

    sockets.add(downstream);
    let pendingBytes = head.length;
    const pending = head.length > 0 ? [head] : [];
    let upstream: Duplex | undefined;
    let settled = false;
    const outgoing = send(target, { method: "GET", headers, agent: false });
    const deadline = setTimeout(() => reject(504), HANDSHAKE_TIMEOUT_MS).unref();

    function reject(status: number): void {
      if (settled) return;
      settled = true;
      clearTimeout(deadline);
      outgoing.destroy();
      if (!downstream.destroyed) {
        downstream.end(
          `HTTP/1.1 ${status} ${STATUS_CODES[status] ?? ""}\r\nConnection: close\r\nContent-Length: 0\r\n\r\n`,
          () => downstream.destroy(),
        );
      }
    }

    function bufferPending(chunk: Buffer): void {
      pendingBytes += chunk.length;
      if (pendingBytes > MAX_PENDING_BYTES) downstream.destroy();
      else pending.push(chunk);
    }

    downstream.on("error", () => downstream.destroy());
    downstream.once("end", () => downstream.destroy());
    // 読み続けて、Sendo の応答を待つ間にもクライアントの切断を拾う。
    downstream.on("data", bufferPending);
    downstream.once("close", () => {
      sockets.delete(downstream);
      clearTimeout(deadline);
      outgoing.destroy();
      upstream?.destroy();
    });

    outgoing.once("error", () => reject(502));
    outgoing.once("response", (response) => {
      if (settled || downstream.destroyed) {
        response.destroy();
        return;
      }
      // Upgrade しなかった場合は、通常の HTTP と同じく応答のヘッダーと本文を中継する。
      settled = true;
      clearTimeout(deadline);
      const reply = new ServerResponse(request);
      // HTTP/1.1 の GET が Upgrade に渡した TCP ソケット。HTTP の応答を書き直す相手にする。
      reply.assignSocket(downstream as Socket);
      reply.shouldKeepAlive = false;
      reply.sendDate = false;
      reply.writeHead(response.statusCode ?? 502, [
        ...forwardedResponseHeaders(response),
        "Connection",
        "close",
      ]);
      reply.once("finish", () => {
        downstream.end(() => downstream.destroy());
      });
      response.on("error", () => downstream.destroy());
      response.pipe(reply);
    });
    outgoing.once("upgrade", (response, peer, upstreamHead) => {
      if (settled || downstream.destroyed) {
        peer.destroy();
        return;
      }
      if (response.statusCode !== 101 || response.headers.upgrade?.toLowerCase() !== "websocket") {
        peer.destroy();
        reject(502);
        return;
      }
      settled = true;
      clearTimeout(deadline);
      upstream = peer;
      peer.on("error", () => peer.destroy());
      peer.once("close", () => downstream.destroy());

      const lines = [
        "HTTP/1.1 101 Switching Protocols",
        "Connection: Upgrade",
        "Upgrade: websocket",
      ];
      const headers = forwardedResponseHeaders(response);
      for (let i = 0; i < headers.length; i += 2) {
        lines.push(`${headers[i]}: ${headers[i + 1]}`);
      }
      downstream.write(`${lines.join("\r\n")}\r\n\r\n`, "latin1");
      if (upstreamHead.length > 0) downstream.write(upstreamHead);
      downstream.off("data", bufferPending);
      for (const chunk of pending) peer.write(chunk);
      downstream.pipe(peer);
      peer.pipe(downstream);
    });
    outgoing.end();
  }

  return {
    handle,
    shouldUpgrade,
    trackRequest,
    stop() {
      for (const socket of sockets) socket.destroy();
    },
  };
}
