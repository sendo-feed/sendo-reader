<script lang="ts">
  import type { Snippet } from "svelte";
  import type { createXEmbedQueue, XEmbedRequest } from "../lib/x-embed-queue";

  let {
    href,
    children,
    enqueue,
    nodePath,
    awaitingPosition,
  }: {
    href: string;
    children: Snippet;
    enqueue: ReturnType<typeof createXEmbedQueue>;
    nodePath: string;
    awaitingPosition: boolean;
  } = $props();
  const origin = __X_EMBED_ORIGIN__;
  // セッションのクッキーはポートで分かれないため、同じホスト名は使えない。
  const separateHost =
    origin !== "" &&
    new URL(origin).hostname.replace(/\.$/, "") !== window.location.hostname.replace(/\.$/, "");
  let block = $state<HTMLElement>();
  let frame = $state<HTMLIFrameElement>();
  let fallback = $state<HTMLDetailsElement>();
  let quoteOpen = $state(true);
  let preserveQuote = false;
  let active = $state(false);
  let settled = $state(false);
  let request: XEmbedRequest | undefined;
  let inView = false;
  let restoreSignal: AbortSignal | undefined;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let height = $state(0);
  const src = $derived(
    active && separateHost ? `${origin}/#${new URL(href).pathname.split("/").at(-1)}` : "",
  );

  function updateRequest() {
    const forRestore = restoreSignal !== undefined && !restoreSignal.aborted;
    if (request !== undefined) {
      if (inView) request.prioritize();
      else if (forRestore) request.deprioritize();
      else if (request.cancelPending()) request = undefined;
      return;
    }
    if (!inView && !forRestore) return;
    request = enqueue(() => {
      active = true;
      timer = setTimeout(() => finish(0), 15_000);
    }, inView);
  }

  function finish(value: number) {
    if (value === 0) quoteOpen = true;
    else if (height === 0) {
      quoteOpen = preserveQuote || (fallback?.contains(document.activeElement) ?? false);
      preserveQuote = false;
    }
    height = value;
    if (value === 0) active = false;
    if (settled) return;
    settled = true;
    clearTimeout(timer);
    request?.cancel();
  }

  $effect(() => {
    const element = block;
    // 履歴から開き直すときは、先頭に一瞬見える投稿を読み込まない。
    if (element === undefined || !separateHost || awaitingPosition || active || settled) return;
    const observer = new IntersectionObserver((entries) => {
      if (awaitingPosition || active || settled) return;
      inView = entries.at(-1)?.isIntersecting ?? false;
      updateRequest();
    });
    observer.observe(element);
    return () => {
      observer.disconnect();
      inView = false;
      if (awaitingPosition) updateRequest();
    };
  });

  $effect(() => {
    const element = block;
    if (element === undefined || !separateHost) return;
    const loadForRestore = (event: Event) => {
      const signal = (event as CustomEvent<AbortSignal>).detail;
      if (signal.aborted) return;
      restoreSignal = signal;
      signal.addEventListener(
        "abort",
        () => {
          if (restoreSignal !== signal) return;
          restoreSignal = undefined;
          updateRequest();
        },
        { once: true },
      );
      updateRequest();
    };
    const keepQuoteOpen = () => {
      preserveQuote = height === 0;
      quoteOpen = true;
    };
    element.addEventListener("sendo:open-x-post", loadForRestore);
    element.addEventListener("sendo:restore-x-quote", keepQuoteOpen);
    return () => {
      element.removeEventListener("sendo:open-x-post", loadForRestore);
      element.removeEventListener("sendo:restore-x-quote", keepQuoteOpen);
      clearTimeout(timer);
      request?.cancel();
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
  data-content-node={nodePath}
  data-x-embed={separateHost ? (settled ? "settled" : "waiting") : undefined}
>
  <div>
    {#if src}
      <iframe
        bind:this={frame}
        {src}
        {height}
        data-x-widget
        title="X の投稿"
        sandbox="allow-scripts allow-same-origin"
        referrerpolicy="no-referrer"
      ></iframe>
    {/if}
  </div>
  <details data-x-quote bind:this={fallback} bind:open={quoteOpen}>
    <summary hidden={height === 0}>記事中の引用</summary>
    {@render children()}
  </details>
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
