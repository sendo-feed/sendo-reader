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
- 手元で動かす [Sendo](https://github.com/sendo-feed/sendo)（画面から `/api` を呼ぶため）

pnpm は corepack で入れると、決められたバージョンが自動で使われます。

```sh
corepack enable pnpm
```

Windows では、WSL の中（Linux 側のファイルシステム）にクローンするのがおすすめです。

## はじめかた

まず、Sendo を手元で動かします（[Sendo の README](https://github.com/sendo-feed/sendo#はじめかた)）。`http://localhost:8787` で動いていれば十分です。

```sh
git clone https://github.com/sendo-feed/sendo-reader.git
cd sendo-reader
pnpm install
pnpm --filter @sendo-reader/core exec playwright install chromium   # ブラウザーで動くテストのため（初回だけ）
pnpm dev
```

`http://localhost:5173` で画面が開きます。`/api` へのリクエストは、Vite の dev サーバーが `http://localhost:8787` の Sendo に中継します。最初の画面で、Sendo で `pnpm token:create --email <メール>` を実行して発行したアクセストークンを貼ってログインします。

> [!NOTE]
> 差分同期の API（`GET /api/v1/sync`）は Sendo でまだ作っている途中です。それまでは、ログインはできても記事は同期されません。

## コマンド

| コマンド | すること |
|---|---|
| `pnpm dev` | 画面の dev サーバーを動かす |
| `pnpm check` | 型チェック、lint、テストをまとめて実行する（PR を出す前に） |
| `pnpm typecheck` | 型チェック（`.svelte` は svelte-check） |
| `pnpm lint` | lint と整形の確認（Biome） |
| `pnpm format` | 整形して、直せる lint の指摘を直す |
| `pnpm test` | テスト（Vitest） |
| `pnpm build` | 画面をビルドし、reader Worker をデプロイせずにバンドルして確かめる |
| `pnpm size` | ビルドのあとに、画面の JS とワーカーの JS・wasm の大きさが予算に収まるか確かめる |
| `pnpm e2e` | 画面を通したテスト（Playwright。`pnpm build` のあとに） |
| `pnpm --filter @sendo-reader/web lighthouse` | 初回の読み込みを Lighthouse で測る |
| `pnpm --filter @sendo-reader/core api:fetch` | 手元の Sendo から API の定義（OpenAPI）を写す |
| `pnpm --filter @sendo-reader/core api:generate` | 写した定義から API の型を作る |

## デプロイ

画面は Cloudflare Workers の Static Assets で配信し、reader Worker が `/api` を Service binding で Sendo（Worker 名 `sendo`）に中継します。Sendo を同じアカウントにデプロイしてから、次を実行します。

```sh
pnpm --filter @sendo-reader/web run deploy
```

## ディレクトリ構成

```text
sendo-reader/
├── packages/
│   └── core/                 # 同期エンジンとローカル DB（UI に依存しない）
├── apps/
│   └── web/                  # PWA（Svelte 5 ＋ Vite）
│       ├── src/              # 画面
│       ├── worker/           # reader Worker（静的なファイル ＋ /api の中継）
│       ├── security-headers.ts  # CSP などのヘッダー
│       └── wrangler.jsonc    # Cloudflare Workers の設定
├── scripts/                  # 手元と CI で動かす道具
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
