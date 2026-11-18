<script lang="ts">
  import Icon from "./Icon.svelte";
  import RemoteImage from "./RemoteImage.svelte";

  let {
    title,
    feedTitle,
    time,
    unread,
    saved = false,
    feedIconUrl = null,
    thumbnailUrl = null,
    href,
    current = false,
    onopen,
  }: {
    title: string;
    feedTitle: string;
    time: string;
    unread: boolean;
    saved?: boolean;
    feedIconUrl?: string | null;
    thumbnailUrl?: string | null;
    href?: string;
    current?: boolean;
    onopen?: (event: MouseEvent) => void;
  } = $props();
</script>

{#snippet contents()}
  <!-- 要約は出さない。行の高さを、どの行も同じにする（docs/decisions/images.md の 5） -->
  <span class="text">
    <span class="title">{title}</span>
    <span class="meta">
      <span class="saved-status">
        {#if saved}
          <Icon name="bookmark" filled />
          <span class="visually-hidden">Saved</span>
        {/if}
      </span>
      <span class="feed-icon"><RemoteImage src={feedIconUrl} /></span>
      <span class="feed">{feedTitle}</span>
      <span class="time">{time}</span>
    </span>
  </span>
  {#if thumbnailUrl !== null}
    <span class="thumb"><RemoteImage src={thumbnailUrl} /></span>
  {/if}
{/snippet}

{#if href !== undefined}
  <a class="item" class:unread {href} aria-current={current ? "true" : undefined} onclick={onopen}>
    {@render contents()}
  </a>
{:else}
  <div class="item" class:unread>
    {@render contents()}
  </div>
{/if}

<style>
  /*
   * 行の高さは、どの行も同じにする（タイトルの長さや、画像のある・なしで変えない）。
   * 指で動かしたときに、同じ動かし方で同じ数だけ進む
   */
  .item {
    display: flex;
    gap: 0.75rem;
    align-items: center;
    height: 6.5rem;
    padding: 0 1rem 0 1.375rem;
    color: var(--muted);
    text-decoration: none;
  }

  .text {
    display: grid;
    flex: 1;
    /* 長いフィードの名前やタイトルで、幅を押し広げない（画像の下にもぐらない） */
    grid-template-columns: minmax(0, 1fr);
    align-content: center;
    gap: 0.25rem;
    min-width: 0;
  }

  /*
   * サムネイル。決まった大きさで、はみ出す分は切る（縦横比の違う画像でも、行の高さは
   * 変わらない）。場所は、画像が届く前に取っておく。読み込みに失敗したら、場所ごと出さない
   */
  .thumb {
    flex: none;
    width: 6.75rem;
    height: 4.5rem;
    overflow: hidden;
    border-radius: var(--radius-small);
    background: var(--surface);
  }

  .thumb:not(:has(:global(img))) {
    display: none;
  }

  /* フィードのアイコン。ない・失敗したときは、場所ごと出さない */
  .feed-icon {
    flex: none;
    align-self: center;
    width: 1rem;
    height: 1rem;
    overflow: hidden;
    border-radius: 0.2rem;
  }

  .feed-icon:not(:has(:global(img))) {
    display: none;
  }

  /* 指で長く押したときに、文字の選択やリンクのプレビューを出さない（記事の操作を出す） */
  @media (hover: none) {
    .item {
      -webkit-touch-callout: none;
      user-select: none;
    }
  }

  .item:focus-visible {
    outline-offset: -2px;
  }

  /* 未読の印 */
  .item.unread::before {
    content: "";
    position: absolute;
    top: calc(50% - 0.21875rem);
    left: 0.5rem;
    width: 0.4375rem;
    height: 0.4375rem;
    border-radius: 50%;
    background: var(--accent);
  }

  .meta {
    display: flex;
    gap: 0.375rem;
    align-items: baseline;
    min-width: 0;
    font-size: 0.75rem;
    color: var(--muted);
  }

  /* 保存の有無でフィード名を動かさず、画像にも重ねない。既読になっても色を保つ */
  .saved-status {
    display: inline-flex;
    flex: none;
    align-self: center;
    align-items: center;
    justify-content: center;
    width: 1rem;
    height: 1rem;
    color: var(--accent);
  }

  .saved-status :global(.icon) {
    width: 0.875rem;
    height: 1rem;
  }

  .feed {
    min-width: 0;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }

  .time {
    flex: none;
    color: var(--faint);
    font-variant-numeric: tabular-nums;
  }

  /* フィードの名前と時刻の間の区切り */
  .time::before {
    content: "/ ";
  }

  .title {
    display: -webkit-box;
    overflow: hidden;
    -webkit-box-orient: vertical;
    -webkit-line-clamp: 3;
    line-clamp: 3;
    font-size: 0.9375rem;
    line-height: 1.45;
    overflow-wrap: anywhere;
  }

  .item.unread .title {
    color: var(--text);
    font-weight: 600;
  }
</style>
