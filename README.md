# sendo-reader

> **鮮度を、導く。** — Fresh feeds, guided.

[![CI](https://github.com/sendo-feed/sendo-reader/actions/workflows/ci.yml/badge.svg)](https://github.com/sendo-feed/sendo-reader/actions/workflows/ci.yml)

sendo-reader は、フィード集約サーバー [Sendo](https://github.com/sendo-feed/sendo) の公式リーダーです。

- **サクサク動く**：画面は手元の SQLite だけを読み書きし、ネットワークを待たない（ローカルファースト）
- **起動して 1 回で揃う**：Sendo とは、差分を 1 回のリクエストで同期する
- **どこでも読める**：PWA としてブラウザで動き、あとで Capacitor でスマホのアプリにする

> [!WARNING]
> まだ開発の初期段階で、使える機能はありません。

## 必要なもの

- Node.js 22.12 以上（CI は [.node-version](.node-version) のバージョンで動かす）
- pnpm（バージョンは [package.json](package.json) の `packageManager` で固定している）
- 手元で動かす [Sendo](https://github.com/sendo-feed/sendo)（画面から Sendo の API を呼ぶため）

pnpm は corepack で入れると、決められたバージョンが自動で使われます。

```sh
corepack enable pnpm
```

Windows では、WSL の中（Linux 側のファイルシステム）にクローンするのがおすすめです。

## はじめかた

まず、Sendo を手元で `pnpm dev` で動かします（[Sendo の README](https://github.com/sendo-feed/sendo#手元で動かす)）。`http://localhost:8787` で動いていれば十分です。

```sh
git clone https://github.com/sendo-feed/sendo-reader.git
cd sendo-reader
pnpm install
pnpm --filter @sendo-reader/core exec playwright install chromium   # ブラウザーで動くテストのため（初回だけ）
pnpm dev
```

`http://localhost:5173` で画面が開きます。Sendo のパス（`/api`、`/mcp`、OAuth など。本番の reader のコンテナと同じ一覧）へのリクエストは、Vite の dev サーバーが `http://localhost:8787` の Sendo に中継します。最初の画面で「Google でログイン」を押すと、Sendo の Google のログインを通って戻ってきます。

ログインするには、手元の Sendo の `.env` に Google の OAuth クライアントと、ログインできるメールを設定しておきます（[Sendo の README](https://github.com/sendo-feed/sendo#ブラウザでログインするgoogle)）。「承認済みのリダイレクト URI」には `http://localhost:5173/api/v1/auth/google/callback` を登録します。

## コマンド

| コマンド | すること |
|---|---|
| `pnpm dev` | 画面の dev サーバーを動かす |
| `pnpm check` | 型チェック、lint、テストをまとめて実行する（PR を出す前に） |
| `pnpm typecheck` | 型チェック（`.svelte` は svelte-check） |
| `pnpm lint` | lint と整形の確認（Biome） |
| `pnpm format` | 整形して、直せる lint の指摘を直す |
| `pnpm test` | テスト（Vitest） |
| `pnpm build` | 画面をビルドし、コンテナのサーバーを `apps/web/dist-server/server.mjs` にバンドルする |
| `pnpm size` | ビルドのあとに、画面の JS とワーカーの JS・wasm の大きさが予算に収まるか確かめる |
| `pnpm e2e` | 画面を通したテスト（Playwright。`pnpm build` のあとに） |
| `pnpm --filter @sendo-reader/web start:server` | コンテナのサーバーを手元の Node で動かす（`pnpm build` のあとに。`SENDO_URL=http://localhost:8787` で手元の Sendo に中継する） |
| `pnpm --filter @sendo-reader/web lighthouse` | 初回の読み込みを Lighthouse で測る |
| `pnpm --filter @sendo-reader/core api:fetch` | 手元の Sendo から API の定義（OpenAPI）を写す |
| `pnpm --filter @sendo-reader/core api:generate` | 写した定義から API の型を作る |

## 動かす


X の公式埋め込みを有効にするには、Sendo と reader の両方で対応版が必要です。対応版の reader は、別の HTTPS ホストを用意し、その配信元を指定してイメージをビルドします。有効化と更新は [コンテナ版の決定の 2](docs/decisions/container.md#決定)を参照してください。
Sendo と並べて、コンテナで動かします（[決定](docs/decisions/container.md)）。上流の CI が作ったイメージ（`ghcr.io/sendo-feed/sendo-reader`）を、Sendo の [`compose.yaml`](https://github.com/sendo-feed/sendo/blob/main/compose.yaml) で Sendo のイメージと並べて動かすので、標準構成では fork もビルドも要りません。手順は [Sendo の README](https://github.com/sendo-feed/sendo#動かす) にあります。

- 外に出すのは reader のコンテナのポート（`127.0.0.1:8080`）だけです。reader のコンテナが画面を返し、Sendo のパス（`/api`、`/mcp`、OAuth、Google Reader API、`/healthz`）を、compose の中の Sendo（`http://sendo:8787`）に中継します。画面・API・認証は同じ reader のオリジンを使います
- Sendo の `PUBLIC_URL` と `READER_URL` には、どちらも reader のオリジン（例：`https://reader.example.com`）を入れます。Google のリダイレクト URI、リーダーアプリのサーバー、MCP の URL も、このオリジンにします
- TLS は、手前に置くリバースプロキシ（Caddy など）や Cloudflare Tunnel で終えます。コンテナは HTTP（既定はポート 8080）だけを受けます
- reader は、Sendo のヘルスチェックが通ってから始まります。標準構成の更新は `docker compose pull && docker compose up -d` で、Sendo と一緒に新しくなります

reader のコンテナの設定（環境変数）は、次の 2 つだけです。どちらも、ふつうは変えません。

| 名前 | 既定 | 意味 |
|---|---|---|
| `SENDO_URL` | `http://sendo:8787` | 中継の先の Sendo（compose の中の名前） |
| `PORT` | `8080` | 受けるポート |

手元でイメージを作るときは `docker build -t sendo-reader .` です。手元で作ったイメージを Sendo の `compose.yaml` で試すときは、`reader` の `image` を `sendo-reader` に替えます。

中継するパスのずれは `Sendo paths` ワークフローが検査します。PR・main への push と毎日の実行で、
sendo の最新 main の実際のルートを、中継するパスの一覧（コンテナ、Service Worker、手元の Vite が使う）に照合します。
sendo の変更によって reader の検査が落ちる場合は、エラーに出たパスを `apps/web/sendo-paths.ts` に足してください。
画面のルートと重なる場合は、両方のパスを調整します。

手元では、依存を入れた sendo のディレクトリから、その tsx で同じ検査を実行できます。

```sh
pnpm --dir ../sendo exec tsx ../sendo-reader/scripts/check-sendo-paths.ts ../sendo
```

### X の投稿の埋め込み

`apps/web/x-embed/` を reader とホスト名が異なる HTTPS オリジンのルートで配信する。Cloudflare Pages など、同梱の `_headers` を適用できる静的ホスティングを使う。埋め込み用のオリジンには reader の API や認証を置かない。

reader をビルドするときに `SENDO_X_EMBED_ORIGIN` でそのオリジンを指定する。Docker では次のようにイメージを作る。

```sh
docker build --build-arg SENDO_X_EMBED_ORIGIN=https://embed.example.com -t sendo-reader:x-embeds .
```

配信先の設定があり、対象の引用から投稿が一意に決まると、記事を開いたときに X の公式ウィジェットが表示されます。未設定の場合や読み込めない場合は記事中の引用と投稿リンクが表示されます。公式ウィジェットの表示後も、その下から記事中の引用を開けます。

配備後は、対象記事の本文をまだ保持していないブラウザープロファイルで、対応版の Sendo が保存した X の引用を含む記事をオンラインで開き、投稿 ID が一意に決まる引用で公式ウィジェットが表示されることを確かめます。専用 HTTPS ホストのルートの応答ヘッダーを、その reader のビルドに使った版の `apps/web/x-embed/_headers` と照合します。[配備後の確認](docs/decisions/container.md#決定)

## ディレクトリ構成

```text
sendo-reader/
├── packages/
│   └── core/                 # 同期エンジンとローカル DB（UI に依存しない）
├── apps/
│   └── web/                  # PWA（Svelte 5 ＋ Vite）
│       ├── src/              # 画面
│       ├── server/           # コンテナのサーバー（静的なファイル ＋ Sendo のパスの中継）
│       ├── sendo-paths.ts    # Sendo に中継するパス
│       └── security-headers.ts  # CSP などのヘッダー
├── scripts/                  # 手元と CI で動かす道具
├── Dockerfile                # reader のイメージ
├── docs/decisions/           # 今の決定
└── biome.json                # lint と整形の設定
```

同期とローカル DB のロジックはすべて `packages/core` に置き、`packages/core` からは Svelte も `apps/` も import しません。lint で検査しています（[決定](docs/decisions/local-first.md)）。

## 文書

- [決定の一覧](docs/decisions/README.md)：今の決定とその理由
- Sendo の[インセプションデッキ](https://github.com/sendo-feed/sendo/blob/main/docs/inception-deck.md)、[技術構成](https://github.com/sendo-feed/sendo/blob/main/docs/tech-deck.md)、[決定の一覧](https://github.com/sendo-feed/sendo/blob/main/docs/decisions/README.md)

## 貢献

いまは2人で開発していて、外部からの Issue や PR は公開の準備ができてから受け付けます。決まりごとは [CONTRIBUTING.md](https://github.com/sendo-feed/.github/blob/main/CONTRIBUTING.md) にあります。

## ライセンス

未定です。決まるまでは、すべての権利を留保します。
