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

/** Workers Static Assets の設定のファイル。画面のファイルではないので返さない */
const IGNORED = new Set(["_headers", "_redirects"]);

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
    if (IGNORED.has(relative) || relative.split("/").some((part) => part.startsWith("."))) {
      continue;
    }
    assets.set(`/${relative}`, toAsset(file, new Uint8Array(await readFile(file))));
  }
  if (!assets.has("/index.html")) {
    throw new Error(`index.html is not found in ${directory}; run vite build first`);
  }
  return assets;
}
