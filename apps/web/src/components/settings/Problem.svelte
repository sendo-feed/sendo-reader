<script lang="ts">
  import { ApiError } from "@sendo-reader/core";
  import { useReader } from "../../lib/context";
  import { describeError } from "../../lib/errors";
  import { startSignIn } from "../../lib/login";

  /** sendo に聞けなかったときの表示。届かなければ読み込み直し、セッションが切れていればログインし直す */
  let { error, retry }: { error: unknown; retry: () => void } = $props();

  const reader = useReader();
  const unauthorized = $derived(error instanceof ApiError && error.kind === "unauthorized");
  let signInError = $state<string | null>(null);

  async function signInAgain() {
    try {
      await startSignIn(reader.client);
    } catch (e) {
      signInError = describeError(e);
    }
  }
</script>

<div class="problem" role="alert">
  <p>{signInError ?? describeError(error)}</p>
  {#if unauthorized}
    <button type="button" onclick={signInAgain}>ログインし直す</button>
  {:else}
    <button type="button" onclick={retry}>読み込み直す</button>
  {/if}
</div>

<style>
  .problem {
    display: flex;
    flex-wrap: wrap;
    gap: 0.5rem;
    align-items: center;
    color: var(--danger);
  }

  p {
    margin: 0;
  }
</style>
