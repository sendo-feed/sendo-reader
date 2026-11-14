<script lang="ts">
  import { useReader } from "../../lib/context";
  import { describeError } from "../../lib/errors";

  const reader = useReader();
  let name = $state("");
  /** 名前を変えているフォルダと、入力中の名前 */
  let editing = $state<{ id: string; name: string } | null>(null);
  /** 消す前に、もう一度押してもらうフォルダ */
  let confirming = $state<string | null>(null);
  let message = $state<string | null>(null);

  async function run(action: () => Promise<unknown>) {
    message = null;
    try {
      await action();
    } catch (error) {
      message = describeError(error);
    }
  }

  async function create(event: SubmitEvent) {
    event.preventDefault();
    await run(async () => {
      await reader.client.createFolder(name);
      name = "";
    });
  }

  async function rename(event: SubmitEvent) {
    event.preventDefault();
    const target = editing;
    if (target === null) return;
    await run(async () => {
      await reader.client.renameFolder(target.id, target.name);
      editing = null;
    });
  }

  async function remove(id: string) {
    if (confirming !== id) {
      confirming = id;
      return;
    }
    confirming = null;
    await run(() => reader.client.deleteFolder(id));
  }
</script>

<section>
  <h2>フォルダ</h2>
  <form onsubmit={create} class="row">
    <label for="new-folder" class="visually-hidden">新しいフォルダの名前</label>
    <input id="new-folder" placeholder="新しいフォルダの名前" bind:value={name}>
    <button type="submit" disabled={name.trim() === ""}>作る</button>
  </form>

  <ul>
    {#each reader.folders as folder (folder.id)}
      <li>
        {#if editing?.id === folder.id}
          <form onsubmit={rename} class="row">
            <label for="rename-{folder.id}" class="visually-hidden">フォルダの名前</label>
            <input id="rename-{folder.id}" bind:value={editing.name}>
            <button type="submit">保存</button>
            <button type="button" onclick={() => (editing = null)}>やめる</button>
          </form>
        {:else}
          <span class="name">{folder.name}</span>
          <button type="button" onclick={() => (editing = { id: folder.id, name: folder.name })}>
            名前を変える
          </button>
          <button type="button" onclick={() => remove(folder.id)}>
            {confirming === folder.id ? "本当に消す" : "消す"}
          </button>
        {/if}
      </li>
    {:else}
      <li class="empty">フォルダはまだありません。</li>
    {/each}
  </ul>
  <p class="hint">フォルダを消しても、入っていたフィードは消えず、フォルダなしに戻ります。</p>
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
    gap: 0.25rem;
  }

  li {
    display: flex;
    flex-wrap: wrap;
    gap: 0.5rem;
    align-items: center;
  }

  .row {
    display: flex;
    gap: 0.5rem;
  }

  .name {
    flex: 1;
    min-width: 8rem;
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
