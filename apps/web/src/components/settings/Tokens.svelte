<script lang="ts">
  import type { AccessToken } from "@sendo-reader/core";
  import { onDestroy, onMount } from "svelte";
  import { account } from "../../lib/account";
  import ConnectionTable from "./ConnectionTable.svelte";
  import CreateTokenDialog from "./CreateTokenDialog.svelte";

  let { confirm }: { confirm: (signal?: AbortSignal) => Promise<void> } = $props();
  const controller = new AbortController();
  onDestroy(() => controller.abort());
  let tokens = $state<AccessToken[] | null>(null);
  let loadError = $state<unknown>(null);
  let creating = $state(false);
  let generation = 0;
  const rows = $derived(
    tokens?.map((token) => ({
      ...token,
      access:
        token.purpose === "reader"
          ? "Reader app"
          : `MCP · ${token.scopes.includes("write") ? "Read & write" : "Read only"}`,
    })) ?? null,
  );

  async function load() {
    const current = ++generation;
    loadError = null;
    try {
      await confirm(controller.signal);
      const result = await account.listTokens(controller.signal);
      if (!controller.signal.aborted && current === generation) tokens = result;
    } catch (error) {
      if (!controller.signal.aborted && current === generation) loadError = error;
    }
  }
  onMount(() => {
    void load();
  });

  function removed(ids: readonly string[]) {
    generation += 1;
    tokens = tokens?.filter((token) => !ids.includes(token.id)) ?? null;
  }

  function created(token: AccessToken) {
    generation += 1;
    if (tokens !== null) tokens = [token, ...tokens.filter((item) => item.id !== token.id)];
    // 作成窓の中身の表示は、一覧を読み直せるかどうかに依存させない
    void load();
  }
</script>

<ConnectionTable
  title="Access tokens"
  kind="tokens"
  {rows}
  {loadError}
  reload={load}
  {confirm}
  revoke={account.revokeToken}
  onremoved={removed}
>
  {#snippet actions(busy: boolean)}
    <button type="button" class="primary" disabled={busy} onclick={() => (creating = true)}>
      + New token
    </button>
  {/snippet}
</ConnectionTable>
{#if creating}
  <CreateTokenDialog bind:open={creating} {confirm} oncreated={created} />
{/if}
