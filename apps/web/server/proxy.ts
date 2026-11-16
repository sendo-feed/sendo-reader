/**
 * sendo への中継（docs/decisions/container.md の 4）。リクエストと応答を書き換えない。
 *
 * sendo は、受けたヘッダー（Cookie、Origin、Sec-Fetch-*）でセッションと CSRF を確かめ、URL の
 * オリジンを自分の設定（PUBLIC_URL）に置き換える。Cloudflare 版の Service binding と同じく、
 * ヘッダーも本文もそのまま渡し、X-Forwarded-* は付けない。除くのは、1 回の接続にだけ関わる
 * ヘッダー（hop-by-hop）と、接続先で決まる Host だけ。
 *
 * 送るのには fetch を使わず、node:http を使う。Node の fetch は、渡した Sec-Fetch-Mode を cors に
 * 書き換え、圧縮した応答の本文を自分で戻してしまう（Content-Encoding は残す）。node:http は、
 * ヘッダーも本文も、渡したとおりに送り、受けたとおりに返す。
 */
import { request as httpRequest, type IncomingMessage, type OutgoingHttpHeaders } from "node:http";
import { request as httpsRequest } from "node:https";
import { Readable } from "node:stream";
import type { ReadableStream as NodeReadableStream } from "node:stream/web";

/** 1 回の接続にだけ関わるヘッダー（RFC 9110 の 7.6.1） */
const HOP_BY_HOP = new Set([
  "connection",
  "keep-alive",
  "proxy-authenticate",
  "proxy-authorization",
  "proxy-connection",
  "te",
  "trailer",
  "transfer-encoding",
  "upgrade",
]);

/** 本文を持たない状態コード */
const NULL_BODY_STATUSES = new Set([101, 204, 205, 304]);

/** Connection に並べたヘッダーも、その接続だけのもの */
function connectionScoped(connection: string | string[] | undefined | null): Set<string> {
  const names = new Set(HOP_BY_HOP);
  const values = Array.isArray(connection) ? connection : [connection ?? ""];
  for (const token of values.join(",").split(",")) {
    const name = token.trim().toLowerCase();
    if (name !== "") names.add(name);
  }
  return names;
}

function requestHeaders(source: Headers): OutgoingHttpHeaders {
  const skip = connectionScoped(source.get("connection"));
  const headers: OutgoingHttpHeaders = {};
  for (const [name, value] of source) {
    // Host は接続先のものを node:http が付ける。Expect（100-continue）は、この接続の手順
    if (!skip.has(name) && name !== "host" && name !== "expect") headers[name] = value;
  }
  return headers;
}

function responseHeaders(response: IncomingMessage): Headers {
  const skip = connectionScoped(response.headers.connection);
  const headers = new Headers();
  // rawHeaders は名前と値が交互に並ぶ。同じ名前のヘッダー（複数の Set-Cookie など）も 1 つずつ残る
  const raw = response.rawHeaders;
  for (let i = 0; i + 1 < raw.length; i += 2) {
    const name = (raw[i] ?? "").toLowerCase();
    if (!skip.has(name)) headers.append(name, raw[i + 1] ?? "");
  }
  return headers;
}

function badGateway(): Response {
  return Response.json(
    { error: { code: "bad_gateway", message: "could not reach sendo" } },
    { status: 502 },
  );
}

/** リクエストを、パスとクエリはそのままに、sendo（sendoOrigin）へ送る */
export function proxyToSendo(request: Request, sendoOrigin: string): Promise<Response> {
  const url = new URL(request.url);
  const target = new URL(sendoOrigin);
  target.pathname = url.pathname;
  target.search = url.search;
  const send = target.protocol === "https:" ? httpsRequest : httpRequest;

  return new Promise((resolve) => {
    let settled = false;
    const fail = (error: unknown) => {
      if (settled) return;
      settled = true;
      // クエリには OAuth の値などが入りうるので、ログにはパスだけを出す
      if (!request.signal.aborted) {
        console.error("could not reach sendo", { path: url.pathname, error });
      }
      resolve(badGateway());
    };

    const outgoing = send(
      target,
      { method: request.method, headers: requestHeaders(request.headers), signal: request.signal },
      (response) => {
        settled = true;
        const status = response.statusCode ?? 502;
        const empty = NULL_BODY_STATUSES.has(status) || request.method === "HEAD";
        if (empty) response.resume();
        resolve(
          new Response(
            empty ? null : (Readable.toWeb(response) as unknown as ReadableStream<Uint8Array>),
            {
              status,
              statusText: response.statusMessage ?? "",
              headers: responseHeaders(response),
            },
          ),
        );
      },
    );
    outgoing.on("error", fail);

    // 本文はストリームのまま流す（OPML の取り込みなど）
    if (request.body && request.method !== "GET" && request.method !== "HEAD") {
      const body = Readable.fromWeb(request.body as unknown as NodeReadableStream<Uint8Array>);
      body.on("error", (error) => outgoing.destroy(error));
      body.pipe(outgoing);
    } else {
      outgoing.end();
    }
  });
}
