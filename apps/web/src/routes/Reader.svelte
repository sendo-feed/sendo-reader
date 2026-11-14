<script lang="ts">
  import type { ArticleQuery, MarkReadScope } from "@sendo-reader/core";
  import ArticleList from "../components/ArticleList.svelte";
  import ArticleView from "../components/ArticleView.svelte";
  import Sidebar from "../components/Sidebar.svelte";
  import { useReader } from "../lib/context";
  import { router } from "../lib/router.svelte";
  import Manage from "./Manage.svelte";

  const reader = useReader();

  /** 狭い画面で、左のメニューを開いている */
  let menuOpen = $state(false);

  // 別の画面に移ったら、メニューを閉じる
  $effect(() => {
    void router.url;
    menuOpen = false;
  });

  /** 開いている一覧の、読み出しの条件と見出し */
  const list = $derived.by(
    (): { query: ArticleQuery; title: string; scope: MarkReadScope | null } => {
      const view = router.view;
      switch (view.kind) {
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
        default:
          return { query: { state: "unread" }, title: "未読", scope: { all: true } };
      }
    },
  );
</script>

<div
  class="reader"
  class:managing={router.view.kind === "manage"}
  class:reading={router.articleId !== null}
  class:menu-open={menuOpen}
>
  <Sidebar />
  <button
    type="button"
    class="menu"
    aria-expanded={menuOpen}
    onclick={() => (menuOpen = !menuOpen)}
  >
    {menuOpen ? "閉じる" : "メニュー"}
  </button>
  {#if router.view.kind === "manage"}
    <Manage />
  {:else}
    <ArticleList query={list.query} title={list.title} markScope={list.scope} />
    <ArticleView articleId={router.articleId} />
  {/if}
</div>

<style>
  .reader {
    display: grid;
    grid-template-columns: 16rem 24rem 1fr;
    height: 100dvh;
  }

  .reader.managing {
    grid-template-columns: 16rem 1fr;
  }

  .menu {
    display: none;
  }

  /* 狭い画面では、一覧か記事のどちらかだけを出し、メニューは重ねて開く */
  @media (max-width: 60rem) {
    .reader,
    .reader.managing {
      grid-template-columns: 1fr;
    }

    .menu {
      display: block;
      position: fixed;
      right: 0.75rem;
      bottom: calc(0.75rem + env(safe-area-inset-bottom, 0px));
      z-index: 2;
    }

    .reader > :global(nav) {
      display: none;
    }

    .reader.menu-open > :global(nav) {
      display: flex;
      position: fixed;
      inset: 0;
      z-index: 1;
    }

    .reader.reading > :global(.article-list) {
      display: none;
    }

    .reader:not(.reading) > :global(.article-view) {
      display: none;
    }
  }
</style>
