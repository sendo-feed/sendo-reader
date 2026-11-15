<script lang="ts">
  import type { Feed } from "@sendo-reader/core";
  import { useReader } from "../lib/context";
  import { prefs } from "../lib/prefs.svelte";
  import { handleLink, router, type View, viewHref } from "../lib/router.svelte";
  import Icon, { type IconName } from "./Icon.svelte";
  import SyncStatus from "./SyncStatus.svelte";

  let { onhelp }: { onhelp: () => void } = $props();

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
    const [first] = (feed.title ?? new URL(feed.url, location.href).hostname).trim();
    return (first ?? "?").toUpperCase();
  }

  const progress = $derived(reader.progress);

  function signOut() {
    void reader.signOut();
  }
</script>

{#snippet item(view: View, label: string, count: number, icon: IconName | null)}
  {@const href = viewHref(view)}
  <a
    {href}
    aria-current={currentHref === href ? "page" : undefined}
    onclick={(e) => handleLink(e, href)}
  >
    {#if icon !== null}
      <Icon name={icon} />
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
  <li>
    <a
      {href}
      class:quiet={count === 0}
      aria-current={currentHref === href ? "page" : undefined}
      onclick={(e) => handleLink(e, href)}
    >
      <span class="avatar" style:--hue={hueOf(feed.id)} aria-hidden="true">
        {initialOf(feed)}
      </span>
      <span class="name">{feed.title ?? feed.url}</span>
      {#if count > 0}
        <span class="count">{count}</span>
      {/if}
    </a>
  </li>
{/snippet}

<nav aria-label="フィード">
  <div class="brand">
    <span class="logo">Sendo</span>
    <a
      class="add"
      href="/manage"
      title="フィードを追加"
      aria-label="フィードを追加"
      onclick={(e) => handleLink(e, "/manage")}
    >
      <Icon name="plus" />
    </a>
  </div>

  <div
    class="today"
    role="img"
    aria-label={`未読 ${reader.unread.total} 件。今日は ${reader.readToday} 件読みました（${progress}%）`}
  >
    <svg class="gauge" viewBox="0 0 36 36" aria-hidden="true">
      <circle class="track" cx="18" cy="18" r="15.9155" />
      {#if progress > 0}
        <circle class="bar" cx="18" cy="18" r="15.9155" stroke-dasharray={`${progress} 100`} />
      {/if}
    </svg>
    <span class="percent" aria-hidden="true">{progress}<small>%</small></span>
    <span class="numbers" aria-hidden="true">
      <strong>{reader.unread.total}</strong>
      <span>件の未読</span>
      <span class="done">
        {reader.unread.total === 0 && reader.feeds.length > 0
          ? "すべて読み終えました"
          : `今日 ${reader.readToday} 件読みました`}
      </span>
    </span>
  </div>

  <div class="scroll">
    <div class="views">
      {@render item({ kind: "unread" }, "未読", reader.unread.total, "inbox")}
      {@render item({ kind: "all" }, "すべて", 0, "layers")}
      {@render item({ kind: "starred" }, "スター", 0, "star")}
    </div>

    <div class="heading">
      <span>フィード</span>
      <button
        type="button"
        class="icon-button"
        aria-pressed={prefs.value.hideReadFeeds}
        aria-label="未読のあるフィードだけを出す"
        title="未読のあるフィードだけを出す"
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
            aria-label={`${folder.name} を${collapsed ? "開く" : "畳む"}`}
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
        <a href="/manage" onclick={(e) => handleLink(e, "/manage")}>フィードを追加</a>
      </p>
    {:else if groups.length === 0 && loose.length === 0}
      <p class="empty">未読のあるフィードはありません。</p>
    {/if}
  </div>

  <footer>
    <SyncStatus />
    <div class="links">
      {@render item({ kind: "manage" }, "購読の管理", 0, "rss")}
      {@render item({ kind: "settings" }, "設定", 0, "sliders")}
    </div>
    <div class="account">
      {#if reader.user !== null}
        <span class="user" title={reader.user.email}>{reader.user.email}</span>
      {/if}
      <button
        type="button"
        class="icon-button"
        aria-label="キーボードの操作"
        title="キーボードの操作（?）"
        onclick={onhelp}
      >
        <Icon name="keyboard" />
      </button>
      <button
        type="button"
        class="icon-button"
        aria-label="ログアウト"
        title="ログアウト"
        onclick={signOut}
      >
        <Icon name="logout" />
      </button>
    </div>
  </footer>
</nav>

<style>
  nav {
    display: flex;
    flex-direction: column;
    min-height: 0;
    border-right: 1px solid var(--border);
    background: var(--surface);
    font-size: 0.9375rem;
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
</style>
