<script lang="ts">
  import { useReader } from "../lib/context";
  import Dialog from "./Dialog.svelte";
  import Icon from "./Icon.svelte";

  const reader = useReader();
  let open = $state(false);
  const names = $derived(
    reader.workspaces
      .filter((workspace) => reader.workspaceIds?.includes(workspace.id))
      .map((workspace) => workspace.name),
  );
  const label = $derived(
    reader.workspaceIds === undefined
      ? "All workspaces"
      : names.length === 0
        ? "No workspace selected"
        : names.join(", "),
  );

  function toggle(id: string, checked: boolean) {
    const ids = reader.workspaceIds ?? reader.workspaces.map((workspace) => workspace.id);
    reader.selectWorkspaces(checked ? [...ids, id] : ids.filter((item) => item !== id));
  }
</script>

<button
  type="button"
  class="workspace-switch"
  aria-label="Workspaces: {label}"
  title={label}
  onclick={() => (open = true)}
>
  <Icon name="folder" />
  <span>{label}</span>
  <Icon name="chevronDown" />
</button>

<Dialog bind:open title="Workspaces">
  <button
    type="button"
    aria-pressed={reader.workspaceIds === undefined}
    onclick={() => reader.selectWorkspaces(undefined)}
  >
    All workspaces
  </button>
  <ul>
    {#each reader.workspaces as workspace (workspace.id)}
      <li>
        <label>
          <input
            type="checkbox"
            checked={reader.workspaceIds === undefined ||
              reader.workspaceIds.includes(workspace.id)}
            onchange={(event) => toggle(workspace.id, event.currentTarget.checked)}
          >
          <span>{workspace.name}</span>
        </label>
        <button
          type="button"
          aria-label="Only {workspace.name}"
          onclick={() => reader.selectWorkspaces([workspace.id])}
        >
          Only
        </button>
      </li>
    {/each}
  </ul>
  {#if reader.workspaceIds !== undefined}
    <button type="button" class="link" onclick={() => reader.selectWorkspaces([])}>
      Clear selection
    </button>
  {/if}
</Dialog>

<style>
  .workspace-switch,
  label,
  li {
    display: flex;
    align-items: center;
    gap: 0.5rem;
  }

  .workspace-switch {
    max-width: 100%;
    background: var(--surface);
  }

  label span {
    overflow-wrap: anywhere;
  }

  .workspace-switch > span {
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }

  ul {
    display: grid;
    gap: 0.5rem;
    padding: 0;
    list-style: none;
  }

  li {
    justify-content: space-between;
  }
</style>
