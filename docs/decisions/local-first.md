# ローカルファースト

- 状態：提案中
- 関連：[UI とツール](ui.md)、sendo の[差分同期](https://github.com/sendo-feed/sendo/blob/main/docs/decisions/sync.md)・[ユーザーと認証](https://github.com/sendo-feed/sendo/blob/main/docs/decisions/accounts.md)、[技術構成](https://github.com/sendo-feed/sendo/blob/main/docs/tech-deck.md)（方針 03・06）

## 決定

1. **最初からローカルファーストで作る。** 画面はネットワークを待たない。読み書きは手元の SQLite に対して行い、sendo とは同期で揃える。
2. **同期とローカル DB のロジックは、すべて `packages/core` に置く。** core は UI のフレームワークにも `apps/` にも依存しない。SQLite には core の DB の窓口（インターフェース）越しに触れ、Web の実装（下の Wasm）と、ネイティブの実装（Capacitor で包むとき）を差し替えられるようにする。スキーマとマイグレーションは SQL で書き、どのプラットフォームでも同じにする。
3. **同期は sendo の[差分同期](https://github.com/sendo-feed/sendo/blob/main/docs/decisions/sync.md)に従う。** 決まりはそちらが正で、ここには書き写さない。reader の側では、特に次を守る。
   - カーソルの中身は解釈せず、受け取ったものをそのまま送り返す
   - 差分は `GET /api/v1/sync` の 1 回のリクエスト（続きがあれば続けて）で取る
   - 消した印を受けたら、手元からも消す。購読をやめたフィードの記事は、スターを付けたもの以外を手元から消す
   - 手元に置くのは、最初の同期で届く範囲（未読、スター、直近 30 日）とその後の差分だけ。それより古い記事は、ネットワークがあるときに通常の API で読み、手元には置かない
   - 操作（既読、スター、購読、フォルダなど）は手元にすぐ反映して操作キューに積み、通常の REST API で送る。同期で届いた行には、まだ送り終えていない操作を重ねて画面に出す。ぶつかったら、サーバーが後から受けたほうを採る
   - 「すべて既読」の境界は、同期済みの範囲（カーソル）にする。手元に届いていない記事を、見ないまま既読にしない
4. **Web の SQLite は、公式の `@sqlite.org/sqlite-wasm` と `opfs-sahpool` の VFS にする。** 専用のワーカー（Dedicated Worker）の中で動かし、データは OPFS に置く。COOP ／ COEP のヘッダーは要らないので付けない。
5. **どのタブでも使えるようにする。** タブごとにワーカーを持ち、Web Locks で代表のタブを 1 つ決める。
   - 代表のタブのワーカーだけが DB を開き、同期と操作キューの送信を回す
   - ほかのタブのワーカーは、読み書きを BroadcastChannel で代表に頼む（SQLite の wasm は読み込まない）
   - 代表が書き込んだら、変わった表をすべてのタブに知らせ、各タブは画面に出している読み出しをやり直す
   - 代表のタブが閉じたら、待っていたタブが代表を引き継ぎ、DB を開き直す。引き継ぎの間に頼んだ読み書きは、新しい代表にやり直す（操作は冪等にしておく）
6. **最初のログインは、アクセストークンを貼る形にする。** sendo で `pnpm token:create --email <メール>` で発行した `sendo_…` のトークンを最初の画面に貼り、手元の DB に置く。代表のワーカーが `Authorization: Bearer` に付けて送る。sendo に OpenID Connect とセッションができたら、ブラウザはセッションのクッキーに切り替え、手元のトークンは消す（sendo の[ユーザーと認証](https://github.com/sendo-feed/sendo/blob/main/docs/decisions/accounts.md)）。

### トークンをブラウザに置く間の危険と対策

トークンは、ページの JS から読める場所（OPFS の DB）に置く。XSS などでページに他人の JS が入ると、トークンを盗まれ、取り消すまで API を使われる（アプリ用パスワードとして、Reeder などからも使える）。手元の記事や購読のデータも読まれる。そこで、次の対策を取る。

- **CSP を厳しくする。** reader Worker と Vite の dev サーバーで、すべての応答に付ける。
  - `default-src 'none'`、`script-src 'self' 'wasm-unsafe-eval'`（wasm のため）、`worker-src 'self'`、`connect-src 'self'`、`img-src 'self' data:`、`style-src 'self'`、`manifest-src 'self'`、`base-uri 'none'`、`form-action 'none'`、`frame-ancestors 'none'`、`object-src 'none'`
  - インラインのスクリプトと `eval` を許さない。ほかのオリジンへの通信を許さないので、盗んだトークンを `fetch` で外に送れない
  - 記事の画像を出すときなど、緩める必要が出たら、そのときに範囲を決めてこのファイルを直す
- **Trusted Types を強制する**（`require-trusted-types-for 'script'`）。許すポリシーは、Svelte が作るもの（`svelte-trusted-html`）と、ワーカーの URL を自分のオリジンに限るものだけにする。対応していないブラウザでは効かないので、ほかの対策と重ねる。
- **記事のデータを HTML として出さない。** `{@html}` を使わず、URL は http ／ https を確かめてから `href` に入れる（[UI とツール](ui.md)の守る規約）。
- **トークンを外に出さない。** ログ、エラーの表示、URL、Service Worker のキャッシュに入れない。
- **サインアウトで消す。** サインアウトしたら、トークンと手元の DB をまとめて消す。

## 理由

- **ローカルファースト**：最優先は「サクサク動く」こと。画面の操作が手元の DB だけで終われば、通信の遅さや切断に左右されない。iOS ではバックグラウンドで同期できないので、起動したときの 1 回の同期の速さが体感を決める（技術構成）。
- **core に閉じ込める**：Capacitor で包むときや、UI を替えるときに、同期とデータの作りをそのまま使える。テストも画面なしで書ける。
- **公式の sqlite-wasm**：SQLite の開発元が保守していて、SQLite の版と一緒に出る。Node でもそのまま動くので、core のテストに本番と同じエンジンを使える。
- **opfs-sahpool**：OPFS の VFS の中でいちばん速く、COOP ／ COEP が要らない。COEP を付けると、ほかのオリジンの画像（記事の画像、フィードのアイコン）は、相手が CORP のヘッダーを返さない限り読めなくなる。`credentialless` なら避けられるが、Safari が対応していない。
- **代表のタブ**：opfs-sahpool で同じ DB を開けるのは同時に 1 か所だけ。同期と操作キューの送信も 1 か所で回さないと、同じ操作を二重に送る。ワーカーごと引き継げば、どのタブが閉じても使い続けられる。
- **トークンを貼る形**：sendo の OpenID Connect ができる前から、reader を作って試せる。

## 検討した代替案

- **wa-sqlite（`@journeyapps/wa-sqlite`）と OPFSCoopSyncVFS**：複数のタブから同時に DB を開け、JS も小さい（gzip 後 約 31KB、公式は約 67KB）。ただし本家は npm に 2024 年 1 月から出ておらず、使えるのは PowerSync 社の fork で、wasm に使わない PowerSync の拡張が入っていて大きい（約 518KB、公式は約 406KB）。同期を 1 か所で回すための代表のタブは、どちらにしても要る。
- **公式の `opfs` の VFS**：複数のつなぎを持てるが、SharedArrayBuffer のために COOP ／ COEP が要る（上の画像の問題）。
- **SQLite を使わず IndexedDB に置く**：wasm が要らず軽いが、ネイティブと同じスキーマにできず、未読の数や絞り込みのクエリを自前で書くことになる。
- **SharedWorker で DB を持つ**：タブの間の受け渡しが要らないが、OPFS の同期アクセス（`createSyncAccessHandle`）は Dedicated Worker でしか使えない。
- **使えるのは 1 つのタブだけにする**：作りは小さいが、2 つめのタブで読めないのは不便なので、最初からどのタブでも使えるようにした。
- **トークンを reader Worker の HttpOnly のクッキーに置く**：貼ったトークンを reader Worker がクッキーにし、`/api` の中継で `Authorization` に付け替えれば、JS から読めなくなる。ただし CSRF の対策と、手元の Vite の proxy にも同じ付け替えが要る。sendo のセッション（HttpOnly のクッキー）ができるまでのつなぎなので、CSP を厳しくすることで済ませた。
- **トークンを手元に保存しない（毎回貼る）**：盗まれる時間は短くなるが、開くたびに貼るのは使えない。

## 見直す条件

- sendo に OpenID Connect とセッションができたとき。トークンを手元に置くのをやめ、この節を書き換える。
- 手元のデータが増え、opfs-sahpool の容量や速さで困ったとき。
- Capacitor で包むとき。ネイティブの SQLite に替えるか、WebView の中で Wasm を使い続けるかを決める。
- タブの引き継ぎで、操作が失われたり二重になったりすると分かったとき。
