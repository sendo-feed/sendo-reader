# コンテナ版

- 状態：提案中
- 関連：[UI とツール](ui.md)（4。配信と中継、手元の開発）、[記事の中の X の投稿](embeds.md)（3。隔離フレームの配り方と設定）、[ローカルファースト](local-first.md)（6 のログイン、「記事の本文」、「ページの守り」）、[アカウントの画面](account.md)（5 の OAuth の許可の画面）、sendo の[テックスタック](https://github.com/sendo-feed/sendo/blob/main/docs/decisions/tech-stack.md)（2）・[コンテナ版](https://github.com/sendo-feed/sendo/blob/main/docs/decisions/container.md)・[MCP サーバー](https://github.com/sendo-feed/sendo/blob/main/docs/decisions/mcp.md)（3・4）

sendo-reader は、[sendo のコンテナ版](https://github.com/sendo-feed/sendo/blob/main/docs/decisions/container.md)と並べて、コンテナだけで動かす。reader が公式の画面と中継を提供し、ログインや MCP の OAuth の許可も同じオリジンで扱う。

## 決定

1. **reader は、コンテナだけで配る。Cloudflare（Workers、Static Assets、Service binding）では動かさない。**
   - 上流の CI がイメージを作り、GHCR（`ghcr.io/sendo-feed/sendo-reader`）に置く。使う人は fork しない
   - タグと CPU は sendo にそろえる。`main` に入るたびに `main` と `sha-<コミット>` のタグで出し、amd64 と arm64 の両方で作る。版のタグは、sendo が版を切るときに一緒に決める
   - イメージは公開する（sendo のイメージと同じ）。使う人は `docker login` せずに取ってこられる
   - sendo の `compose.yaml` に reader のサービスを並べ、`docker compose pull && docker compose up -d` で sendo と一緒に更新する。reader は、sendo のヘルスチェックが通ってから始める（`depends_on` の `condition: service_healthy`）
2. **外からは、reader のオリジン 1 つに見せる。** 例外は、X の投稿の隔離フレームのホスト名（下の 4。[記事の中の X の投稿](embeds.md)の 3）で、画面と sendo のどちらにも使わない
   - 外に出すのは reader のコンテナのポート（`compose.yaml` では `127.0.0.1:8080:8080`）だけにする。TLS は、sendo と同じく、手前に置くリバースプロキシ（Caddy など）や Cloudflare Tunnel で終える。コンテナは HTTP だけを受ける
   - sendo のコンテナは、ポートを外に出さない。reader のコンテナが、compose の中のネットワークで呼ぶ
   - sendo の `PUBLIC_URL` と `READER_URL` には、どちらも reader のオリジン（例：`https://reader.example.com`）を入れる。`PUBLIC_URL` は欠かせない。コンテナは HTTP だけを受けるので、ないと sendo から見える URL は、中継の先の URL（`http://sendo:8787`）か、ホスト名は合っていても `http` のままのオリジンになり、ログインの戻り先や `__Host-` のクッキーが合わない
   - Google のリダイレクト URI、リーダーアプリ（Google Reader API）のサーバー、MCP の URL も、このオリジンにする
   - 画面を使わない人は、reader のコンテナを外して sendo のポートを出してよい（sendo の[コンテナ版](https://github.com/sendo-feed/sendo/blob/main/docs/decisions/container.md)の 7。このとき OAuth は使えない）。reader は、この形には関わらない
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
   - WebSocket の Upgrade（sendo の通知の `/api/v1/sync/updates`。sendo の[差分同期](https://github.com/sendo-feed/sendo/blob/main/docs/decisions/sync.md)の 9）も、一覧のパスなら書き換えずに中継する。`Origin`、`Cookie`、`Sec-WebSocket-*` はそのまま渡す。sendo が `101` を返したら、そのあとは両方向のバイト列を、中身（フレーム）を読まずにそのまま流す。`101` 以外の応答（401、403、429 など）は、そのままブラウザに返す。一覧にないパスの Upgrade は断る
   - reader のコンテナが止まるときは、中継している WebSocket も切る。ブラウザはつなぎ直す（[ローカルファースト](local-first.md)の 3）
   - 応答の状態、ヘッダー（複数の `Set-Cookie` を含む）、本文をそのまま返す。本文は溜めずに流す（MCP、OPML の書き出しなど）
   - sendo の応答には、画面のセキュリティのヘッダーを足さない
   - 中継の先は設定 `SENDO_URL` で変えられる（既定は compose の中の `http://sendo:8787`）。reader のコンテナに、ほかに欠かせない設定はない（自分のオリジンも知らなくてよい）
   - X の投稿の隔離フレームを使うときだけ、設定 `X_EMBED_ORIGIN`（隔離フレームのオリジン）を足す。このホスト名への要求には、隔離フレームのページだけを返し、sendo には中継しない。未設定なら、この機能は出ない（[記事の中の X の投稿](embeds.md)の 3）
5. **静的なファイルは、次のように返す。**
   - `apps/web/security-headers.ts` のヘッダーを、静的なファイルのすべての応答に付ける。手元の Vite の dev サーバー・preview も同じところから付け、別に書き写さない。例外は、隔離フレームのホスト名への応答で、隔離フレームのページのヘッダーを付ける（[記事の中の X の投稿](embeds.md)の 2）
   - `X_EMBED_ORIGIN` を設定したときは、起動時に、メモリーに読んだ `index.html` に隔離フレームのオリジンの `<meta>` を足し、CSP に `frame-src` を足し、`sw.js` の中の `index.html` の版の印を書き換える。書き換える場所が見つからなければ起動しない。未設定なら、ビルドしたものをそのまま返す（[記事の中の X の投稿](embeds.md)の 3）
   - キャッシュは、毎回確かめさせる（`Cache-Control: public, max-age=0, must-revalidate` と ETag で、変わっていなければ 304）。Service Worker（`sw.js`）が新しい版を見つけられるように、長く持たせない
   - JS、CSS、wasm などは、ブラウザが受けられれば圧縮して返す（brotli か gzip）
6. **reader のコンテナのヘルスチェック（イメージの `HEALTHCHECK`）は、reader 自身が返す `/`（`index.html`）を見る。** `/healthz` は sendo に中継するので、reader のコンテナで見ると sendo の生死を見ることになる。reader のためだけのパスは足さない（sendo のパスと重なるおそれを増やさない）。
7. **サーバーは Node で書く。** HTTP は Hono と `@hono/node-server`（sendo と同じ）で受ける。コードは `apps/web/server/` に置き、ここだけ `node:*` を使ってよい。イメージには、画面のビルド（`vite build` の `dist`）と、依存ごと 1 つのファイルにまとめたサーバーを入れる。
8. **sendo の機能は、すべて使える前提で作る。`GET /api/v1/features` は見ない。**
   - sendo は、ページ本文の抽出と言語判定を常に動かし、欠いたままでは起動しない（sendo の[コンテナ版](https://github.com/sendo-feed/sendo/blob/main/docs/decisions/container.md)の 1〜3）。reader は、全文の取得を、いつでも使える機能として出す
   - `/features` は、この決定を実装する PR で使わなくする。その PR を含む reader のイメージが GHCR の `main` に出たら、sendo は `/features` を消してよい（sendo の[コンテナ版](https://github.com/sendo-feed/sendo/blob/main/docs/decisions/container.md)の 3）
   - 消したあとに、古い版の画面（Service Worker に残った版）が `/features` を呼んでも、404 を「全文を使えない」と受けて、全文の取得の操作を出さないだけで動き続ける。新しい版に切り替われば（[UI とツール](ui.md)の 5）、出る
9. **テストは Node で動かす。** 中継するパスの振り分け、中継（ヘッダー、`Set-Cookie`、リダイレクト、ストリーム、WebSocket の Upgrade）、静的なファイルのヘッダー、`X_EMBED_ORIGIN` を設定したときの振り分けと書き換えを、偽の sendo を相手に Vitest で確かめる。CI では、PR でイメージが作れて動くことを確かめ、`main` に入ったらイメージを出す（sendo と同じ形）。

## 理由

- **コンテナだけにする**
  - sendo が、Cloudflare 版をやめてコンテナだけで動くことになった（sendo の[テックスタック](https://github.com/sendo-feed/sendo/blob/main/docs/decisions/tech-stack.md)の 2、[sendo-feed/sendo#129](https://github.com/sendo-feed/sendo/pull/129)）。Sendo がほかの RSS リーダーと違う価値を出すのは、ページ本文の抽出、言語判定、これから作る LLM・埋め込みなど、CPU を多く使う処理。Cloudflare の無料プランの上限（CPU、1 回の実行のクエリ 50、外への取得 50、D1 の容量と書き込み）にはこれらが収まらず、Cloudflare 版は普通の RSS リーダーの範囲にとどまった。2 つの版を保つ手間も大きかった
  - sendo の Worker がなくなったので、reader Worker から Service binding でつなぐ先がない。reader だけを Cloudflare に残す形は、下の代替案のとおり、使う人が置くものが 2 か所に分かれる
  - 配り方が 1 つになり、fork、Workers Builds、sendo を先にデプロイする順番、sendo-updater が要らなくなる。sendo と reader は `docker compose pull` で一緒に新しくなる
- **reader のオリジン 1 つに見せる**
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
- **書き換えずに中継する**：sendo は、受けたヘッダー（`Sec-Fetch-Site`、`Origin`、`Cookie`）でセッションと CSRF を確かめる。書き換えなければ、sendo から見て、ブラウザが直接呼んだのと変わらない。WebSocket も同じで、`Origin` とクッキーをそのまま渡せば sendo が接続を確かめられ、フレームを読まずに流せば、sendo の閉じるコードもそのままブラウザに届く。sendo はクライアントの IP を使わない（`X-Forwarded-For` などを読まない）ので、すべてのリクエストが reader のコンテナから来ても困らない
- **ヘルスチェックで `/` を見る**：sendo が止まっても、reader のコンテナは静的なファイルを返し続けられ、作り直しても直らない。reader の生死に sendo を混ぜると、sendo だけの不調で reader まで不健全と出て、どちらが悪いか分からなくなる。sendo の生死は、sendo のコンテナのヘルスチェック（compose の `depends_on` もこれを見る）と、外からの `/healthz` で見る
- **Node で書く**
  - `security-headers.ts` をそのまま読み込めて、ヘッダーを 1 か所で保てる
  - 振り分けと中継を、ほかのテストと同じ Vitest で確かめられる
  - sendo と同じ道具（Node、Hono）で、2 つのコンテナの作りがそろう
- **すべての機能を使える前提にする**
  - sendo は機能を欠いたまま起動しないので、出し分けても、欠けた sendo を相手にすることがない。分岐とそのテストを残すと、使われないまま保つことになり、記事を開くたびに `/features` を呼ぶ
  - reader が先に使わなくなれば、sendo はいつ消しても reader を壊さない。sendo が先に消しても、古い画面は 404 を「使えない」と受けるので壊れないが、新しい版に替わるまで全文の取得が出なくなる。reader から先に外す

## 検討した代替案

- **sendo のイメージに画面を入れて、sendo が配る**：コンテナが 1 つで済み、中継の手間もない。ただ、リポジトリをまたいだビルドになり、reader を直すたびに sendo のイメージを作り直すことになる。sendo に、静的なファイルの配信と画面の CSP を持たせることになり、「sendo は API だけ」の分け方に合わない。
- **sendo のコンテナが前に立ち、画面のパスを reader のコンテナに回す**：外の入口が sendo になるだけで、中継の仕事を sendo に持たせることになる。上と同じく分け方に合わない。
- **reader だけを Cloudflare（Workers Static Assets）に残し、外に出したコンテナの sendo に URL で中継する**：サーバーを持たずに画面を配れる。ただ、次のどれかになる
  - sendo の `PUBLIC_URL` を sendo のオリジンにすると、ログインの戻り先もクッキーも sendo のオリジンのものになり、reader のオリジンにセッションができない
  - reader Worker が `X-Forwarded-Host` を付け、sendo がそれを信じる形は、sendo が避けている。そのヘッダーは誰でも付けられる
  - sendo の `PUBLIC_URL` を reader のオリジンにすれば、sendo を変えずに動く。ただ、OAuth の発行者と MCP の宛先も reader のオリジンになるので、reader Worker が `/mcp`、OAuth、Google Reader API もすべて中継することになる。sendo のコンテナも外に出す必要があり、使う人が置くものが 2 か所（Cloudflare とサーバー）に分かれ、配り方と中継を 2 組保つことになる
- **WebSocket は中継せず、sendo のポートを外に出してブラウザから直接つなぐ**：中継の作りが要らないが、外から見えるオリジンが 2 つになる。クッキーと `Origin` の確かめが合わなくなり、CSP の `connect-src` も緩めることになる。
- **静的な配信のサーバー（Caddy、nginx）で返し、中継する**：配信と中継はよくこなれていて、イメージも小さい。ただ、設定の言語が 1 つ増え、ヘッダーを `security-headers.ts` とは別の形で書き出すことになる。振り分けを確かめるにも、サーバーを動かす必要がある。
- **中継するパスを、`/` 以外は全部 sendo にする、ページの移動かどうかで分ける**：上の「許す一覧で中継する」の理由で採らない。
- **`/features` を見た出し分けを残す**：sendo が機能を欠いた形で動くようになっても、そのまま対応できる。ただ、sendo は欠いたまま起動しないと決めていて、使われない分岐とテストが残る。

## 見直す条件

- sendo が外に出すパスを足したり、変えたりしたとき。一覧を直す。
- sendo が版を切るようになったとき。reader のイメージのタグも、そろえて決める。
- sendo が、機能を欠いた形で動くようになったとき。8 の出し分けを決め直す。
- サーバーを持たない人にも使ってもらう必要が出たとき（sendo の[テックスタック](https://github.com/sendo-feed/sendo/blob/main/docs/decisions/tech-stack.md)の見直す条件と一緒に）。
- ネイティブ（Capacitor）で包むとき。アプリがどのオリジンを呼ぶかを決め直す。
