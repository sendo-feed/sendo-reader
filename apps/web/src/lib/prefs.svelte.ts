/**
 * 表示の好み（テーマ、文字の大きさ、一覧の形など）。この端末だけの設定で、sendo には送らない。
 * 秘密ではないので localStorage に置く（起動してすぐ、DB のワーカーを待たずに当てるため）。
 * ほかのタブで変えたら、こちらにも当てる。
 */
export type Theme = "auto" | "light" | "dark";
export type TextSize = "small" | "medium" | "large";
/** compact はタイトルだけ、comfortable は要約も出す */
export type ListLayout = "compact" | "comfortable";

export interface PrefsValue {
  theme: Theme;
  textSize: TextSize;
  layout: ListLayout;
  /** フィードとフォルダの一覧で、未読だけを出す */
  unreadOnly: boolean;
  /** 一覧を動かして、上へ通り過ぎた未読の記事を既読にする */
  markReadOnScroll: boolean;
  /** 一覧を古い順に並べる */
  oldestFirst: boolean;
  /** 左のメニューで、未読のないフィードを隠す */
  hideReadFeeds: boolean;
  /** 左のメニューで、畳んでいるフォルダの ID */
  collapsed: string[];
}

const KEY = "sendo.prefs";

const DEFAULTS: PrefsValue = {
  theme: "auto",
  textSize: "medium",
  layout: "comfortable",
  unreadOnly: false,
  markReadOnScroll: true,
  oldestFirst: false,
  hideReadFeeds: false,
  collapsed: [],
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
    textSize: oneOf(raw.textSize, ["small", "medium", "large"], DEFAULTS.textSize),
    layout: oneOf(raw.layout, ["compact", "comfortable"], DEFAULTS.layout),
    unreadOnly: flag("unreadOnly"),
    markReadOnScroll: flag("markReadOnScroll"),
    oldestFirst: flag("oldestFirst"),
    hideReadFeeds: flag("hideReadFeeds"),
    collapsed: Array.isArray(raw.collapsed)
      ? raw.collapsed.filter((id): id is string => typeof id === "string").slice(0, 500)
      : [],
  };
}

function read(): PrefsValue {
  try {
    return parsePrefs(localStorage.getItem(KEY));
  } catch {
    // localStorage が使えない（プライベートモードなど）。既定で動く
    return { ...DEFAULTS };
  }
}

class Prefs {
  value = $state<PrefsValue>(read());

  constructor() {
    this.#apply();
    window.addEventListener("storage", (event) => {
      if (event.key !== KEY) return;
      this.value = parsePrefs(event.newValue);
      this.#apply();
    });
  }

  set(patch: Partial<PrefsValue>): void {
    this.value = { ...this.value, ...patch };
    this.#apply();
    try {
      localStorage.setItem(KEY, JSON.stringify(this.value));
    } catch {
      // 置けなくても、開いている間は効く
    }
  }

  isCollapsed(folderId: string): boolean {
    return this.value.collapsed.includes(folderId);
  }

  toggleCollapsed(folderId: string): void {
    const collapsed = this.value.collapsed;
    this.set({
      collapsed: collapsed.includes(folderId)
        ? collapsed.filter((id) => id !== folderId)
        : [...collapsed, folderId],
    });
  }

  /** テーマと文字の大きさを <html> に付ける（色と大きさは app.css が決める） */
  #apply(): void {
    const root = document.documentElement;
    if (this.value.theme === "auto") delete root.dataset.theme;
    else root.dataset.theme = this.value.theme;
    if (this.value.textSize === "medium") delete root.dataset.textSize;
    else root.dataset.textSize = this.value.textSize;
  }
}

export const prefs = new Prefs();
