# デプロイ

- 状態：提案中
- 関連：sendo の[デプロイ](https://github.com/sendo-feed/sendo/blob/main/docs/decisions/deploy.md)、[UI とツール](ui.md)（4。配信と `/api` の中継）、[コンテナ版](container.md)

ここでは Cloudflare 版を決める。コンテナ版の sendo と組むときの配り方は、[コンテナ版](container.md)で決める。

Cloudflare 版の sendo-reader も、使う人がそれぞれ自分の Cloudflare アカウントにデプロイする。sendo と同じアカウントに置き、`/api` を Service binding で sendo に中継する（[UI とツール](ui.md)の 4）。デプロイの形は sendo にそろえ、ここには reader だけの違いを決める。2026-11-16 に、fork と Workers Builds で実際にデプロイし、ブラウザでログインして確かめた。

## 決定

1. **sendo と同じく、各自が GitHub で fork し、Cloudflare の Workers Builds でつなぐ。** fork の `main` に push すると、Cloudflare がビルドしてデプロイする。
   - 上流の更新は、GitHub の「Sync fork」で取り込む。取り込んだ push で、そのままデプロイされる。自動で取り込むなら、sendo の 7 の sendo-updater が reader の fork も受け持つ
   - Cloudflare の GitHub App の「Repository access」に、reader の fork も入れる。入れていないと、push でビルドが始まらない
   - 手元からも `pnpm run deploy` でデプロイできる
2. **Worker の名前は `sendo-reader` のままにする。**
   - `wrangler.jsonc` の `name` と違うと、ビルドが失敗する
   - sendo の `READER_URL` と、Google の OAuth クライアントのリダイレクト URI は、この名前の `workers.dev` の URL を前提にしている（sendo の README）
3. **sendo を先にデプロイする。更新も、sendo、reader の順に取り込む。**
   - Service binding は、同じアカウントの `sendo` という名前の Worker を指す
   - reader は、sendo の OpenAPI から作った型で API を呼ぶ。新しい reader が古い sendo を呼ぶと、足した API や項目がまだないことがある
   - sendo-updater（sendo の 7）は、sendo の fork が上流に追いつき、sendo の `main` の先頭で Workers Builds のチェックが成功してから、reader を取り込む。手で取り込むときは、sendo のデプロイを確かめてから reader の「Sync fork」を押す
4. **Workers Builds の「ルート ディレクトリ」は、リポジトリの一番上（`/`）のままにする。デプロイの手順は一番上の `package.json` の `deploy` に書き、画面のデプロイのコマンドは `pnpm run deploy` にする。**
   - 一番上の `deploy` は、`apps/web` の `deploy`（`vite build && wrangler deploy`）を呼ぶ
   - 画面のビルドのコマンドは空にする。ビルドは `deploy` の中で行う
5. **main 以外のブランチのビルドは、オフにする。**
6. **`apps/web/wrangler.jsonc` に `workers_dev: true` と `preview_urls: false` を書く。** sendo の 6 と同じ。

## 理由

- **sendo と同じ形にする**
  - sendo が fork と Workers Builds を選んだ理由は、reader にもそのまま当てはまる。GitHub App はリポジトリを持つアカウントにしか入れられず、上流を直接つなげない。fork なら「Sync fork」1 つで更新がデプロイになり、各自が API トークンを作る必要もない（sendo の[デプロイ](https://github.com/sendo-feed/sendo/blob/main/docs/decisions/deploy.md)の「理由」）
  - 2 つが同じ手順なら、使う人は sendo と reader を同じやり方で扱える
  - reader は、同じアカウントの sendo を名前で呼ぶ。各自が自分のアカウントに 2 つの fork をつなぐ形なら、何も足さずに満たせる
- **自動の取り込みも sendo にそろえる**。sendo-updater が sendo のデプロイ成功を待って reader を取り込むため、reader が先に配備されて新しい API を呼ぶ事態を防げる。
- **ルート ディレクトリを一番上にする**
  - Workers Builds は、Node のバージョンを、ルート ディレクトリに置いた `.node-version` から読む（Cloudflare の文書）。`apps/web` にすると、一番上の `.node-version`（24）が読まれないおそれがある。ロックファイルを親のフォルダまでたどるかも、文書には書かれていない
  - 一番上なら、`pnpm install --frozen-lockfile` がワークスペースの全体を入れる。試したとき、`.node-version` と `packageManager` を読んで Node 24.22.3 と pnpm 11.28.10 で動き、`minimumReleaseAge` と `allowBuilds` も手元と同じに効いた
- **手順を一番上の `package.json` に書く**：画面に書いた手順は、上流からは直せない。画面には `pnpm run deploy` とだけ書いておけば、手順を変えても、取り込みで各自に届く（sendo の 2 と同じ）。画面のコマンドも sendo とそろう。
- **main 以外のブランチのビルドをオフにする**
  - main 以外のブランチのビルドは、既定では一番上で `npx wrangler versions upload` を動かす。一番上には wrangler の設定がないので、失敗する
  - fork で main 以外のブランチを push することは、ほとんどない
- **`workers_dev` と `preview_urls` を書く**：sendo の 6 と同じ理由。プレビューの URL がオンだと、main 以外のブランチの版を、本番の sendo への中継につながったまま外から開けてしまう。書かないと、デプロイのたびに画面の設定との違いを警告され、既定のオンで上書きされる。

## 検討した代替案

- **ルート ディレクトリを `apps/web` にする**：wrangler の設定がある場所なので、一番上に `deploy` を置かずに済む。ただ、上の理由で、Node のバージョンや依存の入れ方が一番上と変わるおそれがある。試してはいない。
- **画面のデプロイのコマンドに `pnpm --filter @sendo-reader/web run deploy` を直接書く**：一番上の `deploy` が要らない。ただ、手順を変えたときに、各自が画面を直すことになる。
- **main 以外のブランチのビルドのコマンドを、`apps/web` で `wrangler versions upload` を動かすように変える**：ブランチの版を上げても、プレビューの URL がオフなので開けない。使い道がないのに、画面に書く手順が増える。
- **Deploy to Cloudflare のボタン、fork の GitHub Actions**：sendo の代替案と同じ理由でとらない（上流の更新を取り込む道がない、各自が API トークンを置く必要がある）。

## 見直す条件

- sendo のデプロイの決定が変わったとき。こちらもそろえる。
- reader に、人ごとの設定や秘密が要るようになったとき。sendo と同じく、画面の変数（`keep_vars`）とシークレットに置く形で決め直す（sendo の 4・5）。
- `apps/mobile` など、リポジトリから出すものが増えたとき。Workers Builds のビルドを始めるパス（build watch paths）を絞るかを決める。
