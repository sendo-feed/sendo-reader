import type { Workspace } from "../models";
import type { Executor } from "./database";
import { deleteSetting, getSetting, setSetting } from "./settings";

const WORKSPACES_AVAILABLE_KEY = "sync.workspacesAvailable";

export async function workspacesAvailable(db: Executor): Promise<boolean> {
  return (await getSetting(db, WORKSPACES_AVAILABLE_KEY)) === "1";
}

export async function setWorkspacesAvailable(db: Executor, available: boolean): Promise<boolean> {
  if (available === (await workspacesAvailable(db))) return false;
  if (available) await setSetting(db, WORKSPACES_AVAILABLE_KEY, "1");
  else await deleteSetting(db, WORKSPACES_AVAILABLE_KEY);
  return true;
}

export async function listWorkspaces(db: Executor): Promise<Workspace[]> {
  return db.all<{ id: string; name: string; createdAt: number }>(
    'select id, name, created_at as "createdAt" from workspaces where deleted_locally = 0 order by name, id',
  );
}

export async function putWorkspace(db: Executor, workspace: Workspace): Promise<void> {
  await db.run(
    `insert into workspaces (id, name, created_at) values (?, ?, ?)
     on conflict (id) do update set name = excluded.name, created_at = excluded.created_at`,
    [workspace.id, workspace.name, workspace.createdAt],
  );
}
