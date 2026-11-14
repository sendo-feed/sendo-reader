<script lang="ts">
  import type { OpmlImportResult } from "@sendo-reader/core";
  import { useReader } from "../../lib/context";
  import { describeError } from "../../lib/errors";

  const reader = useReader();
  let busy = $state(false);
  let result = $state<OpmlImportResult | null>(null);
  let message = $state<string | null>(null);

  const REASONS: Record<OpmlImportResult["skipped"][number]["reason"], string> = {
    url_not_allowed: "使えない URL",
    url_too_long: "URL が長すぎる",
    duplicate: "重複",
    too_many: "多すぎる",
  };

  async function importFile(event: Event) {
    const input = event.currentTarget as HTMLInputElement;
    const file = input.files?.[0];
    if (file === undefined) return;
    busy = true;
    message = null;
    result = null;
    try {
      result = await reader.client.importOpml(await file.text());
    } catch (error) {
      message = describeError(error);
    } finally {
      busy = false;
      input.value = "";
    }
  }
</script>

<section>
  <h2>OPML を取り込む</h2>
  <p class="hint">
    Feedly などから書き出した OPML を選ぶと、フォルダごと取り込みます。sendo
    が順に登録するので、フィードと記事は少しずつ届きます。
  </p>
  <label for="opml-file">OPML のファイル</label>
  <input
    id="opml-file"
    type="file"
    accept=".opml,.xml,text/x-opml,text/xml,application/xml"
    onchange={importFile}
    disabled={busy}
  >
  {#if busy}
    <p aria-live="polite">取り込んでいます…</p>
  {/if}
  {#if result !== null}
    <p aria-live="polite">
      {result.accepted}
      件の登録を受け付けました。
      {#if result.skippedCount > 0}
        {result.skippedCount}
        件は飛ばしました。
      {/if}
    </p>
    {#if result.skipped.length > 0}
      <!-- 同じ URL が何度も飛ばされることがあるので、並びの番号をキーにする -->
      <ul class="skipped">
        {#each result.skipped as skipped, i (i)}
          <li><span class="url">{skipped.url}</span>（{REASONS[skipped.reason]}）</li>
        {/each}
      </ul>
    {/if}
  {/if}
  {#if message !== null}
    <p class="error" role="alert">{message}</p>
  {/if}
</section>

<style>
  section {
    display: grid;
    gap: 0.5rem;
    justify-items: start;
  }

  .hint {
    margin: 0;
    color: var(--muted);
    font-size: 0.9rem;
  }

  .skipped {
    margin: 0;
    font-size: 0.85rem;
  }

  .url {
    overflow-wrap: anywhere;
  }

  .error {
    color: var(--danger);
  }
</style>
