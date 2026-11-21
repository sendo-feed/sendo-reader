<script lang="ts">
  import { CONTENT_STORAGE_LIMITS } from "@sendo-reader/core";
  import { onDestroy, onMount } from "svelte";
  import { ContentStorageState, formatBytes } from "../../lib/content-storage.svelte";
  import { useReader } from "../../lib/context";

  /**
   * 記事の全文を先に取って手元に置く量の上限。この端末だけの設定で、sendo には預けない
   * （docs/decisions/local-first.md の「記事の本文」、docs/decisions/settings.md の 4）
   */
  const reader = useReader();
  const state = new ContentStorageState(reader.client);
  /** 欄を開いている間、裏の先読みで増えた量を出すために読み直す間隔 */
  const REFRESH_MS = 5000;

  onMount(() => {
    void state.load();
    state.start(REFRESH_MS);
  });
  onDestroy(() => state.stop());
</script>

<section aria-labelledby="offline-heading">
  <h2 id="offline-heading">Offline</h2>
  <p class="note" id="offline-note">
    未読の記事の全文を先に取って、この端末に置いておきます。開いたときに待たず、オフラインでも読めます。上限を超えたら、既読の記事から消します（スターを付けた記事と、いま開いている記事は消しません）。この設定はこの端末だけのもので、ほかの端末には引き継ぎません。
  </p>
  {#if state.storage !== null}
    <label>
      <span>Storage limit</span>
      <select
        bind:value={() => state.selected, (value) => void state.select(value)}
        aria-describedby="offline-note offline-used"
      >
        {#each CONTENT_STORAGE_LIMITS as limit (limit)}
          <option value={String(limit)}>{limit === 0 ? "Off" : formatBytes(limit)}</option>
        {/each}
      </select>
    </label>
    <p class="note" id="offline-used">いま {formatBytes(state.storage.used)} を使っています。</p>
  {/if}
  {#if state.failed === "load"}
    <div class="error-row">
      <p class="error" role="alert">使っている量を読めませんでした。</p>
      <button type="button" onclick={() => void state.load()}>Retry</button>
    </div>
  {:else if state.failed === "save"}
    <p class="error" role="alert">上限を変えられませんでした。もう一度お試しください。</p>
  {/if}
</section>

<style>
  section {
    display: grid;
    gap: 0.75rem;
  }

  h2 {
    margin: 0;
    font-size: 1.125rem;
  }

  .note,
  .error {
    margin: 0;
    font-size: 0.875rem;
    line-height: 1.7;
  }

  .note {
    color: var(--muted);
  }

  .error {
    color: var(--danger);
  }

  .error-row {
    display: flex;
    flex-wrap: wrap;
    align-items: center;
    gap: 0.5rem 1rem;
  }

  label {
    display: flex;
    flex-wrap: wrap;
    align-items: center;
    justify-content: space-between;
    gap: 0.25rem 1rem;
    max-width: 28rem;
  }

  select {
    min-width: 12rem;
  }
</style>
