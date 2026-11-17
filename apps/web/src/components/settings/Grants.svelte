<script lang="ts">
  import type { OAuthGrant } from "@sendo-reader/core";
  import { onDestroy, onMount } from "svelte";
  import { account } from "../../lib/account";
  import ConnectionTable from "./ConnectionTable.svelte";

  let { confirm }: { confirm: (signal?: AbortSignal) => Promise<void> } = $props();
  const controller = new AbortController();
  onDestroy(() => controller.abort());
  let grants = $state<OAuthGrant[] | null>(null);
  let loadError = $state<unknown>(null);
  let generation = 0;
  const rows = $derived(
    grants?.map((grant) => ({
      ...grant,
      name: grant.clientName ?? grant.clientId,
      detail: clientHost(grant),
      note: grant.clientKind === "registered" ? "クライアントが名乗った名前" : undefined,
      access: grant.scopes.includes("write") ? "Read & write" : "Read only",
    })) ?? null,
  );

  async function load() {
    const current = ++generation;
    loadError = null;
    try {
      await confirm(controller.signal);
      const result = await account.listGrants(controller.signal);
      if (!controller.signal.aborted && current === generation) grants = result;
    } catch (error) {
      if (!controller.signal.aborted && current === generation) loadError = error;
    }
  }
  onMount(() => {
    void load();
  });

  function clientHost(grant: OAuthGrant): string | null {
    if (grant.clientKind !== "metadata_document") return null;
    try {
      return new URL(grant.clientId).host;
    } catch {
      return null;
    }
  }

  function removed(ids: readonly string[]) {
    generation += 1;
    grants = grants?.filter((grant) => !ids.includes(grant.id)) ?? null;
  }
</script>

<ConnectionTable
  title="Connected apps"
  kind="grants"
  {rows}
  {loadError}
  reload={load}
  {confirm}
  revoke={account.revokeGrant}
  onremoved={removed}
/>
