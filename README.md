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

`http://localhost:5173` で画面が開きます。`/api` へのリクエストは、Vite の dev サーバーが `http://localhost:8787` の Sendo に中継します。最初の画面で「Google でログイン」を押すと、Sendo の Google のログインを通って戻ってきます。

ログインするには、手元の Sendo に Google の OAuth クライアントと、ログインできるメールを設定しておきます（[Sendo の README](https://github.com/sendo-feed/sendo#ブラウザでログインするgoogle)）。「承認済みのリダイレクト URI」には `http://localhost:5173/api/v1/auth/google/callback` を登録します。

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
| `pnpm run deploy` | 画面をビルドし、reader Worker をデプロイする（[デプロイ](#デプロイ)。ふつうは fork への push で Workers Builds が動かす） |
| `pnpm --filter @sendo-reader/web lighthouse` | 初回の読み込みを Lighthouse で測る |
| `pnpm --filter @sendo-reader/core api:fetch` | 手元の Sendo から API の定義（OpenAPI）を写す |
| `pnpm --filter @sendo-reader/core api:generate` | 写した定義から API の型を作る |

## デプロイ

自分の Cloudflare アカウントに、GitHub の fork からデプロイします。fork の `main` に push するたびに、Cloudflare（Workers Builds）がビルドしてデプロイします（[決定](docs/decisions/deploy.md)）。Cloudflare の無料プランで動きます。

画面は Workers Static Assets で配信し、reader Worker が `/api` を Service binding で Sendo（Worker 名 `sendo`）に中継します。Sendo を、同じアカウントに先にデプロイしておいてください（[Sendo の README](https://github.com/sendo-feed/sendo#デプロイ)）。

### 初めてのデプロイ

1. GitHub で `sendo-feed/sendo-reader` を、自分のアカウントに fork する
2. Cloudflare の画面で、Workers & Pages →「作成」→「リポジトリをインポート」を選び、fork を選ぶ。Cloudflare の GitHub App の「Repository access」に、この fork を入れる
   - Sendo の fork だけを入れていたら、GitHub の Settings → Applications → Cloudflare Workers and Pages で足す。入れ忘れると、画面から始めたビルドは動くのに、push してもビルドが始まらない
3. 次のように入れてデプロイする

   | 項目 | 値 |
   |---|---|
   | Worker の名前 | `sendo-reader`（変えない。`wrangler.jsonc` の `name` と違うとビルドが失敗し、Sendo の `READER_URL` やリダイレクト URI も、この名前の URL を前提にしている） |
   | ビルドのコマンド | 空のまま |
   | デプロイのコマンド | `pnpm run deploy`（`run` を付ける。`pnpm deploy` は pnpm 自身のコマンド） |
   | ルート ディレクトリ | 空のまま、または `/`（`apps/web` にしない） |

4. Worker の「設定」→「ビルド」で、「プレビュービルドの有効化」をオフにする（main 以外のブランチのビルドを止める）。リポジトリの一番上には wrangler の設定がないので、既定のコマンドでは失敗する
5. `https://sendo-reader.<自分のサブドメイン>.workers.dev` を開き、Google でログインする
   - Sendo の Google の OAuth クライアントの「承認済みのリダイレクト URI」に、`https://sendo-reader.<自分のサブドメイン>.workers.dev/api/v1/auth/google/callback` を入れておく（[Sendo の README](https://github.com/sendo-feed/sendo#ブラウザでログインするgoogle)）

### 更新する

Sendo を先に更新してから、GitHub の reader の fork の画面で「Sync fork」→「Update branch」を押します。上流の変更が fork の `main` に入り、その push でデプロイされます。

reader は Sendo の API の型に合わせて作っているので、新しい reader を古い Sendo につなぐと、まだない API を呼ぶことがあります。

### 手元からデプロイする

Workers Builds を使わずに、手元からもデプロイできます。

```sh
pnpm --filter @sendo-reader/web exec wrangler login   # 最初に 1 回
pnpm run deploy
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
