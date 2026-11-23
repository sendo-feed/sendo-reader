<script lang="ts">
  import type { TranslationChip } from "../lib/translation";
  import Icon from "./Icon.svelte";
  import RemoteImage from "./RemoteImage.svelte";
  import TranslationLabel from "./TranslationLabel.svelte";

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
    translationLabel = null,
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
    /** 元の言語と翻訳の状態の枠（lib/translation.ts）。翻訳のない記事は null */
    translationLabel?: TranslationChip[] | null;
    onopen?: (event: MouseEvent) => void;
  } = $props();
</script>

{#snippet contents()}
  <!-- 要約は出さない。行の高さを、どの行も同じにする（docs/decisions/images.md の 5） -->
  <span class="text">
    <span class="title">{title}</span>
    <span class="meta">
      <span class="source">
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
      {#if translationLabel !== null}
        <span class="translation-slot"><TranslationLabel chips={translationLabel} compact /></span>
      {/if}
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
    padding: 0 1rem;
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

  /* 指で横に動かしている間や長く押したときに、文字の選択やリンクのプレビューを出さない（スワイプの邪魔をしない） */
  @media (hover: none) {
    .item {
      -webkit-touch-callout: none;
      user-select: none;
    }
  }

  .item:focus-visible {
    outline-offset: -2px;
  }

  /*
   * メタの並び。保存の印、フィードのアイコン、フィードの名前、時刻（.source）のあとに、翻訳のラベルを
   * 置く（docs/decisions/translation.md の 1）。折り返すのは .source とラベルの間だけで、メタは
   * 最大 2 行。.source の全体のあとにラベルが入りきらないとき（狭い画面、サムネイルのある行、大きな
   * 文字、長い時刻）は、ラベルを次の行に送る。2 行になっても、タイトル 3 行と合わせて行の高さに
   * 収まるよう、行の間を詰める
   */
  .meta {
    display: flex;
    flex-wrap: wrap;
    gap: 0 0.375rem;
    align-items: baseline;
    min-width: 0;
    font-size: 0.75rem;
    line-height: 1.35;
    color: var(--muted);
  }

  /* 1 行で折り返さない。入りきらなければ、フィードの名前を縮めて省略記号で切る */
  .source {
    display: flex;
    gap: 0.375rem;
    align-items: baseline;
    min-width: 0;
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

  /*
   * 翻訳のラベル（言語と状態の枠。docs/decisions/translation.md の 1）。時刻のあとに並べる
   * （入りきらなければ、上のとおり次の行に送る）。枠で分かれるので、区切りの「/」は付けない。
   * 次の行でも幅が足りないとき（とても狭い画面と大きな文字）は、枠の中の文字を省略記号で切り、
   * 3 行にしない
   */
  .translation-slot {
    display: inline-flex;
    flex: 0 1 auto;
    min-width: 0;
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

  /* 未読は、タイトルの色と太さだけで示す（印は付けない。読む画面の没入感を優先する） */
  .item.unread .title {
    color: var(--text);
    font-weight: 600;
  }
</style>
