import { createHmac, randomBytes, timingSafeEqual } from "node:crypto";
import {
  type ClientRequest,
  request as httpRequest,
  type IncomingMessage,
  type ServerResponse,
  STATUS_CODES,
} from "node:http";
import { request as httpsRequest } from "node:https";
import type { Socket } from "node:net";
import type { Duplex } from "node:stream";
import { parse as parseCookie } from "hono/utils/cookie";
import { SYNC_UPDATES_PROTOCOL_PREFIX } from "../../../packages/core/src/web/sync-updates-protocol.ts";
import { SYNC_UPDATES_PATH } from "../sendo-paths.ts";
import { forwardedRequestHeaders, forwardedResponseHeaders } from "./proxy.ts";

const HANDSHAKE_TIMEOUT_MS = 10_000;
const REJECTION_IDLE_TIMEOUT_MS = 30_000;
const MAX_PENDING_BYTES = 64 * 1024;
const SESSION_COOKIE = "__Host-sendo_session";

function writeResponseHead(
  socket: Duplex,
  status: number,
  message: string,
  headers: string[],
): void {
  const lines = [`HTTP/1.1 ${status} ${message}`];
  for (let i = 0; i < headers.length; i += 2) {
    lines.push(`${headers[i]}: ${headers[i + 1]}`);
  }
  socket.write(`${lines.join("\r\n")}\r\n\r\n`, "latin1");
}

export function createSyncUpdatesProxy(
  sendoOrigin: string,
  options: { preserveHost?: boolean } = {},
) {
  const sockets = new Set<Duplex>();
  const pendingHttp = new WeakMap<Socket, number>();
  const sessionKey = randomBytes(32);

  /** /me と Upgrade に同じセッションのクッキーが付いたことを、クッキーを公開せずに確かめる。 */
  function sessionProtocol(cookieHeader: string | null | undefined): string | undefined {
    const cookie = cookieHeader ? parseCookie(cookieHeader, SESSION_COOKIE)[SESSION_COOKIE] : null;
    if (!cookie) return undefined;
    const proof = createHmac("sha256", sessionKey).update(cookie).digest("base64url");
    return `${SYNC_UPDATES_PROTOCOL_PREFIX}${proof}`;
  }

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
    if (options.preserveHost && request.headers.host !== undefined) {
      headers.host = request.headers.host;
    }
    const cookie = headers.cookie;
    const protocol = headers["sec-websocket-protocol"];
    // このサブプロトコルは reader が消費する。Sendo には WebSocket の通常の要求を渡す。
    delete headers["sec-websocket-protocol"];
    headers.connection = "Upgrade";
    headers.upgrade = "websocket";

    sockets.add(downstream);
    let pendingBytes = head.length;
    const pending = head.length > 0 ? [head] : [];
    let upstream: Duplex | undefined;
    let outgoing: ClientRequest | undefined;
    let settled = false;
    const deadline = setTimeout(() => reject(504), HANDSHAKE_TIMEOUT_MS).unref();

    function reject(status: number): void {
      if (settled) return;
      settled = true;
      clearTimeout(deadline);
      outgoing?.destroy();
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
      outgoing?.destroy();
      upstream?.destroy();
    });

    function forwardUpgrade(selectedProtocol: string): void {
      const upgrade = send(target, { method: "GET", headers, agent: false });
      outgoing = upgrade;
      upgrade.once("error", () => reject(502));
      upgrade.once("response", forwardRejection);
      upgrade.once("upgrade", (response, peer, upstreamHead) => {
        if (settled || downstream.destroyed) {
          peer.destroy();
          return;
        }
        if (
          response.statusCode !== 101 ||
          response.headers.upgrade?.toLowerCase() !== "websocket" ||
          response.headers["sec-websocket-protocol"] !== undefined
        ) {
          peer.destroy();
          reject(502);
          return;
        }
        settled = true;
        clearTimeout(deadline);
        upstream = peer;
        peer.on("error", () => peer.destroy());
        peer.once("close", () => downstream.destroy());

        writeResponseHead(downstream, 101, "Switching Protocols", [
          ...forwardedResponseHeaders(response),
          "Connection",
          "Upgrade",
          "Upgrade",
          "websocket",
          "Sec-WebSocket-Protocol",
          selectedProtocol,
        ]);
        if (upstreamHead.length > 0) downstream.write(upstreamHead);
        downstream.off("data", bufferPending);
        for (const chunk of pending) peer.write(chunk);
        downstream.pipe(peer);
        peer.pipe(downstream);
      });
      upgrade.end();
    }

    function forwardRejection(response: IncomingMessage): void {
      if (settled || downstream.destroyed) {
        response.destroy();
        return;
      }
      // Upgrade しなかった場合は、通常の HTTP と同じく応答のヘッダーと本文を中継する。
      settled = true;
      clearTimeout(deadline);
      outgoing?.setTimeout(REJECTION_IDLE_TIMEOUT_MS, () => downstream.destroy());
      const status = response.statusCode ?? 502;
      writeResponseHead(downstream, status, response.statusMessage ?? STATUS_CODES[status] ?? "", [
        ...forwardedResponseHeaders(response),
        "Connection",
        "close",
      ]);
      response.on("error", () => downstream.destroy());
      response.pipe(downstream);
    }

    if (typeof protocol !== "string" || !protocol.startsWith(SYNC_UPDATES_PROTOCOL_PREFIX)) {
      reject(400);
      return;
    }
    const expected = sessionProtocol(typeof cookie === "string" ? cookie : undefined);
    if (expected === undefined) {
      reject(401);
      return;
    }
    const offeredBytes = Buffer.from(protocol);
    const expectedBytes = Buffer.from(expected);
    if (
      offeredBytes.length !== expectedBytes.length ||
      !timingSafeEqual(offeredBytes, expectedBytes)
    ) {
      reject(403);
      return;
    }
    forwardUpgrade(protocol);
  }

  return {
    handle,
    sessionProtocol,
    shouldUpgrade,
    trackRequest,
    stop() {
      for (const socket of sockets) socket.destroy();
    },
  };
}
