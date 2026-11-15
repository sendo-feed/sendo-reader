<script lang="ts">
  import { type Article, toSafeHttpUrl } from "@sendo-reader/core";
  import { untrack } from "svelte";
  import { useReader } from "../lib/context";
  import { formatDateTime } from "../lib/format";
  import type { ArticleListState } from "../lib/list.svelte";
  import { handleLink, router, viewHref } from "../lib/router.svelte";
  import Icon from "./Icon.svelte";

  let {
    articleId,
    list,
    onstep,
  }: {
    articleId: string | null;
    list: ArticleListState;
    /** 一覧の前（-1）・次（1）の記事に移る */
    onstep: (delta: 1 | -1) => void;
  } = $props();

  const reader = useReader();
  let article = $state<Article | null>(null);
  let missing = $state(false);
  /** 開いたときに一度だけ既読にする（「未読に戻す」を押したあとに、また既読にしない） */
  let markedFor: string | null = null;
  let scroller = $state<HTMLElement>();

  async function load(id: string) {
    const found = await reader.client.getArticle(id);
    if (id !== articleId) return;
    article = found;
    missing = found === null;
    // 開いて初めて読み出したときだけ、未読なら既読にする（既読の記事を開いたときも、
    // 済んだことを覚える。表示している間に「未読に戻す」を押したら、そのままにする）
    if (found !== null && markedFor !== id) {
      markedFor = id;
      if (found.readAt === null) {
        list.patch(id, { readAt: Date.now() });
        await reader.client.setRead(id, true);
      }
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
        // 一覧にある記事は、手元の DB を待たずにすぐ出す（そのあと読み直す）
        const listed = list.find(id);
        if (listed !== null) {
          article = listed;
          missing = false;
        }
        scroller?.scrollTo({ top: 0 });
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
  export async function toggle(field: "readAt" | "starredAt") {
    const current = article;
    if (current === null) return;
    const on = current[field] === null;
    const change = { [field]: on ? Date.now() : null };
    article = { ...current, ...change };
    list.patch(current.id, change);
    saveError = null;
    try {
      if (field === "readAt") await reader.client.setRead(current.id, on);
      else await reader.client.setStarred(current.id, on);
    } catch {
      // 手元に書けなかった（容量不足など）。表示を手元の DB の状態に戻す
      saveError = "保存できませんでした。";
      void list.refresh();
      if (articleId === current.id) await load(current.id);
    }
  }

  /** 元の記事を新しいタブで開く（リンクにできる URL のときだけ） */
  export function openOriginal() {
    if (link !== null) window.open(link, "_blank", "noopener,noreferrer");
  }

  /** 書き込みに失敗したときの知らせ */
  let saveError = $state<string | null>(null);

  /** 記事の URL は、http ／ https のものだけをリンクにする（記事のデータは信頼できない） */
  const link = $derived(article === null ? null : toSafeHttpUrl(article.url));

  const feedHref = $derived(
    article === null ? "/" : viewHref({ kind: "feed", id: article.feedId }),
  );

  /** 要約は、空行で段落に分けて出す（HTML としては出さない） */
  const paragraphs = $derived(
    (article?.summary ?? "")
      .split(/\n\s*\n/)
      .map((text) => text.trim())
      .filter((text) => text !== ""),
  );
</script>

<article class="article-view" aria-live="polite" bind:this={scroller}>
  {#if article !== null}
    <div class="toolbar">
      <button
        type="button"
        class="icon-button back"
        aria-label="一覧に戻る"
        title="一覧に戻る（Esc）"
        onclick={() => router.openArticle(null)}
      >
        <Icon name="arrowLeft" />
      </button>
      <button
        type="button"
        class="icon-button close"
        aria-label="記事を閉じる"
        title="記事を閉じる（Esc）"
        onclick={() => router.openArticle(null)}
      >
        <Icon name="close" />
      </button>
      <button
        type="button"
        class="icon-button"
        aria-label="前の記事"
        title="前の記事（k）"
        onclick={() => onstep(-1)}
      >
        <Icon name="arrowUp" />
      </button>
      <button
        type="button"
        class="icon-button"
        aria-label="次の記事"
        title="次の記事（j）"
        onclick={() => onstep(1)}
      >
        <Icon name="arrowDown" />
      </button>
      <span class="spacer"
        >{#if saveError !== null}
          <span class="error" role="alert">{saveError}</span>
        {/if}</span
      >
      <button
        type="button"
        class="icon-button"
        aria-label={article.readAt === null ? "既読にする" : "未読に戻す"}
        title={article.readAt === null ? "既読にする（m）" : "未読に戻す（m）"}
        onclick={() => toggle("readAt")}
      >
        <Icon name={article.readAt === null ? "check" : "circle"} />
      </button>
      <button
        type="button"
        class="icon-button star"
        aria-pressed={article.starredAt !== null}
        aria-label={article.starredAt === null ? "スターを付ける" : "スターを外す"}
        title={article.starredAt === null ? "スターを付ける（s）" : "スターを外す（s）"}
        onclick={() => toggle("starredAt")}
      >
        <Icon name="star" filled={article.starredAt !== null} />
      </button>
      {#if link !== null}
        <a
          class="open"
          href={link}
          target="_blank"
          rel="noopener noreferrer"
          aria-label="元の記事を開く"
          title="元の記事を開く（v）"
        >
          <Icon name="external" />
        </a>
      {/if}
    </div>

    <div class="content">
      <header>
        <p class="meta">
          <a class="feed" href={feedHref} onclick={(e) => handleLink(e, feedHref)}>
            {reader.feedTitle(article.feedId)}
          </a>
        </p>
        <h1>{article.title ?? "（タイトルなし）"}</h1>
        <p class="meta">
          <time datetime={new Date(article.publishedAt).toISOString()}>
            {formatDateTime(article.publishedAt)}
          </time>
          {#if article.author !== null}
            <span>・ {article.author}</span>
          {/if}
        </p>
      </header>
      {#each paragraphs as text, index (index)}
        <p class="summary">{text}</p>
      {/each}
      {#if link !== null}
        <p>
          <a class="read-on" href={link} target="_blank" rel="noopener noreferrer">
            元の記事を読む
            <Icon name="external" />
          </a>
        </p>
      {/if}
    </div>
  {:else if missing}
    <div class="placeholder"><p>この記事は手元にありません。</p></div>
  {:else}
    <div class="placeholder">
      <Icon name="inbox" />
      <p>記事を選んでください。</p>
      <p class="hint"><kbd>j</kbd> <kbd>k</kbd> で次・前の記事、<kbd>?</kbd> で操作の一覧</p>
    </div>
  {/if}
</article>

<style>
  .article-view {
    display: flex;
    flex-direction: column;
    min-width: 0;
    overflow-y: auto;
    background: var(--background);
  }

  .toolbar {
    position: sticky;
    top: 0;
    z-index: 1;
    display: flex;
    align-items: center;
    gap: 0.125rem;
    min-height: 3.25rem;
    padding: 0.5rem;
    border-bottom: 1px solid var(--border);
    background: var(--background);
  }

  .spacer {
    flex: 1;
    min-width: 0;
    padding: 0 0.5rem;
    text-align: end;
  }

  .star[aria-pressed="true"] {
    color: var(--star);
  }

  .open {
    display: inline-grid;
    place-items: center;
    width: 2.25rem;
    height: 2.25rem;
    border-radius: var(--radius-small);
    color: var(--muted);
  }

  .open:hover {
    background: var(--hover);
    color: var(--text);
  }

  .content {
    width: 100%;
    max-width: 44rem;
    margin: 0 auto;
    padding: 1.75rem 1.5rem calc(4rem + env(safe-area-inset-bottom, 0px));
  }

  h1 {
    margin: 0.375rem 0 0.5rem;
    font-size: 1.625rem;
    line-height: 1.4;
    letter-spacing: 0.01em;
    overflow-wrap: anywhere;
  }

  .meta {
    margin: 0;
    color: var(--muted);
    font-size: 0.875rem;
  }

  .feed {
    color: var(--accent);
    font-weight: 600;
    text-decoration: none;
  }

  .feed:hover {
    text-decoration: underline;
  }

  header {
    margin-bottom: 1.5rem;
    padding-bottom: 1.25rem;
    border-bottom: 1px solid var(--border);
  }

  .summary {
    margin: 0 0 1.25em;
    font-size: 1.0625rem;
    line-height: 1.9;
    white-space: pre-wrap;
    overflow-wrap: anywhere;
  }

  .read-on {
    display: inline-flex;
    align-items: center;
    gap: 0.5rem;
    margin-top: 0.75rem;
    padding: 0.5rem 1rem;
    border: 1px solid var(--accent);
    border-radius: 999px;
    color: var(--accent);
    font-weight: 600;
    text-decoration: none;
  }

  .read-on:hover {
    background: var(--selected);
  }

  .placeholder {
    display: grid;
    justify-items: center;
    gap: 0.5rem;
    margin: auto;
    padding: 2rem;
    color: var(--muted);
    text-align: center;
  }

  .placeholder :global(.icon) {
    width: 3rem;
    height: 3rem;
    color: var(--border-strong);
  }

  .placeholder p {
    margin: 0;
  }

  .hint {
    font-size: 0.8125rem;
    color: var(--faint);
  }

  .error {
    color: var(--danger);
    font-size: 0.875rem;
  }

  .back {
    display: none;
  }

  @media (max-width: 56rem) {
    .back {
      display: inline-grid;
    }

    /* 狭い画面では、操作を親指の届く下に置く */
    .toolbar {
      order: 2;
      top: auto;
      bottom: 0;
      justify-content: space-between;
      margin-top: auto;
      padding: 0.375rem 0.75rem calc(0.375rem + env(safe-area-inset-bottom, 0px));
      border-top: 1px solid var(--border);
      border-bottom: 0;
    }

    .spacer:empty {
      display: none;
    }

    .open {
      width: 2.75rem;
      height: 2.75rem;
    }

    .close,
    .hint {
      display: none;
    }

    .content {
      padding-inline: 1.125rem;
    }

    h1 {
      font-size: 1.375rem;
    }
  }
</style>
