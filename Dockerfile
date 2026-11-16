# コンテナ版の reader のイメージ（docs/decisions/container.md）。上流の CI が作って GHCR
# （ghcr.io/sendo-feed/sendo-reader）に置き、使う人は sendo の compose.yaml で sendo と並べて動かす。
# 手元で作るときは docker build -t sendo-reader .
#
# 土台のイメージは、sendo と同じものをダイジェストで固定する（Dependabot が上げる）。Node のメジャーは
# .node-version と揃える

# 画面（vite build）とサーバー（esbuild でひとつのファイルにまとめる）を作る。できるのは JS と wasm で
# CPU に依らないので、ビルドするマシンの CPU で 1 回だけ作る（arm64 をエミュレーションで作ると遅いため）
FROM --platform=$BUILDPLATFORM node:24-bookworm-slim@sha256:dc26ae92c9fb15cf6b1d63e20f0944b2efe0f115b20e00be48fb23fceb061c54 AS build
# pnpm は package.json の packageManager の版を、corepack で入れる
ENV COREPACK_ENABLE_DOWNLOAD_PROMPT=0
RUN corepack enable
WORKDIR /app
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
COPY packages/core/package.json packages/core/
COPY apps/web/package.json apps/web/
# インストール時のスクリプト（wrangler types など）は、ビルドには要らないので動かさない
RUN pnpm install --frozen-lockfile --ignore-scripts
COPY tsconfig.base.json ./
COPY packages/core packages/core
COPY apps/web apps/web
# 設定の画面に出す版の印（vite.config.ts の appVersion）。CI がコミットを渡す
ARG APP_COMMIT_SHA=unknown
RUN APP_COMMIT_SHA="$APP_COMMIT_SHA" pnpm --filter @sendo-reader/web exec vite build \
  && pnpm --filter @sendo-reader/web run build:server

# 動かすイメージ。画面のビルドと、依存まで含めたサーバーのバンドルだけを入れる（node_modules は要らない）
FROM node:24-bookworm-slim@sha256:dc26ae92c9fb15cf6b1d63e20f0944b2efe0f115b20e00be48fb23fceb061c54 AS runtime
ENV NODE_ENV=production \
    PORT=8080
WORKDIR /app
COPY --from=build /app/apps/web/dist ./dist
COPY --from=build /app/apps/web/dist-server ./dist-server
USER node
EXPOSE 8080
# reader 自身が返す / を見る。/healthz は sendo に中継するので、見ると sendo の生死になる
# （docs/decisions/container.md の 6）
HEALTHCHECK --interval=30s --timeout=5s --start-period=10s \
  CMD ["node", "-e", "fetch(`http://127.0.0.1:${process.env.PORT}/`).then((r) => process.exit(r.ok ? 0 : 1), () => process.exit(1))"]
CMD ["node", "--enable-source-maps", "dist-server/server.mjs"]
