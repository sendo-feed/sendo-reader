# 決定の一覧

sendo-reader で決めたことを、テーマごとに1ファイルで置く。各ファイルには今の決定だけを書き、経緯は git の履歴で追う。残し方は [documentation.md](documentation.md) を参照。

サーバーとの約束ごと（認証、差分同期など）は、sendo の決定が正。[sendo の決定の一覧](https://github.com/sendo-feed/sendo/blob/main/docs/decisions/README.md)も読む。

| テーマ | 状態 | 概要 |
|---|---|---|
| [決定の残し方](documentation.md) | 提案中 | sendo と同じ。テーマごとに1ファイルを書き換え、履歴は git が持つ |

経緯を知りたいとき：

```sh
git log -p -- docs/decisions/<テーマ>.md
```
