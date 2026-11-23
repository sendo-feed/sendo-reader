<script lang="ts">
  import { updateReadyMessage } from "../lib/app-update";
  import { isStandalone, updateNotice } from "../lib/update-notice.svelte";

  /**
   * 新しい版に替わったが、まだ読み込み直していないことを知らせる（docs/decisions/ui.md の 5）。
   * 裏に回れば自動で読み込み直すので、閉じてもよい。Reload で、その場で切り替えられる
   */
  const message = updateReadyMessage(isStandalone());
</script>

<div class="update-ready" role="status">
  <p>{message}</p>
  <div class="actions">
    <button type="button" class="primary" onclick={() => location.reload()}>Reload</button>
    <button type="button" onclick={() => updateNotice.dismiss()}>Dismiss</button>
  </div>
</div>

<style>
  .update-ready {
    position: fixed;
    top: calc(1rem + env(safe-area-inset-top, 0px));
    right: 1rem;
    left: 1rem;
    /* 読み終えたときのお祝い（z-index 5）より上に出す */
    z-index: 6;
    display: flex;
    flex-wrap: wrap;
    align-items: center;
    gap: 0.75rem;
    width: fit-content;
    max-width: min(36rem, calc(100vw - 2rem));
    margin-inline: auto;
    padding: 0.75rem 1rem;
    border: 1px solid var(--border-strong);
    border-radius: var(--radius);
    background: var(--raised);
    color: var(--text);
    font-size: 0.9375rem;
    box-shadow: var(--shadow);
  }

  p {
    flex: 1 1 14rem;
    margin: 0;
  }

  .actions {
    display: flex;
    flex: none;
    gap: 0.5rem;
  }
</style>
