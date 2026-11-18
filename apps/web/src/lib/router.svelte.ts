import { CAPTURE_PATH } from "./bookmarklet";

/**
 * 小さな自前のルーター（History API。docs/decisions/ui.md）。
 *
 * - /                All（すべてのフィードの記事。未読だけにするかは、一覧の絞り込みで選ぶ）
 * - /recently-read   最近既読にした記事
 * - /starred         保存済み
 * - /search?q=<言葉> 検索（手元の記事を探す）
 * - /feeds/:id       フィード
 * - /folders/:id     フォルダ
 * - /manage          購読の管理（追加、フォルダ、OPML の取り込み）
 * - /add             ブックマークレットから渡されたページを追加
 * - /settings        設定（アクセストークンと OAuth の許可。docs/decisions/account.md）
 * 開いている記事は ?article=<id> に持つ。
 *
 * 画面の状態のうち、共有しても意味のあるもの（どの画面か、探す言葉、開いている記事）は URL に、
 * その画面のどこを見ていたか（一覧と記事の位置）は履歴の項目（history.state）に持つ。どちらも、
 * 読み込み直しても、戻る・進むでも残るので、同じ画面の同じ位置に戻れる。
 * 一覧の表示の設定（未読だけ、並び順）は、一覧ごとの設定として手元の DB に持つ（prefs.svelte.ts）。
 * docs/decisions/ui.md の 1
 */
export type View =
  | { kind: "all" }
  | { kind: "recentlyRead" }
  | { kind: "starred" }
  | { kind: "search" }
  | { kind: "feed"; id: string }
  | { kind: "folder"; id: string }
  | { kind: "manage" }
  | { kind: "add" }
  | { kind: "settings" };

/** 一覧のどこを見ていたか。見出しのすぐ下に出ていた行の記事と、その行の上の端のずれ（px） */
export interface ListAnchor {
  id: string;
  publishedAt: number;
  readAt?: number | null;
  offset: number;
}

/** 履歴の項目に持つ、その画面のどこを見ていたか */
export interface Position {
  /** 一覧の位置。key は一覧の条件（条件が替わったら、前の位置には戻さない） */
  list?: { key: string; anchor: ListAnchor } | undefined;
  /** 記事の位置（px） */
  article?: { id: string; top: number } | undefined;
}

class Router {
  url = $state(new URL(location.href));

  /**
   * いまの履歴の項目に入ったときに、その項目に残っていた位置（読み込み直した、戻る・進むで来た）。
   * 戻したら消す（そのあとに一覧を読み直しても、また戻さない）
   */
  #entered: Position;

  /** いまの履歴の項目の鍵（項目ごとに付ける） */
  #key: string;

  /**
   * 項目ごとの位置の写し。戻る・進むでは、移ったあとにしか知らせが来ず、移る前の項目には書けない
   * ので、移る前の位置はここに残す（その項目に戻ったときは、history.state よりこちらを使う）
   */
  readonly #memory = new Map<string, Position>();

  /** 履歴の項目を移る直前に呼び、見ている位置を返してもらう（戻る・進むでは、まだ前の画面のまま） */
  beforeLeave: (() => Position | null) | null = null;

  constructor() {
    this.#key = keyOf(history.state) ?? this.#stamp();
    this.#entered = positionOf(history.state);
    window.addEventListener("popstate", () => {
      const left = this.beforeLeave?.() ?? null;
      if (left !== null) this.#memory.set(this.#key, { ...this.#memory.get(this.#key), ...left });
      this.#key = keyOf(history.state) ?? this.#stamp();
      this.#entered = { ...positionOf(history.state), ...this.#memory.get(this.#key) };
      this.url = new URL(location.href);
    });
  }

  /** 鍵のない項目（前の版が足した項目）に、鍵を付ける */
  #stamp(): string {
    const key = crypto.randomUUID();
    const state: unknown = history.state;
    history.replaceState({ ...(isRecord(state) ? state : {}), key }, "");
    return key;
  }

  /** いまの履歴の項目に、見ている位置を書く（URL は変えない） */
  remember(position: Position): void {
    const state: unknown = history.state;
    history.replaceState({ ...(isRecord(state) ? state : {}), ...position }, "");
    this.#memory.set(this.#key, { ...this.#memory.get(this.#key), ...position });
  }

  /** 別の項目を足す前に、いまの項目に見ている位置を書く */
  #leave(): void {
    const position = this.beforeLeave?.() ?? null;
    if (position !== null) this.remember(position);
  }

  /** 新しい項目を足す */
  #push(state: Record<string, unknown>, url: URL): void {
    this.#key = crypto.randomUUID();
    history.pushState({ ...state, key: this.#key }, "", url);
    this.#entered = {};
    this.url = url;
  }

  /** この項目に入ったときの一覧の位置（一覧の条件が同じときだけ）。一度だけ返す */
  takeList(key: string): ListAnchor | null {
    const list = this.#entered.list;
    this.#entered.list = undefined;
    return list?.key === key ? list.anchor : null;
  }

  /** この項目に入ったときの記事の位置（同じ記事のときだけ）。一度だけ返す */
  takeArticle(id: string): number | null {
    const article = this.#entered.article;
    this.#entered.article = undefined;
    return article?.id === id ? article.top : null;
  }

  get view(): View {
    const path = this.url.pathname;
    if (path === "/recently-read") return { kind: "recentlyRead" };
    if (path === "/starred") return { kind: "starred" };
    if (path === "/search") return { kind: "search" };
    if (path === "/manage") return { kind: "manage" };
    if (path === CAPTURE_PATH) return { kind: "add" };
    if (path === "/settings") return { kind: "settings" };
    const feed = /^\/feeds\/([^/]+)$/.exec(path);
    if (feed?.[1] !== undefined) return { kind: "feed", id: decodeURIComponent(feed[1]) };
    const folder = /^\/folders\/([^/]+)$/.exec(path);
    if (folder?.[1] !== undefined) return { kind: "folder", id: decodeURIComponent(folder[1]) };
    // 前にあった /all（既読も出す画面）も、ここに来る。未読だけにするかは、一覧の絞り込みで選ぶ
    return { kind: "all" };
  }

  /** 検索の画面で探している言葉 */
  get searchQuery(): string {
    return this.url.searchParams.get("q") ?? "";
  }

  /** 探す言葉を替える。打つたびに履歴を足さないように、置き換える（開いていた記事は閉じる） */
  setSearchQuery(query: string): void {
    const next = new URL("/search", location.href);
    if (query !== "") next.searchParams.set("q", query);
    history.replaceState({ key: this.#key }, "", next);
    this.#entered = {};
    this.url = next;
  }

  get articleId(): string | null {
    return this.url.searchParams.get("article");
  }

  /** ログインのエラーから戻るときなど、今の履歴だけを書き換える。 */
  replace(href: string): void {
    const next = new URL(href, location.href);
    if (next.origin !== location.origin) return;
    history.replaceState(history.state, "", next);
    this.url = next;
  }

  navigate(href: string): void {
    const next = new URL(href, location.href);
    if (next.origin !== location.origin) return;
    this.#leave();
    this.#push({}, next);
  }

  /**
   * 開いている一覧のまま、記事を開く（null なら閉じる）。
   * 一覧から開いたときだけ履歴を足し、記事から記事へ移るときは置き換える（「戻る」で、読んだ記事を
   * 1 つずつ戻らずに一覧に戻る）。閉じるときは、一覧から開いていたなら履歴を戻る
   */
  openArticle(id: string | null): void {
    const next = new URL(this.url);
    if (id === null) next.searchParams.delete("article");
    else next.searchParams.set("article", id);
    const opened = (history.state as { opened?: unknown } | null)?.opened === true;
    if (id === null) {
      if (this.articleId === null) return;
      if (opened) history.back();
      else this.navigate(next.href);
    } else if (this.articleId !== null) {
      history.replaceState(history.state, "", next);
      this.url = next;
    } else {
      // 一覧はそのままなので、一覧の位置は引き継ぐ（記事を開いたまま読み込み直しても、広い画面の
      // 一覧の位置が戻る）
      this.#leave();
      this.#push({ opened: true, list: positionOf(history.state).list }, next);
    }
  }
}

export const router = new Router();

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function keyOf(state: unknown): string | null {
  return isRecord(state) && typeof state.key === "string" ? state.key : null;
}

/** 履歴の項目の状態から、位置を取り出す（前の版が書いた、形の違う状態は捨てる） */
export function positionOf(state: unknown): Position {
  if (!isRecord(state)) return {};
  const position: Position = {};
  const list = state.list;
  if (isRecord(list) && typeof list.key === "string" && isRecord(list.anchor)) {
    const { id, publishedAt, readAt, offset } = list.anchor;
    if (typeof id === "string" && typeof publishedAt === "number" && typeof offset === "number") {
      position.list = {
        key: list.key,
        anchor: { id, publishedAt, offset, ...(typeof readAt === "number" ? { readAt } : {}) },
      };
    }
  }
  const article = state.article;
  if (isRecord(article) && typeof article.id === "string" && typeof article.top === "number") {
    position.article = { id: article.id, top: article.top };
  }
  return position;
}

export function viewHref(view: View): string {
  switch (view.kind) {
    case "all":
      return "/";
    case "recentlyRead":
      return "/recently-read";
    case "starred":
      return "/starred";
    case "search":
      return "/search";
    case "feed":
      return `/feeds/${encodeURIComponent(view.id)}`;
    case "folder":
      return `/folders/${encodeURIComponent(view.id)}`;
    case "manage":
      return "/manage";
    case "add":
      return CAPTURE_PATH;
    case "settings":
      return "/settings";
  }
}

/** ふつうのクリックだけをルーターで扱う（新しいタブで開くなどはブラウザに任せる） */
export function handleLink(event: MouseEvent, href: string): void {
  if (!isPlainClick(event)) return;
  event.preventDefault();
  router.navigate(href);
}

export function isPlainClick(event: MouseEvent): boolean {
  if (event.defaultPrevented || event.button !== 0) return false;
  return !(event.metaKey || event.ctrlKey || event.shiftKey || event.altKey);
}
