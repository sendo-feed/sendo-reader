/**
 * 画面のビルド（vite build の dist）を、起動するときにすべてメモリーに読み込む。
 *
 * ファイルは十数個・数 MB なので、読み込んでおけば、リクエストのたびにファイルを開かずに済み、
 * パスからファイルを探すこともない（dist の外のファイルを返すおそれがない）。圧縮と ETag も、
 * ここで 1 回だけ作る。
 */
import { createHash } from "node:crypto";
import { readdir, readFile } from "node:fs/promises";
import path from "node:path";
import { brotliCompressSync, constants, gzipSync } from "node:zlib";
import { applyXEmbedOrigin } from "../x-embed-origin";
import type { Asset, Assets, AssetVariant } from "./static";

const CONTENT_TYPES: Record<string, string> = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".mjs": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".map": "application/json; charset=utf-8",
  ".webmanifest": "application/manifest+json; charset=utf-8",
  ".wasm": "application/wasm",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".ico": "image/x-icon",
  ".txt": "text/plain; charset=utf-8",
};

/** 圧縮すると小さくなる形式（画像の png などは、もともと圧縮してある） */
const COMPRESSIBLE = new Set([
  ".html",
  ".js",
  ".mjs",
  ".css",
  ".json",
  ".map",
  ".webmanifest",
  ".wasm",
  ".svg",
  ".txt",
]);

function hashOf(body: Uint8Array): string {
  return createHash("sha256").update(body).digest("base64url").slice(0, 22);
}

function compressed(
  body: Uint8Array,
  compress: (input: Uint8Array) => Uint8Array,
): Uint8Array | undefined {
  const result = compress(body);
  return result.byteLength < body.byteLength ? result : undefined;
}

function toAsset(file: string, body: Uint8Array): Asset {
  const extension = path.extname(file).toLowerCase();
  const hash = hashOf(body);
  const variant = (data: Uint8Array, suffix: string): AssetVariant => ({
    body: data,
    etag: `"${hash}${suffix}"`,
  });
  const asset: Asset = {
    type: CONTENT_TYPES[extension] ?? "application/octet-stream",
    identity: variant(body, ""),
  };
  if (COMPRESSIBLE.has(extension)) {
    const br = compressed(body, (input) =>
      brotliCompressSync(input, {
        params: {
          [constants.BROTLI_PARAM_QUALITY]: constants.BROTLI_MAX_QUALITY,
          [constants.BROTLI_PARAM_SIZE_HINT]: input.byteLength,
        },
      }),
    );
    const gzip = compressed(body, (input) => gzipSync(input, { level: 9 }));
    if (br) asset.br = variant(br, "-br");
    if (gzip) asset.gzip = variant(gzip, "-gz");
  }
  return asset;
}

/** dist の下のファイルを、URL のパス（/assets/index-xxx.js など）ごとに読み込む */
export async function loadAssets(directory: string): Promise<Assets> {
  const entries = await readdir(directory, { recursive: true, withFileTypes: true });
  const assets = new Map<string, Asset>();
  for (const entry of entries) {
    if (!entry.isFile()) continue;
    const file = path.join(entry.parentPath, entry.name);
    const relative = path.relative(directory, file).split(path.sep).join("/");
    if (relative.split("/").some((part) => part.startsWith("."))) {
      continue;
    }
    assets.set(`/${relative}`, toAsset(file, new Uint8Array(await readFile(file))));
  }
  if (!assets.has("/index.html")) {
    throw new Error(`index.html is not found in ${directory}; run vite build first`);
  }
  return assets;
}

/**
 * X の投稿の隔離フレームのページ（apps/web/x-embed の index.html と embed.js。docs/decisions/embeds.md
 * の 2・3）。隔離フレームのホスト名の / と /embed.js で返す。画面のビルド（dist）とは別に、サーバーの
 * バンドルに取り込む（x-embed-page.ts）ので、reader のホスト名では返さず、Service Worker の precache
 * にも入らない
 */
export function xEmbedPageAssets(html: string, script: string): Assets {
  const encoder = new TextEncoder();
  return new Map([
    ["/", toAsset("index.html", encoder.encode(html))],
    ["/embed.js", toAsset("embed.js", encoder.encode(script))],
  ]);
}

/** 隔離フレームのページを、置き場所から読む（テストと、バンドルしない手元の確かめ用） */
export async function loadXEmbedPage(directory: string): Promise<Assets> {
  return xEmbedPageAssets(
    await readFile(path.join(directory, "index.html"), "utf8"),
    await readFile(path.join(directory, "embed.js"), "utf8"),
  );
}

/**
 * X の投稿の隔離フレームのオリジンが設定してあるときの、画面のファイル（docs/decisions/embeds.md の 3）。
 * index.html に <meta> を足し、sw.js の中の index.html の revision を、書き換えたあとの index.html と
 * 付ける CSP から作った値に替える。Service Worker が新しい版として取り込み、index.html を取り直す。
 * 書き換えられなければ投げる（起動しない）
 */
export async function withXEmbedOrigin(
  assets: Assets,
  origin: string,
  csp: string,
): Promise<Assets> {
  const decoder = new TextDecoder("utf-8", { fatal: true });
  const index = assets.get("/index.html");
  const sw = assets.get("/sw.js");
  if (index === undefined || sw === undefined) {
    throw new Error("index.html and sw.js are needed to set X_EMBED_ORIGIN; run vite build first");
  }
  const files = await applyXEmbedOrigin(
    { indexHtml: decoder.decode(index.identity.body), sw: decoder.decode(sw.identity.body) },
    origin,
    csp,
  );
  const encoder = new TextEncoder();
  const next = new Map(assets);
  next.set("/index.html", toAsset("index.html", encoder.encode(files.indexHtml)));
  next.set("/sw.js", toAsset("sw.js", encoder.encode(files.sw)));
  return next;
}
