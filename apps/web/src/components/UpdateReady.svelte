<script lang="ts">
  import { updateReadyMessage } from "../lib/app-update";
  import { isStandalone, updateNotice } from "../lib/update-notice.svelte";

  /**
   * 新しい版に替わったが、まだ読み込み直していないことを知らせる（docs/decisions/ui.md の 5）。
   * 裏に回れば自動で読み込み直すので、閉じてもよい。Reload で、その場で切り替えられる
   */
  let { failed }: { failed: boolean } = $props();
  const message = updateReadyMessage(isStandalone());
</script>

<div class="update-ready" class:failed role="status">
  <p>{failed ? "新しい版がありますが、切り替えられませんでした。" : message}</p>
  <div class="actions">
    {#if !failed}
      <button type="button" class="primary" onclick={() => location.reload()}>Reload</button>
    {/if}
    <button type="button" onclick={() => updateNotice.dismiss()}>Dismiss</button>
  </div>
</div>

<style>
  /*
   * 広い画面では右下に、狭い画面では下のバー（記事の画面では記事の操作）の上に出す
   * （docs/decisions/ui.md の 5）。見出しの操作は覆わない。
   *
   * 画面の下に出るほかのもの（取り消しの知らせ、記事の画面の知らせ）、開いているメニュー、窓は、
   * この知らせより手前にする。そのため重なり順は低く（1）し、App.svelte で画面より前に置く
   * （同じ重なり順のものは、あとに置いたほうが手前になる）。取り消しの知らせは 4、メニューは 2〜3、
   * 窓は top layer
   */
  .update-ready {
    position: fixed;
    right: 1rem;
    bottom: calc(1rem + env(safe-area-inset-bottom, 0px));
    z-index: 1;
    display: flex;
    flex-wrap: wrap;
    align-items: center;
    gap: 0.75rem;
    width: fit-content;
    max-width: min(24rem, calc(100vw - 2rem));
    padding: 0.75rem 1rem;
    border: 1px solid var(--border-strong);
    border-radius: var(--radius);
    background: var(--raised);
    color: var(--text);
    font-size: 0.9375rem;
    box-shadow: var(--shadow);
  }

  .failed {
    border-color: var(--danger);
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

  /*
   * 狭い画面（docs/decisions/ui.md の 6）：取り消しの知らせと同じ高さ。下のバーのない画面（ログインの画面
   * など）でも、どの画面か見分けずに同じ高さに出す（画面の下の側には違いない）
   */
  @media (max-width: 56rem) {
    .update-ready {
      bottom: calc(4.5rem + env(safe-area-inset-bottom, 0px));
      left: 1rem;
      margin-inline: auto;
    }
  }
</style>
