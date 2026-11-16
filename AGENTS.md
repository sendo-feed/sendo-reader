# sendo-reader

Sendo の公式リーダー。`packages/core`（同期エンジン）と `apps/web`・`apps/mobile` のモノレポ。API の型は sendo の OpenAPI から生成する。

このファイルは AI エージェント（Claude Code、Codex など）共通の指示。開発は主に Claude Code で行い、Codex はおもにレビューに使う。

## 最初に読むもの

- `docs/decisions/`：このリポジトリの今の決定。ほかの文書と食い違ったら、こちらが正しい。特に `local-first.md`（同期とローカル DB）、`ui.md`（UI とツール）、`performance.md`（速さの予算）、`images.md`（サムネイルとアイコン）、`settings.md`（設定の同期）
- サーバーとの約束ごと（認証、差分同期、設定の預かり方）は sendo の決定が正：`accounts.md`、`sync.md`、`settings.md`
- プロダクト全体の目的・進め方・技術構成は sendo リポジトリにある：
  - https://github.com/sendo-feed/sendo/tree/main/docs/decisions
  - https://github.com/sendo-feed/sendo/blob/main/docs/inception-deck.md
  - https://github.com/sendo-feed/sendo/blob/main/docs/tech-deck.md

## 開発コマンド

- `pnpm install`：依存を入れる。あわせて `apps/web/worker/worker-configuration.d.ts`（reader Worker の型）を生成する
- `pnpm check`：型チェック、lint、テストをまとめて実行する。変更したら、コミットの前に必ず通す
- `pnpm format`：整形して、直せる lint の指摘を直す（Biome。`.svelte` も対象）
- `pnpm dev`：画面の dev サーバー（http://localhost:5173）。`/api` は手元の sendo（http://localhost:8787）に中継する。sendo は sendo の README のとおりに別に動かす
- `pnpm build`：画面をビルドし、reader Worker をデプロイせずにバンドルして確かめる。コンテナ版のサーバーも `apps/web/dist-server/server.mjs` にバンドルする
- `pnpm --filter @sendo-reader/web start:server`：コンテナ版のサーバーを手元の Node で動かす（`pnpm build` のあとに。`SENDO_URL` で中継の先を、`PORT` で受けるポートを変える）。イメージは `docker build -t sendo-reader .`
- `pnpm run deploy`：画面をビルドし、reader Worker をデプロイする。ふつうは各自の fork への push で、Workers Builds がこれを動かす（`docs/decisions/deploy.md`）。手順を変えるときは、画面のコマンド（`pnpm run deploy`）を変えずに済むよう、`package.json` の側で直す
- `pnpm size`：ビルドのあとに、画面のスレッドの JS（gzip 後 100KB）と、DB のワーカーの JS と wasm（550KB）が予算に収まるか確かめる
- `pnpm e2e`：画面を通したテスト（Playwright）。`pnpm build` のあとに動かす。本番のビルドを `vite preview` で開き、`/api` には `packages/core/test/fake-sendo.ts` の偽の sendo が答える。速さの予算（キャッシュ済みの起動から記事まで 1 秒、操作の反応 100ms）も、CPU を 4 倍遅くして確かめる
- `pnpm --filter @sendo-reader/web lighthouse`：初回の読み込みを Lighthouse で測り、`apps/web/.lighthouseci/` に残す（上限はまだ決めていない）。手元では `CHROME_PATH` に Chromium の場所を渡す
- `apps/web/wrangler.jsonc` を変えたら `pnpm --filter @sendo-reader/web cf-typegen` で型を作り直す
- sendo の API が変わったら、`pnpm --filter @sendo-reader/core api:fetch`（sendo の OpenAPI を `packages/core/src/api/openapi.json` に写す。既定は手元の sendo の `/api/v1/openapi.json`。`SENDO_OPENAPI` で、sendo の `spec/openapi.json` などの別のファイルか URL を指せる）と `pnpm --filter @sendo-reader/core api:generate`（`schema.gen.ts` を作る）を実行し、両方をコミットする。生成したファイルは手で直さない（CI で食い違いを検査している）

## ディレクトリ

- `packages/core/`：同期エンジンとローカル DB（UI に依存しない）。`test/` にテスト（Vitest、Node で動く）
  - `src/reader.ts`：`ReaderCore`。ログイン、同期、手元の DB の読み出し、変更の通知をまとめる窓口
  - `src/api/`：sendo の API。`schema.gen.ts` は OpenAPI から生成したもの。`sync-contract.ts` は、`/sync` の応答の形を確かめて（外から来たデータなので）、core の中の形（`src/sync/page.ts` の `SyncPage`）に変える。応答の形を扱うのはこのファイルだけにし、同期のロジックは `SyncPage` だけを扱う
  - `src/db/`：DB の窓口（`database.ts`）、スキーマとマイグレーション（`schema.ts`。足すだけにし、出したものは書き換えない）、画面のための読み出し（`queries.ts`）、sqlite-wasm の実装（`sqlite-wasm.ts`）
  - `src/settings.ts`：sendo に預ける設定の、名前と値の決まり（`reader.` で始める、一覧ごとの設定の名前）。項目の中身（どんな項目があるか、既定は何か）は画面（`apps/web/src/lib/prefs.svelte.ts`）が決める。手元の置き場所は `src/db/synced-settings.ts`（端末の種類・名前・値。手元だけの値を置く `settings` の表とは別）
  - `src/content/parse.ts`：記事の本文の HTML（信頼できない）を、通すタグと属性だけの木（`ContentNode`）にする。通すものを変えるときは、ここと `test/content-parse.test.ts` を直す。手元の置き場所は `src/db/content.ts`（`article_contents` の表。記事を消すと、トリガーで一緒に消える）。本文は差分同期に載らず、記事ごとに取る（`ReaderCore` の `getArticleContent` は手元だけ、`fetchArticleContent` は、なければ sendo から取る）
  - `src/online.ts`：sendo に問い合わせないとできない操作（フィードの候補探し、購読、OPML の取り込み）。手元にすぐ反映できないので、画面では待っている間の表示を出す
  - `src/sync/`：差分同期（`pull.ts`）と操作キュー（`ops.ts` が操作ごとの「手元への反映・送り方・戻し方」、`queue.ts` が積む・まとめる・送る）。操作は手元への反映と同じトランザクションで積み、同期で届いた行の上に重ね直す。どの操作も冪等にする
  - `src/sync/scheduler.ts`：いつ同期するか（起動時、書き込みのあと、一定の間隔、届かなければ間隔を延ばしてやり直す）
  - `src/web/`：Web の実装（UI には依存しない）。`worker.ts` はタブごとの Dedicated Worker で動き、Web Locks で決めた代表だけが DB（`database.ts`、opfs-sahpool）と同期を持ち、ほかのタブは BroadcastChannel で代表に頼む。`client.ts` は画面から使う窓口（`@sendo-reader/core/web`）。やり取りの形は `protocol.ts`
  - `src/web/image-cache.ts`：画像のキャッシュ（Service Worker が入れる `sendo-images`）の名前と上限、消す・減らす処理。ログアウトとユーザーの切り替えで、手元の DB と一緒に消す
  - opfs-sahpool は、開くのに失敗すると既定でデータを消す。`preserveOnInitFailure` を外さない
  - `test/web/*.browser.test.ts`：Web の実装のテスト。Vitest のブラウザーモードで Chromium の中で動く（初回は `pnpm --filter @sendo-reader/core exec playwright install chromium`）。ワーカーからは、ページの偽の sendo に BroadcastChannel で話す（`test/web/fake-bridge.ts`）
  - `test/fake-sendo.ts`：sendo の差分同期の決定に沿った偽のサーバー。core のテストはこれを相手にし、外へは通信しない。手元の DB は、本番と同じ sqlite-wasm を Node のメモリーで開く（`test/helpers.ts`）
- `apps/web/`：PWA（Svelte 5 ＋ Vite の SPA）
  - `src/`：画面。`main.ts` が入口、`App.svelte` が一番外の部品
    - `db.worker.ts`：DB と同期を持つワーカーの入口（`@sendo-reader/core/web/worker` を動かすだけ）
    - `lib/reader.ts`：ワーカーを起こす。`lib/trusted.ts` の Trusted Types の `sendo-worker` のポリシーで、自分のオリジンの URL だけを許す（Service Worker の登録も同じ）
    - Service Worker（vite-plugin-pwa、`vite.config.ts`）：アプリの外枠と SQLite の wasm をキャッシュし、ネットワークがなくても起動する。Trusted Types の都合で、Workbox の実行部分は `sw.js` に入れている（`importScripts` を使わない）
    - `lib/app-update.ts`：新しい版への切り替え（`docs/decisions/ui.md` の 5）。前に出たときと一定の間隔で新しい版を確かめ、替わったら、画面が裏にある間か次に前に出たときに読み込み直す。読み込み直すと消えるものを出す画面を足したら、`main.ts` の `canReload` に足す
    - `e2e/`：画面を通したテスト（Playwright）
    - `lib/state.svelte.ts`：画面の状態（フォルダ、フィード、未読の数、同期の様子）。手元の表が変わったら読み直す
    - `lib/router.svelte.ts`：小さな自前のルーター（History API）
    - `lib/list.svelte.ts`：開いている記事の一覧（読み出し、続き、楽観的な更新、前後の記事）。一覧・記事・キーボードの操作が同じものを見る
    - `lib/prefs.svelte.ts`：表示の好み（テーマ、文字の大きさ、一覧の形など）。正は手元の DB で、sendo に預けて同じ種類の端末（スマホ ／ それ以外）に引き継ぐ（`docs/decisions/settings.md`）。項目を足すときは、既定と同じ値を預けない、別々に変わるものは別の項目にする、を守る。localStorage には、起動してすぐ当てるための写しだけを置く
    - キーボードの操作は `routes/Reader.svelte` に割り当て、一覧を `components/ShortcutHelp.svelte` に出す（足したら両方を直す）
    - 色・余白・文字の大きさは `app.css` の変数を使う。アイコンは `components/Icon.svelte`（画像を足さない）
    - sendo が中継した画像（サムネイル、フィードのアイコン、本文の中の画像）は、`components/RemoteImage.svelte` で出す（ほかの場所で `<img>` を書かない）
    - 記事の本文は、`components/ArticleBody.svelte` で出す。core が作った木から要素を組み立て、HTML の文字列は扱わない。本文の見た目（CSS）もここで決める
    - `routes/`：画面（ログイン、読む画面、購読の管理）、`components/`：部品（`components/manage/` は購読の管理の部品）
    - `lib/errors.ts`：失敗（`ApiError` の `code` ／ `kind`）を、画面に出す文にする
    - 画面は `@sendo-reader/core/web` の窓口だけを使い、DB や sendo の API に直接触れない
  - `worker/`：reader Worker（Cloudflare 版）。静的なファイルは Workers Static Assets が返し、`/api` だけを Service binding で sendo に中継する
  - `server/`：コンテナ版のサーバー（`docs/decisions/container.md`）。Node で動き、ここだけ `node:*` を使ってよい。`assets.ts` が画面のビルドを起動するときにメモリーに読み、`static.ts` が Workers Static Assets と同じ応答（ヘッダー、ETag、圧縮、SPA）で返し、`proxy.ts` が sendo のパスを書き換えずに中継する。依存ごと esbuild で 1 つのファイルにまとめる（イメージに `node_modules` を入れない）
  - `sendo-paths.ts`：コンテナ版で sendo に中継するパスの一覧。Service Worker の `navigateFallbackDenylist` も同じものを使う。sendo が外に出すパスを足したらここに足し、画面のルートはここと重ねない（`/oauth/authorize` は画面、`/oauth/token` は sendo）
  - `security-headers.ts`：CSP などのヘッダー。dev サーバーと、本番の `dist/_headers` の両方に使う
  - `test/`：reader Worker とヘッダーのテスト。`test/server/` はコンテナ版のサーバーのテストで、偽の sendo と reader のサーバーを本物の HTTP で動かして確かめる
- `scripts/`：手元と CI で動かす道具（Node で動く。`node:*` を使ってよい）
- `apps/mobile/`：Capacitor（あとで作る）

## 言語

- 文書、コミットメッセージ、PR、レビューコメントは日本語で書く（一般に公開したら英語に切り替える）
- 識別子は英語
- 画面の文字は、短い呼び名を英語にする：画面の名前（All、Saved、Search、Settings）、操作の名前（Mark as read、Unread only、Sync now）、時刻（3h、2d、Today）。文になるもの（説明、確認、空のときの文、エラー）は日本語で書く

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
- `packages/core`、`apps/web/src`、`apps/web/worker` では `node:*` を使わない（ブラウザと Workers で動くため。Biome で検査している）。コンテナ版のサーバー（`apps/web/server`）は Node で動くので使ってよい
- 画面はネットワークを待たない。読み書きはローカル DB に対して行い、サーバーとは同期で揃える。例外は、sendo にしかないものを扱うアカウントの画面（設定、OAuth の許可の画面。`docs/decisions/account.md`）で、手元の DB に置かず、core の API の窓口（`createAccountApi`）で sendo に聞く
- OpenAPI から生成したファイルは手で直さない。sendo の OpenAPI を直して生成し直す
- 記事のデータ（タイトル、要約、本文）は信頼できないデータとして扱う
  - `{@html}` を使わない（Biome の `noSvelteAtHtmlTags` で検査している）。本文の HTML は、sendo がサニタイズしてあっても信頼しない。core で、通すタグと属性だけの木にしてから（`src/content/parse.ts`）、専用の部品（`ArticleBody.svelte`）で出す。HTML の文字列を、画面に渡さない（`innerHTML` や `DOMParser` に入れない）
  - URL は `toSafeHttpUrl`（`packages/core`）を通し、http ／ https のものだけを `href` に入れる
  - 画像の URL（記事の `thumbnailUrl`、フィードの `iconUrl`）は、sendo から受け取ったものをそのまま使う。組み立てない、書き換えない、中身（`url=` や `sig=`）を読まない（`docs/decisions/images.md`）。同じオリジンを指すかは、同期で受けるときに `toSameOriginUrl` で確かめる
- CSP を緩めない（`apps/web/security-headers.ts`）。インラインのスクリプト、`eval`、テンプレートの `style` 属性（本番の CSP で止まる。`style:` ディレクティブか CSS のクラスを使う）、ほかのオリジンへの通信を使わない。緩める必要が出たら、`docs/decisions/local-first.md` を直してから変える
- ログインは sendo のセッションのクッキーで行う（`docs/decisions/local-first.md` の 6）。リクエストに `Authorization` を付けない。アクセストークンなど sendo が返す秘密は、画面に一度出すだけにし、手元の DB、ログ、エラーの表示、URL、Service Worker のキャッシュに入れない
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
3. **ローカルファースト**：画面の操作がネットワークの応答を待っていないか（アカウントの画面を除く）。オフラインで操作したときに、操作キューと楽観的更新で正しく戻せるか
4. **速さの予算**：JS が gzip 後 100KB を超えそうな依存の追加や、操作の反応が 100ms を超えそうな処理がないか
5. **セキュリティ**：記事のデータの HTML の出し方（XSS）、URL のスキームの確かめ漏れ、CSP や Trusted Types を緩める変更、秘密（発行したトークンなど）の置き場所、ログへの秘密情報の出力、状態を変えるリクエストを同じオリジンから送っているか
6. **生成物**：OpenAPI から生成したファイルを手で直していないか
7. **テスト**：振る舞いを変える変更に、それを確かめるテストがあるか
8. **PR の書き方**：タイトルがコミットメッセージの形式か。説明に「なぜ」が書かれているか
