# コンテナ版

- 状態：提案中
- 関連：[UI とツール](ui.md)（4。配信と中継、手元の開発）、[ローカルファースト](local-first.md)（6 のログイン、「記事の本文」、「ページの守り」）、[アカウントの画面](account.md)（5 の OAuth の許可の画面）、sendo の[テックスタック](https://github.com/sendo-feed/sendo/blob/main/docs/decisions/tech-stack.md)（2）・[コンテナ版](https://github.com/sendo-feed/sendo/blob/main/docs/decisions/container.md)・[MCP サーバー](https://github.com/sendo-feed/sendo/blob/main/docs/decisions/mcp.md)（3・4）

sendo-reader は、[sendo のコンテナ版](https://github.com/sendo-feed/sendo/blob/main/docs/decisions/container.md)と並べて、コンテナだけで動かす。reader が公式の画面と中継を提供し、ログインや MCP の OAuth の許可も同じオリジンで扱う。

## 決定

1. **reader は、コンテナだけで配る。Cloudflare（Workers、Static Assets、Service binding）では動かさない。**
   - 上流の CI がイメージを作り、GHCR（`ghcr.io/sendo-feed/sendo-reader`）に置く。使う人は fork しない
   - タグと CPU は sendo にそろえる。`main` に入るたびに `main` と `sha-<コミット>` のタグで出し、amd64 と arm64 の両方で作る。版のタグは、sendo が版を切るときに一緒に決める
   - イメージは公開する（sendo のイメージと同じ）。使う人は `docker login` せずに取ってこられる
   - 標準構成では、sendo の `compose.yaml` に reader のサービスを並べ、`docker compose pull && docker compose up -d` で sendo と一緒に更新する。reader は、sendo のヘルスチェックが通ってから始める（`depends_on` の `condition: service_healthy`）
2. **reader の画面と Sendo の API・認証は、reader のオリジン 1 つから配る。**
   - 外に出すのは reader のコンテナのポート（`compose.yaml` では `127.0.0.1:8080:8080`）だけにする。TLS は、sendo と同じく、手前に置くリバースプロキシ（Caddy など）や Cloudflare Tunnel で終える。コンテナは HTTP だけを受ける
   - sendo のコンテナは、ポートを外に出さない。reader のコンテナが、compose の中のネットワークで呼ぶ
   - sendo の `PUBLIC_URL` と `READER_URL` には、どちらも reader のオリジン（例：`https://reader.example.com`）を入れる。`PUBLIC_URL` は欠かせない。コンテナは HTTP だけを受けるので、ないと sendo から見える URL は、中継の先の URL（`http://sendo:8787`）か、ホスト名は合っていても `http` のままのオリジンになり、ログインの戻り先や `__Host-` のクッキーが合わない
   - Google のリダイレクト URI、リーダーアプリ（Google Reader API）のサーバー、MCP の URL も、このオリジンにする
   - 画面を使わない人は、reader のコンテナを外して sendo のポートを出してよい（sendo の[コンテナ版](https://github.com/sendo-feed/sendo/blob/main/docs/decisions/container.md)の 7。このとき OAuth は使えない）。reader は、この形には関わらない
   - X の埋め込みを有効にする場合は、専用の HTTPS ホストのルート（`/`）で埋め込みページ、`/embed.js` でそのスクリプトを配る（[ローカルファースト](local-first.md#ページの守り)）。reader の配布済みイメージで通常の構成を使うと、引用と投稿リンクを表示する。埋め込みを有効にする場合は、HTTPS の配信元を `SENDO_X_EMBED_ORIGIN` の Docker ビルド引数に渡して reader のイメージをビルドし、Compose の `reader` でそのイメージを使う。配信先の変更と reader の更新に合わせてイメージをビルドし直す。静的ファイルや配信用ヘッダーに変更があった場合は、そのイメージのソースと同じ版の `apps/web/x-embed/` を再配信する。投稿 ID や高さ通知の形式を変えるときは旧 reader との互換性を保つ。互換性を変える場合は新しいホストを使う。配信先を移す場合は、開いたままの旧 reader と、Service Worker のキャッシュから起動する旧 reader が使うホストの配信も続ける。Sendo は `docker compose pull sendo` で更新し、Compose でコンテナを作り直す
   - 配備後は、対象記事の本文をまだ保持していないブラウザープロファイルで、対応版の Sendo が取得・保存した、[HTTPS の投稿リンクと出典から投稿 ID が一意に決まる引用](local-first.md#記事の本文)を含む記事をオンラインで開き、隔離フレームに公式ウィジェットが表示されることを確かめる。専用ホストのルート（`/`）の HTTPS 応答のヘッダー（CSP と Referrer-Policy を含む）を、reader のビルドに使った版の `apps/web/x-embed/_headers` と照合する。保存済み本文での取り扱いは [Sendo の本文の決定](https://github.com/sendo-feed/sendo/blob/main/docs/decisions/content.md)に従う
3. **reader のコンテナは、画面の静的なファイルを返し、sendo のパスを sendo に中継する。中継するパスは、許す一覧で持つ。**
   - 一覧：`/api/`（の下すべて）、`/mcp`、`/.well-known/oauth-protected-resource/mcp`、`/.well-known/oauth-authorization-server`、`/oauth/token`、`/oauth/register`、`/accounts/ClientLogin`、`/reader/api/0/`（の下すべて）、`/healthz`
   - 一覧にないパスには、静的なファイルか、なければ `index.html` を返す（SPA）
   - 一覧は 1 か所に置き、コンテナのサーバー、Service Worker のページの移動の横取り（`navigateFallbackDenylist`）、手元の Vite の dev サーバーの中継（[UI とツール](ui.md)の 4）が同じものを使う。ブラウザでこれらのパスを開いたときに、Service Worker が `index.html` を返さないようにする
   - 画面のルートは、一覧と重ねない。`/oauth/authorize` は画面（許可の画面）で、`/oauth/token` と `/oauth/register` は sendo。`/oauth/` で始まるパスをまとめて回さない
   - sendo が外に出すパスを足したら、この一覧にも足す。CI で、sendo の `main` の実際のルートと一覧を突き合わせる
   - `/healthz` は sendo の生死を答える。外から `https://reader.example.com/healthz` を見ると、reader と sendo をつないだ全体を確かめられる
4. **中継では、リクエストと応答を書き換えない。**
   - メソッド、パスとクエリ、ヘッダー、本文をそのまま sendo に渡す。除くのは、1 回の接続にだけ関わるヘッダー（`Connection`、`Transfer-Encoding` など）だけにする。`Cookie`、`Origin`、`Sec-Fetch-*`、`Authorization` はそのまま渡す
   - `X-Forwarded-*` は付けない。sendo はそれを信じず、URL のオリジンを `PUBLIC_URL` に置き換える
   - リダイレクトは追わずに、そのまま返す（ログインの 302 など）
   - 応答の状態、ヘッダー（複数の `Set-Cookie` を含む）、本文をそのまま返す。本文は溜めずに流す（MCP、OPML の書き出しなど）
   - sendo の応答には、画面のセキュリティのヘッダーを足さない
   - 中継の先は設定 `SENDO_URL` で変えられる（既定は compose の中の `http://sendo:8787`）。reader のコンテナに、ほかの設定は要らない（自分のオリジンも知らなくてよい）
5. **静的なファイルは、次のように返す。**
   - `apps/web/security-headers.ts` のヘッダーを、静的なファイルのすべての応答に付ける。手元の Vite の dev サーバー・preview も同じところから付け、別に書き写さない
   - キャッシュは、毎回確かめさせる（`Cache-Control: public, max-age=0, must-revalidate` と ETag で、変わっていなければ 304）。Service Worker（`sw.js`）が新しい版を見つけられるように、長く持たせない
   - JS、CSS、wasm などは、ブラウザが受けられれば圧縮して返す（brotli か gzip）
6. **reader のコンテナのヘルスチェック（イメージの `HEALTHCHECK`）は、reader 自身が返す `/`（`index.html`）を見る。** `/healthz` は sendo に中継するので、reader のコンテナで見ると sendo の生死を見ることになる。reader のためだけのパスは足さない（sendo のパスと重なるおそれを増やさない）。
7. **サーバーは Node で書く。** HTTP は Hono と `@hono/node-server`（sendo と同じ）で受ける。コードは `apps/web/server/` に置き、ここだけ `node:*` を使ってよい。イメージには、画面のビルド（`vite build` の `dist`）と、依存ごと 1 つのファイルにまとめたサーバーを入れる。
8. **全文取得は常に使える機能として出す。全文取得の可否に `GET /api/v1/features` を使わない。**
   - sendo は、ページ本文の抽出と言語判定を常に動かし、欠いたままでは起動しない（sendo の[コンテナ版](https://github.com/sendo-feed/sendo/blob/main/docs/decisions/container.md)の 1〜3）。reader は、全文の取得を、いつでも使える機能として出す
   - 全文取得の判定に使っていた参照は廃止済み（[sendo-reader #125](https://github.com/sendo-feed/sendo-reader/pull/125)）。WebSocket 通知の互換判定と API の削除条件は、sendo の[差分同期の決定](https://github.com/sendo-feed/sendo/blob/main/docs/decisions/sync.md#決定)の 9 と[コンテナ版の決定](https://github.com/sendo-feed/sendo/blob/main/docs/decisions/container.md)の 3 に従う
   - 消したあとに、古い版の画面（Service Worker に残った版）が `/features` を呼んでも、404 を「全文を使えない」と受けて、全文の取得の操作を出さないだけで動き続ける。新しい版に切り替われば（[UI とツール](ui.md)の 5）、出る
9. **テストは Node で動かす。** 中継するパスの振り分け、中継（ヘッダー、`Set-Cookie`、リダイレクト、ストリーム）、静的なファイルのヘッダーを、偽の sendo を相手に Vitest で確かめる。CI では、PR でイメージが作れて動くことを確かめ、`main` に入ったらイメージを出す（sendo と同じ形）。

## 理由

- **コンテナだけにする**
  - sendo が、Cloudflare 版をやめてコンテナだけで動くことになった（sendo の[テックスタック](https://github.com/sendo-feed/sendo/blob/main/docs/decisions/tech-stack.md)の 2、[sendo-feed/sendo#129](https://github.com/sendo-feed/sendo/pull/129)）。Sendo がほかの RSS リーダーと違う価値を出すのは、ページ本文の抽出、言語判定、これから作る LLM・埋め込みなど、CPU を多く使う処理。Cloudflare の無料プランの上限（CPU、1 回の実行のクエリ 50、外への取得 50、D1 の容量と書き込み）にはこれらが収まらず、Cloudflare 版は普通の RSS リーダーの範囲にとどまった。2 つの版を保つ手間も大きかった
  - sendo の Worker がなくなったので、reader Worker から Service binding でつなぐ先がない。reader だけを Cloudflare に残す形は、下の代替案のとおり、使う人が置くものが 2 か所に分かれる
  - 配り方が 1 つになり、fork、Workers Builds、sendo を先にデプロイする順番、sendo-updater が要らなくなる。標準構成では、配布済みの sendo と reader のイメージを取り込んでコンテナを作り直す。埋め込みを有効にした構成では、配信元をビルドに渡すため reader のイメージをビルドし直す（2）
- **画面・API・認証を reader と同じオリジンで使う**
  - コンテナの sendo は、リクエストの URL のオリジンを `PUBLIC_URL` に置き換える。`PUBLIC_URL` を reader のオリジンにすれば、ログインの戻り先（ブラウザから見た `/api/v1/auth/<提供元>/login` の隣）、セッションのクッキー、状態を変えるリクエストの確かめ（`Sec-Fetch-Site` と `Origin`）、OAuth の発行者（issuer）と MCP の宛先、`/mcp` の `Origin` の確かめが、どれも reader のオリジンでそろう
  - sendo の設定は、`PUBLIC_URL` と `READER_URL` が同じオリジンでも受ける（2 つを比べない）。sendo のコードを変えずに済む
  - 画面の CSP（`connect-src 'self'`、`img-src 'self' data:`）を緩めずに済む
- **reader のイメージを sendo と分ける**
  - リポジトリをまたいだビルドにしない。sendo の CI が reader のビルドを取りにいく必要も、2 つのリポジトリのコミットをそろえる仕組みも要らない
  - sendo は API だけを持ち、画面は reader が持つという分け方（sendo の tech-deck、mcp.md の 4）を保てる。CSP など画面の守りは、reader が決めて reader が付ける
  - reader だけを直したときに、reader のイメージだけを出せる
- **許す一覧で中継する**
  - 画面と sendo の両方が `/oauth/` の下を使うので、前に付く文字だけでは分けられない
  - 「静的なファイル以外は全部 sendo に回す」と、画面のルート（`/settings`、`/feeds/<ID>`、`/oauth/authorize` など）を `index.html` にするために、結局、画面のルートの一覧が要る。画面のルートは増えやすい
  - ページの移動（`Sec-Fetch-Mode: navigate`）かどうかで分けると、同じパスでも、ブラウザで開いたときとアプリから呼んだときで行き先が変わる
  - sendo が外に出すパスは、プロトコルで決まったもので数が少なく、めったに増えない。一覧なら、何が sendo に届くかを 1 か所で読める
- **書き換えずに中継する**：sendo は、受けたヘッダー（`Sec-Fetch-Site`、`Origin`、`Cookie`）でセッションと CSRF を確かめる。書き換えなければ、sendo から見て、ブラウザが直接呼んだのと変わらない。sendo はクライアントの IP を使わない（`X-Forwarded-For` などを読まない）ので、すべてのリクエストが reader のコンテナから来ても困らない
- **ヘルスチェックで `/` を見る**：sendo が止まっても、reader のコンテナは静的なファイルを返し続けられ、作り直しても直らない。reader の生死に sendo を混ぜると、sendo だけの不調で reader まで不健全と出て、どちらが悪いか分からなくなる。sendo の生死は、sendo のコンテナのヘルスチェック（compose の `depends_on` もこれを見る）と、外からの `/healthz` で見る
- **Node で書く**
  - `security-headers.ts` をそのまま読み込めて、ヘッダーを 1 か所で保てる
  - 振り分けと中継を、ほかのテストと同じ Vitest で確かめられる
  - sendo と同じ道具（Node、Hono）で、2 つのコンテナの作りがそろう
- **全文取得を常に使える機能として出す**
  - sendo はページ本文の抽出が使えなければ起動を止める。全文取得の可否判定を残すと、使われない分岐とテストを保ち、記事を開くたびに `/features` を呼ぶことになる
  - 全文取得の判定を廃止したため、現行版では最初から全文の操作が出る。キャッシュ済みの旧 reader は、この API が返す値に応じて全文の操作を出し分ける

## 検討した代替案

- **sendo のイメージに画面を入れて、sendo が配る**：コンテナが 1 つで済み、中継の手間もない。ただ、リポジトリをまたいだビルドになり、reader を直すたびに sendo のイメージを作り直すことになる。sendo に、静的なファイルの配信と画面の CSP を持たせることになり、「sendo は API だけ」の分け方に合わない。
- **sendo のコンテナが前に立ち、画面のパスを reader のコンテナに回す**：外の入口が sendo になるだけで、中継の仕事を sendo に持たせることになる。上と同じく分け方に合わない。
- **reader だけを Cloudflare（Workers Static Assets）に残し、外に出したコンテナの sendo に URL で中継する**：サーバーを持たずに画面を配れる。ただ、次のどれかになる
  - sendo の `PUBLIC_URL` を sendo のオリジンにすると、ログインの戻り先もクッキーも sendo のオリジンのものになり、reader のオリジンにセッションができない
  - reader Worker が `X-Forwarded-Host` を付け、sendo がそれを信じる形は、sendo が避けている。そのヘッダーは誰でも付けられる
  - sendo の `PUBLIC_URL` を reader のオリジンにすれば、sendo を変えずに動く。ただ、OAuth の発行者と MCP の宛先も reader のオリジンになるので、reader Worker が `/mcp`、OAuth、Google Reader API もすべて中継することになる。sendo のコンテナも外に出す必要があり、使う人が置くものが 2 か所（Cloudflare とサーバー）に分かれ、配り方と中継を 2 組保つことになる
- **静的な配信のサーバー（Caddy、nginx）で返し、中継する**：配信と中継はよくこなれていて、イメージも小さい。ただ、設定の言語が 1 つ増え、ヘッダーを `security-headers.ts` とは別の形で書き出すことになる。振り分けを確かめるにも、サーバーを動かす必要がある。
- **中継するパスを、`/` 以外は全部 sendo にする、ページの移動かどうかで分ける**：上の「許す一覧で中継する」の理由で採らない。
- **`/features` を見て全文取得の操作を出し分ける**：ページ本文を抽出できない sendo にも対応できる。ただ、現行の sendo はページ本文の抽出を常に動かすため、通常の構成では判定が必要ない。

## 見直す条件

- sendo が外に出すパスを足したり、変えたりしたとき。一覧を直す。
- sendo が版を切るようになったとき。reader のイメージのタグも、そろえて決める。
- sendo がページ本文を抽出しない構成で動くようになったとき。8 の全文取得の表示を見直す。
- サーバーを持たない人にも使ってもらう必要が出たとき（sendo の[テックスタック](https://github.com/sendo-feed/sendo/blob/main/docs/decisions/tech-stack.md)の見直す条件と一緒に）。
- ネイティブ（Capacitor）で包むとき。アプリがどのオリジンを呼ぶかを決め直す。
