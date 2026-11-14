<script lang="ts">
  import type { Article, ArticleQuery, MarkReadScope } from "@sendo-reader/core";
  import { untrack } from "svelte";
  import { useReader } from "../lib/context";
  import { fromNow } from "../lib/format";
  import { router } from "../lib/router.svelte";

  let {
    query,
    title,
    markScope,
  }: { query: ArticleQuery; title: string; markScope: MarkReadScope | null } = $props();

  const reader = useReader();
  const PAGE = 50;

  let articles = $state<Article[]>([]);
  let hasMore = $state(false);
  let loading = $state(true);
  /** 一覧を読んだあとに届いた、条件に合う記事の数 */
  let fresh = $state(0);

  /**
   * 読み出しの世代。条件を変えて読み直すたびに増やし、それより前に始めた読み出し（前の条件の
   * 一覧を元にした読み直しなど）の結果は当てない
   */
  let generation = 0;

  async function load() {
    const current = ++generation;
    loading = true;
    const page = await reader.client.listArticles({ ...query, limit: PAGE });
    if (current !== generation) return;
    articles = page;
    hasMore = page.length === PAGE;
    fresh = 0;
    loading = false;
  }

  /** 続きを読んでいる（続けて押しても、同じページを二重に足さない） */
  let loadingMore = $state(false);

  async function loadMore() {
    const last = articles.at(-1);
    if (last === undefined || loadingMore) return;
    const current = generation;
    loadingMore = true;
    try {
      const page = await reader.client.listArticles({
        ...query,
        limit: PAGE,
        after: { publishedAt: last.publishedAt, id: last.id },
      });
      if (current !== generation) return;
      const shown = new Set(articles.map((article) => article.id));
      articles = [...articles, ...page.filter((article) => !shown.has(article.id))];
      hasMore = page.length === PAGE;
    } finally {
      loadingMore = false;
    }
  }

  /**
   * 記事が変わったら、出している記事の状態だけを読み直す（既読にした記事を、読んでいる途中の
   * 未読の一覧から消さない）。新しく届いた記事は数だけ出し、押したら読み直す。
   */
  async function refresh() {
    if (articles.length === 0) {
      await load();
      return;
    }
    const current = generation;
    const requested = articles.map((article) => article.id);
    const shown = new Set(requested);
    const [latest, top] = await Promise.all([
      Promise.all(requested.map((id) => reader.client.getArticle(id))),
      reader.client.listArticles({ ...query, limit: PAGE }),
    ]);
    if (current !== generation) return;
    // 読み直した記事だけを差し替える（読み直している間に「もっと読む」で足した記事は残す。
    // 読み直して見つからなかった記事は、手元から消えたので外す）
    const byId = new Map(
      latest.filter((article): article is Article => article !== null).map((a) => [a.id, a]),
    );
    articles = articles.flatMap((article) =>
      shown.has(article.id) ? (byId.get(article.id) ?? []) : [article],
    );
    fresh = top.filter((article) => !shown.has(article.id)).length;
  }

  // 条件が変わったときだけ読み直す（記事を開いたり閉じたりしただけでは読み直さない。
  // query は URL が変わるたびに作り直されるので、中身を文字列にして比べる）
  const queryKey = $derived(JSON.stringify(query));
  $effect(() => {
    void queryKey;
    untrack(() => void load());
  });

  // 手元の記事が変わったら、状態を読み直す
  $effect(() => {
    void reader.articlesVersion;
    untrack(() => void refresh());
  });

  async function markAllRead() {
    if (markScope === null) return;
    await reader.client.markAllRead(markScope);
  }
</script>

<section class="article-list" aria-label={title}>
  <header>
    <h2>{title}</h2>
    {#if markScope !== null}
      <button type="button" onclick={markAllRead}>すべて既読にする</button>
    {/if}
  </header>

  {#if fresh > 0}
    <button type="button" class="fresh" onclick={load}>新しい記事 {fresh} 件を読む</button>
  {/if}

  {#if loading}
    <p class="empty">読んでいます…</p>
  {:else if articles.length === 0}
    <p class="empty">記事はありません。</p>
  {:else}
    <ol>
      {#each articles as article (article.id)}
        <li>
          <button
            type="button"
            class="item"
            class:unread={article.readAt === null}
            aria-current={router.articleId === article.id ? "true" : undefined}
            onclick={() => router.openArticle(article.id)}
          >
            <span class="title">{article.title ?? "（タイトルなし）"}</span>
            <span class="meta">
              {#if article.starredAt !== null}
                <span class="star" role="img" aria-label="スター">★</span>
              {/if}
              {reader.feedTitle(article.feedId)}
              ・ {fromNow(article.publishedAt)}
            </span>
          </button>
        </li>
      {/each}
    </ol>
    {#if hasMore}
      <button type="button" class="more" onclick={loadMore} disabled={loadingMore}>
        {loadingMore ? "読んでいます…" : "もっと読む"}
      </button>
    {/if}
  {/if}
</section>

<style>
  .article-list {
    display: flex;
    flex-direction: column;
    overflow-y: auto;
    border-right: 1px solid var(--border);
  }

  header {
    position: sticky;
    top: 0;
    display: flex;
    gap: 0.5rem;
    align-items: center;
    justify-content: space-between;
    padding: 0.75rem;
    background: var(--background);
    border-bottom: 1px solid var(--border);
  }

  h2 {
    margin: 0;
    font-size: 1.1rem;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }

  ol {
    list-style: none;
    margin: 0;
    padding: 0;
  }

  .item {
    display: grid;
    gap: 0.25rem;
    width: 100%;
    padding: 0.75rem;
    border: 0;
    border-bottom: 1px solid var(--border);
    border-radius: 0;
    background: none;
    color: var(--muted);
    text-align: start;
    font: inherit;
  }

  .item:hover {
    background: var(--hover);
  }

  .item[aria-current="true"] {
    background: var(--selected);
  }

  .item.unread {
    color: inherit;
  }

  .item.unread .title {
    font-weight: 600;
  }

  .meta {
    font-size: 0.8rem;
    color: var(--muted);
  }

  .star {
    color: var(--accent);
  }

  .empty {
    padding: 0.75rem;
    color: var(--muted);
  }

  .fresh,
  .more {
    margin: 0.5rem 0.75rem;
  }
</style>
