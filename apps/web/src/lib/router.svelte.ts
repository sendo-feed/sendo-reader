/**
 * 小さな自前のルーター（History API。docs/decisions/ui.md）。
 *
 * - /                未読
 * - /all             すべて
 * - /starred         スター
 * - /feeds/:id       フィード
 * - /folders/:id     フォルダ
 * - /manage          購読の管理（追加、フォルダ、OPML の取り込み）
 * 開いている記事は ?article=<id> に持つ。
 */
export type View =
  | { kind: "unread" }
  | { kind: "all" }
  | { kind: "starred" }
  | { kind: "feed"; id: string }
  | { kind: "folder"; id: string }
  | { kind: "manage" };

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
    if (path === "/manage") return { kind: "manage" };
    const feed = /^\/feeds\/([^/]+)$/.exec(path);
    if (feed?.[1] !== undefined) return { kind: "feed", id: decodeURIComponent(feed[1]) };
    const folder = /^\/folders\/([^/]+)$/.exec(path);
    if (folder?.[1] !== undefined) return { kind: "folder", id: decodeURIComponent(folder[1]) };
    return { kind: "unread" };
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

  /** 開いている一覧のまま、記事を開く（null なら閉じる） */
  openArticle(id: string | null): void {
    const next = new URL(this.url);
    if (id === null) next.searchParams.delete("article");
    else next.searchParams.set("article", id);
    this.navigate(next.href);
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
    case "feed":
      return `/feeds/${encodeURIComponent(view.id)}`;
    case "folder":
      return `/folders/${encodeURIComponent(view.id)}`;
    case "manage":
      return "/manage";
  }
}

/** ふつうのクリックだけをルーターで扱う（新しいタブで開くなどはブラウザに任せる） */
export function handleLink(event: MouseEvent, href: string): void {
  if (event.defaultPrevented || event.button !== 0) return;
  if (event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return;
  event.preventDefault();
  router.navigate(href);
}
