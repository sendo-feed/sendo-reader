<script lang="ts">
  import { type Article, toSafeHttpUrl } from "@sendo-reader/core";
  import { untrack } from "svelte";
  import { useReader } from "../lib/context";
  import { formatDateTime } from "../lib/format";
  import { router } from "../lib/router.svelte";

  let { articleId }: { articleId: string | null } = $props();

  const reader = useReader();
  let article = $state<Article | null>(null);
  let missing = $state(false);
  /** 開いたときに一度だけ既読にする（「未読に戻す」を押したあとに、また既読にしない） */
  let markedFor: string | null = null;

  async function load(id: string) {
    const found = await reader.client.getArticle(id);
    if (id !== articleId) return;
    article = found;
    missing = found === null;
    // 開いて初めて読み出したときだけ、未読なら既読にする（既読の記事を開いたときも、
    // 済んだことを覚える。表示している間に「未読に戻す」を押したら、そのままにする）
    if (found !== null && markedFor !== id) {
      markedFor = id;
      if (found.readAt === null) await reader.client.setRead(id, true);
    }
  }

  $effect(() => {
    const id = articleId;
    untrack(() => {
      // 開く記事が替わったら（閉じたときも）、次に開いたときにまた既読にする
      if (markedFor !== id) markedFor = null;
      saveError = null;
      if (id === null) {
        article = null;
        missing = false;
      } else {
        void load(id);
      }
    });
  });

  $effect(() => {
    void reader.articlesVersion;
    untrack(() => {
      if (articleId !== null) void load(articleId);
    });
  });

  /**
   * 押したらすぐ画面に出し（楽観的な更新）、手元の DB への書き込みはそのあとに待つ
   * （docs/decisions/performance.md の操作の反応 100ms）
   */
  async function toggle(field: "readAt" | "starredAt") {
    const current = article;
    if (current === null) return;
    const on = current[field] === null;
    article = { ...current, [field]: on ? Date.now() : null };
    saveError = null;
    try {
      if (field === "readAt") await reader.client.setRead(current.id, on);
      else await reader.client.setStarred(current.id, on);
    } catch {
      // 手元に書けなかった（容量不足など）。表示を手元の DB の状態に戻す
      saveError = "保存できませんでした。";
      if (articleId === current.id) await load(current.id);
    }
  }

  /** 書き込みに失敗したときの知らせ */
  let saveError = $state<string | null>(null);

  /** 記事の URL は、http ／ https のものだけをリンクにする（記事のデータは信頼できない） */
  const link = $derived(article === null ? null : toSafeHttpUrl(article.url));
</script>

<article class="article-view" aria-live="polite">
  {#if article !== null}
    <header>
      <button type="button" class="back" onclick={() => router.openArticle(null)}>
        一覧に戻る
      </button>
      <p class="feed">{reader.feedTitle(article.feedId)}</p>
      <h1>{article.title ?? "（タイトルなし）"}</h1>
      <p class="meta">
        {formatDateTime(article.publishedAt)}
        {#if article.author !== null}
          ・ {article.author}
        {/if}
      </p>
      <div class="actions">
        <button
          type="button"
          aria-pressed={article.starredAt !== null}
          onclick={() => toggle("starredAt")}
        >
          {article.starredAt === null ? "☆ スターを付ける" : "★ スターを外す"}
        </button>
        <button type="button" onclick={() => toggle("readAt")}>
          {article.readAt === null ? "既読にする" : "未読に戻す"}
        </button>
        {#if saveError !== null}
          <span class="error" role="alert">{saveError}</span>
        {/if}
        {#if link !== null}
          <a href={link} target="_blank" rel="noopener noreferrer">元の記事を開く</a>
        {/if}
      </div>
    </header>
    {#if article.summary !== null}
      <p class="summary">{article.summary}</p>
    {/if}
  {:else if missing}
    <p class="empty">この記事は手元にありません。</p>
  {:else}
    <p class="empty">記事を選んでください。</p>
  {/if}
</article>

<style>
  .article-view {
    overflow-y: auto;
    padding: 1rem 1.5rem;
  }

  h1 {
    margin: 0.25rem 0;
    font-size: 1.5rem;
    line-height: 1.4;
  }

  .feed,
  .meta {
    margin: 0;
    color: var(--muted);
    font-size: 0.9rem;
  }

  .actions {
    display: flex;
    flex-wrap: wrap;
    gap: 0.5rem;
    align-items: center;
    margin: 1rem 0;
  }

  .summary {
    max-width: 40rem;
    white-space: pre-wrap;
    overflow-wrap: anywhere;
  }

  .empty {
    color: var(--muted);
  }

  .error {
    color: var(--danger);
  }

  .back {
    display: none;
  }

  @media (max-width: 60rem) {
    .back {
      display: inline-block;
      margin-bottom: 0.5rem;
    }
  }
</style>
