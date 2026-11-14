<script lang="ts">
  import { useReader } from "../lib/context";
  import { fromNow } from "../lib/format";

  const reader = useReader();
  let syncing = $state(false);

  const label = $derived.by(() => {
    const status = reader.status;
    if (status === null) return "";
    if (status.syncing || syncing) return "同期しています…";
    if (status.error === "network") return "オフライン";
    if (status.error === "unauthorized") return "トークンが使えなくなりました";
    if (status.error !== null) return "同期できませんでした";
    if (status.lastSyncedAt === null) return "";
    return `${fromNow(status.lastSyncedAt)}に同期`;
  });

  async function syncNow() {
    syncing = true;
    try {
      await reader.client.syncNow();
    } finally {
      syncing = false;
    }
  }
</script>

<div class="sync" aria-live="polite">
  <span class="label">{label}</span>
  {#if (reader.status?.pending ?? 0) > 0}
    <span class="pending">未送信 {reader.status?.pending} 件</span>
  {/if}
  <button type="button" onclick={syncNow} disabled={syncing}>今すぐ同期</button>
</div>

<style>
  .sync {
    display: flex;
    flex-wrap: wrap;
    gap: 0.25rem 0.5rem;
    align-items: center;
    font-size: 0.8rem;
    color: var(--muted);
  }

  .pending {
    color: var(--accent);
  }
</style>
