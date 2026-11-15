<script lang="ts">
  import type { Article } from "@sendo-reader/core";
  import type { Snippet } from "svelte";
  import { useReader } from "../lib/context";
  import { compactCount, dayLabel, shortTime } from "../lib/format";
  import type { ArticleListState, ListProgress } from "../lib/list.svelte";
  import { prefs, type ViewOptions } from "../lib/prefs.svelte";
  import { handleLink, isPlainClick, router } from "../lib/router.svelte";
  import Icon from "./Icon.svelte";

  let {
    list,
    title,
    kind,
    unread,
    onmarkall,
    progress,
    onprogress,
    search,
    onsearch,
    options,
    onoption,
    onmenu,
    next,
    leading,
  }: {
    list: ArticleListState;
    title: string;
    /** 開いている一覧の種類。空のときの文と、出す操作を決める */
    kind: "unread" | "all" | "starred" | "feed" | "folder" | "search";
    /** 検索の画面で探している言葉（検索でなければ null） */
    search: string | null;
    onsearch: (query: string) => void;
    /** この一覧の範囲にある未読の数（まとめて既読にできないなら null） */
    unread: number | null;
    onmarkall: () => void;
    /** この一覧の進み具合（出さない一覧は null） */
    progress: ListProgress | null;
    onprogress: () => void;
    /** この一覧の表示の設定（一覧ごとに覚える） */
    options: ViewOptions;
    onoption: (patch: Partial<ViewOptions>) => void;
    /** 行を長く押した（右クリックした）とき。その記事の操作を出す */
    onmenu: (article: Article) => void;
    /** 一覧の終わりに出す、次へ進むボタン（出さないなら null） */
    next: { label: string; go: () => void } | null;
    /** 見出しの左に置くもの（狭い画面のメニューのボタン） */
    leading?: Snippet;
  } = $props();

  const reader = useReader();

  /** 一覧の中で、いま開いている（開いていなければ、キーボードで選んでいる）記事 */
  const currentId = $derived(router.articleId ?? list.cursorId);

  /** 記事と、その前に日付の見出しを出すなら、その文 */
  const rows = $derived.by(() => {
    const now = Date.now();
    let previous = "";
    return list.articles.map((article) => {
      const label = dayLabel(article.publishedAt, now);
      const heading = label === previous ? null : label;
      previous = label;
      return { article, heading };
    });
  });

  function articleHref(id: string): string {
    const url = new URL(router.url);
    url.searchParams.set("article", id);
    return url.pathname + url.search;
  }

  function open(event: MouseEvent, id: string) {
    if (!isPlainClick(event)) return;
    event.preventDefault();
    router.openArticle(id);
  }

  let scroller = $state<HTMLElement>();

  // 開いている（選んでいる）記事が替わったら、一覧の中で見えるところまで動かす
  $effect(() => {
    const id = currentId;
    if (id === null || scroller === undefined) return;
    for (const row of scroller.querySelectorAll<HTMLElement>(".row[data-article]")) {
      if (row.dataset.article === id) {
        row.scrollIntoView({ block: "nearest" });
        break;
      }
    }
  });

  /**
   * 一覧を動かして、見出しの下を上へ通り過ぎた未読の記事を、既読にする（設定で切れる）。
   * 行ごとに位置を測らず、IntersectionObserver で「見えなくなって、上にある」行だけを拾う。
   * 少しためてから、まとめて書く
   */
  let observer: IntersectionObserver | undefined;
  /** 一度でも画面に出た行。出ていない行（別の一覧に替えた直後に上にある行など）は数えない */
  const seen = new WeakSet<Element>();
  const passed = new Set<string>();
  let flushTimer: ReturnType<typeof setTimeout> | undefined;

  function flushPassed() {
    const ids = [...passed];
    passed.clear();
    // 書けなかったら、一覧が手元の DB の状態に戻る
    list.markRead(ids).catch(() => {});
  }

  function onPass(entries: IntersectionObserverEntry[]) {
    for (const entry of entries) {
      const bounds = entry.rootBounds;
      const rect = entry.boundingClientRect;
      if (entry.isIntersecting) {
        seen.add(entry.target);
        continue;
      }
      // 一覧を出していないとき（狭い画面で記事を開いている）は、位置が分からないので何もしない
      if (bounds === null || bounds.height === 0 || rect.height === 0) continue;
      // 監視を始めたときの知らせなど、画面に出たことのない行は、通り過ぎたのではない
      if (!seen.has(entry.target)) continue;
      // 下にあって見えていない行は、まだ通り過ぎていない
      if (rect.bottom > bounds.top) continue;
      const id = (entry.target as HTMLElement).dataset.article;
      // 探した結果は、読み進める一覧ではないので、通り過ぎても既読にしない
      if (id !== undefined && prefs.value.markReadOnScroll && kind !== "search") passed.add(id);
    }
    if (passed.size === 0) return;
    clearTimeout(flushTimer);
    flushTimer = setTimeout(flushPassed, 250);
  }

  function watchPass(node: HTMLElement) {
    const root = node.closest<HTMLElement>(".article-list");
    const header = root?.querySelector("header");
    observer ??= new IntersectionObserver(onPass, {
      root,
      rootMargin: `-${header?.offsetHeight ?? 0}px 0px 0px 0px`,
    });
    observer.observe(node);
    return { destroy: () => observer?.unobserve(node) };
  }

  // 別の一覧に替えたら、先頭に戻す（前の一覧の位置のまま、新しい一覧の途中を出さない）
  $effect(() => {
    void list.opened;
    passed.clear();
    scroller?.scrollTo({ top: 0 });
  });

  /** 探す言葉を打つたびに探す。打っている途中で何度も探さないように、少し待つ */
  let searchTimer: ReturnType<typeof setTimeout> | undefined;

  function onSearchInput(event: Event & { currentTarget: HTMLInputElement }) {
    const value = event.currentTarget.value;
    clearTimeout(searchTimer);
    searchTimer = setTimeout(() => onsearch(value), 200);
  }

  // 検索の画面を離れたら（別の一覧に替えた、購読の管理へ移った）、待っている検索を捨てる。
  // 残しておくと、移った先から検索の画面に引き戻してしまう
  $effect(() => {
    if (search === null) clearTimeout(searchTimer);
    return () => clearTimeout(searchTimer);
  });

  /** Enter か Esc で、入力から抜ける（そのあと j / k で結果を移れる。スマホではキーボードを閉じる） */
  function onSearchKeydown(event: KeyboardEvent & { currentTarget: HTMLInputElement }) {
    if (event.isComposing || (event.key !== "Enter" && event.key !== "Escape")) return;
    event.preventDefault();
    event.currentTarget.blur();
  }

  /** 検索の画面を開いたら、すぐ打てるようにする */
  function focusOnOpen(node: HTMLInputElement) {
    node.focus();
  }

  /** 一覧の終わりが近づいたら、続きを読む */
  function autoload(node: HTMLElement) {
    const observer = new IntersectionObserver(
      (entries) => {
        if (entries.some((entry) => entry.isIntersecting)) void list.loadMore();
      },
      { root: node.closest(".article-list"), rootMargin: "600px" },
    );
    observer.observe(node);
    return { destroy: () => observer.disconnect() };
  }

  /** これだけ横に動かして離したら、操作する（px） */
  const SWIPE = 72;
  /** これだけ押し続けたら、その記事の操作を出す（ミリ秒） */
  const LONG_PRESS = 500;

  /**
   * 指で行を横にはじく。右へはじくと既読・未読、左へはじくとスターを切り替える。
   * 縦に動かし始めたら、一覧を動かすだけにする（行は touch-action: pan-y）。
   * 動かさずに長く押す（マウスなら右クリック）と、その記事の操作を出す
   */
  function swipe(node: HTMLElement, article: Article) {
    let current = article;
    let startX = 0;
    let startY = 0;
    let dx = 0;
    let tracking = false;
    let sideways = false;

    /** 長く押したら、その記事の操作を出す。そのあとの指を離したときのクリックでは、開かない */
    let pressTimer: ReturnType<typeof setTimeout> | undefined;
    let pressed = false;

    function openMenu() {
      if (pressed) return;
      pressed = true;
      reset();
      onmenu(current);
    }

    function onContextMenu(event: MouseEvent) {
      event.preventDefault();
      openMenu();
      // マウスの右クリックでは、あとにクリックは来ない
      if (event.button === 2) pressed = false;
    }

    function onClickCapture(event: MouseEvent) {
      if (!pressed) return;
      pressed = false;
      event.preventDefault();
      event.stopPropagation();
    }

    function reset() {
      clearTimeout(pressTimer);
      tracking = false;
      sideways = false;
      // class は Svelte が書き直すので、data 属性で持つ
      delete node.dataset.swiping;
      delete node.dataset.armed;
      node.style.removeProperty("--swipe");
    }

    function onStart(event: TouchEvent) {
      const touch = event.touches[0];
      if (event.touches.length !== 1 || touch === undefined) return reset();
      startX = touch.clientX;
      startY = touch.clientY;
      dx = 0;
      tracking = true;
      sideways = false;
      pressed = false;
      pressTimer = setTimeout(openMenu, LONG_PRESS);
    }

    function onMove(event: TouchEvent) {
      const touch = event.touches[0];
      if (!tracking || touch === undefined) return;
      const x = touch.clientX - startX;
      const y = touch.clientY - startY;
      if (!sideways) {
        if (Math.abs(x) < 10 && Math.abs(y) < 10) return;
        clearTimeout(pressTimer);
        if (Math.abs(y) >= Math.abs(x)) return reset();
        sideways = true;
        node.dataset.swiping = "";
      }
      dx = Math.max(-SWIPE * 1.6, Math.min(SWIPE * 1.6, x));
      const field = dx > 0 ? "readAt" : "starredAt";
      node.dataset.swipe = dx > 0 ? "read" : "star";
      node.dataset.swipeLabel =
        field === "readAt"
          ? current.readAt === null
            ? "既読にする"
            : "未読に戻す"
          : current.starredAt === null
            ? "スターを付ける"
            : "スターを外す";
      node.style.setProperty("--swipe", `${dx}px`);
      if (Math.abs(dx) >= SWIPE) node.dataset.armed = "";
      else delete node.dataset.armed;
    }

    function onEnd() {
      if (sideways && Math.abs(dx) >= SWIPE) toggle(current, dx > 0 ? "readAt" : "starredAt");
      reset();
    }

    node.addEventListener("touchstart", onStart, { passive: true });
    node.addEventListener("touchmove", onMove, { passive: true });
    node.addEventListener("touchend", onEnd);
    node.addEventListener("touchcancel", reset);
    node.addEventListener("contextmenu", onContextMenu);
    node.addEventListener("click", onClickCapture, { capture: true });
    return {
      update(next: Article) {
        current = next;
      },
      destroy() {
        node.removeEventListener("touchstart", onStart);
        node.removeEventListener("touchmove", onMove);
        node.removeEventListener("touchend", onEnd);
        node.removeEventListener("touchcancel", reset);
        node.removeEventListener("contextmenu", onContextMenu);
        node.removeEventListener("click", onClickCapture, { capture: true });
        clearTimeout(pressTimer);
      },
    };
  }

  async function reload() {
    await list.load();
    scroller?.scrollTo({ top: 0 });
  }

  function toggle(article: Article, field: "readAt" | "starredAt") {
    // 書けなかったら、一覧が手元の DB の状態に戻る
    list.toggle(article, field).catch(() => {});
  }
</script>

<section class="article-list" aria-label={title} bind:this={scroller}>
  <header>
    {@render leading?.()}
    {#if progress !== null}
      <button
        type="button"
        class="gauge"
        aria-label={`この一覧の進み具合 ${progress.percent}%`}
        title="進み具合の内訳"
        onclick={onprogress}
      >
        <svg viewBox="0 0 36 36" aria-hidden="true">
          <circle class="track" cx="18" cy="18" r="15.9155" />
          {#if progress.percent > 0}
            <circle
              class="bar"
              cx="18"
              cy="18"
              r="15.9155"
              stroke-dasharray={`${progress.percent} 100`}
            />
          {/if}
        </svg>
        <span class="gauge-count" aria-hidden="true">{compactCount(progress.remaining)}</span>
      </button>
    {/if}
    {#if search !== null}
      <input
        class="search"
        type="search"
        enterkeyhint="search"
        autocomplete="off"
        placeholder="記事を探す"
        aria-label="記事を探す"
        value={search}
        oninput={onSearchInput}
        onkeydown={onSearchKeydown}
        use:focusOnOpen
      >
    {:else}
      <h2>
        <span class="name">{title}</span>
        {#if unread !== null && unread > 0}
          <span class="count">{unread}</span>
        {/if}
      </h2>
    {/if}
    {#if kind === "feed" || kind === "folder"}
      <button
        type="button"
        class="icon-button"
        aria-pressed={options.unreadOnly}
        aria-label="未読だけを出す"
        title="未読だけを出す"
        onclick={() => onoption({ unreadOnly: !options.unreadOnly })}
      >
        <Icon name="filter" />
      </button>
    {/if}
    <button
      type="button"
      class="icon-button"
      aria-pressed={options.oldestFirst}
      aria-label="古い順に並べる"
      title="古い順に並べる"
      onclick={() => onoption({ oldestFirst: !options.oldestFirst })}
    >
      <Icon name="sort" />
    </button>
    <button
      type="button"
      class="icon-button"
      aria-pressed={options.layout === "comfortable"}
      aria-label="要約も出す"
      title="要約も出す"
      onclick={() =>
        onoption({ layout: options.layout === "comfortable" ? "compact" : "comfortable" })}
    >
      <Icon name={options.layout === "comfortable" ? "cards" : "rows"} />
    </button>
    {#if unread !== null}
      <button
        type="button"
        class="icon-button"
        aria-label="まとめて既読にする"
        title="まとめて既読にする（Shift + A）"
        disabled={unread === 0}
        onclick={onmarkall}
      >
        <Icon name="checkAll" />
      </button>
    {/if}
  </header>

  {#if list.fresh > 0}
    <button type="button" class="fresh" onclick={reload}>新しい記事 {list.fresh} 件を読む</button>
  {/if}

  {#if search !== null && search.trim() === ""}
    <div class="empty">
      <Icon name="search" />
      <p>タイトル・要約・著者から、手元の記事を探します。</p>
      <p class="hint">空白で区切ると、すべての言葉が入っている記事だけを出します。</p>
    </div>
  {:else if list.loading && list.articles.length === 0}
    <div class="skeleton" aria-hidden="true">
      {#each [0, 1, 2, 3, 4, 5] as n (n)}
        <div></div>
      {/each}
    </div>
    <p class="visually-hidden" role="status">読んでいます…</p>
  {:else if list.articles.length === 0}
    <div class="empty">
      {#if reader.feeds.length === 0}
        <Icon name="rss" />
        <p>まだフィードを購読していません。</p>
        <a href="/manage" onclick={(e) => handleLink(e, "/manage")}>フィードを追加する</a>
      {:else if kind === "unread" || ((kind === "feed" || kind === "folder") && options.unreadOnly)}
        <Icon name="check" />
        <p>すべて読み終えました。</p>
      {:else if kind === "search"}
        <Icon name="search" />
        <p>見つかりませんでした。</p>
      {:else if kind === "starred"}
        <Icon name="star" />
        <p>スターを付けた記事が、ここに並びます。</p>
      {:else}
        <p>記事はありません。</p>
      {/if}
      {#if next !== null}
        <button type="button" class="primary" onclick={next.go}>{next.label}</button>
      {/if}
    </div>
  {:else}
    <ol class:compact={options.layout === "compact"}>
      {#each rows as { article, heading } (article.id)}
        <li data-article={article.id} use:watchPass>
          {#if heading !== null}
            <h3>{heading}</h3>
          {/if}
          <div
            class="row"
            class:unread={article.readAt === null}
            class:current={currentId === article.id}
            data-article={article.id}
            use:swipe={article}
          >
            <a
              class="item"
              href={articleHref(article.id)}
              aria-current={router.articleId === article.id ? "true" : undefined}
              onclick={(e) => open(e, article.id)}
            >
              <span class="meta">
                <span class="feed">{reader.feedTitle(article.feedId)}</span>
                <span class="time">{shortTime(article.publishedAt)}</span>
              </span>
              <span class="title">{article.title ?? "（タイトルなし）"}</span>
              {#if options.layout === "comfortable" && article.summary}
                <span class="summary">{article.summary.slice(0, 240)}</span>
              {/if}
            </a>
            <span class="actions">
              <button
                type="button"
                class="icon-button"
                aria-label={article.readAt === null ? "既読にする" : "未読に戻す"}
                title={article.readAt === null ? "既読にする" : "未読に戻す"}
                onclick={() => toggle(article, "readAt")}
              >
                <Icon name={article.readAt === null ? "check" : "circle"} />
              </button>
              <button
                type="button"
                class="icon-button star"
                aria-pressed={article.starredAt !== null}
                aria-label={article.starredAt === null ? "スターを付ける" : "スターを外す"}
                title={article.starredAt === null ? "スターを付ける" : "スターを外す"}
                onclick={() => toggle(article, "starredAt")}
              >
                <Icon name="star" filled={article.starredAt !== null} />
              </button>
            </span>
          </div>
        </li>
      {/each}
    </ol>
    {#if list.hasMore}
      <button
        type="button"
        class="more"
        use:autoload
        onclick={() => list.loadMore()}
        disabled={list.loadingMore}
      >
        {list.loadingMore ? "読んでいます…" : "もっと読む"}
      </button>
    {:else}
      <div class="end">
        <p>ここまで</p>
        {#if next !== null}
          <button type="button" class="primary" onclick={next.go}>{next.label}</button>
        {/if}
      </div>
    {/if}
  {/if}
</section>

<style>
  .article-list {
    display: flex;
    flex-direction: column;
    min-width: 0;
    overflow-y: auto;
    border-right: 1px solid var(--border);
    background: var(--background);
  }

  header {
    position: sticky;
    top: 0;
    z-index: 1;
    display: flex;
    align-items: center;
    gap: 0.125rem;
    min-height: 3.25rem;
    padding: 0.5rem 0.5rem 0.5rem 1rem;
    border-bottom: 1px solid var(--border);
    background: var(--background);
  }

  /* この一覧の進み具合の輪。広い画面では左のメニューに出すので、狭い画面でだけ出す */
  .gauge {
    display: none;
    flex: none;
    position: relative;
    width: 2.5rem;
    height: 2.5rem;
    margin-right: 0.375rem;
    padding: 0.125rem;
    border: 0;
    border-radius: 50%;
    background: none;
  }

  /* 輪の中に、残っている未読の数を出す */
  .gauge-count {
    position: absolute;
    inset: 0;
    display: grid;
    place-items: center;
    color: var(--muted);
    font-size: 0.625rem;
    font-weight: 700;
    font-variant-numeric: tabular-nums;
  }

  .gauge svg {
    display: block;
    transform: rotate(-90deg);
    fill: none;
    stroke-width: 3.5;
  }

  .track {
    stroke: var(--hover);
  }

  .bar {
    stroke: var(--accent);
    stroke-linecap: round;
  }

  @media (max-width: 56rem) {
    .gauge {
      display: block;
    }

    /* 数は輪の中に出している */
    h2 .count {
      display: none;
    }
  }

  .search {
    flex: 1;
    min-width: 0;
    margin-right: 0.25rem;
    padding: 0.4rem 0.75rem;
    border-radius: 999px;
    background: var(--surface);
  }

  .empty .hint {
    font-size: 0.8125rem;
    color: var(--faint);
  }

  h2 {
    display: flex;
    flex: 1;
    align-items: baseline;
    gap: 0.5rem;
    min-width: 0;
    margin: 0;
    font-size: 1.0625rem;
  }

  h2 .name {
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }

  h2 .count {
    flex: none;
    color: var(--muted);
    font-size: 0.8125rem;
    font-weight: 500;
    font-variant-numeric: tabular-nums;
  }

  ol {
    list-style: none;
    margin: 0;
    padding: 0;
  }

  /* 画面の外の行は、描くのを後回しにする（長い一覧でも、動かしたときに重くしない） */
  li {
    content-visibility: auto;
    contain-intrinsic-size: auto 5.5rem;
  }

  h3 {
    margin: 0;
    padding: 0.875rem 1rem 0.25rem;
    color: var(--faint);
    font-size: 0.75rem;
    font-weight: 600;
    letter-spacing: 0.04em;
  }

  .row {
    position: relative;
    overflow: hidden;
    border-bottom: 1px solid var(--border);
    touch-action: pan-y;
  }

  @media (hover: hover) {
    .row:hover {
      background: var(--hover);
    }
  }

  .row:active {
    background: var(--hover);
  }

  .row.current {
    background: var(--selected);
  }

  .item {
    display: grid;
    gap: 0.125rem;
    padding: 0.625rem 1rem 0.75rem 1.375rem;
    color: var(--muted);
    text-decoration: none;
  }

  /* 指で長く押したときに、文字の選択やリンクのプレビューを出さない（記事の操作を出す） */
  @media (hover: none) {
    .item {
      -webkit-touch-callout: none;
      user-select: none;
    }
  }

  .item:focus-visible {
    outline-offset: -2px;
  }

  /* 未読の印 */
  .row.unread .item::before {
    content: "";
    position: absolute;
    top: 1.05rem;
    left: 0.5rem;
    width: 0.4375rem;
    height: 0.4375rem;
    border-radius: 50%;
    background: var(--accent);
  }

  .meta {
    display: flex;
    gap: 0.5rem;
    align-items: baseline;
    font-size: 0.75rem;
    color: var(--muted);
  }

  .feed {
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }

  .time {
    flex: none;
    margin-left: auto;
    color: var(--faint);
    font-variant-numeric: tabular-nums;
  }

  .title {
    display: -webkit-box;
    overflow: hidden;
    -webkit-box-orient: vertical;
    -webkit-line-clamp: 2;
    line-clamp: 2;
    font-size: 0.9375rem;
    line-height: 1.45;
    overflow-wrap: anywhere;
  }

  .compact .title {
    -webkit-line-clamp: 1;
    line-clamp: 1;
  }

  .row.unread .title {
    color: var(--text);
    font-weight: 600;
  }

  .summary {
    display: -webkit-box;
    overflow: hidden;
    -webkit-box-orient: vertical;
    -webkit-line-clamp: 2;
    line-clamp: 2;
    font-size: 0.8125rem;
    line-height: 1.5;
    overflow-wrap: anywhere;
  }

  .compact li {
    contain-intrinsic-size: auto 3.5rem;
  }

  .compact .item {
    padding-block: 0.4rem 0.5rem;
  }

  .compact .row.unread .item::before {
    top: 0.85rem;
  }

  /* 行の操作（既読、スター）。マウスでは、行に乗せたときと、キーボードで入ったときだけ出す */
  .actions {
    position: absolute;
    top: 0.125rem;
    right: 0.375rem;
    display: flex;
    border-radius: var(--radius-small);
    background: var(--raised);
    box-shadow: 0 1px 4px rgb(0 0 0 / 18%);
  }

  .actions .icon-button {
    width: 1.875rem;
    height: 1.875rem;
  }

  .star[aria-pressed="true"] {
    color: var(--star);
  }

  @media (hover: hover) {
    .actions {
      opacity: 0;
      pointer-events: none;
    }

    .row:hover .actions,
    .actions:focus-within {
      opacity: 1;
      pointer-events: auto;
    }
  }

  /* 指で使う画面では、行の操作は出さない（記事を開いて操作する）。スターの印だけ残す */
  @media (hover: none) {
    .actions {
      background: none;
      box-shadow: none;
      pointer-events: none;
    }

    .actions .icon-button:not(.star[aria-pressed="true"]) {
      display: none;
    }

    .row:has(.star[aria-pressed="true"]) .time {
      margin-right: 1.5rem;
    }
  }

  .empty {
    display: grid;
    justify-items: center;
    gap: 0.5rem;
    margin: auto;
    padding: 3rem 1.5rem;
    color: var(--muted);
    text-align: center;
  }

  .empty :global(.icon) {
    width: 2.5rem;
    height: 2.5rem;
    color: var(--faint);
  }

  .empty p {
    margin: 0;
  }

  .empty button {
    max-width: 100%;
    margin-top: 0.5rem;
    padding: 0.6rem 1rem;
    overflow-wrap: anywhere;
  }

  .fresh {
    position: sticky;
    top: 3.75rem;
    z-index: 1;
    align-self: center;
    margin: 0.5rem 0 -2.5rem;
    border-color: var(--accent);
    border-radius: 999px;
    background: var(--accent);
    color: var(--on-accent);
    font-size: 0.8125rem;
    font-weight: 600;
    box-shadow: var(--shadow);
  }

  .fresh:hover:not(:disabled) {
    background: var(--accent-strong);
  }

  .more {
    margin: 1rem;
  }

  .end {
    display: grid;
    justify-items: center;
    gap: 0.75rem;
    padding: 1.5rem 1rem calc(2rem + env(safe-area-inset-bottom, 0px));
    color: var(--faint);
    font-size: 0.8125rem;
    text-align: center;
  }

  .end p {
    margin: 0;
  }

  .end button {
    max-width: 100%;
    padding: 0.6rem 1rem;
    font-size: 0.9375rem;
    overflow-wrap: anywhere;
  }

  .skeleton div {
    height: 4.5rem;
    margin: 0.75rem 1rem;
    border-radius: var(--radius);
    background: var(--surface);
  }

  /* 指で横にはじいている間。行を指に合わせて動かし、下に何をするかを出す */
  .row:global([data-swiping]) {
    background: var(--hover);
  }

  .row:global([data-swiping][data-armed][data-swipe="read"]) {
    background: var(--accent);
    color: var(--on-accent);
  }

  .row:global([data-swiping][data-armed][data-swipe="star"]) {
    background: var(--star);
    color: #ffffff;
  }

  .row:global([data-swiping])::after {
    content: attr(data-swipe-label);
    position: absolute;
    top: 50%;
    transform: translateY(-50%);
    font-size: 0.8125rem;
    font-weight: 600;
  }

  .row:global([data-swiping][data-swipe="read"])::after {
    left: 1rem;
  }

  .row:global([data-swiping][data-swipe="star"])::after {
    right: 1rem;
  }

  .row:global([data-swiping]) .item {
    position: relative;
    z-index: 1;
    background: var(--background);
    transform: translateX(var(--swipe, 0));
  }

  .row:global([data-swiping]) .actions {
    display: none;
  }
</style>
