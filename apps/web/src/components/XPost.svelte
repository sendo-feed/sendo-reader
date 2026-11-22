<script lang="ts">
  import { xPostUrl } from "@sendo-reader/core";
  import type { Snippet } from "svelte";
  import { useXPostLoader, type XPostFrame } from "../lib/x-post.svelte";
  import Icon from "./Icon.svelte";

  /**
   * 記事の中の X の投稿（docs/decisions/embeds.md の 1、2）。sendo が印を付けた引用を、元の引用の
   * まま出し、その下に投稿を X で開くリンクを出す。引用の中の文もリンクの文字も空の引用
   * （出典のリンクだけ、など）からも、投稿を開けるようにする。
   *
   * 隔離フレームのオリジンが設定してあれば、表示範囲に入ったときに、隔離フレームの iframe で公式
   * ウィジェットを読み込む（いつ始めるかは lib/x-post.svelte.ts が決める）。出るまでは元の引用を出し、
   * iframe は場所を取らない。出たら、元の引用を隠す。失敗したら、元の引用のまま。
   *
   * 行き先は、core が確かめた投稿の ID から組み立てる（引用の中のリンクを使わない）。
   */
  let { id, children }: { id: string; children: Snippet } = $props();

  const href = $derived(xPostUrl(id));
  const loader = useXPostLoader();
  let element = $state<HTMLElement>();
  let post = $state<XPostFrame | null>(null);

  $effect(() => {
    if (loader === null || element === undefined) return;
    const added = loader.add(id, element);
    post = added;
    return () => {
      loader.remove(added);
      post = null;
    };
  });

  const shown = $derived(post !== null && post.height !== null);
</script>

<div class="x-post" bind:this={element}>
  {#if post !== null && post.src !== null}
    <iframe
      src={post.src}
      sandbox="allow-scripts allow-same-origin allow-popups allow-popups-to-escape-sandbox"
      allow="fullscreen"
      referrerpolicy="no-referrer"
      title="X の投稿"
      class:shown
      style:height={post.height === null ? undefined : `${post.height}px`}
      onload={(event) => {
        if (event.currentTarget instanceof HTMLIFrameElement) post?.hello(event.currentTarget);
      }}
    ></iframe>
  {/if}
  <blockquote hidden={shown}>{@render children()}</blockquote>
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

  .x-post > blockquote[hidden] {
    display: none;
  }

  /* 幅は本文に合わせる（X のウィジェットは 550px で止まる）。出るまでは、場所を取らない */
  iframe {
    display: block;
    width: 100%;
    max-width: 550px;
    height: 0;
    margin: 0;
    border: 0;
  }

  iframe.shown {
    margin-bottom: 0.5em;
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
