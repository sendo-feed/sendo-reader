<script lang="ts">
  import { type Feed, feedName } from "@sendo-reader/core";
  import { useReader } from "../lib/context";
  import type { ListProgress } from "../lib/list.svelte";
  import { prefs } from "../lib/prefs.svelte";
  import { handleLink, router, type View, viewHref } from "../lib/router.svelte";
  import Icon, { type IconName } from "./Icon.svelte";
  import RemoteImage from "./RemoteImage.svelte";
  import SyncStatus from "./SyncStatus.svelte";
  import WorkspaceSelector from "./WorkspaceSelector.svelte";

  let {
    onhelp,
    progress,
    onprogress,
  }: {
    onhelp: () => void;
    /** 開いている一覧の進み具合（一覧を開いていなければ null） */
    progress: ListProgress | null;
    onprogress: () => void;
  } = $props();

  const reader = useReader();

  const currentHref = $derived(viewHref(router.view));

  function unreadOf(feed: Feed): number {
    return reader.unread.feeds.get(feed.id) ?? 0;
  }

  /** 未読のないフィードを隠しているときも、開いているフィードは出す */
  function visible(feed: Feed): boolean {
    if (!prefs.value.hideReadFeeds || unreadOf(feed) > 0) return true;
    return currentHref === viewHref({ kind: "feed", id: feed.id });
  }

  const groups = $derived(
    reader.folders
      .map((folder) => ({
        folder,
        feeds: reader.feeds.filter((feed) => feed.folderId === folder.id && visible(feed)),
        unread: reader.unread.folders.get(folder.id) ?? 0,
      }))
      .filter(
        (group) =>
          !prefs.value.hideReadFeeds ||
          group.unread > 0 ||
          group.feeds.length > 0 ||
          currentHref === viewHref({ kind: "folder", id: group.folder.id }),
      ),
  );
  const loose = $derived(reader.feeds.filter((feed) => feed.folderId === null && visible(feed)));

  /** フィードの頭文字の丸に付ける色。フィードごとに決まった色にする（アイコンの画像は出さない） */
  function hueOf(id: string): number {
    let hash = 0;
    for (let i = 0; i < id.length; i++) hash = (Math.imul(hash, 31) + id.charCodeAt(i)) >>> 0;
    // 似た ID（末尾だけ違う）でも色が離れるように、かき混ぜる
    return (Math.imul(hash, 2654435761) >>> 0) % 360;
  }

  function initialOf(feed: Feed): string {
    const [first] = (
      feed.displayName ??
      feed.title ??
      new URL(feed.url, location.href).hostname
    ).trim();
    return (first ?? "?").toUpperCase();
  }

  function signOut() {
    void reader.signOut();
  }
</script>

{#snippet item(view: View, label: string, count: number, icon: IconName | null)}
  {@const href = viewHref(view)}
  <a
    {href}
    title={count > 0 ? `${label} (${count} unread)` : label}
    class:quiet={view.kind === "folder" && count === 0}
    aria-current={currentHref === href ? "page" : undefined}
    onclick={(e) => handleLink(e, href)}
  >
    {#if icon !== null}
      <Icon name={icon} />
    {:else}
      <span class="folder-icon"><Icon name="folder" /></span>
    {/if}
    <span class="name">{label}</span>
    {#if count > 0}
      <span class="count">{count}</span>
    {/if}
  </a>
{/snippet}

{#snippet feedItem(feed: Feed)}
  {@const href = viewHref({ kind: "feed", id: feed.id })}
  {@const count = unreadOf(feed)}
  {@const label = feedName(feed)}
  <li>
    <a
      {href}
      title={count > 0 ? `${label} (${count} unread)` : label}
      class:quiet={count === 0}
      aria-current={currentHref === href ? "page" : undefined}
      onclick={(e) => handleLink(e, href)}
    >
      <span class="avatar" style:--hue={hueOf(feed.id)} aria-hidden="true">
        <RemoteImage src={feed.iconUrl}>
          {#snippet fallback()}
            {initialOf(feed)}
          {/snippet}
        </RemoteImage>
      </span>
      <span class="name">{label}</span>
      {#if count > 0}
        <span class="count">{count}</span>
      {/if}
    </a>
  </li>
{/snippet}

<nav class="sidebar" class:compact={prefs.value.sidebarCollapsed} aria-label="Feeds">
  <div class="brand">
    <span class="logo">Sendo</span>
    <button
      type="button"
      class="icon-button sidebar-toggle"
      aria-label={prefs.value.sidebarCollapsed ? "Expand sidebar" : "Collapse sidebar"}
      title={prefs.value.sidebarCollapsed ? "Expand sidebar" : "Collapse sidebar"}
      aria-expanded={!prefs.value.sidebarCollapsed}
      onclick={() => prefs.set({ sidebarCollapsed: !prefs.value.sidebarCollapsed })}
    >
      <Icon name={prefs.value.sidebarCollapsed ? "panelRight" : "panelLeft"} />
    </button>
    <a
      class="add"
      href="/manage"
      title="Add feed"
      aria-label="Add feed"
      onclick={(e) => handleLink(e, "/manage")}
    >
      <Icon name="plus" />
    </a>
  </div>

  <button
    type="button"
    class="today"
    disabled={progress === null}
    aria-label={progress === null
      ? `${reader.unread.total} unread`
      : `${reader.unread.total} unread. Progress ${progress.percent}%`}
    title="Progress"
    onclick={onprogress}
  >
    {#if progress !== null}
      <svg class="gauge" viewBox="0 0 36 36" aria-hidden="true">
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
      <span class="percent">{progress.percent}<small>%</small></span>
    {:else}
      <span class="progress-icon"><Icon name="inbox" /></span>
    {/if}
    <span class="numbers">
      <strong>{reader.unread.total}</strong>
      <span>unread</span>
      {#if progress !== null}
        <span class="done">
          {progress.remaining === 0 && progress.done === 0
            ? "この一覧に未読はありません"
            : `この一覧で ${progress.done} 件読みました`}
        </span>
      {/if}
    </span>
  </button>

  {#if reader.workspacesAvailable || reader.workspaceIds !== undefined}
    <WorkspaceSelector compact={prefs.value.sidebarCollapsed} />
  {/if}

  <div class="scroll">
    <div class="views">
      {@render item({ kind: "all" }, "All", reader.unread.total, "inbox")}
      {@render item({ kind: "recentlyRead" }, "Recently Read", 0, "history")}
      {@render item({ kind: "starred" }, "Saved", 0, "bookmark")}
      {@render item({ kind: "search" }, "Search", 0, "search")}
    </div>

    <div class="heading">
      <span>Feeds</span>
      <button
        type="button"
        class="icon-button"
        aria-pressed={prefs.value.hideReadFeeds}
        aria-label="Unread feeds only"
        title="Unread feeds only"
        onclick={() => prefs.set({ hideReadFeeds: !prefs.value.hideReadFeeds })}
      >
        <Icon name="filter" />
      </button>
    </div>

    {#each groups as { folder, feeds, unread } (folder.id)}
      {@const collapsed = prefs.isCollapsed(folder.id)}
      <section>
        <div class="folder">
          <button
            type="button"
            class="toggle"
            aria-expanded={!collapsed}
            aria-label={`${collapsed ? "Expand" : "Collapse"} ${folder.name}`}
            onclick={() => prefs.toggleCollapsed(folder.id)}
          >
            <Icon name={collapsed ? "chevronRight" : "chevronDown"} />
          </button>
          {@render item({ kind: "folder", id: folder.id }, folder.name, unread, null)}
        </div>
        {#if !collapsed && feeds.length > 0}
          <ul>
            {#each feeds as feed (feed.id)}
              {@render feedItem(feed)}
            {/each}
          </ul>
        {/if}
      </section>
    {/each}

    {#if loose.length > 0}
      <ul class="loose">
        {#each loose as feed (feed.id)}
          {@render feedItem(feed)}
        {/each}
      </ul>
    {/if}

    {#if reader.feeds.length === 0}
      <p class="empty">
        購読しているフィードはまだありません。
        <a href="/manage" onclick={(e) => handleLink(e, "/manage")}>Add feed</a>
      </p>
    {:else if groups.length === 0 && loose.length === 0}
      <p class="empty">未読のあるフィードはありません。</p>
    {/if}
  </div>

  <footer>
    <SyncStatus compact={prefs.value.sidebarCollapsed} />
    <div class="links">
      {@render item({ kind: "manage" }, "Manage feeds", 0, "rss")}
      {@render item({ kind: "settings" }, "Settings", 0, "sliders")}
    </div>
    <div class="account">
      {#if reader.user !== null}
        <span class="user" title={reader.user.email}>{reader.user.email}</span>
      {/if}
      <button
        type="button"
        class="icon-button"
        aria-label="Keyboard shortcuts"
        title="Keyboard shortcuts (?)"
        onclick={onhelp}
      >
        <Icon name="keyboard" />
      </button>
      <button
        type="button"
        class="icon-button"
        aria-label="Sign out"
        title="Sign out"
        onclick={signOut}
      >
        <Icon name="logout" />
      </button>
    </div>
  </footer>
</nav>

<style>
  .sidebar {
    display: flex;
    flex-direction: column;
    min-height: 0;
    border-right: 1px solid var(--border);
    background: var(--surface);
    font-size: 0.9375rem;
  }

  .sidebar-toggle,
  .folder-icon,
  .progress-icon {
    display: none;
  }

  .brand {
    display: flex;
    align-items: center;
    justify-content: space-between;
    padding: 0.75rem 0.75rem 0.5rem 1rem;
  }

  .logo {
    font-size: 1.125rem;
    font-weight: 700;
    margin-right: auto;
    letter-spacing: 0.02em;
    color: var(--accent);
  }

  .brand .add {
    flex: none;
    width: 2.25rem;
    height: 2.25rem;
    padding: 0;
    justify-content: center;
    color: var(--muted);
  }

  /* 未読の数と、今日の進み具合の輪 */
  .today {
    position: relative;
    display: flex;
    align-items: center;
    gap: 0.75rem;
    margin: 0 0.5rem 0.75rem;
    padding: 0.625rem 0.75rem;
    border: 1px solid var(--border);
    border-radius: var(--radius);
    background: var(--raised);
    text-align: start;
  }

  .today:disabled {
    opacity: 1;
  }

  .gauge {
    flex: none;
    width: 3rem;
    height: 3rem;
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
    transition: stroke-dasharray 0.3s ease-out;
  }

  .percent {
    position: absolute;
    left: 0.75rem;
    width: 3rem;
    font-size: 0.75rem;
    font-weight: 700;
    font-variant-numeric: tabular-nums;
    text-align: center;
  }

  .percent small {
    font-size: 0.5625rem;
  }

  .numbers {
    min-width: 0;
    color: var(--muted);
    font-size: 0.8125rem;
    line-height: 1.35;
  }

  .numbers strong {
    color: var(--text);
    font-size: 1.375rem;
    font-variant-numeric: tabular-nums;
    line-height: 1.1;
  }

  .done {
    display: block;
    font-size: 0.75rem;
  }

  .scroll {
    flex: 1;
    min-height: 0;
    overflow-y: auto;
    /* 端まで動かしても、うしろのページを動かさない（狭い画面では、メニューの下に一覧がある） */
    overscroll-behavior: contain;
    padding: 0 0.5rem 0.75rem;
  }

  .heading {
    display: flex;
    align-items: center;
    justify-content: space-between;
    margin-top: 0.75rem;
    padding-left: 0.5rem;
    color: var(--faint);
    font-size: 0.75rem;
    font-weight: 600;
    letter-spacing: 0.06em;
  }

  .heading .icon-button {
    width: 1.75rem;
    height: 1.75rem;
  }

  ul {
    list-style: none;
    margin: 0;
    padding: 0 0 0 1.5rem;
  }

  ul.loose {
    padding-left: 0;
  }

  a {
    display: flex;
    align-items: center;
    gap: 0.5rem;
    min-width: 0;
    padding: 0.3rem 0.5rem;
    border-radius: var(--radius-small);
    color: inherit;
    text-decoration: none;
  }

  a:hover {
    background: var(--hover);
  }

  a[aria-current="page"] {
    background: var(--selected);
    font-weight: 600;
  }

  a.quiet:not([aria-current="page"]) {
    color: var(--muted);
  }

  .folder {
    display: flex;
    align-items: center;
  }

  .folder a {
    flex: 1;
    padding-left: 0.25rem;
    font-weight: 400;
  }

  .folder a:not(.quiet) {
    font-weight: 600;
  }

  .toggle {
    display: grid;
    place-items: center;
    flex: none;
    width: 1.5rem;
    height: 1.75rem;
    padding: 0;
    border: 0;
    background: none;
    color: var(--faint);
    font-size: 0.8rem;
  }

  .avatar {
    display: grid;
    place-items: center;
    flex: none;
    width: 1.25rem;
    height: 1.25rem;
    border-radius: 0.3rem;
    background: hsl(var(--hue) 42% 46%);
    color: #ffffff;
    font-size: 0.6875rem;
    font-weight: 700;
    line-height: 1;
    overflow: hidden;
  }

  /* アイコンの画像があるときは、頭文字の印の色を出さない */
  .avatar:has(:global(img)) {
    background: none;
  }

  .name {
    flex: 1;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }

  .count {
    flex: none;
    color: var(--muted);
    font-size: 0.8125rem;
    font-weight: 500;
    font-variant-numeric: tabular-nums;
  }

  .empty {
    margin: 0.5rem;
    color: var(--muted);
    font-size: 0.875rem;
  }

  .empty a {
    display: inline;
    padding: 0;
    color: var(--accent);
  }

  footer {
    display: grid;
    gap: 0.25rem;
    padding: 0.5rem 0.5rem calc(0.5rem + env(safe-area-inset-bottom, 0px));
    border-top: 1px solid var(--border);
  }

  .account {
    display: flex;
    align-items: center;
    padding-left: 0.5rem;
  }

  .user {
    flex: 1;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
    color: var(--muted);
    font-size: 0.8125rem;
  }
  @media (width > 56rem) {
    .sidebar-toggle {
      display: grid;
    }

    .compact .brand,
    .compact .account {
      flex-direction: column;
      padding: 0.5rem;
      gap: 0.25rem;
    }

    .compact .logo,
    .compact .heading > span,
    .compact .user,
    .compact .empty,
    .compact .toggle {
      display: none;
    }

    /* 名前と件数は、アイコンだけのときも読み上げられるように残す */
    .compact .name,
    .compact .count,
    .compact .numbers {
      position: absolute;
      width: 1px;
      height: 1px;
      padding: 0;
      overflow: hidden;
      clip-path: inset(50%);
      white-space: nowrap;
    }

    .compact a {
      position: relative;
      justify-content: center;
      min-height: 2.5rem;
      padding: 0.5rem;
    }

    .compact .folder-icon,
    .compact .progress-icon {
      display: flex;
    }

    .compact .folder a {
      padding-left: 0.5rem;
    }

    .compact ul {
      padding-left: 0;
    }

    .compact section,
    .compact .loose {
      margin-top: 0.5rem;
      border-top: 1px solid var(--border);
    }

    .compact .heading {
      justify-content: center;
      padding-left: 0;
    }

    .compact .today {
      justify-content: center;
      height: 3rem;
      padding: 0;
    }

    .compact .gauge {
      width: 2.25rem;
      height: 2.25rem;
    }

    .compact .percent {
      left: 0;
      width: 100%;
    }

    .compact .account {
      padding: 0;
    }
  }
</style>
