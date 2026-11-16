import {
  type DeviceType,
  type JsonValue,
  listSettingName,
  listSettingPath,
  type SettingItem,
  type SettingsChange,
} from "@sendo-reader/core";
import type { ReaderClient } from "@sendo-reader/core/web";

/**
 * 表示の好み（テーマ、文字の大きさ、一覧の形など。docs/decisions/settings.md）。
 *
 * 正は手元の DB にあり、sendo に預けて、同じ種類の端末（スマホ ／ それ以外）に引き継ぐ。変えたら、
 * 画面にすぐ当てて、core に渡す（core が手元の DB に置き、操作キューで sendo に送る）。手元の
 * 設定が変わったら（同期で届いた、ほかのタブで変えた）、読み直す。
 *
 * localStorage には、起動してすぐ当てるための写しだけを置く（DB のワーカーを待たずに、テーマと
 * 文字の大きさを当てるため）。写しから DB には戻さない。
 */
export type Theme = "auto" | "light" | "dark";
export type TextSize = "xsmall" | "small" | "medium" | "large" | "xlarge";

/** 文字の大きさ。小さい順（設定の画面のスライダーの並び） */
export const TEXT_SIZES: readonly TextSize[] = ["xsmall", "small", "medium", "large", "xlarge"];

/** 一覧の行を、横にスワイプしたときにすること */
export type ListSwipe = "none" | "read" | "star";
/** 記事を、横にスワイプしたときにすること */
export type ArticleSwipe = "none" | "back" | "next" | "previous";

export const LIST_SWIPES: readonly ListSwipe[] = ["none", "read", "star"];
export const ARTICLE_SWIPES: readonly ArticleSwipe[] = ["none", "back", "next", "previous"];

/** 指でのスワイプの割り当て（left は左へ、right は右へ動かしたとき） */
export interface Swipes {
  listLeft: ListSwipe;
  listRight: ListSwipe;
  articleLeft: ArticleSwipe;
  articleRight: ArticleSwipe;
}

/** 一覧ごとに変えられるもの */
export interface ViewOptions {
  /** 未読だけを出す（All、フォルダ、フィードの一覧） */
  unreadOnly: boolean;
  /** 古い順に並べる */
  oldestFirst: boolean;
}

/** 畳んでいるフォルダを覚えておく数の上限（1 つの項目の値の上限に収める） */
const MAX_COLLAPSED = 200;

export interface PrefsValue {
  theme: Theme;
  textSize: TextSize;
  /** 一覧（All、フォルダ、フィード）で、未読だけを出す */
  unreadOnly: boolean;
  /** 一覧を動かして、上へ通り過ぎた未読の記事を既読にする */
  markReadOnScroll: boolean;
  /** 一覧を古い順に並べる */
  oldestFirst: boolean;
  /** 左のメニューで、未読のないフィードを隠す */
  hideReadFeeds: boolean;
  /** 左のメニューで、畳んでいるフォルダの ID */
  collapsed: string[];
  /** 指でのスワイプの割り当て */
  swipes: Swipes;
  /**
   * 一覧ごとに変えた設定（鍵は一覧のパス。/feeds/<id> など）。変えていないものは、上の
   * unreadOnly ／ oldestFirst を既定として使う
   */
  views: Record<string, Partial<ViewOptions>>;
}

/** 起動してすぐ当てるための写し */
const SNAPSHOT_KEY = "sendo.prefs.snapshot";
/** 前の版が設定を置いていた鍵。sendo に預ける形に移したら消す（settings.md の 9） */
const LEGACY_KEY = "sendo.prefs";

const DEFAULTS: PrefsValue = {
  theme: "auto",
  textSize: "medium",
  unreadOnly: true,
  markReadOnScroll: true,
  oldestFirst: false,
  hideReadFeeds: false,
  collapsed: [],
  views: {},
  // 記事を右へスワイプすると、一覧に戻る。一覧の行は、右でスター、左で既読・未読（Feedly と同じ）
  swipes: { listLeft: "read", listRight: "star", articleLeft: "none", articleRight: "back" },
};

function oneOf<T extends string>(value: unknown, allowed: readonly T[], fallback: T): T {
  return allowed.includes(value as T) ? (value as T) : fallback;
}

/** 置いてあった値を読む。壊れていたり、知らない値だったりしたら、既定に戻す */
export function parsePrefs(text: string | null): PrefsValue {
  let raw: Record<string, unknown> = {};
  try {
    const parsed: unknown = text === null ? null : JSON.parse(text);
    if (typeof parsed === "object" && parsed !== null) raw = parsed as Record<string, unknown>;
  } catch {
    // 壊れていたら既定にする
  }
  const flag = (key: keyof PrefsValue) =>
    typeof raw[key] === "boolean" ? (raw[key] as boolean) : (DEFAULTS[key] as boolean);
  return {
    theme: oneOf(raw.theme, ["auto", "light", "dark"], DEFAULTS.theme),
    textSize: oneOf(raw.textSize, TEXT_SIZES, DEFAULTS.textSize),
    unreadOnly: flag("unreadOnly"),
    markReadOnScroll: flag("markReadOnScroll"),
    oldestFirst: flag("oldestFirst"),
    hideReadFeeds: flag("hideReadFeeds"),
    collapsed: Array.isArray(raw.collapsed)
      ? raw.collapsed.filter((id): id is string => typeof id === "string").slice(-MAX_COLLAPSED)
      : [],
    views: parseViews(raw.views),
    swipes: parseSwipes(raw.swipes),
  };
}

function parseSwipes(raw: unknown): Swipes {
  const entry = typeof raw === "object" && raw !== null ? (raw as Record<string, unknown>) : {};
  const fallback = DEFAULTS.swipes;
  return {
    listLeft: oneOf(entry.listLeft, LIST_SWIPES, fallback.listLeft),
    listRight: oneOf(entry.listRight, LIST_SWIPES, fallback.listRight),
    articleLeft: oneOf(entry.articleLeft, ARTICLE_SWIPES, fallback.articleLeft),
    articleRight: oneOf(entry.articleRight, ARTICLE_SWIPES, fallback.articleRight),
  };
}

function parseViews(raw: unknown): Record<string, Partial<ViewOptions>> {
  if (typeof raw !== "object" || raw === null) return {};
  // 鍵は外から来たもの（同期で届いた名前）。__proto__ のような鍵でも、ただの項目として置く
  const views: [string, Partial<ViewOptions>][] = [];
  for (const [key, value] of Object.entries(raw)) {
    if (typeof value !== "object" || value === null) continue;
    const entry = value as Record<string, unknown>;
    const options: Partial<ViewOptions> = {};
    if (typeof entry.unreadOnly === "boolean") options.unreadOnly = entry.unreadOnly;
    if (typeof entry.oldestFirst === "boolean") options.oldestFirst = entry.oldestFirst;
    views.push([key, options]);
  }
  return Object.fromEntries(views);
}

const SWIPE_NAMES = {
  listLeft: "reader.swipe.listLeft",
  listRight: "reader.swipe.listRight",
  articleLeft: "reader.swipe.articleLeft",
  articleRight: "reader.swipe.articleRight",
} as const satisfies Record<keyof Swipes, string>;

const SIMPLE_NAMES = {
  theme: "reader.theme",
  textSize: "reader.textSize",
  unreadOnly: "reader.unreadOnly",
  markReadOnScroll: "reader.markReadOnScroll",
  oldestFirst: "reader.oldestFirst",
  hideReadFeeds: "reader.hideReadFeeds",
} as const;

/**
 * 設定を、sendo に預ける項目（名前から値へ）にする。既定と同じ値は入れない（既定に戻したら、
 * 項目を消す）。別々に変わるものは、別の項目にする
 */
export function toItems(value: PrefsValue): Map<string, JsonValue> {
  const items = new Map<string, JsonValue>();
  for (const [key, name] of Object.entries(SIMPLE_NAMES) as [keyof typeof SIMPLE_NAMES, string][]) {
    if (value[key] !== DEFAULTS[key]) items.set(name, value[key]);
  }
  for (const [key, name] of Object.entries(SWIPE_NAMES) as [keyof Swipes, string][]) {
    if (value.swipes[key] !== DEFAULTS.swipes[key]) items.set(name, value.swipes[key]);
  }
  if (value.collapsed.length > 0)
    items.set("reader.collapsed", value.collapsed.slice(-MAX_COLLAPSED));
  for (const [path, options] of Object.entries(value.views)) {
    // 名前に使えない一覧のパス（ASCII でない、長すぎる）の設定は、預けない
    const name = listSettingName(path);
    if (name !== null && Object.keys(options).length > 0) items.set(name, { ...options });
  }
  return items;
}

/** 手元の項目から、設定を組み立てる。ない項目、知らない値、壊れた値は、既定として扱う */
export function fromItems(items: readonly SettingItem[]): PrefsValue {
  const byName = new Map(items.map((item) => [item.name, item.value]));
  const raw: Record<string, unknown> = {};
  for (const [key, name] of Object.entries(SIMPLE_NAMES)) raw[key] = byName.get(name);
  raw.collapsed = byName.get("reader.collapsed");
  raw.swipes = Object.fromEntries(
    Object.entries(SWIPE_NAMES).map(([key, name]) => [key, byName.get(name)]),
  );
  // 名前は外から来たもの。__proto__ のような鍵でも、ただの項目として扱う
  const views = new Map<string, unknown>();
  for (const item of items) {
    const path = listSettingPath(item.name);
    if (path !== null) views.set(path, item.value);
  }
  raw.views = Object.fromEntries(views);
  return parsePrefs(JSON.stringify(raw));
}

/** 前の項目から今の項目への変更。値の変わった項目を置き、なくなった項目を消す */
export function diffItems(
  before: ReadonlyMap<string, JsonValue>,
  after: ReadonlyMap<string, JsonValue>,
): Required<SettingsChange> {
  const put: SettingItem[] = [];
  for (const [name, value] of after) {
    if (JSON.stringify(before.get(name)) !== JSON.stringify(value)) put.push({ name, value });
  }
  return { put, remove: [...before.keys()].filter((name) => !after.has(name)) };
}

/**
 * 端末の種類（settings.md の 1）。スマホ（主な入力が指で、画面の短い辺が 600px より小さい）は
 * mobile、それ以外（PC、タブレット）は desktop。画面（screen）の大きさで決めるので、ウィンドウの
 * 幅を変えても、端末を回しても変わらない
 */
export function detectDeviceType(): DeviceType {
  const coarse = window.matchMedia("(pointer: coarse)").matches;
  return coarse && Math.min(window.screen.width, window.screen.height) < 600 ? "mobile" : "desktop";
}

function readStored(key: string): string | null {
  try {
    return localStorage.getItem(key);
  } catch {
    // localStorage が使えない（プライベートモードなど）。既定で動く
    return null;
  }
}

class Prefs {
  /**
   * 起動したときは、写しを当てる。まだ移していない前の版の設定があれば、それを当てる
   * （手元の DB を読むまでの間の見た目）
   */
  value = $state<PrefsValue>(parsePrefs(readStored(LEGACY_KEY) ?? readStored(SNAPSHOT_KEY)));

  #client: ReaderClient | null = null;
  #deviceType: DeviceType = "desktop";
  /** 画面で変えた回数。読み直している間に変えたら、その読み直しは捨てる */
  #writes = 0;
  #signedIn = false;

  constructor() {
    this.#apply();
  }

  /**
   * 手元の DB につなぐ。ログインしていれば、前の版の設定を移してから、手元の設定を読む。
   * 手元の設定が変わったら（同期で届いた、ほかのタブで変えた、ログアウトした）、読み直す
   */
  connect(client: ReaderClient, deviceType: DeviceType = detectDeviceType()): void {
    this.#client = client;
    this.#deviceType = deviceType;
    client.onChange((tables) => {
      if (tables.has("settings")) void this.#load();
    });
    client.onStatus((status) => this.#onSignedIn(status.signedIn));
    void client.status().then(
      (status) => this.#onSignedIn(status.signedIn),
      () => {},
    );
  }

  #onSignedIn(signedIn: boolean): void {
    if (signedIn === this.#signedIn) return;
    this.#signedIn = signedIn;
    if (signedIn) void this.#migrate().then(() => this.#load());
  }

  /**
   * 前の版が localStorage に置いた設定を、移行待ちとして core に渡す（settings.md の 9）。core が
   * 手元の DB に置けたら、localStorage からは消す。置けなければ残し、次に起動したときにやり直す
   */
  async #migrate(): Promise<void> {
    const legacy = readStored(LEGACY_KEY);
    if (legacy === null || this.#client === null) return;
    const items = [...toItems(parsePrefs(legacy))].map(([name, value]) => ({ name, value }));
    try {
      await this.#client.seedSettings(this.#deviceType, items);
      localStorage.removeItem(LEGACY_KEY);
    } catch {
      // ログインしていない、DB を開けない、など
    }
  }

  /** 手元の設定を読み直して、画面に当てる */
  async #load(): Promise<void> {
    if (this.#client === null) return;
    const writes = this.#writes;
    let items: SettingItem[];
    try {
      items = await this.#client.listSettings(this.#deviceType);
    } catch {
      return;
    }
    // 読んでいる間に画面で変えた。その変更が手元に入ったら、もう一度読み直しに来る
    if (writes !== this.#writes) return;
    this.value = fromItems(items);
    this.#apply();
  }

  set(patch: Partial<PrefsValue>): void {
    const next = { ...this.value, ...patch };
    const change = diffItems(toItems(this.value), toItems(next));
    this.value = next;
    this.#apply();
    if (this.#client === null || (change.put.length === 0 && change.remove.length === 0)) return;
    this.#writes += 1;
    // 手元の DB に置けなかったら（ログインしていない、など）、手元の設定に戻す
    this.#client.changeSettings(this.#deviceType, change).catch(() => {
      this.#writes += 1;
      void this.#load();
    });
  }

  /** その一覧の設定。その一覧で変えていないものは、既定を使う */
  viewOptions(key: string): ViewOptions {
    const own = this.value.views[key] ?? {};
    return {
      unreadOnly: own.unreadOnly ?? this.value.unreadOnly,
      oldestFirst: own.oldestFirst ?? this.value.oldestFirst,
    };
  }

  /** その一覧の設定を変える（ほかの一覧は変えない） */
  setViewOptions(key: string, patch: Partial<ViewOptions>): void {
    this.set({ views: { ...this.value.views, [key]: { ...this.value.views[key], ...patch } } });
  }

  isCollapsed(folderId: string): boolean {
    return this.value.collapsed.includes(folderId);
  }

  toggleCollapsed(folderId: string): void {
    const collapsed = this.value.collapsed;
    this.set({
      collapsed: collapsed.includes(folderId)
        ? collapsed.filter((id) => id !== folderId)
        : [...collapsed, folderId].slice(-MAX_COLLAPSED),
    });
  }

  /**
   * テーマと文字の大きさを <html> に付け（色と大きさは app.css が決める）、次に起動したときに
   * すぐ当てるための写しを置く
   */
  #apply(): void {
    const root = document.documentElement;
    if (this.value.theme === "auto") delete root.dataset.theme;
    else root.dataset.theme = this.value.theme;
    if (this.value.textSize === "medium") delete root.dataset.textSize;
    else root.dataset.textSize = this.value.textSize;
    try {
      localStorage.setItem(SNAPSHOT_KEY, JSON.stringify(this.value));
    } catch {
      // 置けなくても、開いている間は効く
    }
  }
}

export const prefs = new Prefs();
