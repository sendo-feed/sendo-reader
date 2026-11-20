# 決定の一覧

sendo-reader で決めたことを、テーマごとに1ファイルで置く。各ファイルには今の決定だけを書き、経緯は git の履歴で追う。残し方は [documentation.md](documentation.md) を参照。

サーバーとの約束ごと（認証、差分同期など）は、sendo の決定が正。[sendo の決定の一覧](https://github.com/sendo-feed/sendo/blob/main/docs/decisions/README.md)も読む。

| テーマ | 状態 | 概要 |
|---|---|---|
| [決定の残し方](documentation.md) | 提案中 | sendo と同じ。テーマごとに1ファイルを書き換え、履歴は git が持つ |
| [UI とツール](ui.md) | 提案中 | Svelte 5 ＋ Vite の SPA（SvelteKit・Void は使わない）。現在の UI は Web の PWA で、reader のコンテナが配る。手元では Vite の dev サーバーが sendo の `pnpm dev` に中継する。ネイティブ版は配布時に Capacitor で包む。lint と整形は Biome。機能はごちゃごちゃさせず、画面に常に出す操作を絞る。読む画面（記事の一覧、記事）は没入感を優先し、行の基本の操作はスワイプに置いてよく、長押しのメニューは持たない。ほかの画面は分かりやすさを優先し、操作を見えるところに出す |
| [ローカルファースト](local-first.md) | 提案中 | 画面は手元の SQLite（公式の Wasm ＋ opfs-sahpool）だけを読み書きし、sendo の差分同期と削除記録に従う。sendo の通知（WebSocket）を受けたらすぐ同期し、定期同期も続ける。本文は記事ごとに取得して手元に置き、未読の新しい記事の全文は同期のあとに先に取る（フィード本文は全文が取れないときだけ）。手元に置く本文の量は、端末ごとに選ぶ上限（既定 200MB）までにする。どのタブでも使える。ログインは sendo のセッション（HttpOnly のクッキー）で、CSP を厳しく保つ |
| [画像](images.md) | 提案中 | サムネイル、フィードのアイコン、本文の画像は sendo の中継を通す。URL は受け取ったまま使い、Service Worker でキャッシュして（100MB・30 日まで）、ログアウトで消す。ない・失敗した画像は出さない |
| [設定の同期](settings.md) | 提案中 | 表示の設定を sendo に預け、端末の種類（スマホは `mobile`、ほかは `desktop`）ごとに引き継ぐ。項目ごとに手元の DB に置いて操作キューで送り、既定と同じ値は預けない。端末そのものに合わせる設定（本文を置く量の上限）は預けない。「未読」は一覧の絞り込みの状態で、別の画面にはしない。前の localStorage の設定は、同期してから sendo にない項目だけを送る |
| [アカウントの画面](account.md) | 提案中 | 設定の画面でアクセストークンと OAuth の許可を管理し、OAuth の許可の画面を置く。どちらもネットワークが要る画面で、発行したトークンは一度だけ出して保存しない。許可は毎回、利用者が押して決める |
| [速さの予算](performance.md) | 提案中 | 画面のスレッドの JS は gzip 後 100KB 以下、ワーカーは JS と wasm で 550KB 以下。キャッシュ済みの起動から記事まで 1 秒、操作の反応は 100ms |
| [コンテナ版](container.md) | 提案中 | sendo と並べて、コンテナだけで配る（`ghcr.io/sendo-feed/sendo-reader`）。Cloudflare では動かさない。外からは reader のオリジン 1 つに見せ、sendo の `PUBLIC_URL` と `READER_URL` をそのオリジンにする。sendo のパスは許す一覧で中継し、WebSocket も含めて書き換えない。サーバーは Node（Hono）。sendo の機能はすべて使える前提にし、`/api/v1/features` は見ない |

経緯を知りたいとき：

```sh
git log -p -- docs/decisions/<テーマ>.md
```
