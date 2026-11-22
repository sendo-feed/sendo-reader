<script lang="ts">
  import type { ProtocolMismatchError } from "@sendo-reader/core/web";
  import { describeVersionMismatch, isOlderThanPeer } from "../lib/errors";

  /**
   * 版の違うタブが開いていて、このタブが使えないことを知らせる（docs/decisions/local-first.md の 5）。
   * その場では読み込み直さない。このタブのほうが古ければ、利用者が押して読み込み直せる
   */
  let { error }: { error: ProtocolMismatchError } = $props();
</script>

<div class="version-mismatch" role="alert">
  <p>{describeVersionMismatch(error)}</p>
  {#if isOlderThanPeer(error)}
    <button type="button" class="primary" onclick={() => location.reload()}>Reload</button>
  {/if}
</div>

<style>
  .version-mismatch {
    position: fixed;
    top: calc(1rem + env(safe-area-inset-top, 0px));
    right: 1rem;
    left: 1rem;
    /* 読み終えたときのお祝い（z-index 5）より上に出す */
    z-index: 6;
    display: flex;
    align-items: center;
    gap: 0.75rem;
    width: fit-content;
    max-width: min(36rem, calc(100vw - 2rem));
    margin-inline: auto;
    padding: 0.75rem 1rem;
    border: 1px solid var(--danger);
    border-radius: var(--radius);
    background: var(--raised);
    color: var(--text);
    font-size: 0.9375rem;
    box-shadow: var(--shadow);
  }

  p {
    margin: 0;
  }

  button {
    flex: none;
  }
</style>
