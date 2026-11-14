<script lang="ts">
  import { ApiError } from "@sendo-reader/core";
  import { useReader } from "../lib/context";

  const reader = useReader();
  let token = $state("");
  let busy = $state(false);
  let message = $state<string | null>(null);

  async function submit(event: SubmitEvent) {
    event.preventDefault();
    busy = true;
    message = null;
    try {
      await reader.client.signIn(token);
      token = "";
      reader.signedIn = true;
    } catch (error) {
      message =
        error instanceof ApiError && error.kind === "unauthorized"
          ? "このトークンは使えません。sendo で発行したトークンか確かめてください。"
          : error instanceof ApiError && error.kind === "network"
            ? "sendo に届きません。通信を確かめてください。"
            : "ログインできませんでした。";
    } finally {
      busy = false;
    }
  }
</script>

<main class="login">
  <h1>Sendo</h1>
  <form onsubmit={submit}>
    <label for="token">アクセストークン</label>
    <p class="hint">
      sendo で <code>pnpm token:create --email &lt;メール&gt;</code> を実行して発行した、<code
        >sendo_</code
      >
      で始まるトークンを貼ってください。
    </p>
    <input
      id="token"
      type="password"
      autocomplete="off"
      spellcheck="false"
      required
      bind:value={token}
      disabled={busy}
    >
    <button type="submit" disabled={busy || token.trim() === ""}>
      {busy ? "確かめています…" : "ログイン"}
    </button>
    {#if message !== null}
      <p class="error" role="alert">{message}</p>
    {/if}
  </form>
</main>

<style>
  .login {
    max-width: 28rem;
    margin: 4rem auto;
    padding: 0 1rem;
  }

  form {
    display: grid;
    gap: 0.75rem;
  }

  .hint {
    margin: 0;
    color: var(--muted);
    font-size: 0.9rem;
  }

  .error {
    color: var(--danger);
    margin: 0;
  }
</style>
