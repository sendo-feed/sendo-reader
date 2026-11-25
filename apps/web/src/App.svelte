<script lang="ts">
  import LeaveStalled from "./components/LeaveStalled.svelte";
  import UpdateReady from "./components/UpdateReady.svelte";
  import VersionMismatch from "./components/VersionMismatch.svelte";
  import { canReloadPage } from "./lib/app-update";
  import { useReader } from "./lib/context";
  import { reloadGuard } from "./lib/reload-guard.svelte";
  import { router } from "./lib/router.svelte";
  import { selectNotice, updateNotice } from "./lib/update-notice.svelte";
  import Login from "./routes/Login.svelte";
  import Reader from "./routes/Reader.svelte";

  const state = useReader();
  const notice = $derived(
    selectNotice({
      leaveStalled: state.leaveStalled,
      versionMismatch: state.versionMismatch !== null,
      update: updateNotice.visible,
      // 画面を移ったとき、読み込み直すと消えるものを出し始めた ／ 閉じたときに決め直す
      canReload: canReloadPage(router.url.pathname, reloadGuard.held),
    }),
  );
</script>

{#if notice === "leaveStalled"}
  <LeaveStalled />
{:else if notice === "versionMismatch" && state.versionMismatch !== null}
  <VersionMismatch error={state.versionMismatch} />
{:else if notice === "ready" || notice === "failed"}
  <UpdateReady failed={notice === "failed"} />
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
