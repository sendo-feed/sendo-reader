<script lang="ts">
  import type { ArticleQuery } from "@sendo-reader/core";
  import ArticleList from "../components/ArticleList.svelte";
  import ArticleView from "../components/ArticleView.svelte";
  import Sidebar from "../components/Sidebar.svelte";
  import { useReader } from "../lib/context";
  import { router } from "../lib/router.svelte";

  const reader = useReader();

  /** 開いている一覧の、読み出しの条件と見出し */
  const list = $derived.by((): { query: ArticleQuery; title: string; scope: Scope } => {
    const view = router.view;
    switch (view.kind) {
      case "unread":
        return { query: { state: "unread" }, title: "未読", scope: { all: true } };
      case "all":
        return { query: {}, title: "すべて", scope: { all: true } };
      case "starred":
        return { query: { state: "starred" }, title: "スター", scope: null };
      case "feed":
        return {
          query: { feedId: view.id },
          title: reader.feedTitle(view.id),
          scope: { feedId: view.id },
        };
      case "folder":
        return {
          query: { folderId: view.id },
          title: reader.folders.find((f) => f.id === view.id)?.name ?? "フォルダ",
          scope: { folderId: view.id },
        };
    }
  });

  type Scope = { all: true } | { feedId: string } | { folderId: string } | null;
</script>

<div class="reader" class:reading={router.articleId !== null}>
  <Sidebar />
  <ArticleList query={list.query} title={list.title} markScope={list.scope} />
  <ArticleView articleId={router.articleId} />
</div>

<style>
  .reader {
    display: grid;
    grid-template-columns: 16rem 24rem 1fr;
    height: 100dvh;
  }

  /* 狭い画面では、一覧か記事のどちらかだけを出す */
  @media (max-width: 60rem) {
    .reader {
      grid-template-columns: 1fr;
    }

    .reader > :global(nav) {
      display: none;
    }

    .reader.reading > :global(.article-list) {
      display: none;
    }

    .reader:not(.reading) > :global(.article-view) {
      display: none;
    }
  }
</style>
