<script lang="ts">
  import type { TranslationChip } from "../lib/translation";

  /**
   * 翻訳のラベル（docs/decisions/translation.md の 1）。項目ごとに角丸の枠で囲んで並べる。言語の枠
   * だけ、どの言語も同じ 1 色で塗り、状態・モデル・思考量の枠は線だけにする。一覧の行と記事の画面で
   * 同じものを使う
   */
  let {
    chips,
    compact = false,
  }: {
    chips: TranslationChip[];
    /** 一覧の行のように狭いところに置くとき、枠の余白と行の高さを詰める */
    compact?: boolean;
  } = $props();
</script>

<!-- 見た目の区切り文字は出さず、読み上げでは枠の間に区切りを入れる（EN, Translated, Haiku 5.5, low） -->
<span class="translation" class:compact>
  {#each chips as chip, index (chip.kind)}
    {#if index > 0}
      <span class="visually-hidden">, </span>
    {/if}
    <span class="chip" class:language={chip.kind === "language"}>{chip.text}</span>
  {/each}
</span>

<style>
  /* 狭い画面で長いモデルの ID が入っても、枠ごと折り返して横にはみ出さない */
  .translation {
    display: inline-flex;
    flex-wrap: wrap;
    gap: 0.25rem;
    max-width: 100%;
    vertical-align: baseline;
  }

  .chip {
    min-width: 0;
    padding: 0 0.375rem;
    border: 1px solid var(--border-strong);
    border-radius: var(--radius-small);
    color: var(--muted);
    line-height: 1.5;
    overflow-wrap: anywhere;
  }

  /* 一覧の行では、行の高さに収まるよう、枠を低く、余白を狭くする */
  .compact {
    gap: 0.1875rem;
  }

  .compact .chip {
    padding: 0 0.25rem;
    line-height: 1.2;
  }

  /* 線は塗りより濃くし、選んでいる行やマウスで指している行の背景の上でも、枠の形が分かるようにする */
  .chip.language {
    border-color: var(--language-chip-border);
    background: var(--language-chip);
    color: var(--on-language-chip);
    font-weight: 600;
  }
</style>
