<script lang="ts">
  import { useReader } from "../lib/context";
  import { describeError } from "../lib/errors";
  import { startSignIn } from "../lib/login";

  const reader = useReader();
  let busy = $state(false);
  let message = $state<string | null>(null);

  async function signIn() {
    busy = true;
    message = null;
    try {
      // ページごと Google のログインへ移るので、うまくいったら busy のままにする
      await startSignIn(reader.client);
    } catch (error) {
      message = describeError(error);
      busy = false;
    }
  }

  // 「戻る」でこのページに戻ってきたら（ページのキャッシュから）、押せるように戻す
  function onPageShow(event: PageTransitionEvent) {
    if (event.persisted) busy = false;
  }
</script>

<svelte:window onpageshow={onPageShow} />

<main class="login">
  <h1>Sendo</h1>
  <p class="hint">sendo で許可された Google アカウントでログインします。</p>
  <button type="button" onclick={signIn} disabled={busy}>
    {busy ? "ログインの画面に移っています…" : "Google でログイン"}
  </button>
  {#if reader.offline}
    <p class="note" role="status">
      sendo に届きません。オンラインになってから、ログインしてください。
    </p>
  {/if}
  {#if reader.status?.logoutPending === true}
    <p class="note" role="status">
      この端末のデータは消しました。sendo に届かないので、sendo
      のログアウトは、つながったときに送ります。
    </p>
  {/if}
  {#if message !== null || reader.loginError !== null}
    <p class="error" role="alert">{message ?? reader.loginError}</p>
  {/if}
</main>

<style>
  .login {
    display: grid;
    gap: 0.75rem;
    max-width: 28rem;
    margin: 4rem auto;
    padding: 0 1rem;
  }

  h1 {
    margin: 0;
  }

  .hint,
  .note {
    margin: 0;
    color: var(--muted);
    font-size: 0.9rem;
  }

  .error {
    color: var(--danger);
    margin: 0;
  }
</style>
