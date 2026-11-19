<script lang="ts">
  import type { Snippet } from "svelte";

  let { href, automatic, children }: { href: string; automatic: boolean; children: Snippet } =
    $props();
  const origin = __X_EMBED_ORIGIN__;
  // セッションのクッキーはポートで分かれないため、同じホスト名は使えない。
  const separateHost =
    origin !== "" &&
    new URL(origin).hostname.replace(/\.$/, "") !== window.location.hostname.replace(/\.$/, "");
  let frame = $state<HTMLIFrameElement>();
  let height = $state(0);
  const src = $derived(
    automatic && separateHost ? `${origin}/#${new URL(href).pathname.split("/").at(-1)}` : "",
  );

  function resize(event: MessageEvent) {
    if (event.origin !== origin || event.source !== frame?.contentWindow) return;
    const data: unknown = event.data;
    if (
      typeof data === "object" &&
      data !== null &&
      "type" in data &&
      data.type === "sendo:x-post-height" &&
      "height" in data &&
      typeof data.height === "number" &&
      Number.isInteger(data.height) &&
      data.height >= 0 &&
      data.height <= 4000
    ) {
      height = data.height;
    }
  }
</script>

<svelte:window onmessage={resize} />

<blockquote>
  {#if src}
    <iframe
      bind:this={frame}
      {src}
      {height}
      title="X の投稿"
      loading="lazy"
      sandbox="allow-scripts allow-same-origin"
      referrerpolicy="no-referrer"
    ></iframe>
  {/if}
  {#if height === 0}
    {@render children()}
  {/if}
  <a {href} target="_blank" rel="noopener noreferrer nofollow">X で開く</a>
</blockquote>

<style>
  iframe {
    display: block;
    border: 0;
    width: 100%;
    max-width: 550px;
  }
</style>
