# sendo-reader

Sendo の公式リーダー。`packages/core`（同期エンジン）と `apps/web`・`apps/mobile` のモノレポ。API の型は sendo の OpenAPI から生成する。

このファイルは AI エージェント（Claude Code、Codex など）共通の指示。開発は主に Claude Code で行い、Codex はおもにレビューに使う。

## 最初に読むもの

- [決定の残し方](docs/decisions/documentation.md)。決定文書を編集・レビューする前に必ず読む
- [決定の一覧](docs/decisions/README.md)と作業に関係する決定。ほかの文書と食い違ったら、決定を正とする
- サーバーとの約束ごと（認証、差分同期、設定の預かり方）は sendo の決定が正：`accounts.md`、`sync.md`、`settings.md`
- プロダクト全体の目的・進め方・技術構成は sendo リポジトリにある：
  - https://github.com/sendo-feed/sendo/tree/main/docs/decisions
  - https://github.com/sendo-feed/sendo/blob/main/docs/inception-deck.md
  - https://github.com/sendo-feed/sendo/blob/main/docs/tech-deck.md

## 開発コマンド

- `pnpm install`：依存を入れる
- `pnpm check`：型チェック、lint、テストをまとめて実行する。変更したら、コミットの前に必ず通す
- `pnpm format`：整形して、直せる lint の指摘を直す（Biome。`.svelte` も対象）
- `pnpm dev`：画面の dev サーバー（http://localhost:5173）。sendo のパス（`apps/web/sendo-paths.ts` の一覧。本番と同じ。WebSocket の通知も）は、手元の sendo（sendo の `pnpm dev`、http://localhost:8787）に中継する。sendo は sendo の README のとおりに別に動かす
- `pnpm build`：画面をビルドし、コンテナのサーバーを `apps/web/dist-server/server.mjs` にバンドルする
- `pnpm --filter @sendo-reader/web start:server`：コンテナのサーバーを手元の Node で動かす（`pnpm build` のあとに。`SENDO_URL` で中継の先を、`PORT` で受けるポートを変える）。イメージは `docker build -t sendo-reader .`
- `pnpm size`：ビルドのあとに、画面のスレッドの JS（gzip 後 100KB）と、DB のワーカーの JS と wasm（550KB）が予算に収まるか確かめる
- `pnpm e2e`：画面を通したテスト（Playwright）。`pnpm build` のあとに動かす。本番のビルドを `vite preview` で開き、`/api` には `packages/core/test/fake-sendo.ts` の偽の sendo が答える。通知（WebSocket）はワーカーから開くので Playwright では横取りできず、`vite preview` の中継を通して `e2e/fake-updates.ts` の偽の通知のサーバー（ポート 8798）につなぐ。速さの予算（キャッシュ済みの起動から記事まで 1 秒、操作の反応 100ms）も、CPU を 4 倍遅くして確かめる
- `pnpm --filter @sendo-reader/web lighthouse`：初回の読み込みを Lighthouse で測り、`apps/web/.lighthouseci/` に残す（上限はまだ決めていない）。手元では `CHROME_PATH` に Chromium の場所を渡す
- sendo の API が変わったら、`pnpm --filter @sendo-reader/core api:fetch`（sendo の OpenAPI を `packages/core/src/api/openapi.json` に写す。既定は手元の sendo の `/api/v1/openapi.json`。`SENDO_OPENAPI` で、sendo の `spec/openapi.json` などの別のファイルか URL を指せる）と `pnpm --filter @sendo-reader/core api:generate`（`schema.gen.ts` を作る）を実行し、両方をコミットする。生成したファイルは手で直さない（CI で食い違いを検査している）

## ディレクトリ

- `packages/core/`：同期エンジンとローカル DB（UI に依存しない）。`test/` にテスト（Vitest、Node で動く）
  - `src/reader.ts`：`ReaderCore`。ログイン、同期、手元の DB の読み出し、変更の通知をまとめる窓口
  - `src/api/`：sendo の API。`schema.gen.ts` は OpenAPI から生成したもの。`sync-contract.ts` は、`/sync` の応答の形を確かめて（外から来たデータなので）、core の中の形（`src/sync/page.ts` の `SyncPage`）に変える。応答の形を扱うのはこのファイルだけにし、同期のロジックは `SyncPage` だけを扱う
  - `src/db/`：DB の窓口（`database.ts`）、スキーマとマイグレーション（`schema.ts`。足すだけにし、出したものは書き換えない）、画面のための読み出し（`queries.ts`）、sqlite-wasm の実装（`sqlite-wasm.ts`）
  - `src/settings.ts`：sendo に預ける設定の、名前と値の決まり（`reader.` で始める、一覧ごとの設定の名前）。項目の中身（どんな項目があるか、既定は何か）は画面（`apps/web/src/lib/prefs.svelte.ts`）が決める。手元の置き場所は `src/db/synced-settings.ts`（端末の種類・名前・値。手元だけの値を置く `settings` の表とは別）
  - `src/content/parse.ts`：記事の本文の HTML（信頼できない）を、通すタグと属性だけの木（`ContentNode`）にする。通すものを変えるときは、ここと `test/content-parse.test.ts` を直す。手元の置き場所は `src/db/content.ts`（`article_contents` の表。記事を消すと、トリガーで一緒に消える）。本文は差分同期に載らず、記事ごとに取る（`ReaderCore` の `getArticleContent` は手元だけ、`fetchArticleContent` は、なければ sendo から取る）
  - `src/content/storage.ts`：手元に置く本文の量の上限（選べる値と既定。端末ごとの設定で、sendo に預けない）。同期のあとに未読の記事の全文（訳文のある記事は訳した本文）を先に取るのは `ReaderCore` の `prefetchArticleContents`（画面が `setOpenList` で知らせた、開いている一覧の、読んでいる位置のすぐ下から）、上限を超えたときに既読の分から消すのは `src/db/content.ts`（本文の大きさは、トリガーで `article_content_sizes` の表に写す）
  - `src/content/export.ts`：取得した全文（訳文を出していれば訳した本文）を、1 つのファイル（HTML か Markdown）に書き出す（`@sendo-reader/core/export`。画面は使うときだけ読み込む）。入力は `ContentNode` の木で、HTML の文字列は使わない。画像は sendo の中継から取って data: URI で埋め込む。書き出したファイルは画面に出さず、ダウンロードさせるだけ
  - `src/online.ts`：sendo に問い合わせないとできない操作（フィードの候補探し、購読、OPML の取り込み）。手元にすぐ反映できないので、画面では待っている間の表示を出す
  - `src/sync/`：差分同期（`pull.ts`）と操作キュー（`ops.ts` が操作ごとの「手元への反映・送り方・戻し方」、`queue.ts` が積む・まとめる・送る）。操作は手元への反映と同じトランザクションで積み、同期で届いた行の上に重ね直す。どの操作も冪等にする
  - `src/sync/scheduler.ts`：いつ同期するか（起動時、書き込みのあと、一定の間隔、sendo の通知を受けたとき、届かなければ間隔を延ばしてやり直す）
  - `src/sync/updates.ts`：sendo の通知（WebSocket の `/api/v1/sync/updates`）。代表のタブのワーカーだけがつなぎ、知らせを受けたら同期を頼む。閉じるコードごとの動きは sendo の `sync.md` の 9 と OpenAPI の説明に従う。つながらなくても定期同期で動く
  - `src/web/`：Web の実装（UI には依存しない）。`worker.ts` はタブごとの Dedicated Worker で動き、Web Locks で決めた代表だけが DB（`database.ts`、opfs-sahpool）と同期を持ち、ほかのタブは BroadcastChannel で代表に頼む。`client.ts` は画面から使う窓口（`@sendo-reader/core/web`）。やり取りの形は `protocol.ts`。版の違うタブが混ざるので、頼める処理、引数、答え、知らせ（変わった表、同期の様子）の形か意味を変えたら、`PROTOCOL_VERSION` を上げる（`docs/decisions/local-first.md` の 5）
  - `src/web/image-cache.ts`：画像のキャッシュ（Service Worker が入れる `sendo-images`）の名前と上限、消す・減らす処理。ログアウトとユーザーの切り替えで、手元の DB と一緒に消す
  - opfs-sahpool は、開くのに失敗すると既定でデータを消す。`preserveOnInitFailure` を外さない
  - `test/web/*.browser.test.ts`：Web の実装のテスト。Vitest のブラウザーモードで Chromium の中で動く（初回は `pnpm --filter @sendo-reader/core exec playwright install chromium`）。ワーカーからは、ページの偽の sendo に BroadcastChannel で話す（`test/web/fake-bridge.ts`）
  - `test/fake-sendo.ts`：sendo の差分同期の決定に沿った偽のサーバー。core のテストはこれを相手にし、外へは通信しない。手元の DB は、本番と同じ sqlite-wasm を Node のメモリーで開く（`test/helpers.ts`）
- `apps/web/`：PWA（Svelte 5 ＋ Vite の SPA）
  - `src/`：画面。`main.ts` が入口、`App.svelte` が一番外の部品
    - `db.worker.ts`：DB と同期を持つワーカーの入口（`@sendo-reader/core/web/worker` を動かすだけ）
    - `lib/reader.ts`：ワーカーを起こす。`lib/trusted.ts` の Trusted Types の `sendo-worker` のポリシーで、自分のオリジンの URL だけを許す（Service Worker の登録も同じ）
    - Service Worker（vite-plugin-pwa、`vite.config.ts`）：アプリの外枠と SQLite の wasm をキャッシュし、ネットワークがなくても起動する。Trusted Types の都合で、`importScripts` を使わず、Workbox の部品も含めて 1 つの `sw.js` にまとめる。push と通知を押したときの処理は、injectManifest に移して自分で書く（`docs/decisions/notifications.md` の 5〜8）。移しても、今のキャッシュ、画像のキャッシュ、新しい版への切り替え（`docs/decisions/ui.md` の 5）を保つ
    - `lib/app-update.ts`：新しい版への切り替え（`docs/decisions/ui.md` の 5）。前に出たときと一定の間隔で新しい版を確かめ、替わったら、画面が裏にある間か次に前に出たときに読み込み直す。前に出ている間は、新しい版に替わったことを画面で知らせる（出す場所は `ui.md` の 5。`lib/update-notice.svelte.ts`、`components/UpdateReady.svelte`）。読み込み直すと消えるものを出す画面を足したら、パスなら `app-update.ts` の `canReloadPage` に、パスで分からないもの（窓など）なら出している間 `lib/reload-guard.svelte.ts` の `reloadGuard.hold()` で印を付ける（自動の読み込み直しと知らせの両方が使う）
    - `lib/back-forward-cache.ts`：reader の外へページごと移る前（`ReaderState` の `leave`。Google のログイン、Discord の連携）と、ページが bfcache に入るときに DB のワーカーを止め、bfcache から戻ったら読み込み直す。Safari はワーカーごとページを止めて残すので、代表のロックを持ったまま、次に開いたページを待たせる。reader の外へ移る操作を足したら `leave` を使う
    - `e2e/`：画面を通したテスト（Playwright）
    - `lib/state.svelte.ts`：画面の状態（フォルダ、フィード、未読の数、同期の様子）。手元の表が変わったら読み直す
    - `lib/router.svelte.ts`：小さな自前のルーター（History API）。どの画面か（一覧、探す言葉、開いている記事）は URL に、その画面のどこを見ていたか（一覧と記事の位置）は履歴の項目（`history.state`）に持ち、読み込み直しても、戻る・進むでも同じところに戻す
    - `lib/list.svelte.ts`：開いている記事の一覧（読み出し、続き、楽観的な更新、前後の記事）。一覧・記事・キーボードの操作が同じものを見る
    - `lib/prefs.svelte.ts`：表示の好み（テーマ、文字の大きさ、一覧の形など）。正は手元の DB で、sendo に預けて同じ種類の端末（スマホ ／ それ以外）に引き継ぐ（`docs/decisions/settings.md`）。項目を足すときは、既定と同じ値を預けない、別々に変わるものは別の項目にする、を守る。localStorage には、起動してすぐ当てるための写しだけを置く
    - キーボードの操作は `routes/Reader.svelte` に割り当て、一覧を `components/ShortcutHelp.svelte` に出す（足したら両方を直す）
    - 色・余白・文字の大きさは `app.css` の変数を使う。アイコンは `components/Icon.svelte`（画像を足さない）
    - sendo が中継した画像（サムネイル、フィードのアイコン、本文の中の画像）は、`components/RemoteImage.svelte` で出す（ほかの場所で `<img>` を書かない）
    - 記事の本文は、`components/ArticleBody.svelte` で出す。core が作った木から要素を組み立て、HTML の文字列は扱わない。本文の見た目（CSS）もここで決める
    - `routes/`：画面（ログイン、読む画面、購読の管理）、`components/`：部品（`components/manage/` は購読の管理の部品）
    - `lib/errors.ts`：失敗（`ApiError` の `code` ／ `kind`）を、画面に出す文にする
    - 画面は `@sendo-reader/core/web` の窓口だけを使い、DB や sendo の API に直接触れない
  - `server/`：reader のコンテナのサーバー（`docs/decisions/container.md`）。画面を配る唯一の形（Cloudflare では動かさない）。Node で動き、ここだけ `node:*` を使ってよい。`assets.ts` が画面のビルドを起動するときにメモリーに読み、`static.ts` が決まった応答（ヘッダー、ETag、圧縮、SPA）で返し、`proxy.ts` が sendo のパスを書き換えずに中継する（WebSocket の Upgrade は `websocket.ts`）。依存ごと esbuild で 1 つのファイルにまとめる（イメージに `node_modules` を入れない）
  - `x-embed/`：X の投稿の隔離フレームのページ（`index.html` と `embed.js`。`docs/decisions/embeds.md`）。画面のビルド（`dist`）には入れず、サーバーのバンドルに文字として取り込み（`server/x-embed-page.ts`）、コンテナのサーバー（と dev ／ preview）が、`X_EMBED_ORIGIN` のホスト名の `/` と `/embed.js` でだけ返す。CSP は `security-headers.ts` の `xEmbedPageHeaders`（Trusted Types と style 属性は使えないので、見た目は CSSOM で付ける）
  - `sendo-paths.ts`：sendo に中継するパスの一覧。Service Worker が `index.html` を返す道から除く一覧と、手元の Vite の dev サーバーの中継も同じものを使う。sendo が外に出すパスを足したらここに足し、画面のルートはここと重ねない（`/oauth/authorize` は画面、`/oauth/token` は sendo）
  - `security-headers.ts`：CSP などのヘッダー。dev サーバー・preview と、本番のコンテナのサーバーの両方に使う
  - `test/`：ヘッダーと、新しい版への切り替えのテスト。`test/server/` はコンテナのサーバーのテストで、偽の sendo と reader のサーバーを本物の HTTP で動かして確かめる
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
- 決定を変えるときは、その決定を参照する文書も検索して読み、影響する記述を現行の決定にそろえる
- 決定ファイルを足す・消す・改名する場合や、状態・概要が変わる場合は、`docs/decisions/README.md` の一覧も直す

## 守る規約

- 同期とローカル DB のロジックはすべて `packages/core` に入れる。`packages/core` は UI のフレームワーク（`svelte`）と `apps/` に依存しない（Biome の `noRestrictedImports` で検査している）
- `packages/core`、`apps/web/src` では `node:*` を使わない（ブラウザで動くため。Biome で検査している）。コンテナのサーバー（`apps/web/server`）は Node で動くので使ってよい
- 画面はネットワークを待たない。読み書きはローカル DB に対して行い、サーバーとは同期で揃える。例外は、sendo にしかないものを扱うアカウントの画面（設定、OAuth の許可の画面。`docs/decisions/account.md`）で、手元の DB に置かず、core の API の窓口（`createAccountApi`）で sendo に聞く。記事の翻訳を頼む操作も、sendo に届かないとできない（`docs/decisions/translation.md` の 6）。この端末で通知を受ける操作（Settings と、ベルを付けたときの勧め）も、sendo とプッシュサービスに届かないとできない（`docs/decisions/notifications.md` の 1・3）
- OpenAPI から生成したファイルは手で直さない。sendo の OpenAPI を直して生成し直す
- 記事のデータ（タイトル、要約、本文）は信頼できないデータとして扱う
  - `{@html}` を使わない（Biome の `noSvelteAtHtmlTags` で検査している）。本文の HTML は、sendo がサニタイズしてあっても信頼しない。core で、通すタグと属性だけの木にしてから（`src/content/parse.ts`）、専用の部品（`ArticleBody.svelte`）で出す。HTML の文字列を、画面に渡さない（`innerHTML` や `DOMParser` に入れない）
  - URL は `toSafeHttpUrl`（`packages/core`）を通し、http ／ https のものだけを `href` に入れる
  - 通知の中身（タイトルと本文）は、Service Worker が文字のまま通知に出すだけにする。画面に渡さず、手元の DB、IndexedDB、ログ、Service Worker のキャッシュに入れない。IndexedDB に覚えるのは `tag` と覚えた時刻だけ（`docs/decisions/notifications.md` の 10）
  - 画像の URL（記事の `thumbnailUrl`、フィードの `iconUrl`）は、sendo から受け取ったものをそのまま使う。組み立てない、書き換えない、中身（`url=` や `sig=`）を読まない（`docs/decisions/images.md`）。同じオリジンを指すかは、同期で受けるときに `toSameOriginUrl` で確かめる
- CSP を緩めない（`apps/web/security-headers.ts`）。インラインのスクリプト、`eval`、テンプレートの `style` 属性（本番の CSP で止まる。`style:` ディレクティブか CSS のクラスを使う）、ほかのオリジンへの通信を使わない。緩める必要が出たら、`docs/decisions/local-first.md` を直してから変える。例外は、`frame-src` に X の投稿の隔離フレームのオリジンを 1 つ足すことだけ（`docs/decisions/embeds.md`）
- ログインは sendo のセッションのクッキーで行う（`docs/decisions/local-first.md` の 6）。リクエストに `Authorization` を付けない。アクセストークンなど sendo が返す秘密は、画面に一度出すだけにし、手元の DB、ログ、エラーの表示、URL、Service Worker のキャッシュに入れない
- 速さの予算（`docs/decisions/performance.md`）を超える依存を足さない。足す前に `pnpm build && pnpm size` で確かめる
- Svelte の `generics="…"` の中に `{` を書かない（Biome が解析に失敗する）。型に名前を付けてから使う

## テスト

- 振る舞いを変える変更には、それを確かめるテストを足す
- テストは、本番と同じ道と順で呼ぶ。確かめたい処理は、本番の呼び出し元（core なら画面、コンテナのサーバーなら HTTP の要求）と同じ入口から、本番と同じ順と状態で呼ぶ（本番で別の操作のあとに呼ばれる処理は、その操作のあとに呼ぶ）。前提の状態は、本番でその処理が呼ばれるときと同じにする。本番の操作で手軽に作れるものはその操作で作り、作るのに手間のかかる状態や、失敗・割り込みを起こすときだけ、直接の書き込みや差し替えを使う。本番と違う道や順を通ると、本番でだけ起きる不具合をテストが通してしまうため
- 正常の流れに加えて、次のうち当てはまるものを入れる
  - 途中で失敗する：失敗したあとに何が残るか、やり直すと正しい状態に戻るか
  - 境界のちょうど：上限・下限と同じ値、ゼロ、空
  - ほかの操作と重なる：処理の途中に、利用者の操作、同期、別のタブからの頼みが入る

## 変更の進め方

- 作業の前に Issue を用意する。Issue が要るのは feat ／ fix ／ perf ／ 振る舞いが変わる refactor ／ decision。docs ／ ci ／ build ／ chore ／ test ／ 振る舞いを変えない refactor ／ Dependabot の PR には要らない
- 1 Issue ＝ 1 PR。1 本の PR に収まらない作業は、親 Issue（やりたいこと、やらないこと、サブ Issue の一覧と順番）とサブ Issue（PR と 1 対 1）に分ける。決定の変更は、それだけで 1 つの Issue（またはサブ Issue）にする
- 着手の判定：始める前に Issue を読み、「やりたいこと」「やらないこと」「受け入れ条件（確かめる入力と期待する結果、対象外）」が書かれていて、1 本の PR に収まることを確かめる。足りないときは始めず、足りない情報を人間に聞いて Issue に書き足す。ラベルや人間の了承は要らない。Issue はエージェントが書いてよい（テンプレートと同じ見出しで書く）
- 単位の分け方：新しく持つ状態（手元の表、印、設定など）が 2 つ以上増え、片方の変化がもう片方に効く変更は、1 本の PR に収まりそうでも、着手の判定でサブ Issue に分ける。切るときは、受け入れ条件を書ける振る舞いごとに 1 本にし、使う側のない状態だけの PR は作らない。作り始めてから気づいたら、先に Issue を分ける。状態どうしの関わりが不具合になりやすく、1 本にまとめるとレビューで見つけきれないため
- 途中で受け入れ条件や範囲を変えたくなったら、先に Issue を直し、理由を添える。PR の説明だけを変えない
- すべての変更は下書きの PR で出す。`main` へは直接 push できない。Issue が要る変更の PR は、説明に `Closes #番号` を 1 つだけ書き、受け入れ条件を Issue から写す（正本は Issue）
- Codex に出す前に（下書きの PR を作る前に）自己レビューし、見つけたものを直してから出す。書いた側の考えを持ち込まないよう、差分と関係する決定だけを見て見直す。見る観点と終わり方は `.claude/skills/review-loop/SKILL.md` の手順 1。自己レビューはラウンドに数えない
- そのあと Codex のレビューを回し、終了の条件を満たすまで直す。Claude Code では `/review-loop` スキルが、自己レビューも含めてこれを回す
- マージは、人間にマージを指示されたときだけ行う。自分の判断ではマージしない
- レビューは 3 回で打ち切る。打ち切った PR では、同じループを続けない。人間が「そのまま受け入れる」か「捨ててやり直す」を選ぶ。やり直すときは、コードを引き継がず、PR を閉じて Issue に戻り、やりたいこと、受け入れ条件、単位を、この順に見直して直し、着手の判定をやり直してから `main` から作る
- Issue の決まりの全文は CONTRIBUTING.md の「始める前に」、終了の条件、打ち切りのあとの扱い、優先度の定義、指摘の扱いの全文は「レビューの進め方」にある。単位の分け方と自己レビューは、このリポジトリで試している決まりで、CONTRIBUTING.md にはまだない

## Code Review Rules

### 決定文書

- 実装の変更は、該当する Reader と Sendo の決定ファイルと照合する。決定を変える場合は決定ファイルを単独の PR で更新し、実装の PR からその決定を参照する。
- 決定文書のレビューでは `docs/decisions/documentation.md` を読み、変更した決定を参照する文書と一覧も照合する。冒頭・理由・代替案・見直す条件に、旧仕様を現行として書いた記述や、実装済みの仕様を予定とした記述が残っていれば P1 とする。

### Review guidelines

指摘には、必ず次の優先度のどれかを付ける。終了の条件はこの優先度で判定するので、ぶれないようにする。

| 優先度 | 意味 |
|---|---|
| P0 | データの消失や破損、セキュリティの穴、本番が動かなくなる |
| P1 | 明らかなバグ、`docs/decisions/` との食い違い、下の観点で挙げた規約の破れ |
| P2 | 直すべきだが今すぐでなくてよい（境界条件、テスト不足など） |
| P3 | 軽微なことや好み |

PR の説明に `Closes #番号` があるときは、その Issue を読む。前提（やりたいこと、やらないこと、受け入れ条件）は Issue にあり、PR の説明の受け入れ条件はその写し（食い違ったら Issue を正とし、食い違いを P1 で指摘する）。受け入れ条件を「できた」の定義として読む。受け入れ条件の外の入力への指摘は、P0 でない限り P2 以下にする。「対象外」と「やらないこと」に書いたものは指摘しない。Issue が要る変更（feat ／ fix ／ perf ／ 振る舞いが変わる refactor ／ decision）の PR に Issue が結ばれていなければ、P1 とする。

レビューは日本語で書く。いまは2人で試作を繰り返している段階なので、捨てる前提の試作の完成度や、書き方の好みは指摘しなくてよい（整形と lint は Biome に任せる）。次の観点を優先する。

1. **core と画面の境界**：`packages/core` が UI のフレームワークや `apps/` に依存していないか。同期やデータのロジックが `apps/` に漏れていないか
2. **ローカルファースト**：画面の操作がネットワークの応答を待っていないか（アカウントの画面と、翻訳を頼む操作、この端末で通知を受ける操作を除く）。オフラインで操作したときに、操作キューと楽観的更新で正しく戻せるか
3. **速さの予算**：JS が gzip 後 100KB を超えそうな依存の追加や、操作の反応が 100ms を超えそうな処理がないか
4. **セキュリティ**：記事のデータの HTML の出し方（XSS）、URL のスキームの確かめ漏れ、CSP や Trusted Types を緩める変更、秘密（発行したトークンなど）の置き場所、ログへの秘密情報の出力、状態を変えるリクエストを同じオリジンから送っているか
5. **生成物**：OpenAPI から生成したファイルを手で直していないか
6. **テスト**：振る舞いを変える変更に、それを確かめるテストがあるか
7. **PR の書き方**：タイトルがコミットメッセージの形式か。説明に「なぜ」が書かれているか
