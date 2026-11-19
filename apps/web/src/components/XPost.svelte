<script lang="ts">
  import type { Snippet } from "svelte";

  let {
    href,
    children,
    enqueue,
  }: {
    href: string;
    children: Snippet;
    enqueue: (load: (done: () => void) => void) => () => void;
  } = $props();
  const origin = __X_EMBED_ORIGIN__;
  // セッションのクッキーはポートで分かれないため、同じホスト名は使えない。
  const separateHost =
    origin !== "" &&
    new URL(origin).hostname.replace(/\.$/, "") !== window.location.hostname.replace(/\.$/, "");
  let block = $state<HTMLElement>();
  let frame = $state<HTMLIFrameElement>();
  let active = $state(false);
  let settled = $state(false);
  let cancelLoad: (() => void) | undefined;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let height = $state(0);
  const src = $derived(
    active && separateHost ? `${origin}/#${new URL(href).pathname.split("/").at(-1)}` : "",
  );

  function requestLoad() {
    if (cancelLoad !== undefined) return;
    cancelLoad = enqueue(() => {
      active = true;
      timer = setTimeout(() => finish(0), 15_000);
    });
  }

  function finish(value: number) {
    height = value;
    if (value === 0) active = false;
    if (settled) return;
    settled = true;
    clearTimeout(timer);
    cancelLoad?.();
  }

  $effect(() => {
    const element = block;
    if (element === undefined || !separateHost) return;
    const observer = new IntersectionObserver(
      (entries) => {
        if (entries.some((entry) => entry.isIntersecting)) {
          observer.disconnect();
          requestLoad();
        }
      },
      { rootMargin: "240px" },
    );
    observer.observe(element);
    element.addEventListener("sendo:open-x-post", requestLoad);
    return () => {
      observer.disconnect();
      element.removeEventListener("sendo:open-x-post", requestLoad);
      clearTimeout(timer);
      cancelLoad?.();
    };
  });

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
      finish(data.height);
    }
  }
</script>

<svelte:window onmessage={resize} />

<blockquote
  bind:this={block}
  data-x-embed={separateHost ? (settled ? "settled" : "waiting") : undefined}
>
  {#if src}
    <iframe
      bind:this={frame}
      {src}
      {height}
      title="X の投稿"
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
