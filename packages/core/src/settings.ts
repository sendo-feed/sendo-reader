import type { SettingItem, SettingsChange } from "./models";

/**
 * sendo に預ける設定の、名前と値の決まり（docs/decisions/settings.md、sendo の settings.md）。
 * 項目の中身（どんな項目があるか、既定は何か）は画面が決める。ここで扱うのは、sendo が受け付ける
 * 形と、core が自分で消す項目（購読をやめたフィードの一覧の設定）の名前だけ。
 */

/** 名前の形。reader. で始め、残りは空白を除く印字できる ASCII。128 文字まで */
const SETTING_NAME_PATTERN = /^reader\.[\x21-\x7e]+$/;
const MAX_SETTING_NAME_LENGTH = 128;
/** 値を JSON にしたときの大きさの上限（UTF-8 のバイト数） */
const MAX_SETTING_VALUE_BYTES = 8192;
/** 1 回のリクエストで送れる項目の数（put と remove を合わせて） */
export const MAX_SETTINGS_PER_REQUEST = 100;

const LIST_SETTING_PREFIX = "reader.list:";

/** 設定の名前として使えるか */
export function isSettingName(name: string): boolean {
  return name.length <= MAX_SETTING_NAME_LENGTH && SETTING_NAME_PATTERN.test(name);
}

/**
 * 一覧ごとの設定の名前（一覧 1 つにつき 1 項目）。path は一覧のパス（/feeds/<id> など）。
 * 名前に使えないパス（ASCII でない、長すぎる）なら null（その一覧の設定は預けない）
 */
export function listSettingName(path: string): string | null {
  const name = `${LIST_SETTING_PREFIX}${path}`;
  return isSettingName(name) ? name : null;
}

/** 一覧ごとの設定の名前から、一覧のパスを読む。一覧ごとの設定でなければ null */
export function listSettingPath(name: string): string | null {
  return name.startsWith(LIST_SETTING_PREFIX) ? name.slice(LIST_SETTING_PREFIX.length) : null;
}

/** フィードの一覧のパス（画面のルーターと同じ形） */
export function feedListPath(feedId: string): string {
  return `/feeds/${encodeURIComponent(feedId)}`;
}

/** フォルダの一覧のパス（画面のルーターと同じ形） */
export function folderListPath(folderId: string): string {
  return `/folders/${encodeURIComponent(folderId)}`;
}

/**
 * 設定の変更を確かめて、決まった形にする。sendo が断ると分かっているもの（名前の形、値の大きさ、
 * 同じ名前が 2 度ある）は、積む前に RangeError で断る
 */
export function normalizeSettingsChange(change: SettingsChange): {
  put: SettingItem[];
  remove: string[];
} {
  const put = (change.put ?? []).map((item) => ({ name: item.name, value: item.value }));
  const remove = [...(change.remove ?? [])];
  const names = [...put.map((item) => item.name), ...remove];
  if (new Set(names).size !== names.length) throw new RangeError("同じ設定の名前が 2 度ある");
  for (const name of names) {
    if (typeof name !== "string" || !isSettingName(name)) {
      throw new RangeError("設定の名前の形が違う");
    }
  }
  for (const item of put) {
    const text = JSON.stringify(item.value);
    if (text === undefined || new TextEncoder().encode(text).length > MAX_SETTING_VALUE_BYTES) {
      throw new RangeError("設定の値が大きすぎる");
    }
  }
  return { put, remove };
}
