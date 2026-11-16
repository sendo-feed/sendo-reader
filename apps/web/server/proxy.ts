/**
 * sendo への中継（docs/decisions/container.md の 4）。リクエストと応答を書き換えない。
 *
 * sendo は、受けたヘッダー（Cookie、Origin、Sec-Fetch-Site）でセッションと CSRF を確かめ、URL の
 * オリジンを自分の設定（PUBLIC_URL）に置き換える。Cloudflare 版の Service binding と同じく、
 * ヘッダーも本文もそのまま渡し、X-Forwarded-* は付けない。除くのは、1 回の接続にだけ関わる
 * ヘッダー（hop-by-hop）と、接続先で決まる Host だけ。
 */

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
function connectionScoped(headers: Headers): Set<string> {
  const names = new Set(HOP_BY_HOP);
  for (const token of (headers.get("connection") ?? "").split(",")) {
    const name = token.trim().toLowerCase();
    if (name !== "") names.add(name);
  }
  return names;
}

function requestHeaders(source: Headers): Headers {
  const skip = connectionScoped(source);
  const headers = new Headers();
  for (const [name, value] of source) {
    if (!skip.has(name) && name !== "host" && name !== "expect") headers.append(name, value);
  }
  // Node の fetch は、圧縮した応答を自分で戻してしまう（Content-Encoding は残る）。sendo には
  // 圧縮しないで返してもらい、本文をそのまま流す。ブラウザまでの圧縮は、手前のプロキシに任せる
  headers.set("accept-encoding", "identity");
  return headers;
}

function responseHeaders(source: Headers): Headers {
  const skip = connectionScoped(source);
  const headers = new Headers();
  for (const [name, value] of source) {
    if (!skip.has(name) && name !== "set-cookie") headers.append(name, value);
  }
  // Set-Cookie は 1 つにまとめられないので、1 つずつ足す
  for (const cookie of source.getSetCookie()) headers.append("set-cookie", cookie);
  // 圧縮しないよう頼んでも圧縮して返したときは、fetch が戻した本文に合わせる
  if (headers.has("content-encoding")) {
    headers.delete("content-encoding");
    headers.delete("content-length");
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
export async function proxyToSendo(
  request: Request,
  sendoOrigin: string,
  fetchFn: typeof fetch = fetch,
): Promise<Response> {
  const url = new URL(request.url);
  const target = new URL(sendoOrigin);
  target.pathname = url.pathname;
  target.search = url.search;

  const hasBody = request.method !== "GET" && request.method !== "HEAD";
  let response: Response;
  try {
    response = await fetchFn(target, {
      method: request.method,
      headers: requestHeaders(request.headers),
      body: hasBody ? request.body : null,
      // ログインの 302 などは、追わずにブラウザへ返す
      redirect: "manual",
      signal: request.signal,
      // 本文をストリームのまま渡すのに要る（Node の fetch の決まり）
      ...(hasBody ? { duplex: "half" } : {}),
    } as RequestInit);
  } catch (error) {
    // クエリには OAuth の値などが入りうるので、ログにはパスだけを出す
    if (!request.signal.aborted)
      console.error("could not reach sendo", { path: url.pathname, error });
    return badGateway();
  }

  const body =
    NULL_BODY_STATUSES.has(response.status) || request.method === "HEAD" ? null : response.body;
  return new Response(body, {
    status: response.status,
    statusText: response.statusText,
    headers: responseHeaders(response.headers),
  });
}
