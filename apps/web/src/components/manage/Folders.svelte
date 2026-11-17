<script lang="ts">
  import type { Folder } from "@sendo-reader/core";
  import { untrack } from "svelte";
  import { useReader } from "../../lib/context";
  import { describeError } from "../../lib/errors";

  let {
    folder,
    oncomplete,
    oncancel,
  }: {
    folder: Folder | null;
    oncomplete: (message: string) => void;
    oncancel: () => void;
  } = $props();

  const reader = useReader();
  // 窓を開いたときだけ写す。同期で届く変更で、入力中の名前を上書きしない
  let name = $state(untrack(() => folder?.name ?? ""));
  let confirming = $state(false);
  let busy = $state(false);
  let message = $state<string | null>(null);

  async function save(event: SubmitEvent) {
    event.preventDefault();
    busy = true;
    message = null;
    try {
      if (folder === null) await reader.client.createFolder(name);
      else await reader.client.renameFolder(folder.id, name);
      oncomplete(`「${name.trim()}」を保存しました。`);
    } catch (error) {
      message = describeError(error);
    } finally {
      busy = false;
    }
  }

  async function remove() {
    if (folder === null) return;
    busy = true;
    message = null;
    try {
      await reader.client.deleteFolder(folder.id);
      oncomplete("フォルダを削除しました。購読はそのまま続きます。");
    } catch (error) {
      message = describeError(error);
    } finally {
      busy = false;
    }
  }
</script>

{#if confirming}
  <p>「{folder?.name}」を削除しますか？ 中のフィードは No folder に移り、購読は続きます。</p>
  <div class="actions">
    <button type="button" disabled={busy} onclick={() => (confirming = false)}>Cancel</button>
    <button type="button" class="danger" disabled={busy} onclick={remove}>Delete folder</button>
  </div>
{:else}
  <form onsubmit={save}>
    <label for="folder-name">Folder name</label>
    <input
      id="folder-name"
      bind:value={name}
      placeholder="例：テクノロジー"
      required
      disabled={busy}
    >
    <div class="actions">
      <button type="button" disabled={busy} onclick={oncancel}>Cancel</button>
      <button type="submit" class="primary" disabled={busy || name.trim() === ""}>
        {folder === null ? "Create folder" : "Save"}
      </button>
    </div>
  </form>
  {#if folder !== null}
    <div class="remove">
      <button type="button" class="link danger" disabled={busy} onclick={() => (confirming = true)}>
        Delete folder…
      </button>
    </div>
  {/if}
{/if}
{#if message !== null}
  <p class="error" role="alert">{message}</p>
{/if}

<style>
  form {
    display: grid;
    gap: 0.5rem;
  }

  input {
    width: 100%;
    min-width: 0;
  }

  p {
    margin: 0;
  }

  .actions {
    display: flex;
    flex-wrap: wrap;
    justify-content: flex-end;
    gap: 0.5rem;
    margin-top: 1rem;
  }

  .remove {
    border-top: 1px solid var(--border);
    margin-top: 1.25rem;
    padding-top: 1rem;
    font-size: 0.875rem;
  }

  .danger,
  .error {
    color: var(--danger);
  }

  .error {
    margin-top: 0.75rem;
  }
</style>
