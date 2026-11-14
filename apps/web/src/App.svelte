<script lang="ts">
  import { useReader } from "./lib/context";
  import Login from "./routes/Login.svelte";
  import Reader from "./routes/Reader.svelte";

  const state = useReader();
</script>

{#if state.signedIn === null}
  <p class="starting" aria-live="polite">起動しています…</p>
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
