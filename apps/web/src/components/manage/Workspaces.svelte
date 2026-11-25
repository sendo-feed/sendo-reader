<script lang="ts">
  import type { Workspace } from "@sendo-reader/core";
  import { useReader } from "../../lib/context";
  import { describeError } from "../../lib/errors";
  import Icon from "../Icon.svelte";

  const reader = useReader();
  let editing = $state<Workspace | null | undefined>(undefined);
  let name = $state("");
  let confirming = $state(false);
  let busy = $state(false);
  let message = $state("");
  const current = $derived(
    editing == null
      ? undefined
      : reader.workspaces.find((workspace) => workspace.id === editing?.id),
  );
  const hasFeeds = $derived(
    current !== undefined && reader.allFeeds.some((feed) => feed.workspaceId === current.id),
  );

  function edit(workspace: Workspace | null) {
    editing = workspace;
    name = workspace?.name ?? "";
    message = "";
    confirming = false;
  }

  async function save(event: SubmitEvent) {
    event.preventDefault();
    if (editing === undefined) return;
    busy = true;
    message = "";
    try {
      if (editing === null) await reader.client.createWorkspace(name);
      else await reader.client.renameWorkspace(editing.id, name);
      editing = undefined;
    } catch (error) {
      message = describeError(error);
    } finally {
      busy = false;
    }
  }

  async function remove() {
    if (current === undefined) return;
    busy = true;
    message = "";
    try {
      await reader.client.deleteWorkspace(current.id);
      editing = undefined;
    } catch (error) {
      message = describeError(error);
    } finally {
      busy = false;
      confirming = false;
    }
  }
</script>

{#if editing === undefined}
  <ul class="workspaces">
    {#each reader.workspaces as workspace (workspace.id)}
      <li>
        <span>{workspace.name}</span>
        <button type="button" onclick={() => edit(workspace)} aria-label="Edit {workspace.name}">
          Edit
        </button>
      </li>
    {/each}
  </ul>
  <button type="button" class="new" onclick={() => edit(null)}>
    <Icon name="plus" />
    New workspace
  </button>
{:else if confirming}
  <p>「{current?.name ?? editing?.name}」を削除しますか？</p>
  {#if current === undefined}
    <p class="note">このワークスペースはもうありません。</p>
  {:else if hasFeeds}
    <p class="note">削除するには、中の購読をすべて移動するか、解除してください。</p>
  {/if}
  <div class="actions">
    <button type="button" disabled={busy} onclick={() => (confirming = false)}>Cancel</button>
    <button
      type="button"
      class="danger"
      disabled={busy || current === undefined || hasFeeds}
      onclick={remove}
    >
      Delete workspace
    </button>
  </div>
{:else}
  <form onsubmit={save}>
    <label for="workspace-name">Workspace name</label>
    <input id="workspace-name" bind:value={name} required maxlength={200} disabled={busy}>
    <div class="actions">
      <button type="button" disabled={busy} onclick={() => (editing = undefined)}>Cancel</button>
      <button
        type="submit"
        class="primary"
        disabled={busy || name.trim() === "" || (editing !== null && current === undefined)}
      >
        {editing === null ? "Create workspace" : "Save"}
      </button>
    </div>
  </form>
  {#if editing !== null}
    {#if current === undefined}
      <p class="note">このワークスペースはもうありません。</p>
    {:else if hasFeeds}
      <p class="note">削除するには、中の購読をすべて移動するか、解除してください。</p>
    {:else}
      <button type="button" class="link danger" disabled={busy} onclick={() => (confirming = true)}>
        Delete workspace…
      </button>
    {/if}
  {/if}
{/if}

{#if message}
  <p class="error" role="alert">{message}</p>
{/if}

<style>
  .workspaces {
    display: grid;
    gap: 0.5rem;
    list-style: none;
    padding: 0;
    margin: 0 0 1rem;
  }

  li,
  .actions {
    display: flex;
    align-items: center;
    gap: 0.5rem;
    justify-content: space-between;
  }

  li span {
    overflow-wrap: anywhere;
  }

  .new {
    display: inline-flex;
    align-items: center;
    gap: 0.375rem;
  }

  form {
    display: grid;
    gap: 0.5rem;
    margin-bottom: 1rem;
  }

  .actions {
    justify-content: flex-end;
  }

  .note {
    color: var(--muted);
  }

  .error {
    color: var(--danger);
  }
</style>
