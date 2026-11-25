import type { Feed } from "../models";
import type { Executor } from "./database";

/** 同期や購読の応答で受け取った購読を置く。 */
export async function putFeed(tx: Executor, feed: Feed): Promise<void> {
  await tx.run(
    `insert into feeds (
      id, url, title, display_name, site_url, folder_id, icon_url, created_at,
      workspace_id, synced_workspace_id, subscription_id
    ) values (?, ?, ?, ?, ?, ?, ?, ?, ?9, ?9, ?10)
    on conflict (id) do update set
      url = excluded.url, title = excluded.title, display_name = excluded.display_name,
      site_url = excluded.site_url, folder_id = excluded.folder_id, icon_url = excluded.icon_url,
      created_at = excluded.created_at, workspace_id = excluded.workspace_id,
      synced_workspace_id = excluded.synced_workspace_id, subscription_id = excluded.subscription_id`,
    [
      feed.id,
      feed.url,
      feed.title,
      feed.displayName,
      feed.siteUrl,
      feed.folderId,
      feed.iconUrl,
      feed.createdAt,
      feed.workspaceId ?? null,
      feed.subscriptionId ?? null,
    ],
  );
}
