import type { Executor } from "./database";

/** 手元の設定（同期のカーソル、トークンなど）を読む */
export async function getSetting(db: Executor, key: string): Promise<string | null> {
  const [row] = await db.all<{ value: string }>("select value from settings where key = ?", [key]);
  return row?.value ?? null;
}

export async function setSetting(db: Executor, key: string, value: string): Promise<void> {
  await db.run(
    "insert into settings (key, value) values (?, ?) on conflict (key) do update set value = excluded.value",
    [key, value],
  );
}

export async function deleteSetting(db: Executor, key: string): Promise<void> {
  await db.run("delete from settings where key = ?", [key]);
}
