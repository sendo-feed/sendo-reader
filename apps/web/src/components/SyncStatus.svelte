<script lang="ts">
  import { useReader } from "../lib/context";
  import { describeError } from "../lib/errors";
  import { fromNow } from "../lib/format";
  import { startSignIn } from "../lib/login";
  import Icon from "./Icon.svelte";

  const reader = useReader();
  let syncing = $state(false);
  let signingIn = $state(false);
  let signInError = $state<string | null>(null);

  const label = $derived.by(() => {
    const status = reader.status;
    if (status === null) return "";
    if (status.syncing || syncing) return "Syncing…";
    if (status.error === "network") return "Offline";
    if (status.error === "unauthorized") return "Session expired";
    if (status.error !== null) return "Sync failed";
    if (status.lastSyncedAt === null) return "";
    const ago = fromNow(status.lastSyncedAt);
    return ago === "now" ? "Synced just now" : `Synced ${ago} ago`;
  });

  const busy = $derived(syncing || reader.status?.syncing === true);

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
  {#if reader.status?.error === "unauthorized"}
    <span class="label warn">{label}</span>
    <button type="button" class="primary" onclick={signInAgain} disabled={signingIn}>
      Sign in again
    </button>
  {:else}
    <button
      type="button"
      class="icon-button"
      class:spinning={busy}
      aria-label="Sync now"
      title="Sync now (r)"
      onclick={syncNow}
      disabled={syncing}
    >
      <Icon name="refresh" />
    </button>
    <span class="label" class:warn={reader.status?.error != null}>{label}</span>
  {/if}
  {#if (reader.status?.pending ?? 0) > 0}
    <span class="pending">{reader.status?.pending} pending</span>
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
    font-size: 0.8125rem;
    color: var(--muted);
  }

  .label.warn {
    padding-left: 0.5rem;
    color: var(--text);
    font-weight: 600;
  }

  .icon-button + .label.warn {
    padding-left: 0;
  }

  .spinning :global(.icon) {
    animation: spin 1s linear infinite;
  }

  @keyframes spin {
    to {
      transform: rotate(360deg);
    }
  }

  .pending {
    color: var(--accent);
  }

  .error {
    flex-basis: 100%;
    margin: 0;
    padding-left: 0.5rem;
    color: var(--danger);
  }
</style>
