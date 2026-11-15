/**
 * 小さな自前のルーター（History API。docs/decisions/ui.md）。
 *
 * - /                未読
 * - /all             すべて
 * - /starred         スター
 * - /search?q=<言葉> 検索（手元の記事を探す）
 * - /feeds/:id       フィード
 * - /folders/:id     フォルダ
 * - /manage          購読の管理（追加、フォルダ、OPML の取り込み）
 * - /settings        設定（アクセストークンと OAuth の許可。docs/decisions/account.md）
 * 開いている記事は ?article=<id> に持つ。
 */
export type View =
  | { kind: "unread" }
  | { kind: "all" }
  | { kind: "starred" }
  | { kind: "search" }
  | { kind: "feed"; id: string }
  | { kind: "folder"; id: string }
  | { kind: "manage" }
  | { kind: "settings" };

class Router {
  url = $state(new URL(location.href));

  constructor() {
    window.addEventListener("popstate", () => {
      this.url = new URL(location.href);
    });
  }

  get view(): View {
    const path = this.url.pathname;
    if (path === "/all") return { kind: "all" };
    if (path === "/starred") return { kind: "starred" };
    if (path === "/search") return { kind: "search" };
    if (path === "/manage") return { kind: "manage" };
    if (path === "/settings") return { kind: "settings" };
    const feed = /^\/feeds\/([^/]+)$/.exec(path);
    if (feed?.[1] !== undefined) return { kind: "feed", id: decodeURIComponent(feed[1]) };
    const folder = /^\/folders\/([^/]+)$/.exec(path);
    if (folder?.[1] !== undefined) return { kind: "folder", id: decodeURIComponent(folder[1]) };
    return { kind: "unread" };
  }

  /** 検索の画面で探している言葉 */
  get searchQuery(): string {
    return this.url.searchParams.get("q") ?? "";
  }

  /** 探す言葉を替える。打つたびに履歴を足さないように、置き換える（開いていた記事は閉じる） */
  setSearchQuery(query: string): void {
    const next = new URL("/search", location.href);
    if (query !== "") next.searchParams.set("q", query);
    history.replaceState(null, "", next);
    this.url = next;
  }

  get articleId(): string | null {
    return this.url.searchParams.get("article");
  }

  navigate(href: string): void {
    const next = new URL(href, location.href);
    if (next.origin !== location.origin) return;
    history.pushState(null, "", next);
    this.url = next;
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
      history.pushState({ opened: true }, "", next);
      this.url = next;
    }
  }
}

export const router = new Router();

export function viewHref(view: View): string {
  switch (view.kind) {
    case "unread":
      return "/";
    case "all":
      return "/all";
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
