/**
 * 画面の静的なファイルを返す（docs/decisions/container.md の 5）。
 *
 * - セキュリティのヘッダーは、手元の Vite と同じところ（security-headers.ts）から付ける
 * - キャッシュは毎回確かめさせる（ETag。変わっていなければ 304）。sw.js が新しい版を見つけられるように、
 *   長く持たせない
 * - ないパスには index.html を返す（SPA）
 * - ブラウザが受けられれば、圧縮して返す
 */
import { securityHeaders } from "../security-headers";

export type AssetVariant = { body: Uint8Array; etag: string };

export type Asset = {
  type: string;
  identity: AssetVariant;
  br?: AssetVariant;
  gzip?: AssetVariant;
};

/** URL のパス（/index.html など）ごとのファイル */
export type Assets = ReadonlyMap<string, Asset>;

/** 毎回確かめさせる（Service Worker が新しい版を見つけられるように、長く持たせない） */
const CACHE_CONTROL = "public, max-age=0, must-revalidate";

type Encoding = "br" | "gzip";

/** Accept-Encoding から、受けられる圧縮を選ぶ（br を先に） */
export function chooseEncoding(header: string | null, asset: Asset): Encoding | undefined {
  if (!header) return undefined;
  const weights = new Map<string, number>();
  for (const part of header.split(",")) {
    const [name = "", ...params] = part.trim().toLowerCase().split(";");
    if (name === "") continue;
    let weight = 1;
    for (const param of params) {
      const match = /^\s*q\s*=\s*([0-9.]+)\s*$/.exec(param);
      if (match?.[1] !== undefined) weight = Number(match[1]);
    }
    weights.set(name, Number.isNaN(weight) ? 0 : weight);
  }
  const accepts = (name: string) => (weights.get(name) ?? weights.get("*") ?? 0) > 0;
  if (asset.br && accepts("br")) return "br";
  if (asset.gzip && accepts("gzip")) return "gzip";
  return undefined;
}

/** If-None-Match に、この ETag が入っているか（弱い比較） */
function matchesEtag(header: string | null, etag: string): boolean {
  if (!header) return false;
  return header
    .split(",")
    .map((value) => value.trim().replace(/^W\//, ""))
    .some((value) => value === "*" || value === etag);
}

function decodePath(pathname: string): string {
  try {
    return decodeURIComponent(pathname);
  } catch {
    return pathname;
  }
}

function findAsset(pathname: string, assets: Assets): Asset | undefined {
  const exact = assets.get(decodePath(pathname));
  if (exact) return exact;
  // 画面のルート（/settings、/feeds/<ID> など）や、ないパスには index.html を返す
  return assets.get("/index.html");
}

export function serveAsset(request: Request, assets: Assets): Response {
  const headers = new Headers(securityHeaders("production"));
  if (request.method !== "GET" && request.method !== "HEAD") {
    headers.set("allow", "GET, HEAD");
    return new Response(null, { status: 405, headers });
  }
  const asset = findAsset(new URL(request.url).pathname, assets);
  if (!asset) return new Response("Not Found", { status: 404, headers });

  const encoding = chooseEncoding(request.headers.get("accept-encoding"), asset);
  const variant = (encoding && asset[encoding]) || asset.identity;
  headers.set("content-type", asset.type);
  headers.set("cache-control", CACHE_CONTROL);
  headers.set("etag", variant.etag);
  // 圧縮のあるファイルは、Accept-Encoding で中身が変わる
  if (asset.br || asset.gzip) headers.set("vary", "accept-encoding");
  if (encoding) headers.set("content-encoding", encoding);

  if (matchesEtag(request.headers.get("if-none-match"), variant.etag)) {
    return new Response(null, { status: 304, headers });
  }
  headers.set("content-length", String(variant.body.byteLength));
  return new Response(request.method === "HEAD" ? null : variant.body, { status: 200, headers });
}
