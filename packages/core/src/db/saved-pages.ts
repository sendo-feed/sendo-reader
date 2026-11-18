import type { SavedPage } from "../models";
import { normalizeSavedUrl } from "../saved";
import type { Executor } from "./database";

export async function listSavedPages(db: Executor, hideStarred: boolean): Promise<SavedPage[]> {
  const pages = await db.all<SavedPage>(
    "select id, url, title, saved_at as savedAt from visible_saved_pages order by saved_at desc, id desc",
  );
  if (!hideStarred || pages.length === 0) return pages;
  const articles = await db.all<{ url: string }>(
    "select url from articles where starred_at is not null and url is not null",
  );
  const starredUrls = new Set(articles.map(({ url }) => normalizeSavedUrl(url)));
  return pages.filter(({ url }) => !starredUrls.has(url));
}

export async function getSavedPage(db: Executor, id: string): Promise<SavedPage | null> {
  const [page] = await db.all<SavedPage>(
    "select id, url, title, saved_at as savedAt from visible_saved_pages where id = ?",
    [id],
  );
  return page ?? null;
}

export async function countSavedPages(db: Executor): Promise<number> {
  const [row] = await db.all<{ count: number }>(
    "select count(*) as count from visible_saved_pages",
  );
  return row?.count ?? 0;
}

export async function putSavedPage(tx: Executor, page: SavedPage): Promise<void> {
  await tx.run(
    `insert into saved_pages (id, url, title, saved_at) values (?, ?, ?, ?)
     on conflict (id) do update set url = excluded.url, title = excluded.title,
       saved_at = excluded.saved_at`,
    [page.id, page.url, page.title, page.savedAt],
  );
}

export function removeSavedPage(tx: Executor, id: string): Promise<void> {
  return tx.run("delete from saved_pages where id = ?", [id]);
}

export function clearSavedPages(tx: Executor): Promise<void> {
  return tx.run("delete from saved_pages");
}
