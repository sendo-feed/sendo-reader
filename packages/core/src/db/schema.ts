import type { Database } from "./database";

/**
 * 手元の DB のスキーマ。どのプラットフォームでも同じ SQL を使う（docs/decisions/local-first.md）。
 *
 * マイグレーションは足すだけにし、出したものは書き換えない（手元の DB はユーザーの端末にあり、
 * 作り直せない）。版は PRAGMA user_version に持つ。時刻はミリ秒の整数。
 *
 * 手元に置くのは sendo の同期で届く行だけ（docs/decisions/sync.md）。sendo の表とは次のように
 * 対応する。
 * - folders：ユーザーのフォルダ
 * - feeds：ユーザーが購読しているフィード（id は REST API の /feeds/{id} の id）
 * - articles：ユーザーの受信箱の記事（記事の本体と、既読・スター）
 */
const migrations: readonly (readonly string[])[] = [
  [
    `create table settings (
      key text primary key,
      value text not null
    ) strict`,
    `create table folders (
      id text primary key,
      name text not null,
      created_at integer not null
    ) strict`,
    `create table feeds (
      id text primary key,
      url text not null,
      title text,
      site_url text,
      folder_id text,
      created_at integer not null
    ) strict`,
    "create index feeds_folder_id_idx on feeds (folder_id)",
    `create table articles (
      id text primary key,
      feed_id text not null,
      url text,
      title text,
      summary text,
      author text,
      published_at integer not null,
      received_at integer not null,
      read_at integer,
      starred_at integer
    ) strict`,
    // 一覧（新しい順）と、フィードごとの一覧
    "create index articles_published_idx on articles (published_at, id)",
    "create index articles_feed_published_idx on articles (feed_id, published_at, id)",
    // 未読の数はその都度数える。未読の行だけを載せる
    "create index articles_unread_idx on articles (feed_id) where read_at is null",
    "create index articles_starred_idx on articles (starred_at) where starred_at is not null",
    // 手元から古い既読の記事を消すとき（sync/pull.ts）
    "create index articles_received_idx on articles (received_at)",
  ],
  [
    // 操作キュー（sync/queue.ts）。手元にすぐ反映した操作を、ここに積んで順に sendo へ送る
    `create table pending_ops (
      id integer primary key autoincrement,
      kind text not null,
      key text not null,
      payload text not null,
      rev integer not null default 0,
      created_at integer not null,
      attempts integer not null default 0,
      last_error text
    ) strict`,
  ],
];

export const SCHEMA_VERSION = migrations.length;

export class NewerSchemaError extends Error {
  constructor(readonly found: number) {
    super(`手元の DB の版（${found}）が、このアプリの版（${SCHEMA_VERSION}）より新しい`);
    this.name = "NewerSchemaError";
  }
}

/** まだ当てていないマイグレーションを、1 版ずつトランザクションで当てる */
export async function migrate(db: Database): Promise<void> {
  const [row] = await db.all<{ user_version: number }>("pragma user_version");
  const current = row?.user_version ?? 0;
  if (current > SCHEMA_VERSION) throw new NewerSchemaError(current);

  for (let version = current; version < SCHEMA_VERSION; version++) {
    const statements = migrations[version] ?? [];
    await db.transaction(async (tx) => {
      for (const sql of statements) await tx.run(sql);
      await tx.run(`pragma user_version = ${version + 1}`);
    });
  }
}
