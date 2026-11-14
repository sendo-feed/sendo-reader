/**
 * 差分同期（GET /api/v1/sync）の応答の形。
 *
 * sendo の差分同期の決定（docs/decisions/sync.md）に沿った「仮の形」。sendo の OpenAPI に
 * /sync が入ったら、ここは生成した型（schema.gen.ts）に置き換え、この形との違いを直す。
 * 仮の形を使うのはこのファイルと api/client.ts の sync() だけにして、置き換えを小さくする。
 *
 * - カーソルの中身は解釈しない。受け取ったものをそのまま次に送る
 * - カーソルなしで呼ぶと、最初の同期（未読、スター、直近 30 日に受信箱に入った記事）
 * - hasMore が true なら、返ってきたカーソルですぐ続きを取る
 * - 消したフォルダと購読は deletedAt の付いた行で届く
 * - カーソルが古すぎて差分を出せないときは 410 と error.code = "cursor_expired"。最初から同期し直す
 */

export interface SyncResponse {
  cursor: string;
  hasMore: boolean;
  folders: SyncFolder[];
  feeds: SyncFeed[];
  articles: SyncArticle[];
}

export interface SyncFolder {
  id: string;
  name: string;
  createdAt: string;
  /** 消したなら、その時刻 */
  deletedAt: string | null;
}

/** 購読しているフィード。id は REST API の /feeds/{id} と同じ */
export interface SyncFeed {
  id: string;
  url: string;
  title: string | null;
  siteUrl: string | null;
  folderId: string | null;
  createdAt: string;
  /** 購読をやめたなら、その時刻 */
  deletedAt: string | null;
}

/** 受信箱の記事。記事の本体と、既読・スター */
export interface SyncArticle {
  id: string;
  feedId: string;
  /** http ／ https の URL だけ */
  url: string | null;
  /** プレーンテキスト */
  title: string | null;
  /** プレーンテキスト */
  summary: string | null;
  author: string | null;
  publishedAt: string;
  /** 受信箱に入った時刻 */
  receivedAt: string;
  readAt: string | null;
  starredAt: string | null;
}
