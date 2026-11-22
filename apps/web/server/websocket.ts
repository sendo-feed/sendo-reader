/**
 * WebSocket の Upgrade の中継（docs/decisions/container.md の 4）。sendo の通知
 * （/api/v1/sync/updates）に使う。
 *
 * HTTP の中継（proxy.ts）と同じく、書き換えない。
 * - 一覧（sendo-paths.ts）のパスだけを中継する。ほかの Upgrade は断る
 * - ヘッダーは、接続先で決まる Host と、1 回の接続にだけ関わるもの（Connection と Upgrade は
 *   残す）を除いて、そのまま渡す。Origin、Cookie、Sec-WebSocket-* もそのまま
 * - sendo が 101 を返したら、そのあとは両方向のバイト列を、フレームを読まずにそのまま流す。
 *   sendo の閉じるコードも、そのままブラウザに届く
 * - 101 以外の応答（401、403、429 など）は、そのまま返して閉じる
 * - sendo が決まった時間（HANDSHAKE_TIMEOUT_MS）のうちに答え終えなければ、504 で断って閉じる。
 *   黙った sendo に、ブラウザとの接続を持たせたままにしない。ブラウザはつなぎ直す
 *   （docs/decisions/local-first.md の 3）
 */
import type { IncomingMessage, OutgoingHttpHeaders } from "node:http";
import { request as httpRequest } from "node:http";
import { request as httpsRequest } from "node:https";
import type { Duplex } from "node:stream";
import { isSendoPath } from "../sendo-paths";

/** 中継から除くヘッダー（Connection と Upgrade は、Upgrade そのものなので残す） */
const SKIPPED = new Set([
  "host",
  "keep-alive",
  "proxy-authenticate",
  "proxy-authorization",
  "proxy-connection",
  "te",
  "trailer",
  "transfer-encoding",
]);

/** 101 以外の応答の本文を、ためて返す上限（エラーの短い本文だけを想定する） */
const MAX_ERROR_BODY = 64 * 1024;

/** sendo が Upgrade に答え終えるまで（101 か、断る応答の本文の終わりまで）待つ上限 */
export const HANDSHAKE_TIMEOUT_MS = 10 * 1000;

export type UpgradeRelayOptions = {
  /** テストで短くする */
  handshakeTimeoutMs?: number;
};

export type UpgradeRelay = {
  /** http.Server の upgrade のイベントで呼ぶ */
  handle(request: IncomingMessage, socket: Duplex, head: Buffer): void;
  /** 中継している接続を、すべて切る（止めるとき） */
  closeAll(): void;
};

function statusLine(status: number, message: string): string {
  return `HTTP/1.1 ${status} ${message}\r\n`;
}

/** 名前と値が交互に並ぶ rawHeaders を、そのままの順で書き出す */
function headerLines(rawHeaders: string[], skip: (name: string) => boolean = () => false): string {
  let lines = "";
  for (let i = 0; i + 1 < rawHeaders.length; i += 2) {
    const name = rawHeaders[i] ?? "";
    if (!skip(name.toLowerCase())) lines += `${name}: ${rawHeaders[i + 1] ?? ""}\r\n`;
  }
  return lines;
}

function reject(socket: Duplex, status: number, message: string): void {
  if (socket.destroyed) return;
  socket.end(`${statusLine(status, message)}Connection: close\r\nContent-Length: 0\r\n\r\n`);
}

function requestHeaders(rawHeaders: string[]): OutgoingHttpHeaders {
  const headers: OutgoingHttpHeaders = {};
  for (let i = 0; i + 1 < rawHeaders.length; i += 2) {
    const name = (rawHeaders[i] ?? "").toLowerCase();
    const value = rawHeaders[i + 1] ?? "";
    if (SKIPPED.has(name)) continue;
    const current = headers[name];
    headers[name] =
      current === undefined
        ? value
        : Array.isArray(current)
          ? [...current, value]
          : [String(current), value];
  }
  return headers;
}

export function createUpgradeRelay(
  sendoOrigin: string,
  options: UpgradeRelayOptions = {},
): UpgradeRelay {
  const handshakeTimeoutMs = options.handshakeTimeoutMs ?? HANDSHAKE_TIMEOUT_MS;
  const open = new Set<Duplex>();

  function track(...sockets: Duplex[]): void {
    for (const socket of sockets) {
      open.add(socket);
      socket.once("close", () => open.delete(socket));
    }
  }

  /**
   * upgrade のイベントで投げると、reader のプロセスごと落ちる（http.Server は、このイベントの例外を
   * 受け止めない）。どこで失敗しても、断って閉じる
   */
  function handle(request: IncomingMessage, socket: Duplex, head: Buffer): void {
    socket.on("error", () => socket.destroy());
    try {
      relay(request, socket, head);
    } catch (error) {
      console.error("could not relay websocket", { error });
      reject(socket, 400, "Bad Request");
    }
  }

  function relay(request: IncomingMessage, socket: Duplex, head: Buffer): void {
    let url: URL;
    try {
      url = new URL(request.url ?? "/", "http://reader.invalid");
    } catch {
      // 壊れたパス（//[ など）。URL として読めなければ、sendo のパスでもない
      reject(socket, 400, "Bad Request");
      return;
    }
    if (!url.pathname.startsWith("/") || !isSendoPath(url.pathname)) {
      reject(socket, 400, "Bad Request");
      return;
    }
    const target = new URL(sendoOrigin);
    target.pathname = url.pathname;
    target.search = url.search;
    const send = target.protocol === "https:" ? httpsRequest : httpRequest;
    const outgoing = send(target, {
      method: request.method,
      headers: requestHeaders(request.rawHeaders),
    });
    track(socket);

    // 答え終えたら（101 を流し始めたか、断る応答を返したら）止める
    let timedOut = false;
    const deadline = setTimeout(() => {
      timedOut = true;
      console.error("sendo did not answer websocket in time", { path: url.pathname });
      reject(socket, 504, "Gateway Timeout");
      outgoing.destroy();
    }, handshakeTimeoutMs);
    deadline.unref();

    outgoing.on("upgrade", (response, upstream, upstreamHead) => {
      clearTimeout(deadline);
      if (socket.destroyed || timedOut) {
        upstream.destroy();
        return;
      }
      track(upstream);
      socket.write(
        `${statusLine(response.statusCode ?? 101, response.statusMessage ?? "Switching Protocols")}${headerLines(response.rawHeaders)}\r\n`,
      );
      if (upstreamHead.length > 0) socket.write(upstreamHead);
      if (head.length > 0) upstream.write(head);
      upstream.on("error", () => upstream.destroy());
      // どちらかが切れたら、もう片方も切る
      upstream.on("close", () => socket.destroy());
      socket.on("close", () => upstream.destroy());
      upstream.pipe(socket);
      socket.pipe(upstream);
    });

    // 101 にならなかった（断られた、sendo が WebSocket を受けない）。応答をそのまま返して閉じる
    outgoing.on("response", (response) => {
      const chunks: Buffer[] = [];
      let size = 0;
      response.on("data", (chunk: Buffer) => {
        size += chunk.length;
        if (size <= MAX_ERROR_BODY) chunks.push(chunk);
      });
      response.on("end", () => {
        clearTimeout(deadline);
        const body = Buffer.concat(chunks);
        const lines = headerLines(
          response.rawHeaders,
          (name) =>
            name === "connection" ||
            name === "keep-alive" ||
            name === "transfer-encoding" ||
            name === "content-length",
        );
        if (socket.destroyed || timedOut) return;
        socket.end(
          Buffer.concat([
            Buffer.from(
              `${statusLine(response.statusCode ?? 502, response.statusMessage ?? "")}${lines}Connection: close\r\nContent-Length: ${body.length}\r\n\r\n`,
            ),
            body,
          ]),
        );
      });
      response.on("error", () => socket.destroy());
    });

    outgoing.on("error", (error) => {
      clearTimeout(deadline);
      // 待ちきれずに切ったときは、もう 504 で断ってある
      if (timedOut) return;
      // クエリには値が入りうるので、ログにはパスだけを出す
      console.error("could not reach sendo for websocket", { path: url.pathname, error });
      reject(socket, 502, "Bad Gateway");
    });
    socket.on("close", () => {
      clearTimeout(deadline);
      outgoing.destroy();
    });
    outgoing.end();
  }

  return {
    handle,
    closeAll() {
      for (const socket of open) socket.destroy();
      open.clear();
    },
  };
}
