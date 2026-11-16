# 決定の一覧

sendo-reader で決めたことを、テーマごとに1ファイルで置く。各ファイルには今の決定だけを書き、経緯は git の履歴で追う。残し方は [documentation.md](documentation.md) を参照。

サーバーとの約束ごと（認証、差分同期など）は、sendo の決定が正。[sendo の決定の一覧](https://github.com/sendo-feed/sendo/blob/main/docs/decisions/README.md)も読む。

| テーマ | 状態 | 概要 |
|---|---|---|
| [決定の残し方](documentation.md) | 提案中 | sendo と同じ。テーマごとに1ファイルを書き換え、履歴は git が持つ |
| [UI とツール](ui.md) | 提案中 | Svelte 5 ＋ Vite の SPA（SvelteKit・Void は使わない）。ネイティブは Capacitor。lint と整形は Biome |
| [ローカルファースト](local-first.md) | 提案中 | 画面は手元の SQLite（公式の Wasm ＋ opfs-sahpool）だけを読み書きし、sendo の差分同期に従う。どのタブでも使える。ログインは sendo のセッション（HttpOnly のクッキー）で、CSP を厳しく保つ |
| [アカウントの画面](account.md) | 提案中 | 設定の画面でアクセストークンと OAuth の許可を管理し、OAuth の許可の画面を置く。どちらもネットワークが要る画面で、発行したトークンは一度だけ出して保存しない。許可は毎回、利用者が押して決める |
| [速さの予算](performance.md) | 提案中 | 画面のスレッドの JS は gzip 後 100KB 以下、ワーカーは JS と wasm で 550KB 以下。キャッシュ済みの起動から記事まで 1 秒、操作の反応は 100ms |
| [デプロイ](deploy.md) | 提案中 | sendo と同じく、各自が fork し、Workers Builds でつなぐ。sendo を先にデプロイする。ルート ディレクトリは一番上のまま、手順は一番上の `package.json` の `deploy` に書く。main 以外のブランチのビルドはオフ |

経緯を知りたいとき：

```sh
git log -p -- docs/decisions/<テーマ>.md
```
