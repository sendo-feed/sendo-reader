import type { ArticleScope } from "@sendo-reader/core";
import type { View } from "./router.svelte";

/**
 * 先読みの順のために core に知らせる、開いている一覧の範囲（docs/decisions/local-first.md の
 * 「記事の本文」）。未読だけの絞り込みにはよらない。一覧を出さない画面と Recently Read（既読しか
 * 出さない）は null。言葉が空の Search は core が null として扱う
 */
export function openListScope(view: View, searchQuery: string): ArticleScope | null {
  switch (view.kind) {
    case "all":
      return {};
    case "feed":
      return { feedId: view.id };
    case "folder":
      return { folderId: view.id };
    case "starred":
      return { starred: true };
    case "search":
      return { search: searchQuery };
    case "recentlyRead":
    case "manage":
    case "add":
    case "settings":
      return null;
  }
}
