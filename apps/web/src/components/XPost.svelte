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
   * iframe は場所を取らない。出たら、元の引用を隠す。失敗したら、元の引用のまま。読み込み直し・戻る・
   * 進むで開いたときに、前に出した高さを覚えていれば、元の引用の代わりに、その高さの枠を取る
   * （embeds.md の 5）。
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

  /** 枠の高さ。出たらその高さ、出るまでは覚えた高さ（embeds.md の 5）。どちらもなければ null */
  const boxHeight = $derived(post === null ? null : (post.height ?? post.reserved));
  /** 元の引用の代わりに、枠を出している */
  const shown = $derived(boxHeight !== null);
</script>

<div class="x-post" bind:this={element}>
  {#if post !== null && post.src !== null}
    <div class="frame" class:shown>
      {#key post.attempt}
        <iframe
          src={post.src}
          sandbox="allow-scripts allow-same-origin allow-popups allow-popups-to-escape-sandbox"
          allow="fullscreen"
          referrerpolicy="no-referrer"
          title="X の投稿"
          style:height={boxHeight === null ? undefined : `${boxHeight}px`}
          onload={(event) => {
            if (event.currentTarget instanceof HTMLIFrameElement) post?.hello(event.currentTarget);
          }}
        ></iframe>
      {/key}
      {#if post.height !== null && post.covered}
        <!--
          透明な覆い（embeds.md の 6）。iframe の中のタッチは reader に届かないので、覆いの上の
          スワイプとスクロールを reader が受ける。押すと外れる（その押した操作は、中に届かない）
        -->
        <button
          type="button"
          class="cover"
          aria-label="X の投稿を操作する"
          onclick={() => post?.uncover()}
        ></button>
      {/if}
    </div>
  {:else if boxHeight !== null}
    <!-- 覚えた高さの空の枠。表示範囲に入ったら、ここで読み込む -->
    <div class="reserved" style:height={`${boxHeight}px`}></div>
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
  .frame {
    position: relative;
    max-width: 550px;
  }

  .frame.shown {
    margin-bottom: 0.5em;
  }

  iframe {
    display: block;
    width: 100%;
    height: 0;
    margin: 0;
    border: 0;
  }

  /* ウィジェットと同じ大きさの、透明な覆い。iframe の高さが変わっても、ついていく */
  .cover {
    position: absolute;
    inset: 0;
    width: 100%;
    margin: 0;
    padding: 0;
    border: 0;
    background: transparent;
    cursor: pointer;
  }

  /* 出たときの iframe と同じ場所を取る */
  .reserved {
    max-width: 550px;
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
