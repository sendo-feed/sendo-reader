# sendo-reader

Sendo の公式リーダー。`packages/core`（同期エンジン）と `apps/web`・`apps/mobile` のモノレポ。API の型は sendo の OpenAPI から生成する。

このファイルは AI エージェント（Claude Code、Codex など）共通の指示。開発は主に Claude Code で行い、Codex はおもにレビューに使う。

## 最初に読むもの

- `docs/decisions/`：このリポジトリの今の決定。ほかの文書と食い違ったら、こちらが正しい。特に `local-first.md`（同期とローカル DB）、`ui.md`（UI とツール）、`performance.md`（速さの予算）
- サーバーとの約束ごと（認証、差分同期）は sendo の決定が正：`accounts.md`、`sync.md`
- プロダクト全体の目的・進め方・技術構成は sendo リポジトリにある：
  - https://github.com/sendo-feed/sendo/tree/main/docs/decisions
  - https://github.com/sendo-feed/sendo/blob/main/docs/inception-deck.md
  - https://github.com/sendo-feed/sendo/blob/main/docs/tech-deck.md

## 開発コマンド

- `pnpm install`：依存を入れる。あわせて `apps/web/worker/worker-configuration.d.ts`（reader Worker の型）を生成する
- `pnpm check`：型チェック、lint、テストをまとめて実行する。変更したら、コミットの前に必ず通す
- `pnpm format`：整形して、直せる lint の指摘を直す（Biome。`.svelte` も対象）
- `pnpm dev`：画面の dev サーバー（http://localhost:5173）。`/api` は手元の sendo（http://localhost:8787）に中継する。sendo は sendo の README のとおりに別に動かす
- `pnpm build`：画面をビルドし、reader Worker をデプロイせずにバンドルして確かめる
- `pnpm size`：ビルドのあとに、画面のスレッドの JS が予算（gzip 後 100KB）に収まるか確かめる
- `apps/web/wrangler.jsonc` を変えたら `pnpm --filter @sendo-reader/web cf-typegen` で型を作り直す
- sendo の API が変わったら、`pnpm --filter @sendo-reader/core api:fetch`（手元の sendo の `/api/v1/openapi.json` を `packages/core/src/api/openapi.json` に写す。`SENDO_OPENAPI` で別の URL かファイルを指せる）と `pnpm --filter @sendo-reader/core api:generate`（`schema.gen.ts` を作る）を実行し、両方をコミットする。生成したファイルは手で直さない（CI で食い違いを検査している）

## ディレクトリ

- `packages/core/`：同期エンジンとローカル DB（UI に依存しない）。`test/` にテスト（Vitest、Node で動く）
  - `src/reader.ts`：`ReaderCore`。ログイン、同期、手元の DB の読み出し、変更の通知をまとめる窓口
  - `src/api/`：sendo の API。`schema.gen.ts` は OpenAPI から生成したもの。`sync-contract.ts` は、sendo の OpenAPI に `/sync` が入るまでの仮の応答の形（仮の形を使うのは、このファイルと `client.ts` の `sync()` だけにする）
  - `src/db/`：DB の窓口（`database.ts`）、スキーマとマイグレーション（`schema.ts`。足すだけにし、出したものは書き換えない）、画面のための読み出し（`queries.ts`）、sqlite-wasm の実装（`sqlite-wasm.ts`）
  - `src/sync/`：差分同期（`pull.ts`）
  - `test/fake-sendo.ts`：sendo の差分同期の決定に沿った偽のサーバー。core のテストはこれを相手にし、外へは通信しない。手元の DB は、本番と同じ sqlite-wasm を Node のメモリーで開く（`test/helpers.ts`）
- `apps/web/`：PWA（Svelte 5 ＋ Vite の SPA）
  - `src/`：画面。`main.ts` が入口、`App.svelte` が一番外の部品
  - `worker/`：reader Worker。静的なファイルは Workers Static Assets が返し、`/api` だけを Service binding で sendo に中継する
  - `security-headers.ts`：CSP などのヘッダー。dev サーバーと、本番の `dist/_headers` の両方に使う
  - `test/`：reader Worker とヘッダーのテスト
- `scripts/`：手元と CI で動かす道具（Node で動く。`node:*` を使ってよい）
- `apps/mobile/`：Capacitor（あとで作る）

## 言語

- 文書、コミットメッセージ、PR、レビューコメントは日本語で書く（一般に公開したら英語に切り替える）
- 識別子は英語

## コミットメッセージ

Conventional Commits を土台にする。全文は https://github.com/sendo-feed/.github/blob/main/CONTRIBUTING.md

- 形式：`<type>(<scope>): <件名>`。type は feat ／ fix ／ docs ／ decision ／ refactor ／ perf ／ test ／ build ／ ci ／ chore ／ revert
- 本文には「なぜ」を書く
- `docs/decisions/` を変えるときは `decision(<テーマ>): …` にし、本文に何をなぜ変えたかを書く。ほかの変更とは分けて単独の PR にする（スカッシュマージで PR が1つのコミットになるため）
- `main` に force push しない

## 決定の扱い

- 決定は `docs/decisions/<テーマ>.md` にテーマごとに置き、今の決定だけを書く。決定が変わったらファイルを書き換え、古い内容は残さない
- 経緯を聞かれたら `git log -p -- docs/decisions/<テーマ>.md` を読んで答える
- 決定ファイルを足したり状態を変えたりしたら、`docs/decisions/README.md` の一覧も直す

## 守る規約

- 同期とローカル DB のロジックはすべて `packages/core` に入れる。`packages/core` は UI のフレームワーク（`svelte`）と `apps/` に依存しない（Biome の `noRestrictedImports` で検査している）
- `packages/core`、`apps/web/src`、`apps/web/worker` では `node:*` を使わない（ブラウザと Workers で動くため。Biome で検査している）
- 画面はネットワークを待たない。読み書きはローカル DB に対して行い、サーバーとは同期で揃える
- OpenAPI から生成したファイルは手で直さない。sendo の OpenAPI を直して生成し直す
- 記事のデータ（タイトル、要約、本文）は信頼できないデータとして扱う
  - `{@html}` を使わない（Biome の `noSvelteAtHtmlTags` で検査している）。本文の HTML を出すときは、サニタイズしてから専用の部品で出す
  - URL は `toSafeHttpUrl`（`packages/core`）を通し、http ／ https のものだけを `href` に入れる
- CSP を緩めない（`apps/web/security-headers.ts`）。インラインのスクリプト、`eval`、テンプレートの `style` 属性（本番の CSP で止まる。`style:` ディレクティブか CSS のクラスを使う）、ほかのオリジンへの通信を使わない。緩める必要が出たら、`docs/decisions/local-first.md` を直してから変える
- アクセストークンを、ログ、エラーの表示、URL、Service Worker のキャッシュに入れない
- 速さの予算（`docs/decisions/performance.md`）を超える依存を足さない。足す前に `pnpm build && pnpm size` で確かめる
- Svelte の `generics="…"` の中に `{` を書かない（Biome が解析に失敗する）。型に名前を付けてから使う

## 変更の進め方

- すべての変更は下書きの PR で出す。`main` へは直接 push できない
- 下書きの PR には Codex のレビューを回し、終了の条件を満たすまで直す。Claude Code では `/review-loop` スキルがこれを回す
- マージは、人間にマージを指示されたときだけ行う。自分の判断ではマージしない
- 終了の条件、優先度の定義、指摘の扱いの全文は CONTRIBUTING.md の「レビューの進め方」にある

## Review guidelines

指摘には、必ず次の優先度のどれかを付ける。終了の条件はこの優先度で判定するので、ぶれないようにする。

| 優先度 | 意味 |
|---|---|
| P0 | データの消失や破損、セキュリティの穴、本番が動かなくなる |
| P1 | 明らかなバグ、`docs/decisions/` との食い違い、下の観点で挙げた規約の破れ |
| P2 | 直すべきだが今すぐでなくてよい（境界条件、テスト不足など） |
| P3 | 軽微なことや好み |

レビューは日本語で書く。いまは2人で試作を繰り返している段階なので、捨てる前提の試作の完成度や、書き方の好みは指摘しなくてよい（整形と lint は Biome に任せる）。次の観点を優先する。

1. **決定との食い違い**：`docs/decisions/` や sendo 側の決定と食い違う変更がないか
2. **core と画面の境界**：`packages/core` が UI のフレームワークや `apps/` に依存していないか。同期やデータのロジックが `apps/` に漏れていないか
3. **ローカルファースト**：画面の操作がネットワークの応答を待っていないか。オフラインで操作したときに、操作キューと楽観的更新で正しく戻せるか
4. **速さの予算**：JS が gzip 後 100KB を超えそうな依存の追加や、操作の反応が 100ms を超えそうな処理がないか
5. **セキュリティ**：記事のデータの HTML の出し方（XSS）、URL のスキームの確かめ漏れ、CSP や Trusted Types を緩める変更、トークンの保存場所、ログへの秘密情報の出力
6. **生成物**：OpenAPI から生成したファイルを手で直していないか
7. **テスト**：振る舞いを変える変更に、それを確かめるテストがあるか
8. **PR の書き方**：タイトルがコミットメッセージの形式か。説明に「なぜ」が書かれているか
