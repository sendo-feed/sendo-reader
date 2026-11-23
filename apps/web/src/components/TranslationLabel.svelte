<script lang="ts">
  import type { TranslationChip } from "../lib/translation";

  /**
   * 翻訳のラベル（docs/decisions/translation.md の 1）。項目ごとに角丸の枠で囲んで並べる。言語の枠
   * だけ、どの言語も同じ 1 色で塗り、状態・モデル・思考量の枠は線だけにする。一覧の行と記事の画面で
   * 同じものを使う
   */
  let { chips }: { chips: TranslationChip[] } = $props();
</script>

<!-- 見た目の区切り文字は出さず、読み上げでは枠の間に区切りを入れる（EN, Translated, Haiku 5.5, low） -->
<span class="translation">
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

  .chip.language {
    border-color: var(--language-chip);
    background: var(--language-chip);
    color: var(--on-language-chip);
    font-weight: 600;
  }
</style>
