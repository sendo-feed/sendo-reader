// sendo の OpenAPI の定義を取ってきて、src/api/openapi.json に写す。
//
//   pnpm --filter @sendo-reader/core api:fetch                 # 手元の sendo（http://localhost:8787）から
//   SENDO_OPENAPI=<URL か パス> pnpm --filter @sendo-reader/core api:fetch
//
// sendo は、OpenAPI の定義を spec/openapi.json に書き出している。sendo のクローンがあれば、
// SENDO_OPENAPI=<sendo>/spec/openapi.json でそのファイルを指せる（sendo を動かさなくてよい）。
// 写したあとは `api:generate` で型を作り直し、両方をコミットする。

import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";

const source = process.env.SENDO_OPENAPI ?? "http://localhost:8787/api/v1/openapi.json";
const text = /^https?:\/\//.test(source)
  ? await (async () => {
      const response = await fetch(source);
      if (!response.ok) throw new Error(`${source} の取得に失敗した：${response.status}`);
      return response.text();
    })()
  : await readFile(source, "utf8");

const spec = JSON.parse(text);
if (typeof spec.openapi !== "string" || typeof spec.paths !== "object") {
  throw new Error(`${source} は OpenAPI の定義に見えない`);
}
const out = join(import.meta.dirname, "..", "src", "api", "openapi.json");
await writeFile(out, `${JSON.stringify(spec, null, 2)}\n`);
console.log(`${source} → ${out}（${Object.keys(spec.paths).length} パス）`);
