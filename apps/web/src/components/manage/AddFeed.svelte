<script lang="ts">
  import type { Feed, FeedCandidate } from "@sendo-reader/core";
  import { onDestroy, untrack } from "svelte";
  import { useReader } from "../../lib/context";
  import { describeError } from "../../lib/errors";

  let {
    onsubscribed,
    initialUrl = "",
  }: {
    onsubscribed: (feed: Feed) => void;
    initialUrl?: string;
  } = $props();

  const reader = useReader();
  let active = true;
  onDestroy(() => {
    active = false;
  });
  let url = $state(untrack(() => initialUrl));
  let candidates = $state<FeedCandidate[] | null>(null);
  let chosen = $state<string | null>(null);
  let folderId = $state<string>("");
  const mustChooseWorkspace = $derived(
    reader.workspaceIds !== undefined && reader.visibleWorkspaceIds?.length !== 1,
  );
  const choose = "choose";
  let chosenWorkspace = $state<string | undefined>(undefined);
  const workspaceId = $derived(
    chosenWorkspace !== undefined &&
      chosenWorkspace !== "" &&
      (!reader.workspacesAvailable ||
        !reader.workspaces.some((workspace) => workspace.id === chosenWorkspace))
      ? choose
      : (chosenWorkspace ??
          (mustChooseWorkspace ? choose : (reader.visibleWorkspaceIds?.[0] ?? ""))),
  );
  const choosingWorkspace = $derived(
    reader.workspacesAvailable || (chosenWorkspace !== undefined && chosenWorkspace !== ""),
  );
  const workspaceLabel = $derived(
    workspaceId === choose
      ? "Choose workspace"
      : workspaceId === ""
        ? "No workspace"
        : (reader.workspaces.find((workspace) => workspace.id === workspaceId)?.name ??
          "Choose workspace"),
  );
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
    if (chosen === null || (choosingWorkspace && workspaceId === choose)) return;
    busy = true;
    message = null;
    try {
      const feed = await reader.client.subscribe(
        chosen,
        folderId === "" ? null : folderId,
        reader.workspacesAvailable && workspaceId ? workspaceId : undefined,
      );
      url = "";
      candidates = null;
      chosenWorkspace = undefined;
      if (active && feed !== null) onsubscribed(feed);
    } catch (error) {
      message = describeError(error);
    } finally {
      busy = false;
    }
  }
</script>

<section>
  <form onsubmit={discover}>
    <label for="feed-url">Website or feed URL</label>
    <div class="row">
      <input
        id="feed-url"
        type="url"
        inputmode="url"
        placeholder="https://example.com/"
        required
        bind:value={url}
        oninput={() => {
          candidates = null;
          chosen = null;
        }}
        disabled={busy}
      >
      <button type="submit" disabled={busy || url.trim() === ""}>Find</button>
    </div>
  </form>

  {#if candidates !== null && candidates.length > 0}
    <fieldset disabled={busy}>
      <legend>Feeds</legend>
      {#each candidates as candidate (candidate.url)}
        <label class="candidate">
          <input type="radio" name="candidate" value={candidate.url} bind:group={chosen}>
          <span>
            <span class="title">{candidate.title ?? "（タイトルなし）"}</span>
            <span class="url">{candidate.url}</span>
          </span>
        </label>
      {/each}
      <label for="feed-folder">Folder</label>
      <select id="feed-folder" bind:value={folderId}>
        <option value="">No folder</option>
        {#each reader.folders as folder (folder.id)}
          <option value={folder.id}>{folder.name}</option>
        {/each}
      </select>
      {#if choosingWorkspace}
        <details>
          <summary>{workspaceLabel}</summary>
          <label for="feed-workspace">Workspace</label>
          <select
            id="feed-workspace"
            value={workspaceId}
            onchange={(event) => (chosenWorkspace = event.currentTarget.value)}
          >
            {#if mustChooseWorkspace || workspaceId === choose}
              <option value={choose} disabled>Choose workspace</option>
            {/if}
            <option value="">No workspace</option>
            {#each reader.workspacesAvailable ? reader.workspaces : [] as workspace (workspace.id)}
              <option value={workspace.id}>{workspace.name}</option>
            {/each}
          </select>
        </details>
      {/if}
      <button
        type="button"
        class="primary"
        onclick={subscribe}
        disabled={chosen === null || (choosingWorkspace && workspaceId === choose)}
      >
        Subscribe
      </button>
    </fieldset>
  {/if}

  {#if busy}
    <p role="status">処理しています…</p>
  {/if}
  {#if message !== null}
    <p class="error" role="alert">{message}</p>
  {/if}
</section>

<style>
  form,
  fieldset {
    min-width: 0;
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

  .candidate > span {
    min-width: 0;
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
