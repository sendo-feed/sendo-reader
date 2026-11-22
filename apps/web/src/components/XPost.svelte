<script lang="ts">
  import { xPostUrl } from "@sendo-reader/core";
  import type { Snippet } from "svelte";
  import Icon from "./Icon.svelte";

  /**
   * 記事の中の X の投稿（docs/decisions/embeds.md の 1）。sendo が印を付けた引用を、元の引用の
   * まま出し、その下に投稿を X で開くリンクを出す。引用の中の文もリンクの文字も空の引用
   * （出典のリンクだけ、など）からも、投稿を開けるようにする。
   *
   * 行き先は、core が確かめた投稿の ID から組み立てる（引用の中のリンクを使わない）。X への
   * 通信はしない。
   */
  let { id, children }: { id: string; children: Snippet } = $props();

  const href = $derived(xPostUrl(id));
</script>

<div class="x-post">
  <blockquote>{@render children()}</blockquote>
  {#if href !== null}
    <a class="open" {href} target="_blank" rel="noopener noreferrer nofollow">
      <Icon name="external" />
      <span>Open on X</span>
    </a>
  {/if}
</div>

<style>
  .x-post {
    margin: 0 0 1.25em;
  }

  .x-post > blockquote {
    margin: 0 0 0.5em;
  }

  .open {
    display: inline-flex;
    align-items: center;
    gap: 0.375em;
    font-size: 0.875em;
    line-height: 1.6;
    text-decoration: none;
  }

  .open:hover span {
    text-decoration: underline;
  }

  .open :global(.icon) {
    width: 1.125em;
    height: 1.125em;
  }
</style>
