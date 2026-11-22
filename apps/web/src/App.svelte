<script lang="ts">
  import LeaveStalled from "./components/LeaveStalled.svelte";
  import VersionMismatch from "./components/VersionMismatch.svelte";
  import { useReader } from "./lib/context";
  import Login from "./routes/Login.svelte";
  import Reader from "./routes/Reader.svelte";

  const state = useReader();
</script>

{#if state.leaveStalled}
  <LeaveStalled />
{:else if state.versionMismatch !== null}
  <VersionMismatch error={state.versionMismatch} />
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
