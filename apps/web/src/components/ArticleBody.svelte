<script lang="ts">
  import type { ContentNode } from "@sendo-reader/core";
  import { createXEmbedQueue } from "../lib/x-embed-queue";
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
  let {
    nodes,
    awaitingPosition = false,
    scrollRoot = null,
    rootMargin = "0px",
  }: {
    nodes: readonly ContentNode[];
    awaitingPosition?: boolean;
    scrollRoot?: HTMLElement | null;
    rootMargin?: string;
  } = $props();

  const enqueue = createXEmbedQueue();

  function hasXPost(content: readonly ContentNode[]): boolean {
    return content.some(
      (node) => typeof node !== "string" && (node.xPost !== undefined || hasXPost(node.children)),
    );
  }

  const trackText = $derived(__X_EMBED_ORIGIN__ !== "" && hasXPost(nodes));
</script>

{#snippet render(children: readonly ContentNode[], parentPath: string, trackDirectText = false)}
  {#each children as node, index (index)}
    {@const nodePath = `${parentPath}${index}`}
    {@const childPath = `${nodePath}.`}
    {#if typeof node === "string"}
      {#if trackDirectText && node.trim() !== ""}
        <span data-content-node={nodePath} data-content-text>{node}</span>
      {:else}
        {node}
      {/if}
    {:else if node.tag === "br"}
      <br data-content-node={nodePath}>
    {:else if node.tag === "hr"}
      <hr data-content-node={nodePath}>
    {:else if node.tag === "img"}
      <RemoteImage
        src={node.src ?? null}
        alt={node.alt ?? ""}
        width={node.width}
        height={node.height}
        {nodePath}
        inline
      />
    {:else if node.xPost !== undefined}
      {#key node.xPost}
        <XPost href={node.xPost} {enqueue} {nodePath} {awaitingPosition} {scrollRoot} {rootMargin}>
          {@render render(node.children, childPath, trackText)}
        </XPost>
      {/key}
    {:else if node.tag === "a"}
      <a
        data-content-node={nodePath}
        href={node.href}
        target="_blank"
        rel="noopener noreferrer nofollow"
        >{@render render(node.children, childPath)}</a
      >
    {:else if node.tag === "table"}
      <div class="table-scroll" data-content-node={nodePath}>
        <table>
          {@render render(node.children, childPath)}
        </table>
      </div>
    {:else if node.tag === "td"}
      <td data-content-node={nodePath} colspan={node.colspan} rowspan={node.rowspan}>
        {@render render(node.children, childPath)}
      </td>
    {:else if node.tag === "th"}
      <th data-content-node={nodePath} colspan={node.colspan} rowspan={node.rowspan}>
        {@render render(node.children, childPath)}
      </th>
    {:else if node.tag === "ol"}
      <ol data-content-node={nodePath} start={node.start}>
        {@render render(node.children, childPath)}
      </ol>
    {:else}
      <svelte:element data-content-node={nodePath} this={node.tag}
        >{@render render(
          node.children,
          childPath,
          trackText && ["div", "blockquote", "p", "li"].includes(node.tag),
        )}</svelte:element
      >
    {/if}
  {/each}
{/snippet}

<div class="body">{@render render(nodes, "", trackText)}</div>

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
