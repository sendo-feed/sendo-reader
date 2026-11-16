# UI とツール

- 状態：提案中
- 関連：[ローカルファースト](local-first.md)、[速さの予算](performance.md)、sendo の[テックスタック](https://github.com/sendo-feed/sendo/blob/main/docs/decisions/tech-stack.md)、[技術構成](https://github.com/sendo-feed/sendo/blob/main/docs/tech-deck.md)（4・7・8 の未決事項 1・6）

## 決定

1. **UI は Svelte 5 ＋ Vite で作る。** SvelteKit は使わず、SPA にする。画面の切り替えは、History API を使う小さな自前のルーターで行う。
2. **Void（Cloudflare）は使わない。**
3. **ネイティブは、あとで Capacitor で包む。** `apps/web` のビルドをそのまま包み、`apps/mobile` に置く。
4. **配信は Workers Static Assets。** reader Worker（`apps/web/worker/`）が静的なファイルを返し、`/api` は Service binding で sendo（Worker 名 `sendo`）に中継する。ブラウザからは同じオリジンに見えるので、CORS は要らない。手元では、Vite の dev サーバーの proxy で `/api` を `http://localhost:8787` に中継する。
5. **PWA にする。** Service Worker で、アプリの外枠と SQLite の wasm をキャッシュし、ネットワークがなくても起動できるようにする（vite-plugin-pwa）。
   - **新しい版には、利用者が何もしなくても切り替わる。** 画面が前に出たときと、開いたままなら 1 時間ごとに、新しい版があるかを確かめる。新しい版は、裏で取り込んですぐ使い始める
   - 開いている画面は、読み込んだときの版のまま動くので、新しい版に替わったら読み込み直す。読み込み直すのは、画面が裏にある間か、次に前に出たときだけ。読んでいる最中には、読み込み直さない
   - 読み込み直すと消えるものを出している画面（設定の画面の、発行したばかりのアクセストークン。OAuth の許可の画面）では読み込み直さず、ほかの画面に移ってから切り替える
   - 初めて入れたときは、読み込み直さない（版の切り替えではない）
6. **開発ツールは sendo と揃える。** pnpm（ワークスペース）、Biome、Vitest。画面を通したテストは Playwright。ただし TypeScript は 6 系にする（理由は下）。

### lint と整形

- Biome で、`.svelte` のテンプレートまで lint と整形をする（`html.experimentalFullSupportEnabled`）。Svelte 用のルール（`domains.svelte`）も有効にする。
- 型チェックは、`.ts` は `tsc`、`.svelte` は svelte-check で行う。

### 守る規約

- `packages/core` は、UI のフレームワーク（`svelte`）と `apps/` を import しない。Biome の `noRestrictedImports` で検査する。
- 記事のデータ（タイトル、要約など）を `{@html}` で出さない。Biome の `noSvelteAtHtmlTags` で検査する。本文の HTML を表示するときは、サニタイズしてから専用の部品で出す（そのときに決める）。
- 記事やフィードの URL は、http ／ https であることを確かめてから `href` に入れる。

## 理由

- **Svelte 5**：コンパイラが画面ごとに必要なコードだけを出すので、JS が小さく、速い（[速さの予算](performance.md)）。ネイティブは Capacitor（WebView）で包むので、React Native とコードを共有する利点はない。
- **SvelteKit を使わない**：サーバー側の仕組み（SSR、API のルート）は sendo がすでに持っている。SPA として書き出すと使わない機能が多く、ランタイムの分だけ JS が増える。画面の数は多くないので、ルーターは自前で足りる。
- **Void を使わない**：Void の強みはフルスタックの仕組みで、sendo がすでに持っている。UI のアダプタは React と Vue で、Svelte では使えない。公開（2026 年 10 月）から日も浅い。
- **Capacitor**：Web のビルドをそのまま包めて、画面を作り直さずに済む。バックグラウンドの更新、共有の拡張、APNs など、ネイティブの機能はプラグインで足せる。
- **新しい版に自分で切り替わる**：ホーム画面に置いた PWA には、読み込み直す操作がない。ほかのアプリから戻っても読み込み直さないので、新しい版を確かめる機会がなく、古い版のまま動き続ける。各自が fork してデプロイする sendo と版がずれたままになるのも避けたい。読んでいる最中に画面が変わると困るので、切り替えるのは、画面が裏にある間か、戻ってきたときにする。手元の操作は、読み込み直しても手元の DB と操作キューに残る（一覧の位置は、先頭に戻る）。
- **Biome**：sendo と同じ道具で揃えられる。Biome 2.6.4 で試したところ、テンプレートまで読む設定で、ルーン（`$state`、`$props` など）、`{#each}`、`{#snippet}`、`bind:`、`class:` などを誤検出なく lint・整形でき、`{@html}` も検出できた。分かっている弱点は、`generics="…"` の中に `{` を書くと解析に失敗することと、そこでだけ使う型の import が未使用と出ること。使うときは、型に名前を付けてから使う。
- **TypeScript 6**：svelte-check が TypeScript 5・6 にしか対応しておらず、sendo の TypeScript 7 では `.svelte` の型チェックができない。リポジトリの中で版を分けるとエディタの動きが揃わないので、全体を 6 系にする。

## 検討した代替案

- **React（＋ Void）**：Void のアダプタが使え、人も部品も多い。ただし JS が大きくなり、ネイティブを Capacitor で包むなら React Native との共有の利点もない（技術構成の未決事項 1・6）。
- **SvelteKit の SPA モード**：ファイルでのルーティングやデータの読み込みの仕組みが使えるが、上の理由で見送った。
- **Expo（React Native）**：ネイティブの描画で速いが、画面を Web と別に作ることになる（未決事項 2）。
- **「新しい版があります」と出して、利用者が押して切り替える**：切り替わる時を自分で選べるが、押さない人は古い版のまま残る。表示の場所と、消したあとの扱いも要る。
- **Vite+（Oxlint・Oxfmt）**：sendo が「reader を作り始めるときに決め直す」としていたもの。Oxlint 1.90 は `.svelte` の `<script>` の中しか読まず（テンプレートで使う変数が分からず、`{@html}` も検出できない）、Oxfmt 0.75 は `.svelte` を整形しなかった。
- **ESLint ＋ Prettier（eslint-plugin-svelte、prettier-plugin-svelte）**：Svelte への対応はいちばん成熟しているが、道具が 2 つになり、sendo と揃わない。
- **TypeScript 7 と 6 を混ぜる**（`packages/core` は 7、`apps/web` は 6）：core の型チェックは速くなるが、エディタや CI で版が揃わず迷う。

## 見直す条件

- Biome の Svelte 対応（実験的な扱い）で困ったとき。ESLint ＋ Prettier に替えるかを比べる。
- svelte-check（または後継）が TypeScript 7 に対応したとき。sendo と揃える。
- Oxfmt が `.svelte` を整形でき、Oxlint がテンプレートを読めるようになったとき。sendo と一緒に Vite+ に寄せるかを決め直す。
- Capacitor で足りないネイティブの機能が出たとき。
