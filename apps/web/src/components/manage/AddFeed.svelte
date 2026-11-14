<script lang="ts">
  import type { FeedCandidate } from "@sendo-reader/core";
  import { useReader } from "../../lib/context";
  import { describeError } from "../../lib/errors";
  import { router, viewHref } from "../../lib/router.svelte";

  const reader = useReader();
  let url = $state("");
  let candidates = $state<FeedCandidate[] | null>(null);
  let chosen = $state<string | null>(null);
  let folderId = $state<string>("");
  let busy = $state(false);
  let message = $state<string | null>(null);

  async function discover(event: SubmitEvent) {
    event.preventDefault();
    busy = true;
    message = null;
    candidates = null;
    try {
      candidates = await reader.client.discoverFeeds(url.trim());
      chosen = candidates[0]?.url ?? null;
      if (candidates.length === 0) message = "この URL にはフィードが見つかりませんでした。";
    } catch (error) {
      message = describeError(error);
    } finally {
      busy = false;
    }
  }

  async function subscribe() {
    if (chosen === null) return;
    busy = true;
    message = null;
    try {
      const feed = await reader.client.subscribe(chosen, folderId === "" ? null : folderId);
      url = "";
      candidates = null;
      if (feed !== null) router.navigate(viewHref({ kind: "feed", id: feed.id }));
    } catch (error) {
      message = describeError(error);
    } finally {
      busy = false;
    }
  }
</script>

<section>
  <h2>フィードを購読する</h2>
  <form onsubmit={discover}>
    <label for="feed-url">サイトかフィードの URL</label>
    <div class="row">
      <input
        id="feed-url"
        type="url"
        inputmode="url"
        placeholder="https://example.com/"
        required
        bind:value={url}
        disabled={busy}
      >
      <button type="submit" disabled={busy || url.trim() === ""}>探す</button>
    </div>
  </form>

  {#if candidates !== null && candidates.length > 0}
    <fieldset disabled={busy}>
      <legend>購読するフィード</legend>
      {#each candidates as candidate (candidate.url)}
        <label class="candidate">
          <input type="radio" name="candidate" value={candidate.url} bind:group={chosen}>
          <span>
            <span class="title">{candidate.title ?? "（タイトルなし）"}</span>
            <span class="url">{candidate.url}</span>
          </span>
        </label>
      {/each}
      <label for="feed-folder">フォルダ</label>
      <select id="feed-folder" bind:value={folderId}>
        <option value="">フォルダなし</option>
        {#each reader.folders as folder (folder.id)}
          <option value={folder.id}>{folder.name}</option>
        {/each}
      </select>
      <button type="button" onclick={subscribe} disabled={chosen === null}>
        {busy ? "購読しています…" : "購読する"}
      </button>
    </fieldset>
  {/if}

  {#if message !== null}
    <p class="error" role="alert">{message}</p>
  {/if}
</section>

<style>
  form,
  fieldset {
    display: grid;
    gap: 0.5rem;
  }

  fieldset {
    margin-top: 0.75rem;
    border: 1px solid var(--border);
    border-radius: 0.375rem;
  }

  .row {
    display: flex;
    gap: 0.5rem;
  }

  .row input {
    flex: 1;
    min-width: 0;
  }

  .candidate {
    display: flex;
    gap: 0.5rem;
    align-items: baseline;
  }

  .candidate .title {
    display: block;
  }

  .candidate .url {
    display: block;
    color: var(--muted);
    font-size: 0.85rem;
    overflow-wrap: anywhere;
  }

  .error {
    color: var(--danger);
  }
</style>
