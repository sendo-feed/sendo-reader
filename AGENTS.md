# sendo-reader

Sendo の公式リーダー。`packages/core`（同期エンジン）と `apps/web`・`apps/mobile` のモノレポ。API の型は sendo の OpenAPI から生成する。

このファイルは AI エージェント（Claude Code、Codex など）共通の指示。開発は主に Claude Code で行い、Codex はおもにレビューに使う。

## 最初に読むもの

- `docs/decisions/`：このリポジトリの今の決定。ほかの文書と食い違ったら、こちらが正しい
- プロダクト全体の目的・進め方・技術構成は sendo リポジトリにある：
  - https://github.com/sendo-feed/sendo/tree/main/docs/decisions
  - https://github.com/sendo-feed/sendo/blob/main/docs/inception-deck.md
  - https://github.com/sendo-feed/sendo/blob/main/docs/tech-deck.md

## 言語

- 文書、コミットメッセージ、PR、レビューコメントは日本語で書く（一般に公開したら英語に切り替える）
- 識別子は英語

## コミットメッセージ

Conventional Commits を土台にする。全文は https://github.com/sendo-feed/.github/blob/main/CONTRIBUTING.md

- 形式：`<type>(<scope>): <件名>`。type は feat ／ fix ／ docs ／ decision ／ refactor ／ perf ／ test ／ build ／ ci ／ chore ／ revert
- 本文には「なぜ」を書く
- `docs/decisions/` を変えるときは `decision(<テーマ>): …` にし、本文に何をなぜ変えたかを書く。ほかの変更とは分けて単独の PR にする（スカッシュマージで PR が1つのコミットになるため）
- `main` に force push しない

## 決定の扱い

- 決定は `docs/decisions/<テーマ>.md` にテーマごとに置き、今の決定だけを書く。決定が変わったらファイルを書き換え、古い内容は残さない
- 経緯を聞かれたら `git log -p -- docs/decisions/<テーマ>.md` を読んで答える

## 守る規約

- 同期とローカル DB のロジックはすべて `packages/core` に入れる。`packages/core` は UI のフレームワークに依存しない
- 画面はネットワークを待たない。読み書きはローカル DB に対して行い、サーバーとは同期で揃える
- OpenAPI から生成したファイルは手で直さない。sendo の OpenAPI を直して生成し直す
- 記事の本文は信頼できないデータとして扱い、表示する前に HTML をサニタイズする

## 変更の進め方

- すべての変更は下書きの PR で出す。`main` へは直接 push できない
- 下書きの PR には Codex のレビューを回し、終了の条件を満たすまで直す。Claude Code では `/review-loop` スキルがこれを回す
- 終了の条件、優先度の定義、指摘の扱いの全文は CONTRIBUTING.md の「レビューの進め方」にある

## Review guidelines

指摘には、必ず次の優先度のどれかを付ける。終了の条件はこの優先度で判定するので、ぶれないようにする。

| 優先度 | 意味 |
|---|---|
| P0 | データの消失や破損、セキュリティの穴、本番が動かなくなる |
| P1 | 明らかなバグ、`docs/decisions/` との食い違い、下の観点で挙げた規約の破れ |
| P2 | 直すべきだが今すぐでなくてよい（境界条件、テスト不足など） |
| P3 | 軽微なことや好み |

レビューは日本語で書く。いまは2人で試作を繰り返している段階なので、捨てる前提の試作の完成度や、書き方の好みは指摘しなくてよい（整形と lint は Biome に任せる）。次の観点を優先する。

1. **決定との食い違い**：`docs/decisions/` や sendo 側の決定と食い違う変更がないか
2. **core と画面の境界**：`packages/core` が UI のフレームワークや `apps/` に依存していないか。同期やデータのロジックが `apps/` に漏れていないか
3. **ローカルファースト**：画面の操作がネットワークの応答を待っていないか。オフラインで操作したときに、操作キューと楽観的更新で正しく戻せるか
4. **速さの予算**：JS が gzip 後 100KB を超えそうな依存の追加や、操作の反応が 100ms を超えそうな処理がないか
5. **セキュリティ**：記事本文の HTML のサニタイズ漏れ（XSS）、トークンの保存場所、ログへの秘密情報の出力
6. **生成物**：OpenAPI から生成したファイルを手で直していないか
7. **テスト**：振る舞いを変える変更に、それを確かめるテストがあるか
8. **PR の書き方**：タイトルがコミットメッセージの形式か。説明に「なぜ」が書かれているか
