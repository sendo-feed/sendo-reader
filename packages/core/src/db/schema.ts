import type { Database } from "./database";

/**
 * 手元の DB のスキーマ。どのプラットフォームでも同じ SQL を使う（docs/decisions/local-first.md）。
 *
 * マイグレーションは足すだけにし、出したものは書き換えない（手元の DB はユーザーの端末にあり、
 * 作り直せない）。版は PRAGMA user_version に持つ。時刻はミリ秒の整数。
 *
 * 同期で届いた行（docs/decisions/sync.md）は、sendo の表と次のように対応する。
 * - folders：ユーザーのフォルダ
 * - feeds：ユーザーが購読しているフィード（id は REST API の /feeds/{id} の id）
 * - articles：ユーザーの受信箱の記事（記事の本体と、既読・スター）
 * - synced_settings：ユーザーが預けた設定の項目（端末の種類ごと）
 *
 * 本文とフィードの取得時刻は、必要になったときに REST API から取って置く。
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
    // 手元から古い既読の記事を消すとき（今は消さないので、マイグレーション 6 で外した）
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
  [
    // 手元の既読・未読が、最後まで同期し終えたカーソル（sync.completeCursor）の時点の sendo と
    // 同じなら 1。sendo のまとめて既読は、カーソルを境界にすると、そのあとに届いた記事や、そのあと
    // 既読・未読を変えた記事を含めないので、0 の記事は ID でも頼む（sync/ops.ts の markRead）
    "alter table articles add column read_synced integer not null default 0",
    // それより前に積んだまとめて既読には、ID で頼む記事（extraIds）がない。手元で既読にした記事を
    // すべて ID でも頼む（カーソルは途中のものかもしれない）
    `update pending_ops
     set payload = json_set(payload, '$.extraIds', json(json_extract(payload, '$.articleIds')))
     where kind = 'markRead' and json_type(payload, '$.extraIds') is null`,
  ],
  [
    // ログインを sendo のセッション（クッキー）に替えた。前の版が置いたアクセストークンを消す
    // （手元の行は、次にログインしたときに、どのユーザーのものか分からないので消す。reader.ts）
    "delete from settings where key = 'auth.token'",
  ],
  [
    // 手元で作ったフォルダの ID を、仮の ID（local- ＋ 小文字の UUID）から UUID だけにした。sendo に
    // その ID のまま作る（sendo の POST /folders は、クライアントが決めた小文字の UUID を受ける）。
    // まだ送っていないフォルダの ID から、local- を外す（フォルダ、フィード、まだ送っていない操作）
    "update folders set id = substr(id, 7) where substr(id, 1, 6) = 'local-'",
    "update feeds set folder_id = substr(folder_id, 7) where substr(folder_id, 1, 6) = 'local-'",
    `update pending_ops set key = substr(key, 7)
     where substr(key, 1, 6) = 'local-'
       and (json_extract(payload, '$.folderId') = key
         or json_extract(payload, '$.scope.folderId') = key)`,
    `update pending_ops
     set payload = json_set(payload, '$.folderId', substr(json_extract(payload, '$.folderId'), 7))
     where substr(json_extract(payload, '$.folderId'), 1, 6) = 'local-'`,
    `update pending_ops
     set payload = json_set(payload, '$.scope.folderId',
       substr(json_extract(payload, '$.scope.folderId'), 7))
     where substr(json_extract(payload, '$.scope.folderId'), 1, 6) = 'local-'`,
  ],
  [
    // 古くなっても手元では記事を消さなくなった（消すのは sendo の消した記録が届いたときだけ。
    // docs/decisions/local-first.md の 3）。古い既読の記事を探して消すための索引は要らない
    "drop index if exists articles_received_idx",
    // 手元の記事が sendo の受信箱と同じだけ（既定 90 日分）たまるので、未読の一覧（新しい順）を
    // 未読の行だけから読む。未読が少ないと、新しい順の索引をほぼすべてたどることになる
    // （記事 81,000 件・未読 10 件で、1 回 13.7ms が 0.09ms になった）
    "create index articles_unread_published_idx on articles (published_at, id) where read_at is null",
  ],
  [
    // sendo が中継する画像の URL（docs/decisions/images.md）。すでに手元にある行は null のまま
    // （sendo は、記事のサムネイルをさかのぼって付けない。フィードのアイコンは、付いたら同期で届く）
    "alter table articles add column thumbnail_url text",
    "alter table feeds add column icon_url text",
  ],
  [
    // sendo に預ける設定（docs/decisions/settings.md）。端末の種類・名前・値（JSON）で置く。
    // 手元だけの値（カーソルなど）を置く settings の表とは別
    `create table synced_settings (
      device_type text not null,
      name text not null,
      value text not null,
      primary key (device_type, name)
    ) strict, without rowid`,
  ],
  [
    // sendo に本文があるか（sendo の docs/decisions/content.md）。すでに手元にある行は 0 のまま
    // （本文のある記事でも、もう一度届くまでは要約を出す。最初から同期し直させない）
    "alter table articles add column has_content integer not null default 0",
    // 記事ごとに取った本文（sendo がサニタイズした HTML を、受け取ったまま置く。出すときに、
    // 通すタグと属性だけの木にする）。記事の表と分けて、一覧の読み出しが本文を読まないようにする
    `create table article_contents (
      article_id text primary key,
      html text not null,
      source text not null,
      fetched_at integer not null
    ) strict`,
    // 本文は、記事と一緒に消す。記事を消す文がいくつあっても（同期の消した記録、最初からの
    // 同期し直し、購読の停止、ログアウト）、消し忘れないよう、トリガーで行う
    `create trigger articles_delete_content after delete on articles
     begin
       delete from article_contents where article_id = old.id;
     end`,
  ],
  // ページから抜いた全文は、フィードの本文を残して別に置く。has_content はフィード本文だけを示す。
  [
    `create table article_page_contents (
      article_id text primary key,
      html text not null,
      source text not null,
      fetched_at integer not null
    ) strict`,
    `create trigger articles_delete_page_content after delete on articles
     begin
       delete from article_page_contents where article_id = old.id;
     end`,
  ],
  [
    // 最近読んだ一覧を、既読にした日時から少しずつ読む。未読は索引に載せない
    "create index articles_read_idx on articles (read_at, id) where read_at is not null",
  ],
  [
    `create table saved_pages (
      id text primary key,
      url text not null,
      title text,
      saved_at integer not null
    ) strict, without rowid`,
    // 保存は、同期で届いた正の行の上に未送信の操作を重ねて読む。断られた操作を消すだけで正に戻る。
    `create index pending_saved_pages_idx on pending_ops (key, id)
       where kind = 'setSavedPage'`,
    `create view visible_saved_pages as
     with latest as (
       select key, max(id) as id from pending_ops where kind = 'setSavedPage' group by key
     )
     select id, url, title, saved_at from saved_pages
       where id not in (select key from latest)
     union all
     select latest.key, json_extract(payload, '$.page.url'), json_extract(payload, '$.page.title'),
       json_extract(payload, '$.page.savedAt')
       from latest join pending_ops on pending_ops.id = latest.id
       where json_type(payload, '$.page') = 'object'`,
  ],
  ["alter table feeds add column display_name text"],
  [
    // 行がなければ未取得。両方 null の行は、時刻の記録がないことを sendo に確認済み。
    `create table feed_fetch_times (
      feed_id text primary key,
      last_fetched_at integer,
      last_successful_fetch_at integer
    ) strict, without rowid`,
    `create trigger feeds_delete_fetch_times after delete on feeds
     begin
       delete from feed_fetch_times where feed_id = old.id;
     end`,
  ],
  [
    // 全文が取れなかった記事（page_content_unavailable。先に取るときも、開いたときも置く）。先読み
    // では取り直さない（docs/decisions/local-first.md の「記事の本文」）。開いたときは、これまで
    // どおり取りにいき、取れたら印を消す
    `create table article_page_misses (
      article_id text primary key,
      missed_at integer not null
    ) strict, without rowid`,
    `create trigger articles_delete_page_miss after delete on articles
     begin
       delete from article_page_misses where article_id = old.id;
     end`,
    // 手元の本文の大きさ（UTF-8 のバイト数）。上限と比べるたびに本文の表を読まないよう、本文の
    // 表とは別の小さな表に、トリガーで写しておく。本文を置く・消すどの文からも、ずれない
    `create table article_content_sizes (
      article_id text not null,
      source text not null,
      bytes integer not null,
      primary key (article_id, source)
    ) strict, without rowid`,
    ...(["feed", "page"] as const).flatMap((source) => {
      const table = source === "page" ? "article_page_contents" : "article_contents";
      // 本文の UPSERT（on conflict do update）の中で動くトリガーでは、外の文の衝突の扱いが
      // 中の文にも当たり、insert or replace が置き換えにならない。消してから入れる
      const put = `delete from article_content_sizes
           where article_id = new.article_id and source = '${source}';
         insert into article_content_sizes (article_id, source, bytes)
           values (new.article_id, '${source}', length(cast(new.html as blob)))`;
      return [
        `create trigger ${table}_size_insert after insert on ${table} begin ${put}; end`,
        `create trigger ${table}_size_update after update on ${table} begin ${put}; end`,
        `create trigger ${table}_size_delete after delete on ${table}
         begin
           delete from article_content_sizes where article_id = old.article_id and source = '${source}';
         end`,
        `insert into article_content_sizes (article_id, source, bytes)
         select article_id, '${source}', length(cast(html as blob)) from ${table}`,
      ];
    }),
  ],
  [
    // 開いているフィードから先に取る記事を選ぶとき（db/content.ts）、記事の多い
    // フィードでも、そのフィードの記事をすべてたどらずに、未読と、既読の新しい順を読む
    "create index articles_feed_unread_published_idx on articles (feed_id, published_at, id) where read_at is null",
    "create index articles_feed_read_idx on articles (feed_id, read_at) where read_at is not null",
  ],
  [
    // sendo の翻訳（docs/decisions/translation.md）。状態が null なら翻訳なし。すでに手元にある行は
    // null のまま（もう一度届くまでラベルを出さない。最初から同期し直させない）
    "alter table articles add column translation_status text",
    "alter table articles add column translation_language text",
    "alter table articles add column translation_title text",
    "alter table articles add column translation_summary text",
    "alter table articles add column translated_at integer",
  ],
];

export const SCHEMA_VERSION = migrations.length;

export class NewerSchemaError extends Error {
  constructor(readonly found: number) {
    super(`手元の DB の版（${found}）が、このアプリの版（${SCHEMA_VERSION}）より新しい`);
    this.name = "NewerSchemaError";
  }
}

/**
 * まだ当てていないマイグレーションを、1 版ずつトランザクションで当てる。
 * target はテストで前の版の DB を作るときだけ渡す
 */
export async function migrate(db: Database, target = SCHEMA_VERSION): Promise<void> {
  const [row] = await db.all<{ user_version: number }>("pragma user_version");
  const current = row?.user_version ?? 0;
  if (current > SCHEMA_VERSION) throw new NewerSchemaError(current);

  for (let version = current; version < target; version++) {
    const statements = migrations[version] ?? [];
    await db.transaction(async (tx) => {
      for (const sql of statements) await tx.run(sql);
      await tx.run(`pragma user_version = ${version + 1}`);
    });
  }
}
