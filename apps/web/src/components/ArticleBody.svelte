<script lang="ts">
  import type { ContentNode } from "@sendo-reader/core";
  import RemoteImage from "./RemoteImage.svelte";
  import XPost from "./XPost.svelte";

  /**
   * 記事の本文を出す（sendo の docs/decisions/content.md の 6）。本文を出すところは、この部品だけ。
   *
   * 本文は信頼できない HTML なので、HTML の文字列は受け取らない。受け取るのは、core が通すと
   * 決めたタグと属性だけにした木（packages/core の content/parse.ts）で、ここで要素を 1 つずつ
   * 組み立てる（{@html} や innerHTML は使わない）。文字は、文字として出す。
   *
   * - リンクは、新しいタブで開く（同じタブで開くと、読んでいた場所を失う）。target と rel は
   *   ここで付ける
   * - 画像は RemoteImage で出す（見えた分だけ取る。読めなければ出さない）
   * - 見た目は、ここの CSS だけで決まる（本文は class も style も持たない）。表とコードは、
   *   横にあふれたら、その中で動かす
   */
  let { nodes }: { nodes: readonly ContentNode[] } = $props();

  const waiting = new Set<() => void>();
  let loading = 0;

  // 見えてきた投稿から読み込み、同時に初期化する公式ウィジェットを抑える。
  function enqueue(load: (done: () => void) => void): () => void {
    let active = false;
    const done = () => {
      if (!active) return;
      active = false;
      loading -= 1;
      waiting.values().next().value?.();
    };
    const start = () => {
      waiting.delete(start);
      active = true;
      loading += 1;
      load(done);
    };
    if (loading < 4) start();
    else waiting.add(start);
    return () => {
      waiting.delete(start);
      done();
    };
  }
</script>

{#snippet render(children: readonly ContentNode[])}
  {#each children as node, index (index)}
    {#if typeof node === "string"}
      {node}
    {:else if node.tag === "br"}
      <br>
    {:else if node.tag === "hr"}
      <hr>
    {:else if node.tag === "img"}
      <RemoteImage
        src={node.src ?? null}
        alt={node.alt ?? ""}
        width={node.width}
        height={node.height}
        inline
      />
    {:else if node.xPost !== undefined}
      {#key node.xPost}
        <XPost href={node.xPost} {enqueue}> {@render render(node.children)} </XPost>
      {/key}
    {:else if node.tag === "a"}
      <a href={node.href} target="_blank" rel="noopener noreferrer nofollow"
        >{@render render(node.children)}</a
      >
    {:else if node.tag === "table"}
      <div class="table-scroll">
        <table>
          {@render render(node.children)}
        </table>
      </div>
    {:else if node.tag === "td"}
      <td colspan={node.colspan} rowspan={node.rowspan}>{@render render(node.children)}</td>
    {:else if node.tag === "th"}
      <th colspan={node.colspan} rowspan={node.rowspan}>{@render render(node.children)}</th>
    {:else if node.tag === "ol"}
      <ol start={node.start}>
        {@render render(node.children)}
      </ol>
    {:else}
      <svelte:element this={node.tag}>{@render render(node.children)}</svelte:element>
    {/if}
  {/each}
{/snippet}

<div class="body">{@render render(nodes)}</div>

<style>
  .body {
    font-size: 1.0625rem;
    line-height: 1.9;
    overflow-wrap: anywhere;
  }

  .body :global(:is(p, ul, ol, dl, blockquote, pre, figure, hr, .table-scroll)) {
    margin: 0 0 1.25em;
  }

  .body :global(:is(h1, h2, h3, h4, h5, h6)) {
    margin: 1.75em 0 0.5em;
    font-size: 1.0625rem;
    line-height: 1.5;
  }

  .body :global(:is(h1, h2)) {
    font-size: 1.375rem;
  }

  .body :global(h3) {
    font-size: 1.1875rem;
  }

  .body > :global(:first-child) {
    margin-top: 0;
  }

  .body :global(a) {
    color: var(--accent);
    text-underline-offset: 0.15em;
  }

  .body :global(:is(ul, ol)) {
    padding-inline-start: 1.5em;
  }

  .body :global(li > :is(p, ul, ol):last-child) {
    margin-bottom: 0;
  }

  .body :global(dt) {
    font-weight: 600;
  }

  .body :global(dd) {
    margin-inline-start: 1.5em;
  }

  .body :global(blockquote) {
    padding-inline-start: 1em;
    border-inline-start: 3px solid var(--border-strong);
    color: var(--muted);
  }

  .body :global(blockquote > :last-child) {
    margin-bottom: 0;
  }

  .body :global(hr) {
    border: 0;
    border-top: 1px solid var(--border);
  }

  .body :global(:is(code, kbd, pre)) {
    font-family: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace;
    font-size: 0.875em;
  }

  .body :global(code) {
    padding: 0.1em 0.3em;
    border-radius: 0.25rem;
    background: var(--surface);
  }

  /* 長い行は折り返さず、コードの中で横に動かす */
  .body :global(pre) {
    padding: 0.875em 1em;
    overflow-x: auto;
    border: 1px solid var(--border);
    border-radius: var(--radius-small);
    background: var(--surface);
    line-height: 1.6;
    overflow-wrap: normal;
    white-space: pre;
  }

  .body :global(pre code) {
    padding: 0;
    background: none;
    font-size: inherit;
  }

  /* 幅の広い表は、表の中で横に動かす */
  .table-scroll {
    overflow-x: auto;
  }

  .body :global(table) {
    border-collapse: collapse;
    font-size: 0.9375em;
    line-height: 1.6;
    overflow-wrap: normal;
  }

  .body :global(:is(th, td)) {
    padding: 0.375em 0.625em;
    border: 1px solid var(--border);
    text-align: start;
    vertical-align: top;
  }

  .body :global(th) {
    background: var(--surface);
  }

  .body :global(caption) {
    padding-bottom: 0.375em;
    color: var(--muted);
    font-size: 0.875em;
  }

  .body :global(figure) {
    margin-inline: 0;
  }

  .body :global(figcaption) {
    color: var(--muted);
    font-size: 0.875em;
    line-height: 1.6;
  }
</style>
