<script lang="ts">
  import { type Feed, feedName, MAX_FEED_DISPLAY_NAME_LENGTH } from "@sendo-reader/core";
  import { tick } from "svelte";
  import { useReader } from "../../lib/context";
  import { describeError } from "../../lib/errors";
  import Icon from "../Icon.svelte";

  let { feed }: { feed: Feed } = $props();
  const reader = useReader();
  const name = $derived(feedName(feed));
  let editing = $state(false);
  let draft = $state("");
  let saving = $state(false);
  let error = $state<string | null>(null);
  let input = $state<HTMLInputElement>();
  let editButton = $state<HTMLButtonElement>();

  async function edit() {
    draft = name;
    error = null;
    editing = true;
    await tick();
    input?.select();
    input?.focus();
  }

  async function finish() {
    editing = false;
    await tick();
    editButton?.focus();
  }

  async function change(displayName: string | null) {
    if (saving) return;
    saving = true;
    error = null;
    try {
      if (displayName !== name) await reader.client.renameFeed(feed.id, displayName);
      await finish();
    } catch (failure) {
      error = describeError(failure);
    } finally {
      saving = false;
    }
  }
</script>

{#if editing}
  <form
    class="line"
    onsubmit={(event) => {
      event.preventDefault();
      void change(draft.trim());
    }}
  >
    <input
      type="text"
      aria-label="Feed display name"
      bind:this={input}
      bind:value={draft}
      maxlength={MAX_FEED_DISPLAY_NAME_LENGTH}
      required
      onkeydown={(event) => {
        if (event.key === "Escape" && !event.isComposing && !saving) {
          event.preventDefault();
          void finish();
        }
      }}
    >
    <button
      type="submit"
      class="icon-button"
      aria-label="Save feed display name"
      title="Save"
      disabled={saving || draft.trim() === "" || draft.trim().length > MAX_FEED_DISPLAY_NAME_LENGTH}
    >
      <Icon name="check" />
    </button>
    <button
      type="button"
      class="icon-button"
      aria-label="Cancel editing feed display name"
      title="Cancel"
      disabled={saving}
      onclick={finish}
    >
      <Icon name="close" />
    </button>
  </form>
{:else}
  <div class="line">
    <span class="title">{name}</span>
    <button
      type="button"
      class="icon-button"
      aria-label="Edit display name: {name}"
      title="Edit display name"
      bind:this={editButton}
      disabled={saving}
      onclick={edit}
    >
      <Icon name="pencil" />
    </button>
    {#if feed.displayName !== null}
      <button
        type="button"
        class="icon-button"
        aria-label="Reset display name: {name}"
        title="Restore original name"
        disabled={saving}
        onclick={() => change(null)}
      >
        <Icon name="reset" />
      </button>
    {/if}
  </div>
{/if}
{#if error !== null}
  <p class="error" role="alert">{error}</p>
{/if}

<style>
  .line {
    display: flex;
    align-items: center;
    min-width: 0;
  }

  .title {
    min-width: 0;
    overflow-wrap: anywhere;
    font-size: 0.875rem;
    font-weight: 500;
  }

  input {
    flex: 1;
    min-width: 0;
    font-size: 0.875rem;
  }

  button {
    flex: none;
  }

  .error {
    margin: 0.25rem 0 0;
    color: var(--danger);
    font-size: 0.75rem;
  }
</style>
