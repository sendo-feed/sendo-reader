<script lang="ts">
  import { type Snippet, tick } from "svelte";
  import type { createXEmbedQueue, XEmbedRequest } from "../lib/x-embed-queue";

  let {
    href,
    children,
    enqueue,
    nodePath,
    awaitingPosition,
    restoringScroll,
    scrollRoot,
    toolbarHeight,
  }: {
    href: string;
    children: Snippet;
    enqueue: ReturnType<typeof createXEmbedQueue>;
    nodePath: string;
    awaitingPosition: boolean;
    restoringScroll: boolean;
    scrollRoot: HTMLElement | null;
    toolbarHeight: number;
  } = $props();
  const origin = __X_EMBED_ORIGIN__;
  // セッションのクッキーはポートで分かれないため、同じホスト名は使えない。
  const separateHost =
    origin !== "" &&
    new URL(origin).hostname.replace(/\.$/, "") !== window.location.hostname.replace(/\.$/, "");
  let block = $state<HTMLElement>();
  let frame = $state<HTMLIFrameElement>();
  let fallback = $state<HTMLDetailsElement>();
  let postLink = $state<HTMLAnchorElement>();
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
    if (settled || !navigator.onLine) return;
    const forRestore = restoreSignal !== undefined && !restoreSignal.aborted;
    if (request !== undefined) {
      if (inView) request.prioritize();
      else if (forRestore) request.deprioritize();
      else if (request.cancelPending()) request = undefined;
      return;
    }
    if (!inView && !forRestore) return;
    let skipped = false;
    const queued = enqueue(
      () => {
        active = true;
        timer = setTimeout(() => finish(0), 15_000);
      },
      inView,
      () => {
        if (navigator.onLine) {
          if (restoreSignal !== undefined && !restoreSignal.aborted) return true;
          if (inView && isVisibleNow()) return true;
        }
        skipped = true;
        inView = false;
        request = undefined;
        return false;
      },
    );
    if (!skipped) request = queued;
  }

  function isVisibleNow() {
    const bounds = block?.getBoundingClientRect();
    if (awaitingPosition || !bounds || bounds.width === 0 || bounds.height === 0) return false;
    const root = scrollRoot?.getBoundingClientRect();
    const top = Math.max(0, root ? root.top + toolbarHeight : 0);
    const bottom = Math.min(window.innerHeight, root?.bottom ?? window.innerHeight - toolbarHeight);
    const left = Math.max(0, root?.left ?? 0);
    const right = Math.min(window.innerWidth, root?.right ?? window.innerWidth);
    return bounds.bottom > top && bounds.top < bottom && bounds.right > left && bounds.left < right;
  }

  function readingViewportTop() {
    return scrollRoot === null ? 0 : scrollRoot.getBoundingClientRect().top + toolbarHeight;
  }

  function containsReadingLine(element: Element | undefined, top: number) {
    const bounds = element?.getBoundingClientRect();
    return bounds !== undefined && bounds.top <= top + 1 && bounds.bottom > top + 1;
  }

  function keepReadingPosition(readingQuote: boolean, top: number) {
    const scroller = scrollRoot ?? document.scrollingElement;
    const post = block;
    if (restoringScroll || scroller === null || post === undefined) return;

    const quote = fallback;
    const link = postLink;
    let edge: (() => number) | undefined;
    if (readingQuote && quote !== undefined) {
      const summary = quote.querySelector(":scope > summary");
      edge = () =>
        quote.getBoundingClientRect().top + (summary?.getBoundingClientRect().height ?? 0);
    } else if (link !== undefined && containsReadingLine(link, top)) {
      edge = () => link.getBoundingClientRect().top;
    } else if (post.getBoundingClientRect().bottom <= top) {
      edge = () => post.getBoundingClientRect().bottom;
    }
    if (edge === undefined) return;
    const anchor = edge;
    const before = anchor();
    void tick().then(() => {
      if (post.isConnected && !restoringScroll) scroller.scrollTop += anchor() - before;
    });
  }

  function finish(value: number) {
    if (!navigator.onLine && value === 0 && !settled) {
      suspendRequest();
      return;
    }
    const top = readingViewportTop();
    const readingQuote = !restoringScroll && containsReadingLine(fallback, top);
    if (value === 0 && height > 0 && !restoringScroll && containsReadingLine(frame, top)) {
      const scroller = scrollRoot ?? document.scrollingElement;
      const quote = fallback;
      void tick().then(() => {
        if (quote?.isConnected && scroller !== null && !restoringScroll) {
          scroller.scrollTop += quote.getBoundingClientRect().top - readingViewportTop();
        }
      });
    } else if (value !== height) {
      keepReadingPosition(readingQuote, top);
    }
    if (value === 0) quoteOpen = true;
    else if (height === 0) {
      quoteOpen =
        readingQuote ||
        preserveQuote ||
        !navigator.onLine ||
        (fallback?.contains(document.activeElement) ?? false);
      preserveQuote = false;
    }
    height = value;
    if (value === 0) active = false;
    if (settled) return;
    settled = true;
    clearTimeout(timer);
    request?.cancel();
  }

  function suspendRequest() {
    if (settled) {
      if (!quoteOpen) {
        keepReadingPosition(false, readingViewportTop());
        quoteOpen = true;
      }
      return;
    }
    clearTimeout(timer);
    request?.cancel();
    request = undefined;
    active = false;
  }

  $effect(() => {
    const element = block;
    // 履歴から開き直すときは、先頭に一瞬見える投稿を読み込まない。
    if (element === undefined || !separateHost || awaitingPosition || active || settled) return;
    const observer = new IntersectionObserver(
      (entries) => {
        if (awaitingPosition || active || settled) return;
        const entry = entries.at(-1);
        inView = entry !== undefined && entry.intersectionRatio > 0;
        updateRequest();
      },
      {
        root: scrollRoot,
        rootMargin:
          scrollRoot === null ? `0px 0px -${toolbarHeight}px` : `-${toolbarHeight}px 0px 0px`,
        threshold: [0, 0.001],
      },
    );
    observer.observe(element);
    return () => {
      observer.disconnect();
      inView = false;
      updateRequest();
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
    window.addEventListener("online", updateRequest);
    window.addEventListener("offline", suspendRequest);
    return () => {
      element.removeEventListener("sendo:open-x-post", loadForRestore);
      element.removeEventListener("sendo:restore-x-quote", keepQuoteOpen);
      window.removeEventListener("online", updateRequest);
      window.removeEventListener("offline", suspendRequest);
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
  <a {href} bind:this={postLink} data-x-link target="_blank" rel="noopener noreferrer nofollow"
    >X で開く</a
  >
</blockquote>

<style>
  iframe {
    display: block;
    border: 0;
    width: 100%;
    max-width: 550px;
  }
</style>
