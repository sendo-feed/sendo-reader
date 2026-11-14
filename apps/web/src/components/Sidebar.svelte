<script lang="ts">
  import { useReader } from "../lib/context";
  import { handleLink, router, type View, viewHref } from "../lib/router.svelte";
  import SyncStatus from "./SyncStatus.svelte";

  const reader = useReader();

  const loose = $derived(reader.feeds.filter((feed) => feed.folderId === null));

  function feedsIn(folderId: string) {
    return reader.feeds.filter((feed) => feed.folderId === folderId);
  }

  function isCurrent(view: View): boolean {
    return viewHref(view) === viewHref(router.view);
  }

  async function signOut() {
    await reader.client.signOut();
    reader.signedIn = false;
  }
</script>

{#snippet item(view: View, label: string, count: number)}
  {@const href = viewHref(view)}
  <a
    {href}
    aria-current={isCurrent(view) ? "page" : undefined}
    onclick={(e) => handleLink(e, href)}
  >
    <span class="name">{label}</span>
    {#if count > 0}
      <span class="count">{count}</span>
    {/if}
  </a>
{/snippet}

<nav aria-label="フィード">
  <div class="views">
    {@render item({ kind: "unread" }, "未読", reader.unread.total)}
    {@render item({ kind: "all" }, "すべて", 0)}
    {@render item({ kind: "starred" }, "スター", 0)}
  </div>

  {#each reader.folders as folder (folder.id)}
    <section>
      {@render item(
        { kind: "folder", id: folder.id },
        folder.name,
        reader.unread.folders.get(folder.id) ?? 0,
      )}
      <ul>
        {#each feedsIn(folder.id) as feed (feed.id)}
          <li>
            {@render item(
              { kind: "feed", id: feed.id },
              feed.title ?? feed.url,
              reader.unread.feeds.get(feed.id) ?? 0,
            )}
          </li>
        {/each}
      </ul>
    </section>
  {/each}

  {#if loose.length > 0}
    <ul>
      {#each loose as feed (feed.id)}
        <li>
          {@render item(
            { kind: "feed", id: feed.id },
            feed.title ?? feed.url,
            reader.unread.feeds.get(feed.id) ?? 0,
          )}
        </li>
      {/each}
    </ul>
  {/if}

  {#if reader.feeds.length === 0}
    <p class="empty">購読しているフィードはまだありません。</p>
  {/if}

  <footer>
    {@render item({ kind: "manage" }, "購読の管理", 0)}
    <SyncStatus />
    <button type="button" class="link" onclick={signOut}>ログアウト</button>
  </footer>
</nav>

<style>
  nav {
    display: flex;
    flex-direction: column;
    gap: 0.75rem;
    padding: 0.75rem;
    overflow-y: auto;
    border-right: 1px solid var(--border);
    background: var(--surface);
  }

  ul {
    list-style: none;
    margin: 0;
    padding: 0 0 0 0.75rem;
  }

  a {
    display: flex;
    justify-content: space-between;
    gap: 0.5rem;
    padding: 0.25rem 0.5rem;
    border-radius: 0.375rem;
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

  .name {
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }

  .count {
    color: var(--muted);
    font-variant-numeric: tabular-nums;
  }

  .empty {
    color: var(--muted);
    font-size: 0.9rem;
  }

  footer {
    margin-top: auto;
    display: grid;
    gap: 0.5rem;
    justify-items: start;
  }
</style>
