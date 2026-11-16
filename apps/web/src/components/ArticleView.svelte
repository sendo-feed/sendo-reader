<script lang="ts">
  import { type Article, type ArticleContent, toSafeHttpUrl } from "@sendo-reader/core";
  import { tick, untrack } from "svelte";
  import { useReader } from "../lib/context";
  import { formatDateTime } from "../lib/format";
  import { reducedMotion, scrollToTop } from "../lib/layout.svelte";
  import type { ArticleListState } from "../lib/list.svelte";
  import { type ArticleSwipe, prefs } from "../lib/prefs.svelte";
  import { handleLink, router, viewHref } from "../lib/router.svelte";
  import ArticleBody from "./ArticleBody.svelte";
  import Dialog from "./Dialog.svelte";
  import Icon from "./Icon.svelte";
  import Appearance from "./settings/Appearance.svelte";

  let {
    articleId,
    list,
    onstep,
    onpeek = () => {},
  }: {
    articleId: string | null;
    list: ArticleListState;
    /** 一覧の前（-1）・次（1）の記事に移る */
    onstep: (delta: 1 | -1) => Promise<void> | void;
    /** スワイプで戻る間、記事の後ろに一覧を見せる（true）・見せるのをやめる（false） */
    onpeek?: (on: boolean) => void;
  } = $props();

  const reader = useReader();
  let article = $state<Article | null>(null);
  let missing = $state(false);
  let scroller = $state<HTMLElement>();

  async function load(id: string) {
    const found = await reader.client.getArticle(id);
    if (id !== articleId) return;
    article = found;
    missing = found === null;
  }

  /**
   * 本文（sendo の docs/decisions/content.md）。
   * - checking：手元を確かめている（すぐ終わる。本文のある記事では、要約を一瞬出さないよう待つ）
   * - ready：本文を出す
   * - loading：手元になく、sendo から取っている（取れるまで、要約を出しておく）
   * - unavailable：取れなかった（オフラインなど）。要約を出し、つながったら読めると伝える
   * - none：本文のない記事。要約を出す
   */
  let content = $state<ArticleContent | null>(null);
  let contentState = $state<"checking" | "ready" | "loading" | "unavailable" | "none">("none");

  async function loadContent(id: string) {
    content = null;
    contentState = "checking";
    try {
      // まず手元だけを読む（ネットワークを待たない）
      const local = await reader.client.getArticleContent(id);
      if (id !== articleId) return;
      if (local.status === "ready") {
        content = local.content;
        contentState = "ready";
        return;
      }
      if (local.status === "none") {
        contentState = "none";
        return;
      }
      contentState = "loading";
      const fetched = await reader.client.fetchArticleContent(id);
      if (id !== articleId) return;
      content = fetched;
      contentState = fetched === null ? "none" : "ready";
    } catch {
      if (id === articleId) contentState = "unavailable";
    }
  }

  /** つながったら、取れなかった本文を取り直す */
  $effect(() => {
    const retry = () => {
      if (articleId !== null && contentState === "unavailable") void loadContent(articleId);
    };
    window.addEventListener("online", retry);
    return () => window.removeEventListener("online", retry);
  });

  /**
   * 開いたときに一度だけ、未読なら既読にする。表示が間に合わないうちに次の記事へ移っても
   * （j を続けて押したとき）、通り過ぎた記事を既読にする。開いている間に「未読に戻す」を
   * 押したら、そのままにする（記事が替わるまで、もう呼ばない）
   */
  async function markOnOpen(id: string) {
    const found = list.find(id) ?? (await reader.client.getArticle(id));
    if (found === null || found.readAt !== null) return;
    const readAt = Date.now();
    list.patch(id, { readAt });
    if (article?.id === id) article = { ...article, readAt };
    await reader.client.setRead(id, true);
  }

  $effect(() => {
    const id = articleId;
    untrack(() => {
      saveError = null;
      if (id === null) {
        article = null;
        missing = false;
        content = null;
        contentState = "none";
      } else {
        // 一覧にある記事は、手元の DB を待たずにすぐ出す（そのあと読み直す）
        const listed = list.find(id);
        if (listed !== null) {
          article = listed;
          missing = false;
        }
        // 記事は先頭から出す（狭い画面では、ページ全体を動かしている）
        scrollToTop(scroller);
        // 書けなかったら、次に手元が変わったときの読み直しで、手元の DB の状態に戻る
        markOnOpen(id).catch(() => void list.refresh());
        void load(id);
        void loadContent(id);
      }
    });
  });

  $effect(() => {
    void reader.articlesVersion;
    untrack(() => {
      if (articleId !== null) void load(articleId);
    });
  });

  /**
   * 押したらすぐ画面に出し（楽観的な更新）、手元の DB への書き込みはそのあとに待つ
   * （docs/decisions/performance.md の操作の反応 100ms）
   */
  export async function toggle(field: "readAt" | "starredAt") {
    const current = article;
    if (current === null) return;
    const on = current[field] === null;
    const change = { [field]: on ? Date.now() : null };
    article = { ...current, ...change };
    list.patch(current.id, change);
    saveError = null;
    try {
      if (field === "readAt") await reader.client.setRead(current.id, on);
      else await reader.client.setStarred(current.id, on);
    } catch {
      // 手元に書けなかった（容量不足など）。表示を手元の DB の状態に戻す
      saveError = "保存できませんでした。";
      void list.refresh();
      if (articleId === current.id) await load(current.id);
    }
  }

  /** 元の記事を新しいタブで開く（リンクにできる URL のときだけ） */
  export function openOriginal() {
    if (link !== null) window.open(link, "_blank", "noopener,noreferrer");
  }

  /**
   * 指で記事を横にスワイプする。割り当ては設定で変えられる（既定は、右へスワイプすると一覧に
   * 戻る。左は何もしない）。縦に読み進める動きや、文字を選ぶ動きと取り違えないように、
   * はっきり横に動かし始めたときだけにする。
   *
   * 記事は指に付いて横に動き、離したら、外へ流して操作するか、元の位置へ戻す。戻る動きでは、
   * 狭い画面なら記事の後ろに一覧を見せる（onpeek）。次・前の記事へは、外へ流したあと、
   * 次の記事を反対の側から入れる
   */

  /** 記事を、指で横に動かしている分（px） */
  let dragX = $state(0);
  /** 指で動かしている最中（動きを付けず、指にそのまま付いていく） */
  let dragging = $state(false);
  /** 指を離したあとの動きの最中（その間は、次のスワイプを受けない） */
  let settling = $state(false);
  /** 記事を、元の位置からずらしている */
  const moved = $derived(dragX !== 0 || settling);

  /** 外へ流す・元に戻す時間（ミリ秒）。CSS の transition と揃える */
  const SLIDE = 220;
  /** これだけ横に動かして離したら、操作する（px） */
  const SWIPE_DISTANCE = 80;
  /** これより短くても、これより速く（px/ミリ秒）はじいたら、操作する */
  const FLICK_DISTANCE = 30;
  const FLICK_SPEED = 0.5;

  interface Gesture {
    startX: number;
    startY: number;
    /** 横に動かしている（true）、縦に動かしている（false）、まだ分からない（null） */
    sideways: boolean | null;
    lastX: number;
    lastTime: number;
    /** 横に動かしている速さ（px/ミリ秒。右が正） */
    speed: number;
    /** 記事の後ろに一覧を見せている */
    peeking: boolean;
  }
  let gesture: Gesture | null = null;

  /** その向き（dx が正なら右へ）のスワイプに割り当てた操作 */
  function actionFor(dx: number): ArticleSwipe {
    return dx < 0 ? prefs.value.swipes.articleLeft : prefs.value.swipes.articleRight;
  }

  function startPeek(current: Gesture) {
    if (current.peeking) return;
    current.peeking = true;
    onpeek(true);
  }

  function onTouchStart(event: TouchEvent) {
    const touch = event.touches[0];
    if (event.touches.length !== 1 || touch === undefined) {
      // 2 本目の指が触れた（拡大など）。動かしていた記事は元に戻す
      abandon();
      return;
    }
    gesture =
      !settling && article !== null && !startsInSideScroller(event.target)
        ? {
            startX: touch.clientX,
            startY: touch.clientY,
            sideways: null,
            lastX: touch.clientX,
            lastTime: event.timeStamp,
            speed: 0,
            peeking: false,
          }
        : null;
  }

  /** 横に動かしている間は、ページを縦に動かさない（そのため、受け身でない listener で受ける） */
  function onTouchMove(event: TouchEvent) {
    const touch = event.touches[0];
    const current = gesture;
    if (current === null || touch === undefined || current.sideways === false) return;
    const dx = touch.clientX - current.startX;
    const dy = touch.clientY - current.startY;
    if (current.sideways === null) {
      if (Math.abs(dx) < 10 && Math.abs(dy) < 10) return;
      current.sideways =
        Math.abs(dx) > Math.abs(dy) * 2 &&
        getSelection()?.isCollapsed !== false &&
        actionFor(dx) !== "none";
      if (!current.sideways) return;
      dragging = true;
    }
    event.preventDefault();
    if (event.timeStamp > current.lastTime) {
      current.speed = (touch.clientX - current.lastX) / (event.timeStamp - current.lastTime);
      current.lastX = touch.clientX;
      current.lastTime = event.timeStamp;
    }
    const action = actionFor(dx);
    if (action === "back") startPeek(current);
    // 何も割り当てていない向きには、ほとんど動かさない（手ごたえだけ）
    dragX = action === "none" ? dx * 0.1 : dx;
  }

  /**
   * 本文の中の、横に動かせるところ（幅の広い表、長い行のコード）から始まった動きか。そこでの
   * 横の動きは、中身を動かすためのものなので、記事のスワイプとして扱わない
   */
  function startsInSideScroller(target: EventTarget | null): boolean {
    for (
      let element = target instanceof Element ? target : null;
      element !== null && element !== scroller;
      element = element.parentElement
    ) {
      if (element.scrollWidth <= element.clientWidth) continue;
      const overflow = getComputedStyle(element).overflowX;
      if (overflow === "auto" || overflow === "scroll") return true;
    }
    return false;
  }

  function onTouchEnd(event: TouchEvent) {
    const touch = event.changedTouches[0];
    const current = gesture;
    gesture = null;
    if (current === null || touch === undefined || current.sideways === false) return;
    const dx = touch.clientX - current.startX;
    const dy = touch.clientY - current.startY;
    // 動かす途中を受け取らないまま離した（すばやくはじいた）なら、ここで向きを確かめる
    if (
      current.sideways === null &&
      (Math.abs(dx) <= Math.abs(dy) * 2 || getSelection()?.isCollapsed === false)
    ) {
      return;
    }
    const action = actionFor(dx);
    // 指を止めてから離したなら、はじいたことにはしない
    const speed = event.timeStamp - current.lastTime > 100 ? 0 : current.speed;
    const flick = Math.abs(dx) >= FLICK_DISTANCE && speed * Math.sign(dx) >= FLICK_SPEED;
    if (action === "none" || (Math.abs(dx) < SWIPE_DISTANCE && !flick)) {
      void settleBack(current.peeking);
      return;
    }
    if (action === "back") startPeek(current);
    void complete(action, dx < 0 ? -1 : 1, current.peeking);
  }

  function abandon() {
    const current = gesture;
    gesture = null;
    if (current?.sideways === true) void settleBack(current.peeking);
  }

  /** 記事を x まで、動きを付けて動かす。動き終わったら返る */
  function slide(x: number): Promise<void> {
    dragging = false;
    dragX = x;
    return new Promise((resolve) => setTimeout(resolve, reducedMotion() ? 0 : SLIDE));
  }

  /** 記事を x に、動きを付けずに置く（次に slide したときに、そこから動くように） */
  async function place(x: number) {
    dragging = true;
    dragX = x;
    await tick();
    // 置いた位置を、いったん描画の計算に乗せる（でないと、次の動きがここから始まらない）
    scroller?.getBoundingClientRect();
  }

  /** 足りないところで離した。元の位置に戻す */
  async function settleBack(peeking: boolean) {
    if (dragX === 0 && !peeking) {
      dragging = false;
      return;
    }
    settling = true;
    await slide(0);
    if (peeking) onpeek(false);
    settling = false;
  }

  /** 操作するところまで動かして離した。記事を外へ流してから、操作する */
  async function complete(
    action: Exclude<ArticleSwipe, "none">,
    direction: 1 | -1,
    peeking: boolean,
  ) {
    settling = true;
    const width = scroller?.clientWidth || window.innerWidth;
    await slide(direction * width);
    if (action === "back") {
      // 後ろに見せていた一覧は、Reader が、一覧に戻ったところで元に戻す
      router.openArticle(null);
      await place(0);
    } else {
      if (peeking) onpeek(false);
      const before = articleId;
      await onstep(action === "next" ? 1 : -1);
      if (articleId !== before) {
        // 次の記事は、反対の側から入れる
        await place(-direction * width);
      }
      await slide(0);
    }
    settling = false;
  }

  $effect(() => {
    const node = scroller;
    if (node === undefined) return;
    node.addEventListener("touchmove", onTouchMove, { passive: false });
    return () => node.removeEventListener("touchmove", onTouchMove);
  });

  /** 共有したときなどの、少しの間出す知らせ */
  let notice = $state<string | null>(null);
  let noticeTimer: ReturnType<typeof setTimeout> | undefined;

  function showNotice(text: string) {
    clearTimeout(noticeTimer);
    notice = text;
    noticeTimer = setTimeout(() => (notice = null), 3000);
  }

  /**
   * 記事のリンクを共有する。端末の共有の窓（Web Share API）を開き、なければリンクをコピーする。
   * 渡すのは、記事のタイトルと、http ／ https だと確かめた URL だけ
   */
  export async function share() {
    if (article === null || link === null) return;
    try {
      if (typeof navigator.share === "function") {
        await navigator.share({ title: article.title ?? "", url: link });
      } else {
        await navigator.clipboard.writeText(link);
        showNotice("リンクをコピーしました。");
      }
    } catch (error) {
      // 共有の窓を閉じただけなら、何も出さない
      if (error instanceof DOMException && error.name === "AbortError") return;
      showNotice("共有できませんでした。");
    }
  }

  /** 文字の大きさとテーマの窓を開いている */
  let displayOpen = $state(false);

  /** 書き込みに失敗したときの知らせ */
  let saveError = $state<string | null>(null);

  /** 記事の URL は、http ／ https のものだけをリンクにする（記事のデータは信頼できない） */
  const link = $derived(article === null ? null : toSafeHttpUrl(article.url));

  const feedHref = $derived(
    article === null ? "/" : viewHref({ kind: "feed", id: article.feedId }),
  );

  /**
   * 要約を出すか。本文が出せる間は出さない。本文のある記事で、手元を確かめている間（すぐ終わる）も
   * 出さない（要約が一瞬出て、本文に替わらないように）
   */
  const showSummary = $derived(
    contentState !== "ready" && !(contentState === "checking" && article?.hasContent === true),
  );

  /** 要約は、空行で段落に分けて出す（HTML としては出さない） */
  const paragraphs = $derived(
    (article?.summary ?? "")
      .split(/\n\s*\n/)
      .map((text) => text.trim())
      .filter((text) => text !== ""),
  );
</script>

<article
  class="article-view"
  aria-live="polite"
  bind:this={scroller}
  ontouchstart={onTouchStart}
  ontouchend={onTouchEnd}
  ontouchcancel={abandon}
  class:moved
  class:dragging
  style:--drag={`${dragX}px`}
>
  {#if article !== null}
    <div class="toolbar">
      <button
        type="button"
        class="icon-button back"
        aria-label="Back"
        title="Back (Esc)"
        onclick={() => router.openArticle(null)}
      >
        <Icon name="arrowLeft" />
      </button>
      <button
        type="button"
        class="icon-button close"
        aria-label="Close"
        title="Close (Esc)"
        onclick={() => router.openArticle(null)}
      >
        <Icon name="close" />
      </button>
      <button
        type="button"
        class="icon-button"
        aria-label="Previous"
        title="Previous (k)"
        onclick={() => onstep(-1)}
      >
        <Icon name="arrowUp" />
      </button>
      <button
        type="button"
        class="icon-button"
        aria-label="Next"
        title="Next (j)"
        onclick={() => onstep(1)}
      >
        <Icon name="arrowDown" />
      </button>
      <span class="spacer"
        >{#if saveError !== null}
          <span class="error" role="alert">{saveError}</span>
        {:else if notice !== null}
          <span class="notice" role="status">{notice}</span>
        {/if}</span
      >
      <button
        type="button"
        class="icon-button"
        aria-label={article.readAt === null ? "Mark as read" : "Mark as unread"}
        title={article.readAt === null ? "Mark as read (m)" : "Mark as unread (m)"}
        onclick={() => toggle("readAt")}
      >
        <Icon name={article.readAt === null ? "check" : "circle"} />
      </button>
      <button
        type="button"
        class="icon-button star"
        aria-pressed={article.starredAt !== null}
        aria-label={article.starredAt === null ? "Save" : "Unsave"}
        title={article.starredAt === null ? "Save (s)" : "Unsave (s)"}
        onclick={() => toggle("starredAt")}
      >
        <Icon name="star" filled={article.starredAt !== null} />
      </button>
      {#if link !== null}
        <button type="button" class="icon-button" aria-label="Share" title="Share" onclick={share}>
          <Icon name="share" />
        </button>
      {/if}
      <button
        type="button"
        class="icon-button aa"
        aria-label="Appearance"
        title="Appearance"
        onclick={() => (displayOpen = true)}
      >
        Aa
      </button>
      {#if link !== null}
        <a
          class="open"
          href={link}
          target="_blank"
          rel="noopener noreferrer"
          aria-label="Open original"
          title="Open original (v)"
        >
          <Icon name="external" />
        </a>
      {/if}
    </div>

    <div class="content">
      <header>
        <p class="meta">
          <a class="feed" href={feedHref} onclick={(e) => handleLink(e, feedHref)}>
            {reader.feedTitle(article.feedId)}
          </a>
        </p>
        <h1>{article.title ?? "(Untitled)"}</h1>
        <p class="meta">
          <time datetime={new Date(article.publishedAt).toISOString()}>
            {formatDateTime(article.publishedAt)}
          </time>
          {#if article.author !== null}
            <span>・ {article.author}</span>
          {/if}
        </p>
      </header>
      {#if content !== null}
        <ArticleBody nodes={content.nodes} />
      {:else if showSummary}
        {#each paragraphs as text, index (index)}
          <p class="summary">{text}</p>
        {/each}
        {#if contentState === "unavailable"}
          <p class="content-note" role="status">
            この記事には本文があります。sendo につながったら読めます。
          </p>
        {/if}
      {/if}
      {#if link !== null}
        <p>
          <a class="read-on" href={link} target="_blank" rel="noopener noreferrer">
            Open original
            <Icon name="external" />
          </a>
        </p>
      {/if}
    </div>
  {:else if missing}
    <div class="placeholder"><p>この記事は手元にありません。</p></div>
  {:else}
    <div class="placeholder">
      <Icon name="inbox" />
      <p>記事を選んでください。</p>
      <p class="hint"><kbd>j</kbd> <kbd>k</kbd> で次・前の記事、<kbd>?</kbd> で操作の一覧</p>
    </div>
  {/if}
</article>

<Dialog bind:open={displayOpen} title="Appearance">
  <Appearance reading />
</Dialog>

<style>
  .article-view {
    display: flex;
    flex-direction: column;
    min-width: 0;
    overflow-x: hidden;
    overflow-y: auto;
    background: var(--background);
  }

  /*
   * 指で横にスワイプしている間と、離したあとに外へ流す・元に戻す間。広い画面では、欄の中で
   * 中身を動かす（欄の外にははみ出さない）
   */
  .article-view.moved > :not(dialog) {
    transform: translateX(var(--drag));
    transition: transform 0.22s cubic-bezier(0.2, 0.8, 0.2, 1);
  }

  .article-view.dragging > :not(dialog) {
    transition: none;
  }

  @media (prefers-reduced-motion: reduce) {
    .article-view.moved > :not(dialog) {
      transition: none;
    }
  }

  .toolbar {
    position: sticky;
    top: 0;
    z-index: 1;
    display: flex;
    align-items: center;
    gap: 0.125rem;
    min-height: 3.25rem;
    padding: 0.5rem;
    border-bottom: 1px solid var(--border);
    background: var(--background);
  }

  /* 記事の欄が狭いとき（3 カラムで文字を大きくした、など）は、ボタンが縮んで収まる */
  .toolbar > :global(.icon-button),
  .open {
    flex: 0 1 auto;
    min-width: 0;
  }

  .spacer {
    flex: 1;
    min-width: 0;
    padding: 0 0.5rem;
    text-align: end;
  }

  .star[aria-pressed="true"] {
    color: var(--star);
  }

  .aa {
    font-size: 1rem;
    font-weight: 600;
    letter-spacing: -0.02em;
  }

  .notice {
    color: var(--muted);
    font-size: 0.875rem;
  }

  .open {
    display: inline-grid;
    place-items: center;
    width: 2.25rem;
    height: 2.25rem;
    border-radius: var(--radius-small);
    color: var(--muted);
  }

  .open:hover {
    background: var(--hover);
    color: var(--text);
  }

  .content {
    width: 100%;
    max-width: 44rem;
    margin: 0 auto;
    padding: 1.75rem 1.5rem calc(4rem + env(safe-area-inset-bottom, 0px));
  }

  h1 {
    margin: 0.375rem 0 0.5rem;
    font-size: 1.625rem;
    line-height: 1.4;
    letter-spacing: 0.01em;
    overflow-wrap: anywhere;
  }

  .meta {
    margin: 0;
    color: var(--muted);
    font-size: 0.875rem;
  }

  .feed {
    color: var(--accent);
    font-weight: 600;
    text-decoration: none;
  }

  .feed:hover {
    text-decoration: underline;
  }

  header {
    margin-bottom: 1.5rem;
    padding-bottom: 1.25rem;
    border-bottom: 1px solid var(--border);
  }

  .summary {
    margin: 0 0 1.25em;
    font-size: 1.0625rem;
    line-height: 1.9;
    white-space: pre-wrap;
    overflow-wrap: anywhere;
  }

  .content-note {
    margin: 0 0 1.25em;
    color: var(--muted);
    font-size: 0.875rem;
  }

  .read-on {
    display: inline-flex;
    align-items: center;
    gap: 0.5rem;
    margin-top: 0.75rem;
    padding: 0.5rem 1rem;
    border: 1px solid var(--accent);
    border-radius: 999px;
    color: var(--accent);
    font-weight: 600;
    text-decoration: none;
  }

  .read-on:hover {
    background: var(--selected);
  }

  .placeholder {
    display: grid;
    justify-items: center;
    gap: 0.5rem;
    margin: auto;
    padding: 2rem;
    color: var(--muted);
    text-align: center;
  }

  .placeholder :global(.icon) {
    width: 3rem;
    height: 3rem;
    color: var(--border-strong);
  }

  .placeholder p {
    margin: 0;
  }

  .hint {
    font-size: 0.8125rem;
    color: var(--faint);
  }

  .error {
    color: var(--danger);
    font-size: 0.875rem;
  }

  .back {
    display: none;
  }

  @media (max-width: 56rem) {
    /*
     * ページ全体を動かす（docs/decisions/ui.md の 6）。中身が短くても、記事の操作が画面の下に
     * 来るように、画面の高さまでは伸ばす
     */
    .article-view {
      min-height: 100dvh;
      overflow: visible;
    }

    /*
     * 狭い画面では、記事をまるごと動かす（戻る動きでは、後ろに一覧が見える）。
     * 横にはみ出した分は、Reader が切り取る
     */
    .article-view.moved > :not(dialog) {
      transform: none;
      transition: none;
    }

    .article-view.moved {
      box-shadow: var(--shadow);
      transform: translateX(var(--drag));
      transition: transform 0.22s cubic-bezier(0.2, 0.8, 0.2, 1);
    }

    .article-view.dragging {
      transition: none;
    }

    .back {
      display: inline-grid;
    }

    /* 狭い画面では、操作を親指の届く下に置く */
    .toolbar {
      order: 2;
      top: auto;
      bottom: 0;
      justify-content: space-between;
      margin-top: auto;
      padding: 0.375rem 0.75rem calc(0.375rem + env(safe-area-inset-bottom, 0px));
      border-top: 1px solid var(--border);
      border-bottom: 0;
    }

    .spacer:empty {
      display: none;
    }

    /* ボタンは幅を分け合う。文字を大きくしても、狭い画面からはみ出さない */
    .toolbar {
      gap: 0;
    }

    .toolbar > :global(.icon-button) {
      flex: 1 1 0;
      width: auto;
      min-width: 0;
      max-width: 3.5rem;
    }

    /* 元の記事へは、本文の下のボタンから開く（下のバーには、押しやすい数だけ並べる） */
    .open,
    .close,
    .hint {
      display: none;
    }

    /* 知らせは、下のバーの上に浮かせる */
    .spacer {
      position: absolute;
      right: 0;
      bottom: 100%;
      left: 0;
      padding: 0.375rem 1rem;
      background: var(--background);
      text-align: center;
    }

    .content {
      padding-inline: 1.125rem;
    }

    h1 {
      font-size: 1.375rem;
    }
  }

  @media (max-width: 56rem) and (prefers-reduced-motion: reduce) {
    .article-view.moved {
      transition: none;
    }
  }
</style>
