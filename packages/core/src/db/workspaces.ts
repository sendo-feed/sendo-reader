import type { Workspace } from "../models";
import type { Executor } from "./database";
import { deleteSetting, getSetting, setSetting } from "./settings";

const WORKSPACES_AVAILABLE_KEY = "sync.workspacesAvailable";
// 空文字はデフォルトに未対応、設定なしは対応をまだ確認していない。
export const CONFIRMED_WORKSPACE_DEFAULT_KEY = "sync.confirmedWorkspaceDefault";

export async function workspacesAvailable(db: Executor): Promise<boolean> {
  return (await getSetting(db, WORKSPACES_AVAILABLE_KEY)) === "1";
}

export async function setWorkspacesAvailable(db: Executor, available: boolean): Promise<boolean> {
  if (available === (await workspacesAvailable(db))) return false;
  if (available) await setSetting(db, WORKSPACES_AVAILABLE_KEY, "1");
  else await deleteSetting(db, WORKSPACES_AVAILABLE_KEY);
  return true;
}

export async function listWorkspaces(
  db: Executor,
  defaultId?: string | null,
): Promise<Workspace[]> {
  const currentDefault = defaultId === undefined ? await effectiveWorkspaceDefault(db) : defaultId;
  const rows = await db.all<{ id: string; name: string; createdAt: number }>(
    'select id, name, created_at as "createdAt" from workspaces where deleted_locally = 0 order by name, id',
  );
  return currentDefault === null
    ? rows
    : rows.map((row) => ({ ...row, isDefault: row.id === currentDefault }));
}

export async function putWorkspace(db: Executor, workspace: Workspace): Promise<void> {
  await db.run(
    `insert into workspaces (id, name, created_at, synced_is_default) values (?, ?, ?, ?)
     on conflict (id) do update set name = excluded.name, created_at = excluded.created_at,
       synced_is_default = excluded.synced_is_default`,
    [workspace.id, workspace.name, workspace.createdAt, workspace.isDefault === true ? 1 : 0],
  );
}

export async function effectiveWorkspaceDefault(
  db: Executor,
  beforePendingId: number | null = null,
): Promise<string | null> {
  const confirmed = await getSetting(db, CONFIRMED_WORKSPACE_DEFAULT_KEY);
  if (!confirmed) return null;
  const [pending] = await db.all<{ id: string }>(
    `select w.id from pending_ops p
     join workspaces w on w.id = p.key and w.deleted_locally = 0
     where p.kind = 'setDefaultWorkspace' and (?1 is null or p.id < ?1)
     order by p.id desc limit 1`,
    [beforePendingId],
  );
  return pending?.id ?? confirmed;
}

async function confirmWorkspaceDefault(db: Executor, id: string | null): Promise<boolean> {
  const stored = id ?? "";
  const previous = await getSetting(db, CONFIRMED_WORKSPACE_DEFAULT_KEY);
  if (previous === stored) return false;
  await setSetting(db, CONFIRMED_WORKSPACE_DEFAULT_KEY, stored);
  return (previous || null) !== id;
}

/** PATCH または GET の応答で Sendo の現在のデフォルトが分かったときに揃える。 */
export async function putWorkspaceDefault(db: Executor, id: string | null): Promise<boolean> {
  await db.run(
    "update workspaces set synced_is_default = (id is ?1) where synced_is_default = 1 or id = ?1",
    [id],
  );
  return confirmWorkspaceDefault(db, id);
}

export async function invalidateWorkspaceDefault(db: Executor): Promise<void> {
  await putWorkspaceDefault(db, null);
  await deleteSetting(db, CONFIRMED_WORKSPACE_DEFAULT_KEY);
}

/** サーバーの変更が別ページに分かれても、全ページを適用してから印を確定する。 */
export async function finishWorkspaceDefaults(
  db: Executor,
  available: boolean,
  bootstrap?: string | null,
): Promise<boolean> {
  if (!available) return confirmWorkspaceDefault(db, null);
  const defaults = await db.all<{ id: string }>(
    "select id from workspaces where synced_is_default = 1 limit 2",
  );
  if (defaults.length === 1) return confirmWorkspaceDefault(db, defaults[0]?.id ?? null);
  // 旧版への切り戻しから戻ると、変更番号が進まず空の差分でも印が有効になる。
  if (bootstrap === null) return false;
  if (bootstrap !== undefined) return putWorkspaceDefault(db, bootstrap);
  return confirmWorkspaceDefault(db, null);
}

/** 選択中のワークスペースと、開いている一覧に入る有効な購読。 */
export async function workspaceSubscriptions(
  db: Executor,
  workspaceIds: readonly string[],
  scope: { feedId?: string; folderId?: string },
): Promise<{ id: string; subscription_id: string }[]> {
  return db.all<{ id: string; subscription_id: string }>(
    `select f.id, f.subscription_id from feeds f join workspaces w on w.id = f.workspace_id
     where f.subscription_id is not null and w.deleted_locally = 0
       and w.id in (select value from json_each(?1))
       and (?2 is null or f.id = ?2)
       and (?3 is null or f.folder_id = ?3)
     order by f.subscription_id`,
    [JSON.stringify(workspaceIds), scope.feedId ?? null, scope.folderId ?? null],
  );
}
