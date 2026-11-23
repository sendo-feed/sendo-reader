<script lang="ts">
  import LeaveStalled from "./components/LeaveStalled.svelte";
  import UpdateReady from "./components/UpdateReady.svelte";
  import VersionMismatch from "./components/VersionMismatch.svelte";
  import { canReloadAt } from "./lib/app-update";
  import { useReader } from "./lib/context";
  import { router } from "./lib/router.svelte";
  import { topNotice, updateNotice } from "./lib/update-notice.svelte";
  import Login from "./routes/Login.svelte";
  import Reader from "./routes/Reader.svelte";

  const state = useReader();
  const notice = $derived(
    topNotice({
      leaveStalled: state.leaveStalled,
      versionMismatch: state.versionMismatch !== null,
      updatePending: updateNotice.pending,
      canReload: canReloadAt(router.url.pathname),
    }),
  );
</script>

{#if notice === "leaveStalled"}
  <LeaveStalled />
{:else if notice === "versionMismatch" && state.versionMismatch !== null}
  <VersionMismatch error={state.versionMismatch} />
{:else if notice === "updateReady"}
  <UpdateReady />
{/if}
{#if state.signedIn === null}
  <p class="starting" aria-live="polite">Loading…</p>
{:else if state.signedIn}
  <Reader />
{:else}
  <Login />
{/if}

<style>
  .starting {
    padding: 2rem;
    color: var(--muted);
  }
</style>
