import type { DeviceType, JsonValue, SettingItem } from "../models";
import type { Executor } from "./database";
import { deleteSetting, getSetting, setSetting } from "./settings";

/**
 * sendo に預ける設定（docs/decisions/settings.md）。端末の種類・名前・値で置く。どの種類の分も
 * 置き、画面は自分の種類の分だけを読む。手元だけの値（カーソルなど）を置く settings の表とは別。
 */

/** 前の版が localStorage に置いていた設定（移行待ち）を置く、手元の設定の鍵 */
const SEED_KEY = "settings.seed";

/** 移行待ちの設定。同期を最後まで終えたら、sendo にない項目だけを送る */
export interface SettingsSeed {
  deviceType: DeviceType;
  items: SettingItem[];
}

interface Row {
  name: string;
  value: string;
  [column: string]: string;
}

/**
 * その種類の設定を読む。移行待ちの項目は、手元にその名前の項目がない間、設定として使う
 * （移行が済むまでの間に、見た目が既定に戻らない）
 */
export async function listSyncedSettings(
  db: Executor,
  deviceType: DeviceType,
): Promise<SettingItem[]> {
  const rows = await db.all<Row>(
    "select name, value from synced_settings where device_type = ? order by name",
    [deviceType],
  );
  const items = rows.map((row) => ({ name: row.name, value: JSON.parse(row.value) as JsonValue }));
  const seed = await getSettingsSeed(db);
  if (seed === null || seed.deviceType !== deviceType) return items;
  const present = new Set(items.map((item) => item.name));
  return [...items, ...seed.items.filter((item) => !present.has(item.name))];
}

/** その種類に、その名前の項目が手元にあるか */
export async function hasSyncedSetting(
  db: Executor,
  deviceType: DeviceType,
  name: string,
): Promise<boolean> {
  const rows = await db.all("select 1 from synced_settings where device_type = ? and name = ?", [
    deviceType,
    name,
  ]);
  return rows.length > 0;
}

export async function putSyncedSetting(
  tx: Executor,
  deviceType: DeviceType,
  name: string,
  value: JsonValue,
): Promise<void> {
  await tx.run(
    `insert into synced_settings (device_type, name, value) values (?, ?, ?)
     on conflict (device_type, name) do update set value = excluded.value`,
    [deviceType, name, JSON.stringify(value)],
  );
}

export async function removeSyncedSetting(
  tx: Executor,
  deviceType: DeviceType,
  name: string,
): Promise<void> {
  await tx.run("delete from synced_settings where device_type = ? and name = ?", [
    deviceType,
    name,
  ]);
}

/** 同期で届いた設定をすべて消す（最初から取り直した設定で置き換えるとき） */
export async function clearSyncedSettings(tx: Executor): Promise<void> {
  await tx.run("delete from synced_settings");
}

export async function getSettingsSeed(db: Executor): Promise<SettingsSeed | null> {
  const raw = await getSetting(db, SEED_KEY);
  return raw === null ? null : (JSON.parse(raw) as SettingsSeed);
}

export async function setSettingsSeed(tx: Executor, seed: SettingsSeed | null): Promise<void> {
  if (seed === null) await deleteSetting(tx, SEED_KEY);
  else await setSetting(tx, SEED_KEY, JSON.stringify(seed));
}
