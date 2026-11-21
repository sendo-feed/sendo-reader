<script lang="ts">
  import { CONTENT_STORAGE_LIMITS, type ContentStorage } from "@sendo-reader/core";
  import { onMount } from "svelte";
  import { useReader } from "../../lib/context";

  /**
   * 記事の全文を先に取って手元に置く量の上限。この端末だけの設定で、sendo には預けない
   * （docs/decisions/local-first.md の「記事の本文」、docs/decisions/settings.md の 4）
   */
  const reader = useReader();
  const MB = 1024 * 1024;
  let storage = $state<ContentStorage | null>(null);
  let failed = $state(false);

  onMount(() => {
    void reader.client.getContentStorage().then(
      (value) => {
        storage = value;
      },
      () => {
        failed = true;
      },
    );
  });

  async function change(value: string) {
    try {
      storage = await reader.client.setContentStorageLimit(Number(value));
      failed = false;
    } catch {
      failed = true;
    }
  }

  function limitLabel(bytes: number): string {
    if (bytes === 0) return "Off";
    const mb = bytes / MB;
    return mb >= 1024 ? `${mb / 1024}GB` : `${mb}MB`;
  }

  function usedLabel(bytes: number): string {
    if (bytes < MB) return `${Math.ceil(bytes / 1024)}KB`;
    return `${(bytes / MB).toFixed(1)}MB`;
  }
</script>

<section aria-labelledby="offline-heading">
  <h2 id="offline-heading">Offline</h2>
  <p class="note">
    未読の記事の全文を先に取って、この端末に置いておきます。開いたときに待たず、オフラインでも読めます。上限を超えたら、既読の記事から消します。この設定はこの端末だけのもので、ほかの端末には引き継ぎません。
  </p>
  {#if storage !== null}
    <label>
      <span>Storage limit</span>
      <select value={String(storage.limit)} onchange={(e) => change(e.currentTarget.value)}>
        {#each CONTENT_STORAGE_LIMITS as limit (limit)}
          <option value={String(limit)}>{limitLabel(limit)}</option>
        {/each}
      </select>
    </label>
    <p class="note">いま {usedLabel(storage.used)} を使っています。</p>
  {/if}
  {#if failed}
    <p class="error" role="alert">設定を読み書きできませんでした。もう一度お試しください。</p>
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
