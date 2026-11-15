/**
 * 表示の好み（テーマ、文字の大きさ、一覧の形など）。この端末だけの設定で、sendo には送らない。
 * 秘密ではないので localStorage に置く（起動してすぐ、DB のワーカーを待たずに当てるため）。
 * ほかのタブで変えたら、こちらにも当てる。
 */
export type Theme = "auto" | "light" | "dark";
export type TextSize = "small" | "medium" | "large";
/** compact はタイトルだけ、comfortable は要約も出す */
export type ListLayout = "compact" | "comfortable";

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
  layout: ListLayout;
  /** 未読だけを出す（フィードとフォルダの一覧） */
  unreadOnly: boolean;
  /** 古い順に並べる */
  oldestFirst: boolean;
}

/** 一覧ごとの設定を覚えておく数の上限（購読をやめたフィードの分が、たまり続けないように） */
const MAX_VIEWS = 500;

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
  /** 指でのスワイプの割り当て */
  swipes: Swipes;
  /**
   * 一覧ごとに変えた設定（鍵は一覧のパス。/feeds/<id> など）。変えていないものは、上の
   * layout ／ unreadOnly ／ oldestFirst を既定として使う
   */
  views: Record<string, Partial<ViewOptions>>;
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
  views: {},
  // 記事を右へスワイプすると、一覧に戻る。一覧の行は、左でスター、右で既読・未読
  swipes: { listLeft: "star", listRight: "read", articleLeft: "none", articleRight: "back" },
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
  const views: Record<string, Partial<ViewOptions>> = {};
  for (const [key, value] of Object.entries(raw).slice(-MAX_VIEWS)) {
    if (typeof value !== "object" || value === null) continue;
    const entry = value as Record<string, unknown>;
    const options: Partial<ViewOptions> = {};
    if (entry.layout === "compact" || entry.layout === "comfortable") options.layout = entry.layout;
    if (typeof entry.unreadOnly === "boolean") options.unreadOnly = entry.unreadOnly;
    if (typeof entry.oldestFirst === "boolean") options.oldestFirst = entry.oldestFirst;
    views[key] = options;
  }
  return views;
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

  /** その一覧の設定。その一覧で変えていないものは、既定を使う */
  viewOptions(key: string): ViewOptions {
    const own = this.value.views[key] ?? {};
    return {
      layout: own.layout ?? this.value.layout,
      unreadOnly: own.unreadOnly ?? this.value.unreadOnly,
      oldestFirst: own.oldestFirst ?? this.value.oldestFirst,
    };
  }

  /** その一覧の設定を変える（ほかの一覧は変えない）。古いものから、上限を超えた分を捨てる */
  setViewOptions(key: string, patch: Partial<ViewOptions>): void {
    const { [key]: own, ...rest } = this.value.views;
    const entries = [...Object.entries(rest), [key, { ...own, ...patch }] as const];
    this.set({ views: Object.fromEntries(entries.slice(-MAX_VIEWS)) });
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
