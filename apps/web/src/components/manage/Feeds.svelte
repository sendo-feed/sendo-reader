<script lang="ts">
  import { useReader } from "../../lib/context";
  import { describeError } from "../../lib/errors";

  const reader = useReader();
  /** 購読をやめる前に、もう一度押してもらうフィード */
  let confirming = $state<string | null>(null);
  let message = $state<string | null>(null);

  async function move(feedId: string, event: Event) {
    const value = (event.currentTarget as HTMLSelectElement).value;
    message = null;
    try {
      await reader.client.moveFeed(feedId, value === "" ? null : value);
    } catch (error) {
      message = describeError(error);
    }
  }

  async function unsubscribe(feedId: string) {
    if (confirming !== feedId) {
      confirming = feedId;
      return;
    }
    confirming = null;
    message = null;
    try {
      await reader.client.unsubscribe(feedId);
    } catch (error) {
      message = describeError(error);
    }
  }
</script>

<section>
  <h2>購読しているフィード</h2>
  <ul>
    {#each reader.feeds as feed (feed.id)}
      <li>
        <span class="name">
          <span class="title">{feed.title ?? feed.url}</span>
          <span class="url">{feed.url}</span>
        </span>
        <label class="visually-hidden" for="folder-{feed.id}">フォルダ</label>
        <select
          id="folder-{feed.id}"
          value={feed.folderId ?? ""}
          onchange={(e) => move(feed.id, e)}
        >
          <option value="">フォルダなし</option>
          {#each reader.folders as folder (folder.id)}
            <option value={folder.id}>{folder.name}</option>
          {/each}
        </select>
        <button type="button" onclick={() => unsubscribe(feed.id)}>
          {confirming === feed.id ? "本当にやめる" : "購読をやめる"}
        </button>
      </li>
    {:else}
      <li class="empty">購読しているフィードはまだありません。</li>
    {/each}
  </ul>
  <p class="hint">購読をやめると、スターを付けた記事だけが残ります。</p>
  {#if message !== null}
    <p class="error" role="alert">{message}</p>
  {/if}
</section>

<style>
  ul {
    list-style: none;
    margin: 0.5rem 0;
    padding: 0;
    display: grid;
    gap: 0.5rem;
  }

  li {
    display: flex;
    flex-wrap: wrap;
    gap: 0.5rem;
    align-items: center;
  }

  .name {
    flex: 1;
    min-width: 12rem;
  }

  .title {
    display: block;
  }

  .url {
    display: block;
    color: var(--muted);
    font-size: 0.85rem;
    overflow-wrap: anywhere;
  }

  .empty,
  .hint {
    color: var(--muted);
    font-size: 0.9rem;
  }

  .error {
    color: var(--danger);
  }
</style>
