<script lang="ts">
  import { useReader } from "../lib/context";
  import { describeError } from "../lib/errors";
  import { fromNow } from "../lib/format";
  import { startSignIn } from "../lib/login";

  const reader = useReader();
  let syncing = $state(false);
  let signingIn = $state(false);
  let signInError = $state<string | null>(null);

  const label = $derived.by(() => {
    const status = reader.status;
    if (status === null) return "";
    if (status.syncing || syncing) return "同期しています…";
    if (status.error === "network") return "オフライン";
    if (status.error === "unauthorized") return "ログインが切れました";
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

  /** ログインし直す。手元のデータとまだ送っていない操作は残り、戻ってきたら続きから送る */
  async function signInAgain() {
    signingIn = true;
    signInError = null;
    try {
      await startSignIn(reader.client);
    } catch (error) {
      signInError = describeError(error);
      signingIn = false;
    }
  }

  function onPageShow(event: PageTransitionEvent) {
    if (event.persisted) signingIn = false;
  }
</script>

<svelte:window onpageshow={onPageShow} />

<div class="sync" aria-live="polite">
  <span class="label">{label}</span>
  {#if (reader.status?.pending ?? 0) > 0}
    <span class="pending">未送信 {reader.status?.pending} 件</span>
  {/if}
  {#if reader.status?.error === "unauthorized"}
    <button type="button" onclick={signInAgain} disabled={signingIn}>ログインし直す</button>
  {:else}
    <button type="button" onclick={syncNow} disabled={syncing}>今すぐ同期</button>
  {/if}
  {#if signInError !== null || reader.loginError !== null}
    <p class="error" role="alert">{signInError ?? reader.loginError}</p>
  {/if}
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

  .error {
    margin: 0;
    color: var(--danger);
  }
</style>
