<script lang="ts">
  import {
    type Article,
    type ArticleQuery,
    type MarkReadScope,
    toSafeHttpUrl,
  } from "@sendo-reader/core";
  import { untrack } from "svelte";
  import ArticleList from "../components/ArticleList.svelte";
  import ArticleView from "../components/ArticleView.svelte";
  import Dialog from "../components/Dialog.svelte";
  import Icon, { type IconName } from "../components/Icon.svelte";
  import ShortcutHelp from "../components/ShortcutHelp.svelte";
  import Sidebar from "../components/Sidebar.svelte";
  import { useReader } from "../lib/context";
  import { layout } from "../lib/layout.svelte";
  import { ArticleListState, type ListProgress } from "../lib/list.svelte";
  import { prefs } from "../lib/prefs.svelte";
  import { handleLink, isPlainClick, router, type View, viewHref } from "../lib/router.svelte";
  import Manage from "./Manage.svelte";
  import Settings from "./Settings.svelte";

  const reader = useReader();
  const list = new ArticleListState(reader.client);

  /** 狭い画面で、左のメニューを開いている */
  let menuOpen = $state(false);
  let helpOpen = $state(false);
  let confirmOpen = $state(false);
  let progressOpen = $state(false);
  let articleView = $state<ArticleView>();

  // 別の画面に移ったら、メニューを閉じる
  $effect(() => {
    void router.url;
    menuOpen = false;
  });

  type ListKind = "all" | "starred" | "feed" | "folder" | "search";
  interface Listing {
    kind: ListKind;
    query: ArticleQuery;
    title: string;
    /** まとめて既読にする範囲（できない一覧は null） */
    scope: MarkReadScope | null;
    /** その範囲の未読の数 */
    unread: number | null;
  }

  /** 狭い画面の下のバーに並べる行き先（メニューのボタンのあとに、この順で並べる） */
  const TABS: { href: string; label: string; icon: IconName }[] = [
    { href: "/starred", label: "Saved", icon: "star" },
    { href: "/", label: "All", icon: "inbox" },
    { href: "/manage", label: "Add", icon: "plus" },
    { href: "/search", label: "Search", icon: "search" },
  ];

  /** 下のバーで、いまいる場所として示すもの（フィードやフォルダの一覧は、どれでもない） */
  const currentTab = $derived(TABS.find((tab) => tab.href === viewHref(router.view))?.href ?? null);

  let listView = $state<ArticleList>();

  /**
   * 狭い画面では、一覧も記事も同じページを動かす（docs/decisions/ui.md の 6）。記事を開く前の
   * 一覧の位置を覚えておき、記事から戻ったら、その位置に戻す（記事は、先頭から出す）
   */
  let listScrollY = 0;
  let wasReading = router.articleId !== null;

  // 画面が替わる前（一覧がまだ出ている間）に、一覧の位置を覚える
  $effect.pre(() => {
    const reading = router.articleId !== null;
    untrack(() => {
      if (reading && !wasReading && layout.pageScroll) listScrollY = window.scrollY;
    });
  });

  // 別の画面（一覧の種類、購読の管理、設定）に移ったら、ページの先頭から出す。前の画面の位置を
  // 引き継がない（記事を開く・閉じるは、同じ画面のうちなので、ここでは扱わない）
  $effect(() => {
    void viewHref(router.view);
    untrack(() => {
      if (layout.pageScroll) window.scrollTo({ top: 0 });
    });
  });

  // 記事から一覧に戻ったら、覚えていた位置に戻す
  $effect(() => {
    const reading = router.articleId !== null;
    untrack(() => {
      if (!reading && wasReading && layout.pageScroll) window.scrollTo({ top: listScrollY });
      wasReading = reading;
    });
  });

  /** 下のバーを押した。いまいる画面をもう一度押したら、一覧の先頭に戻る（移らない） */
  function onTab(event: MouseEvent, href: string) {
    if (currentTab === href && isPlainClick(event)) {
      event.preventDefault();
      listView?.scrollToTop();
      return;
    }
    handleLink(event, href);
  }

  /** 開いている一覧の表示の設定（画像を出すか、並び順、未読だけ）。一覧ごとに覚える */
  const viewKey = $derived(viewHref(router.view));
  const options = $derived(prefs.viewOptions(viewKey));

  /** 開いている一覧（購読の管理と設定の画面では null） */
  const listing = $derived.by((): Listing | null => {
    const view = router.view;
    const order: ArticleQuery = options.oldestFirst ? { order: "oldest" } : {};
    const state: ArticleQuery = options.unreadOnly ? { state: "unread" } : {};
    switch (view.kind) {
      case "manage":
      case "settings":
        return null;
      case "search":
        return {
          kind: "search",
          query: { search: router.searchQuery, ...order },
          title: "Search",
          scope: null,
          unread: null,
        };
      case "starred":
        return {
          kind: "starred",
          query: { state: "starred", ...order },
          title: "Saved",
          scope: null,
          unread: null,
        };
      case "feed":
        return {
          kind: "feed",
          query: { feedId: view.id, ...state, ...order },
          title: reader.feedTitle(view.id),
          scope: { feedId: view.id },
          unread: reader.unread.feeds.get(view.id) ?? 0,
        };
      case "folder":
        return {
          kind: "folder",
          query: { folderId: view.id, ...state, ...order },
          title: reader.folders.find((f) => f.id === view.id)?.name ?? "Folder",
          scope: { folderId: view.id },
          unread: reader.unread.folders.get(view.id) ?? 0,
        };
      default:
        // 未読は、一覧の種類ではなく、絞り込みの状態（docs/decisions/settings.md の 2）
        return {
          kind: "all",
          query: { ...state, ...order },
          title: "All",
          scope: { all: true },
          unread: reader.unread.total,
        };
    }
  });

  /**
   * 開いている一覧の進み具合：この一覧を開いてから読んだ数 ÷（読んだ数 ＋ 残っている未読）。
   * 未読を数えない一覧（スター）では出さない
   */
  const progress = $derived.by((): ListProgress | null => {
    if (listing === null || listing.unread === null) return null;
    const total = list.done + listing.unread;
    return {
      title: listing.title,
      done: list.done,
      remaining: listing.unread,
      percent: total === 0 ? 100 : Math.round((list.done / total) * 100),
    };
  });

  const pageTitle = $derived(
    listing?.title ?? (router.view.kind === "manage" ? "Manage feeds" : "Settings"),
  );

  // タブの名前に、未読の数を出す
  $effect(() => {
    const count = reader.unread.total;
    document.title = `${count > 0 ? `(${count}) ` : ""}${pageTitle} - Sendo`;
  });

  // 条件が変わったときだけ読み直す（記事を開いたり閉じたりしただけでは読み直さない。
  // query は URL が変わるたびに作り直されるので、中身を文字列にして比べる）
  // 探す言葉が空の検索では、何も読まない（"null" を鍵にして、何も出さない一覧にする）
  const queryKey = $derived.by(() => {
    if (listing === null) return null;
    const blank = listing.kind === "search" && router.searchQuery.trim() === "";
    return JSON.stringify(blank ? null : listing.query);
  });
  $effect(() => {
    const key = queryKey;
    untrack(() => {
      if (key !== null) void list.show(JSON.parse(key) as ArticleQuery | null);
    });
  });

  // 手元の記事が変わったら、出している記事の状態を読み直す
  let seenVersion = reader.articlesVersion;
  $effect(() => {
    const version = reader.articlesVersion;
    untrack(() => {
      if (version === seenVersion) return;
      seenVersion = version;
      if (listing !== null) void list.refresh();
    });
  });

  // 開いた記事を、キーボードで選んでいる記事にもする（閉じたあと、その続きから移れる）
  $effect(() => {
    const id = router.articleId;
    if (id !== null) list.cursorId = id;
  });

  /** 次（1）・前（-1）の記事に移る。open なら開き、そうでなければ選ぶだけ */
  async function step(delta: 1 | -1, open = true) {
    const next = await list.step(router.articleId ?? list.cursorId, delta);
    if (next === null) return;
    list.cursorId = next.id;
    if (open || router.articleId !== null) router.openArticle(next.id);
  }

  function toggleCurrent(field: "readAt" | "starredAt") {
    if (router.articleId !== null) {
      void articleView?.toggle(field);
      return;
    }
    const article = list.find(list.cursorId);
    if (article !== null) list.toggle(article, field).catch(() => {});
  }

  function openOriginal() {
    if (router.articleId !== null) {
      articleView?.openOriginal();
      return;
    }
    const link = toSafeHttpUrl(list.find(list.cursorId)?.url ?? null);
    if (link !== null) window.open(link, "_blank", "noopener,noreferrer");
  }

  function askMarkAll() {
    if (listing?.scope != null && (listing.unread ?? 0) > 0) confirmOpen = true;
  }

  /** 取り消せる数の上限。sendo には記事ごとに送るので、多すぎるときは取り消しを出さない */
  const UNDO_LIMIT = 300;
  const DAY = 86_400_000;

  /** 画面の下に少しの間出す知らせ。undo があれば「取り消す」を出す */
  let toast = $state<{ message: string; undo: string[] | null } | null>(null);
  let toastTimer: ReturnType<typeof setTimeout> | undefined;

  function showToast(message: string, undo: string[] | null = null) {
    clearTimeout(toastTimer);
    toast = { message, undo };
    toastTimer = setTimeout(() => (toast = null), undo === null ? 4000 : 10_000);
  }

  type Range = NonNullable<Parameters<typeof reader.client.markAllRead>[1]>;

  /** 開いている一覧の範囲を、まとめて既読にする。range を渡すと、その一部だけ */
  async function markAll(range: Range = {}) {
    confirmOpen = false;
    menuArticle = null;
    if (listing?.scope == null) return;
    try {
      const ids = await reader.client.markAllRead(listing.scope, range);
      if (ids.length === 0) showToast("既読にする記事はありませんでした。");
      else {
        showToast(`${ids.length} 件を既読にしました。`, ids.length <= UNDO_LIMIT ? ids : null);
      }
    } catch {
      showToast("既読にできませんでした。");
    }
  }

  /** 行を長く押して（右クリックして）操作を出している記事 */
  let menuArticle = $state<Article | null>(null);
  let menuOpenFor = $state(false);

  function openArticleMenu(article: Article) {
    menuArticle = article;
    menuOpenFor = true;
  }

  // 窓を閉じたら、記事も外す
  $effect(() => {
    if (!menuOpenFor) menuArticle = null;
  });

  function menuToggle(field: "readAt" | "starredAt") {
    const article = list.find(menuArticle?.id ?? null);
    menuOpenFor = false;
    if (article !== null) list.toggle(article, field).catch(() => {});
  }

  /** 画面の並びで、その記事より上（above）か下の記事を、まとめて既読にする */
  function markBeside(above: boolean) {
    const article = menuArticle;
    menuOpenFor = false;
    if (article === null) return;
    const edge = { publishedAt: article.publishedAt, id: article.id };
    // 新しい順なら、上にあるのは新しい記事。古い順なら逆
    const newer = above !== options.oldestFirst;
    void markAll(newer ? { newerThan: edge } : { olderThan: edge });
  }

  const menuLink = $derived(toSafeHttpUrl(menuArticle?.url ?? null));

  /** 左のメニューに並ぶ順のフィード（フォルダごと、そのあとにフォルダなし） */
  const feedOrder = $derived([
    ...reader.folders.flatMap((folder) => reader.feeds.filter((f) => f.folderId === folder.id)),
    ...reader.feeds.filter((feed) => feed.folderId === null),
  ]);

  /** 開いているフィードから見て、次（1）・前（-1）の、未読のあるフィード */
  function besideFeed(delta: 1 | -1) {
    const view = router.view;
    const from = view.kind === "feed" ? feedOrder.findIndex((feed) => feed.id === view.id) : -1;
    if (from === -1 && delta === -1) return null;
    for (let i = from + delta; i >= 0 && i < feedOrder.length; i += delta) {
      const feed = feedOrder[i];
      if (feed !== undefined && (reader.unread.feeds.get(feed.id) ?? 0) > 0) return feed;
    }
    return null;
  }

  function stepFeed(delta: 1 | -1) {
    const feed = besideFeed(delta);
    if (feed !== null) go({ kind: "feed", id: feed.id });
  }

  /** 一覧の終わりに出す、次へ進むボタン。未読が残っていれば既読にしてから、次のフィードへ移る */
  const next = $derived.by(() => {
    if (listing === null || listing.scope === null) return null;
    const unread = listing.unread ?? 0;
    const feed = listing.kind === "feed" ? besideFeed(1) : null;
    if (feed === null) {
      return unread === 0 ? null : { label: "Mark all as read", go: () => void markAll() };
    }
    const title = feed.title ?? feed.url;
    return {
      label: unread === 0 ? `Next: ${title}` : `Mark all as read, next: ${title}`,
      go: () => {
        if (unread > 0) void markAll();
        go({ kind: "feed", id: feed.id });
      },
    };
  });

  async function undoMarkAll() {
    if (toast?.undo == null) return;
    // 状態に入れた配列は、そのままではワーカーに渡せない（複製できない）。素の配列にする
    const ids = [...toast.undo];
    try {
      await reader.client.setReadMany(ids, false);
      showToast(`${ids.length} 件を未読に戻しました。`);
    } catch {
      showToast("未読に戻せませんでした。");
    }
  }

  function go(view: View) {
    router.navigate(viewHref(view));
  }

  /** g のあとに押すキーを待っている（g u で未読、など） */
  let chord = false;
  let chordTimer: ReturnType<typeof setTimeout> | undefined;

  /** キーボードの操作（一覧は components/ShortcutHelp.svelte）。文字を打っているときは何もしない */
  function onKeydown(event: KeyboardEvent) {
    if (event.defaultPrevented || event.isComposing) return;
    if (event.ctrlKey || event.metaKey || event.altKey) return;
    const target = event.target;
    if (target instanceof HTMLElement) {
      if (target.isContentEditable || /^(INPUT|TEXTAREA|SELECT)$/.test(target.tagName)) return;
      // ボタンやリンクの上の Enter は、それを押す
      if (event.key === "Enter" && /^(BUTTON|A|SUMMARY)$/.test(target.tagName)) return;
    }
    if (document.querySelector("dialog[open]") !== null) return;

    if (chord) {
      chord = false;
      clearTimeout(chordTimer);
      const views: Record<string, View> = {
        a: { kind: "all" },
        s: { kind: "starred" },
        m: { kind: "manage" },
      };
      const view = views[event.key];
      if (view !== undefined) {
        event.preventDefault();
        go(view);
        return;
      }
    }

    const actions: Record<string, () => void> = {
      "?": () => (helpOpen = true),
      g: () => {
        chord = true;
        chordTimer = setTimeout(() => (chord = false), 1500);
      },
      "/": () => go({ kind: "search" }),
      r: () => void reader.client.syncNow(),
      Escape: () => {
        if (menuOpen) menuOpen = false;
        else router.openArticle(null);
      },
    };
    if (listing !== null) {
      Object.assign(actions, {
        j: () => void step(1),
        k: () => void step(-1),
        n: () => void step(1, false),
        p: () => void step(-1, false),
        o: () => list.cursorId !== null && router.openArticle(list.cursorId),
        Enter: () => list.cursorId !== null && router.openArticle(list.cursorId),
        m: () => toggleCurrent("readAt"),
        s: () => toggleCurrent("starredAt"),
        v: openOriginal,
        A: askMarkAll,
        J: () => stepFeed(1),
        K: () => stepFeed(-1),
      });
    }
    const action = actions[event.key];
    if (action === undefined) return;
    event.preventDefault();
    action();
  }
</script>

<svelte:window onkeydown={onKeydown} />

<div
  class="reader"
  class:managing={listing === null}
  class:reading={router.articleId !== null}
  class:menu-open={menuOpen}
>
  <Sidebar onhelp={() => (helpOpen = true)} {progress} onprogress={() => (progressOpen = true)} />
  <button
    type="button"
    class="scrim"
    aria-label="Close menu"
    tabindex="-1"
    onclick={() => (menuOpen = false)}
  ></button>
  {#if listing === null}
    <div class="page">
      <div class="bar">{pageTitle}</div>
      {#if router.view.kind === "manage"}
        <Manage />
      {:else}
        <Settings />
      {/if}
    </div>
  {:else}
    <ArticleList
      bind:this={listView}
      {list}
      title={listing.title}
      kind={listing.kind}
      unread={listing.scope === null ? null : listing.unread}
      onmarkall={askMarkAll}
      search={listing.kind === "search" ? router.searchQuery : null}
      onsearch={(query) => router.setSearchQuery(query)}
      {options}
      onoption={(patch) => prefs.setViewOptions(viewKey, patch)}
      onmenu={openArticleMenu}
      {next}
      {progress}
      onprogress={() => (progressOpen = true)}
    />
    <ArticleView bind:this={articleView} articleId={router.articleId} {list} onstep={step} />
  {/if}

  <!--
    狭い画面の下のバー。一覧の画面でだけ出す（記事の画面では、同じ場所に記事の操作が入る）。
    広い画面では、左のメニューを出したままにするので出さない
  -->
  <nav class="tabs" aria-label="Main">
    <button
      type="button"
      class="tab"
      aria-label="Menu"
      aria-expanded={menuOpen}
      onclick={() => (menuOpen = !menuOpen)}
    >
      <Icon name="menu" />
      <span>Menu</span>
    </button>
    {#each TABS as tab (tab.href)}
      <a
        class="tab"
        href={tab.href}
        aria-current={currentTab === tab.href ? "page" : undefined}
        onclick={(e) => onTab(e, tab.href)}
      >
        <Icon name={tab.icon} filled={tab.icon === "star" && currentTab === tab.href} />
        <span>{tab.label}</span>
      </a>
    {/each}
  </nav>
</div>

<ShortcutHelp bind:open={helpOpen} />

<Dialog bind:open={progressOpen} title="Progress">
  {#if progress !== null}
    <dl class="stats">
      <div>
        <dt>「{progress.title}」で読んだ記事</dt>
        <dd>{progress.done} 件</dd>
      </div>
      <div>
        <dt>「{progress.title}」に残っている未読</dt>
        <dd>{progress.remaining} 件</dd>
      </div>
      <div>
        <dt>今日読んだ記事</dt>
        <dd>{reader.readToday} 件</dd>
      </div>
      <div>
        <dt>未読の合計</dt>
        <dd>{reader.unread.total} 件</dd>
      </div>
    </dl>
  {/if}
</Dialog>

<Dialog bind:open={confirmOpen} title="Mark as read">
  <p class="confirm">
    「{listing?.title}」の未読 {listing?.unread ?? 0} 件のうち、どれを既読にしますか。
    {#if (listing?.unread ?? 0) > UNDO_LIMIT}
      {UNDO_LIMIT}
      件を超えると、取り消せません。
    {/if}
  </p>
  <div class="choices">
    <!-- svelte-ignore a11y_autofocus -->
    <!-- biome-ignore lint/a11y/noAutofocus: 確かめの窓（dialog）の中で、Enter でそのまま進めるようにする -->
    <button type="button" class="primary" autofocus onclick={() => markAll()}>
      Mark all as read
    </button>
    <button type="button" onclick={() => markAll({ publishedBefore: Date.now() - DAY })}>
      Older than 1 day
    </button>
    <button type="button" onclick={() => markAll({ publishedBefore: Date.now() - 7 * DAY })}>
      Older than 1 week
    </button>
    <button type="button" class="link" onclick={() => (confirmOpen = false)}>Cancel</button>
  </div>
</Dialog>

<Dialog bind:open={menuOpenFor} title={menuArticle?.title ?? "(Untitled)"}>
  {#if menuArticle !== null}
    <div class="choices">
      <button type="button" onclick={() => menuToggle("readAt")}>
        {menuArticle.readAt === null ? "Mark as read" : "Mark as unread"}
      </button>
      <button type="button" onclick={() => menuToggle("starredAt")}>
        {menuArticle.starredAt === null ? "Save" : "Unsave"}
      </button>
      {#if listing?.scope != null}
        <button type="button" onclick={() => markBeside(true)}>Mark above as read</button>
        <button type="button" onclick={() => markBeside(false)}>Mark below as read</button>
      {/if}
      {#if menuLink !== null}
        <a
          class="choice"
          href={menuLink}
          target="_blank"
          rel="noopener noreferrer"
          onclick={() => (menuOpenFor = false)}
        >
          Open original
        </a>
      {/if}
    </div>
  {/if}
</Dialog>

{#if toast !== null}
  <div class="toast" role="status">
    <span>{toast.message}</span>
    {#if toast.undo !== null}
      <button type="button" onclick={undoMarkAll}>Undo</button>
    {/if}
  </div>
{/if}

<style>
  .reader {
    display: grid;
    grid-template-columns: 17rem clamp(20rem, 30vw, 27rem) minmax(0, 1fr);
    height: 100dvh;
  }

  .reader > :global(*) {
    min-height: 0;
  }

  .reader.managing {
    grid-template-columns: 17rem minmax(0, 1fr);
  }

  .page {
    display: flex;
    flex-direction: column;
    min-width: 0;
  }

  .page > :global(main) {
    flex: 1;
    min-height: 0;
  }

  .tabs,
  .bar,
  .scrim {
    display: none;
  }

  .stats {
    margin: 0;
  }

  .stats div {
    display: flex;
    justify-content: space-between;
    gap: 1rem;
    padding: 0.5rem 0;
    border-bottom: 1px solid var(--border);
  }

  .stats dt {
    color: var(--muted);
  }

  .stats dd {
    flex: none;
    margin: 0;
    font-weight: 600;
    font-variant-numeric: tabular-nums;
  }

  .confirm {
    margin: 0 0 1.25rem;
  }

  .choices {
    display: grid;
    gap: 0.5rem;
  }

  .choices button {
    padding-block: 0.6rem;
  }

  .choice {
    padding: 0.6rem 0.8rem;
    border: 1px solid var(--border-strong);
    border-radius: var(--radius-small);
    color: inherit;
    text-align: center;
    text-decoration: none;
  }

  .choice:hover {
    background: var(--hover);
  }

  .choices .link {
    justify-self: center;
    padding-block: 0.25rem;
  }

  /* 画面の下に少しの間出す知らせ（取り消し） */
  .toast {
    position: fixed;
    right: 1rem;
    bottom: calc(1rem + env(safe-area-inset-bottom, 0px));
    left: 1rem;
    z-index: 4;
    display: flex;
    align-items: center;
    gap: 0.75rem;
    width: fit-content;
    max-width: calc(100vw - 2rem);
    margin-inline: auto;
    padding: 0.625rem 0.75rem 0.625rem 1rem;
    border-radius: var(--radius);
    background: var(--text);
    color: var(--background);
    font-size: 0.9375rem;
    box-shadow: var(--shadow);
  }

  .toast button {
    flex: none;
    border-color: transparent;
    background: none;
    color: inherit;
    font-weight: 700;
    text-decoration: underline;
  }

  .toast button:hover:not(:disabled) {
    background: none;
    opacity: 0.8;
  }

  /* 狭い画面では、一覧か記事のどちらかだけを出し、メニューは左から重ねて開く */
  @media (max-width: 56rem) {
    .reader,
    .reader.managing {
      grid-template-columns: minmax(0, 1fr);
    }

    /*
     * ページ全体をスクロールする（docs/decisions/ui.md の 6）。高さを画面に固定せず、中身の分だけ
     * 伸ばす。一覧（か、購読の管理・設定）の下のバーは、画面の下に貼り付け、その分を空けておく。
     * 記事の画面では出さない（同じ場所に、記事の操作が入る）
     */
    .reader {
      --tabs-height: calc(3.5rem + env(safe-area-inset-bottom, 0px));
      grid-template-rows: auto;
      height: auto;
      min-height: 100dvh;
    }

    .reader:not(.reading) {
      padding-bottom: var(--tabs-height);
    }

    .reader:not(.reading) > .tabs {
      position: fixed;
      right: 0;
      bottom: 0;
      left: 0;
      z-index: 1;
      display: flex;
      height: var(--tabs-height);
      padding-bottom: env(safe-area-inset-bottom, 0px);
      border-top: 1px solid var(--border);
      background: var(--background);
    }

    .tab {
      display: grid;
      flex: 1 1 0;
      justify-items: center;
      gap: 0.125rem;
      min-width: 0;
      padding: 0.5rem 0.125rem 0.375rem;
      border: 0;
      border-radius: 0;
      background: none;
      color: var(--muted);
      font: inherit;
      font-size: 0.6875rem;
      line-height: 1.2;
      text-decoration: none;
    }

    .tab :global(.icon) {
      width: 1.5rem;
      height: 1.5rem;
    }

    .tab span {
      max-width: 100%;
      overflow: hidden;
      text-overflow: ellipsis;
      white-space: nowrap;
    }

    .tab[aria-current="page"],
    .tab[aria-expanded="true"] {
      color: var(--accent);
      font-weight: 600;
    }

    /* 知らせは、下のバー（記事の画面では、記事の操作）の上に出す */
    .toast {
      bottom: calc(4.5rem + env(safe-area-inset-bottom, 0px));
    }

    .bar {
      position: sticky;
      top: 0;
      z-index: 1;
      background: var(--background);
      display: flex;
      align-items: center;
      gap: 0.25rem;
      min-height: 3.25rem;
      padding: 0.5rem 1rem;
      border-bottom: 1px solid var(--border);
      font-weight: 600;
    }

    .reader > :global(.sidebar) {
      position: fixed;
      inset: 0 auto 0 0;
      z-index: 3;
      width: min(19rem, 86vw);
      box-shadow: var(--shadow);
      visibility: hidden;
      transform: translateX(-100%);
      transition:
        transform 0.18s ease-out,
        visibility 0.18s;
    }

    .reader.menu-open > :global(.sidebar) {
      visibility: visible;
      transform: none;
    }

    .reader.menu-open > .scrim {
      display: block;
      position: fixed;
      inset: 0;
      z-index: 2;
      padding: 0;
      border: 0;
      border-radius: 0;
      background: var(--scrim);
    }

    @media (prefers-reduced-motion: reduce) {
      .reader > :global(.sidebar) {
        transition: none;
      }
    }

    .reader.reading > :global(.article-list) {
      display: none;
    }

    .reader:not(.reading) > :global(.article-view) {
      display: none;
    }
  }
</style>
