<script lang="ts">
  import { useReader } from "../lib/context";
  import Dialog from "./Dialog.svelte";
  import Icon from "./Icon.svelte";

  let { compact }: { compact: boolean } = $props();
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
  class:compact
  aria-label="Workspaces: {label}"
  aria-haspopup="dialog"
  title={label}
  onclick={() => (open = true)}
>
  <Icon name="folder" />
  <span class="selection">{label}</span>
  <span class="chevron"><Icon name="chevronDown" /></span>
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
    width: 100%;
    min-height: 2.5rem;
    margin-bottom: 0.25rem;
    padding: 0.3rem 0.5rem;
    background: var(--surface);
    text-align: left;
  }

  .selection {
    flex: 1;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }

  .chevron {
    display: flex;
  }

  /* 範囲の変更で All に戻り、狭い画面のサイドバーが閉じても、開いている窓は表示する。 */
  .workspace-switch + :global(dialog[open]) {
    visibility: visible;
  }

  @media (width > 56rem) {
    .workspace-switch.compact {
      justify-content: center;
    }

    .compact .selection,
    .compact .chevron {
      display: none;
    }
  }

  label span {
    overflow-wrap: anywhere;
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
