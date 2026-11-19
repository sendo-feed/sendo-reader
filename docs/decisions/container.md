# コンテナ版

- 状態：提案中
- 関連：[UI とツール](ui.md)（4。配信と中継）、[デプロイ](deploy.md)（Cloudflare 版）、[ローカルファースト](local-first.md)（6 のログイン、「ページの守り」）、[アカウントの画面](account.md)（5 の OAuth の許可の画面）、sendo の[コンテナ版](https://github.com/sendo-feed/sendo/blob/main/docs/decisions/container.md)・[MCP サーバー](https://github.com/sendo-feed/sendo/blob/main/docs/decisions/mcp.md)（3・4）

コンテナ版の reader は、同じサーバーで動く [sendo のコンテナ版](https://github.com/sendo-feed/sendo/blob/main/docs/decisions/container.md) と組み合わせて使う。reader が公式の画面と中継を提供し、ログインや MCP の OAuth の許可も同じオリジンで扱う。

## 決定

1. **コンテナ版の sendo と組むときは、reader もコンテナで配る。**
   - 上流の CI がイメージを作り、GHCR（`ghcr.io/sendo-feed/sendo-reader`）に置く。使う人は fork しない
   - タグと CPU は sendo にそろえる。`main` に入るたびに `main` と `sha-<コミット>` のタグで出し、amd64 と arm64 の両方で作る。版のタグは、sendo が版を切るときに一緒に決める
   - イメージは公開する（sendo のイメージと同じ）。使う人は `docker login` せずに取ってこられる
   - sendo の `compose.yaml` に reader のサービスを並べる。標準構成は `docker compose pull && docker compose up -d` で一緒に更新する。reader は、sendo が動き出してから（ヘルスチェックが通ってから）始める
2. **reader の画面と Sendo の API・認証は、reader のオリジン 1 つから配る。**
   - 外に出すのは reader のコンテナだけにする。TLS は、sendo と同じく、手前に置くリバースプロキシや Cloudflare Tunnel で終える。コンテナは HTTP だけを受ける
   - sendo のコンテナは、ポートを外に出さない。reader のコンテナが、compose の中のネットワークで呼ぶ
   - sendo の `PUBLIC_URL` と `READER_URL` には、どちらも reader のオリジン（例：`https://reader.example.com`）を入れる。`PUBLIC_URL` は欠かせない。コンテナは HTTP だけを受けるので、ないと sendo から見える URL は、中継の先の URL（`http://sendo:8787`）か、ホスト名は合っていても `http` のままのオリジンになり、ログインの戻り先や `__Host-` のクッキーが合わない
   - Google のリダイレクト URI、リーダーアプリ（Google Reader API）のサーバー、MCP の URL も、このオリジンにする
   - X の埋め込みを有効にする場合は、埋め込み用の静的ファイルだけを別ホストから配る（[ローカルファースト](local-first.md#ページの守り)）。reader の配布済みイメージで通常の構成を使うと、引用と投稿リンクを表示する。埋め込みを有効にする場合は、配信元を指定して reader のイメージをビルドし、Compose の `reader` でそのイメージを使う。更新時は reader のイメージもビルドし直す
3. **reader のコンテナは、画面の静的なファイルを返し、sendo のパスを sendo に中継する。中継するパスは、許す一覧で持つ。**
   - 一覧：`/api/`（の下すべて）、`/mcp`、`/.well-known/oauth-protected-resource/mcp`、`/.well-known/oauth-authorization-server`、`/oauth/token`、`/oauth/register`、`/accounts/ClientLogin`、`/reader/api/0/`（の下すべて）、`/healthz`
   - 一覧にないパスには、静的なファイルか、なければ `index.html` を返す（Cloudflare 版と同じ SPA の扱い）
   - 一覧は 1 か所に置き、コンテナのサーバーと、Service Worker のページの移動の横取り（`navigateFallbackDenylist`）が同じものを使う。ブラウザでこれらのパスを開いたときに、Service Worker が `index.html` を返さないようにする
   - 画面のルートは、一覧と重ねない。`/oauth/authorize` は画面（許可の画面）で、`/oauth/token` と `/oauth/register` は sendo。`/oauth/` で始まるパスをまとめて回さない
   - sendo が外に出すパスを足したら、この一覧にも足す
   - `/healthz` は sendo の生死を答える。外から `https://reader.example.com/healthz` を見ると、reader と sendo をつないだ全体を確かめられる
4. **中継では、リクエストと応答を書き換えない。**
   - メソッド、パスとクエリ、ヘッダー、本文をそのまま sendo に渡す。除くのは、1 回の接続にだけ関わるヘッダー（`Connection`、`Transfer-Encoding` など）だけにする。`Cookie`、`Origin`、`Sec-Fetch-*`、`Authorization` はそのまま渡す
   - `X-Forwarded-*` は付けない。sendo はそれを信じず、URL のオリジンを `PUBLIC_URL` に置き換える
   - リダイレクトは追わずに、そのまま返す（ログインの 302 など）
   - 応答の状態、ヘッダー（複数の `Set-Cookie` を含む）、本文をそのまま返す。本文は溜めずに流す（MCP、OPML の書き出しなど）
   - sendo の応答には、画面のセキュリティのヘッダーを足さない（Cloudflare 版の `/api` と同じ）
   - 中継の先は設定 `SENDO_URL` で変えられる（既定は `http://sendo:8787`）。reader のコンテナは自分のオリジンを知らなくてよい
5. **静的なファイルの応答は、Cloudflare 版と同じにする。**
   - `apps/web/security-headers.ts` のヘッダーを、静的なファイルのすべての応答に付ける。`dist/_headers` と同じところから作り、別に書き写さない
   - キャッシュは、毎回確かめさせる（ETag で、変わっていなければ 304）。Service Worker（`sw.js`）が新しい版を見つけられるように、長く持たせない
   - JS、CSS、wasm などは圧縮して返す（Workers Static Assets と同じ）
6. **reader のコンテナのヘルスチェック（イメージの `HEALTHCHECK`）は、reader 自身が返す `/`（`index.html`）を見る。** `/healthz` は sendo に中継するので、reader のコンテナで見ると sendo の生死を見ることになる。reader のためだけのパスは足さない（sendo のパスと重なるおそれを増やさない）。
7. **サーバーは Node で書く。** HTTP は Hono と `@hono/node-server`（sendo のコンテナ版と同じ）で受ける。コードは `apps/web/server/` に置き、ここだけ `node:*` を使ってよい。イメージには、Cloudflare 版と同じ画面のビルド（`vite build` の `dist`）を入れる。
8. **Cloudflare 版の reader Worker は、`/api` だけを Service binding で中継する。**画面のビルドは、2 つの版で同じものを使う。
   - 支える組み合わせは、Cloudflare 版どうしと、コンテナ版どうしの 2 つだけにする。Cloudflare 版の reader とコンテナ版の sendo のような、版をまたぐ組み合わせは支えない
9. **テストは Node で動かす。** 中継するパスの振り分け、中継（ヘッダー、`Set-Cookie`、リダイレクト、ストリーム）、静的なファイルのヘッダーを、偽の sendo を相手に Vitest で確かめる。CI では、PR でイメージが作れることを確かめ、`main` に入ったらイメージを出す（sendo と同じ形）。

## 理由

- **画面・API・認証は reader のオリジン 1 つから配る**
  - Cloudflare 版でログインが動くのは、Service binding が、受けたリクエストを reader のオリジンの URL のまま sendo に渡すから（`env.SENDO.fetch(request)`）。Cloudflare 版の sendo は URL を書き換えないので、ログインの戻り先（ブラウザから見た `/api/v1/auth/<提供元>/login` の隣）も、セッションのクッキーも、reader のオリジンのものになる
  - コンテナ版の sendo は、リクエストの URL のオリジンを `PUBLIC_URL` に置き換える。`PUBLIC_URL` を reader のオリジンにすれば、Cloudflare 版と同じことが起きる。戻り先、クッキー、状態を変えるリクエストの確かめ（`Sec-Fetch-Site` と `Origin`）、OAuth の発行者（issuer）と MCP の宛先、`/mcp` の `Origin` の確かめが、どれも reader のオリジンでそろう
  - sendo の設定は、`PUBLIC_URL` と `READER_URL` が同じオリジンでも受ける（2 つを比べる処理はない。sendo の `src/platform/config.ts`）。sendo のコードを変えずに済む
  - 画面の CSP（`connect-src 'self'`、`img-src 'self' data:`）を緩めずに済む
- **reader のイメージを sendo と分ける**
  - リポジトリをまたいだビルドにしない。sendo の CI が reader のビルドを取りにいく必要も、2 つの版をそろえる仕組みも要らない
  - sendo は API だけを持ち、画面は reader が持つという分け方（sendo の tech-deck、mcp.md の 4）を保てる。CSP など画面の守りは、reader が決めて reader が付ける
  - reader だけを直したときに、reader のイメージだけを出せる
- **許す一覧で中継する**
  - 画面と sendo の両方が `/oauth/` の下を使うので、前に付く文字だけでは分けられない
  - 「静的なファイル以外は全部 sendo に回す」と、画面のルート（`/settings`、`/feeds/<ID>`、`/oauth/authorize` など）を `index.html` にするために、結局、画面のルートの一覧が要る。画面のルートは増えやすい
  - ページの移動（`Sec-Fetch-Mode: navigate`）かどうかで分けると、同じパスでも、ブラウザで開いたときとアプリから呼んだときで行き先が変わる
  - sendo が外に出すパスは、プロトコルで決まったもので数が少なく、めったに増えない。一覧なら、何が sendo に届くかを 1 か所で読める
- **書き換えずに中継する**：sendo は、受けたヘッダー（`Sec-Fetch-Site`、`Origin`、`Cookie`）でセッションと CSRF を確かめる。Service binding も書き換えずに渡すので、同じにすれば sendo から見て 2 つの版の違いがない。sendo はクライアントの IP を使わない（`X-Forwarded-For` などを読まない）ので、すべてのリクエストが reader のコンテナから来ても困らない
- **ヘルスチェックで `/` を見る**：sendo が止まっても、reader のコンテナは静的なファイルを返し続けられ、作り直しても直らない。reader の生死に sendo を混ぜると、sendo だけの不調で reader まで不健全と出て、どちらが悪いか分からなくなる。sendo の生死は、sendo のコンテナのヘルスチェック（compose の `depends_on` もこれを見る）と、外からの `/healthz` で見る
- **Node で書く**
  - `security-headers.ts` をそのまま読み込めて、ヘッダーを 1 か所で保てる
  - 振り分けと中継を、ほかのテストと同じ Vitest で確かめられる
  - sendo のコンテナ版と同じ道具（Node、Hono）で、2 つのコンテナの作りがそろう
- **Cloudflare 版は `/api` を中継する**：Cloudflare 版では、MCP のクライアントやリーダーアプリは sendo のオリジンに直接つなぐ（sendo の mcp.md の「理由」）。reader Worker が `/api` のほかを中継する理由がない
- **版をまたぐ組み合わせを支えない**：下の代替案のとおり、どちらも Cloudflare 版の動きを変えるか、sendo を外に出すことになる。

## 検討した代替案

- **sendo のイメージに画面を入れて、sendo が配る**：コンテナが 1 つで済み、中継の手間もない。ただ、リポジトリをまたいだビルドになり、reader を直すたびに sendo のイメージを作り直すことになる。sendo に、静的なファイルの配信と画面の CSP を持たせることになり、「sendo は API だけ」の分け方に合わない。
- **sendo のコンテナが前に立ち、画面のパスを reader のコンテナに回す**：外の入口が sendo になるだけで、中継の仕事を sendo に持たせることになる。上と同じく分け方に合わない。
- **reader Worker（Cloudflare）が、URL で外の sendo に中継する**
  - sendo の `PUBLIC_URL` を sendo のオリジンにすると、ログインの戻り先もクッキーも sendo のオリジンのものになり、reader のオリジンにセッションができない
  - reader Worker が `X-Forwarded-Host` を付け、sendo がそれを信じる形は、sendo が避けている。そのヘッダーは誰でも付けられる（sendo の `src/platform/node/index.ts`）
  - sendo の `PUBLIC_URL` を reader（Cloudflare）のオリジンにすれば、sendo を変えずに `/api` は動く。ただ、OAuth の発行者と MCP の宛先も reader のオリジンになるので、reader Worker が `/mcp`、OAuth、Google Reader API も中継することになり、Cloudflare 版の reader の動きが変わる。sendo のコンテナも外に出す必要があり、使う人が置くものが 2 か所（Cloudflare とサーバー）に分かれる
- **静的な配信のサーバー（Caddy、nginx）で返し、中継する**：配信と中継はよくこなれていて、イメージも小さい。ただ、設定の言語が 1 つ増え、ヘッダーを `_headers` とは別の形で書き出すことになる。振り分けを確かめるにも、サーバーを動かす必要がある。
- **reader Worker を、コンテナの中で workerd で動かす**：Cloudflare 版と同じコードで動く。ただ、Workers Static Assets と同じ振る舞いを得るには、手元で試すための道具（wrangler の `dev`、Miniflare）を本番で動かすことになる。
- **中継するパスを、`/` 以外は全部 sendo にする、ページの移動かどうかで分ける**：上の「許す一覧で中継する」の理由で採らない。

## 見直す条件

- sendo が外に出すパスを足したり、変えたりしたとき。一覧を直す。
- 版をまたぐ組み合わせ（とくに Cloudflare 版の reader とコンテナ版の sendo）を使いたい人が出たとき。上の代替案の、`PUBLIC_URL` を reader のオリジンにする形を考え直す。
- sendo が版を切るようになったとき。reader のイメージのタグも、そろえて決める。
- ネイティブ（Capacitor）で包むとき。アプリがどのオリジンを呼ぶかを、2 つの版で決め直す。
