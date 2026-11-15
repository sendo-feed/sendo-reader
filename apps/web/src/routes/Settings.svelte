<script lang="ts">
  import Grants from "../components/settings/Grants.svelte";
  import Tokens from "../components/settings/Tokens.svelte";
  import { confirmAccount } from "../lib/account";
  import { useReader } from "../lib/context";

  /**
   * 設定の画面（docs/decisions/account.md）。sendo にしかないもの（アクセストークン、OAuth の許可）を
   * 扱うので、ネットワークが要る。手元の DB には置かず、開くたびに sendo に聞く。
   *
   * 出しているアカウントは手元のユーザーで、sendo には今のクッキーで送る。別のタブなどでログインし
   * 直していると食い違うので、聞く前と送る前に、セッションのユーザーが手元のユーザーと同じかを
   * 確かめる（違えば送らず、同期に切り替えを任せる）。手元のユーザーが替わったら、一覧も発行した
   * 中身も捨てて作り直す。
   */
  const reader = useReader();

  function confirm(signal?: AbortSignal): Promise<void> {
    return confirmAccount(reader.user, () => void reader.client.syncNow(), signal);
  }
</script>

<main class="settings">
  <h1>設定</h1>
  {#key reader.user?.id}
    {#if reader.user !== null}
      <p class="account">ログインしているアカウント：{reader.user.email}</p>
      <Tokens {confirm} />
      <Grants {confirm} />
    {/if}
  {/key}
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
