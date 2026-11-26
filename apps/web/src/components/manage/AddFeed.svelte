<script lang="ts">
  import { ApiError, type Feed, type FeedCandidate } from "@sendo-reader/core";
  import { onDestroy, untrack } from "svelte";
  import { useReader } from "../../lib/context";
  import { describeError } from "../../lib/errors";

  let {
    onsubscribed,
    initialUrl = "",
  }: {
    onsubscribed: (feed: Feed, outside: boolean) => void;
    initialUrl?: string;
  } = $props();

  const reader = useReader();
  const DEFAULT_WORKSPACE_OPTION = ":default";
  let active = true;
  onDestroy(() => {
    active = false;
  });
  let url = $state(untrack(() => initialUrl));
  let candidates = $state<FeedCandidate[] | null>(null);
  let chosen = $state<string | null>(null);
  let folderId = $state<string>("");
  let chosenWorkspaceId = $state<string | undefined>(undefined);
  let rejectedWorkspaceIds = $state.raw<string[]>([]);
  const supportsDefault = $derived(
    reader.workspacesAvailable && reader.defaultWorkspaceOnSubscribe,
  );
  const useDefault = $derived(supportsDefault && chosenWorkspaceId === undefined);
  const preferredWorkspaceId = $derived(
    chosenWorkspaceId ??
      (!supportsDefault && reader.visibleWorkspaceIds?.length === 1
        ? reader.visibleWorkspaceIds[0]
        : undefined),
  );
  const destinations = $derived(
    reader.workspacesAvailable
      ? reader.workspaces.filter((item) => !rejectedWorkspaceIds.includes(item.id))
      : [],
  );
  const workspace = $derived(destinations.find((item) => item.id === preferredWorkspaceId));
  const defaultWorkspace = $derived(
    destinations.find((item) => item.id === reader.defaultWorkspaceId),
  );
  const defaultOutside = $derived(
    useDefault &&
      defaultWorkspace !== undefined &&
      reader.workspaceIds?.includes(defaultWorkspace.id) === false,
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
    const workspaceId = workspace?.id;
    if (chosen === null || (!useDefault && workspaceId === undefined)) return;
    busy = true;
    message = null;
    try {
      const feed = await reader.client.subscribe(
        chosen,
        folderId === "" ? null : folderId,
        useDefault ? { useDefault: true } : (workspaceId ?? null),
      );
      url = "";
      candidates = null;
      chosenWorkspaceId = undefined;
      rejectedWorkspaceIds = [];
      if (active && feed !== null) {
        // 購読による読み直しの間も、利用者が選んだ範囲から判定する。
        const scope = reader.workspaceIds;
        const actual = feed.workspaceId;
        onsubscribed(
          feed,
          scope !== undefined &&
            actual !== undefined &&
            (actual === null || !scope.includes(actual)),
        );
      }
    } catch (error) {
      if (
        error instanceof ApiError &&
        error.code === "workspace_not_found" &&
        workspaceId !== undefined
      ) {
        rejectedWorkspaceIds = [...rejectedWorkspaceIds, workspaceId];
        void reader.client.syncNow().catch(() => {});
      }
      if (error instanceof ApiError && error.kind === "cursor_invalid") {
        void reader.client.syncNow().catch(() => {});
      }
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
        {#each reader.folderDestinations as folder (folder.id)}
          <option value={folder.id}>{folder.name}</option>
        {/each}
      </select>
      {#if !reader.workspacesAvailable}
        <p>購読するには、ワークスペースに対応した Sendo と同期してください。</p>
      {:else if destinations.length === 0 && !supportsDefault}
        <p>購読するには、Manage feeds の Workspaces で先にワークスペースを作成してください。</p>
      {:else}
        <details>
          <summary>{useDefault ? "Use default" : (workspace?.name ?? "Choose workspace")}</summary>
          <label for="feed-workspace">Workspace</label>
          <select
            id="feed-workspace"
            value={useDefault ? DEFAULT_WORKSPACE_OPTION : (workspace?.id ?? "")}
            onchange={(event) => {
              const value = event.currentTarget.value;
              chosenWorkspaceId = value === DEFAULT_WORKSPACE_OPTION ? undefined : value;
            }}
          >
            <option value="" disabled>Choose workspace</option>
            {#if supportsDefault}
              <option value={DEFAULT_WORKSPACE_OPTION}>
                Use default{defaultWorkspace ? ` (${defaultWorkspace.name})` : ""}
              </option>
            {/if}
            {#each destinations as item (item.id)}
              <option value={item.id}>{item.name}</option>
            {/each}
          </select>
        </details>
        {#if defaultOutside}
          <p>閲覧範囲外のデフォルトに追加します。</p>
        {/if}
      {/if}
      <button
        type="button"
        class="primary"
        onclick={subscribe}
        disabled={chosen === null || (!useDefault && workspace === undefined)}
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
