<script lang="ts">
  import Grants from "../components/settings/Grants.svelte";
  import Tokens from "../components/settings/Tokens.svelte";
  import { useReader } from "../lib/context";

  /**
   * 設定の画面（docs/decisions/account.md）。sendo にしかないもの（アクセストークン、OAuth の許可）を
   * 扱うので、ネットワークが要る。手元の DB には置かず、開くたびに sendo に聞く。
   */
  const reader = useReader();
</script>

<main class="settings">
  <h1>設定</h1>
  {#if reader.user !== null}
    <p class="account">ログインしているアカウント：{reader.user.email}</p>
  {/if}
  <Tokens />
  <Grants />
</main>

<style>
  .settings {
    display: grid;
    gap: 2rem;
    align-content: start;
    max-width: 48rem;
    padding: 1rem 1.5rem 3rem;
    overflow-y: auto;
  }

  h1 {
    margin: 0;
    font-size: 1.5rem;
  }

  .account {
    margin: 0;
    color: var(--muted);
  }
</style>
