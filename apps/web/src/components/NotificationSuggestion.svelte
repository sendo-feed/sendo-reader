<script lang="ts">
  import { notificationSuggestion } from "../lib/notification-suggestion.svelte";
  import { IOS_HOME_SCREEN_GUIDE } from "../lib/push";

  /**
   * ベルを付けたときの、この端末で通知を受ける勧め（docs/decisions/notifications.md の 1）。画面の下の
   * 知らせと同じ場所に出す。取り消しの知らせ、記事の画面の知らせ、開いているメニューと窓より奥、
   * 新しい版の知らせより手前（App.svelte で、新しい版の知らせのあとに置く）
   */
  const suggestion = $derived(notificationSuggestion.current);
</script>

{#if suggestion !== null}
  <div class="suggestion" role="status">
    {#if suggestion.kind === "turn-on"}
      {@const publicKey = suggestion.publicKey}
      <p>この端末で通知を受けますか？</p>
      <div class="actions">
        <button
          type="button"
          class="primary"
          disabled={notificationSuggestion.busy}
          onclick={() => notificationSuggestion.turnOn(publicKey)}
        >
          Turn on notifications
        </button>
        <button type="button" onclick={() => notificationSuggestion.dismiss()}>Dismiss</button>
      </div>
    {:else}
      <p>{IOS_HOME_SCREEN_GUIDE}</p>
      <div class="actions">
        <button type="button" onclick={() => notificationSuggestion.dismiss()}>Dismiss</button>
      </div>
    {/if}
    {#if notificationSuggestion.failure !== null}
      <p class="error" role="alert">{notificationSuggestion.failure}</p>
    {/if}
  </div>
{/if}

<style>
  /*
   * 新しい版の知らせ（UpdateReady.svelte）と同じ場所と重なり順（1）。App.svelte でそのあとに置くので、
   * 重なればこちらが手前になる。取り消しの知らせ（4）、メニュー（2〜3）、窓（top layer）より奥
   */
  .suggestion {
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

  p {
    flex: 1 1 14rem;
    margin: 0;
  }

  .actions {
    display: flex;
    flex: none;
    flex-wrap: wrap;
    gap: 0.5rem;
  }

  .error {
    flex-basis: 100%;
    color: var(--danger);
  }

  /* 狭い画面（docs/decisions/ui.md の 6）：取り消しの知らせと同じ高さ */
  @media (max-width: 56rem) {
    .suggestion {
      bottom: calc(4.5rem + env(safe-area-inset-bottom, 0px));
      left: 1rem;
      margin-inline: auto;
    }
  }
</style>
