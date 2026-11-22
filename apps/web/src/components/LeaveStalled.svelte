<script lang="ts">
  /**
   * reader の外へ移ろうとしたのに、しばらくしてもこのページが残っている（lib/back-forward-cache.ts）。
   * 移る前に DB のワーカーを止めたので、このページはもう動かない。移り先の応答が遅いだけかもしれない
   * ので、自分では読み込み直さず、利用者が選べるようにする
   */
</script>

<div class="leave-stalled" role="alert">
  <p>移り先のページが開きません。このまま待つか、読み込み直してからやり直してください。</p>
  <button type="button" class="primary" onclick={() => location.reload()}>Reload</button>
</div>

<style>
  .leave-stalled {
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
