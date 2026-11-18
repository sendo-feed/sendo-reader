<script lang="ts">
  import AddFeed from "../components/manage/AddFeed.svelte";
  import { capturedPageUrl, clearCapturedPage } from "../lib/bookmarklet";
  import { useReader } from "../lib/context";
  import { describeError } from "../lib/errors";
  import { handleLink, router } from "../lib/router.svelte";

  const reader = useReader();
  const url = $derived(capturedPageUrl(router.url));
  let showFeed = $state(false);
  let saving = $state(false);
  let error = $state<string | null>(null);
  let subscribed = $state<string | null>(null);

  async function savePage() {
    if (url === null) return;
    saving = true;
    error = null;
    try {
      await reader.client.savePage(url);
      clearCapturedPage();
      router.navigate("/starred");
    } catch (failure) {
      error = describeError(failure);
    } finally {
      saving = false;
    }
  }
</script>

<main class="add">
  <h1>Add to Sendo</h1>
  {#if subscribed !== null}
    <p role="status">{subscribed} を購読しました。</p>
    <a href="/manage" onclick={(event) => handleLink(event, "/manage")}>Manage feeds</a>
  {:else}
    {#if url === null}
      <p role="alert">追加できるページの URL がありません。</p>
    {:else}
      <p class="url">{url}</p>
      <div class="actions">
        <button type="button" class="primary" disabled={saving} onclick={savePage}>
          Save for later
        </button>
        {#if !showFeed}
          <button type="button" onclick={() => (showFeed = true)}>Subscribe to a feed</button>
        {/if}
      </div>
      {#if showFeed}
        {#key url}
          <AddFeed
            initialUrl={url}
            onsubscribed={(feed) => {
              subscribed = feed.title ?? feed.url;
              clearCapturedPage();
            }}
          />
        {/key}
      {/if}
      {#if error !== null}
        <p class="error" role="alert">{error}</p>
      {/if}
    {/if}
    <button
      type="button"
      class="link"
      onclick={() => {
        clearCapturedPage();
        router.navigate("/manage");
      }}
    >
      Cancel
    </button>
  {/if}
</main>

<style>
  .add {
    display: grid;
    align-content: start;
    gap: 1rem;
    max-width: 38rem;
    padding: 2rem 2.5rem;
    overflow-y: auto;
  }

  :is(p, h1) {
    margin: 0;
  }

  .url {
    overflow-wrap: anywhere;
  }

  .actions {
    display: flex;
    flex-wrap: wrap;
    gap: 0.5rem;
  }

  .error {
    color: var(--danger);
  }

  .link,
  a {
    justify-self: start;
  }

  @media (max-width: 56rem) {
    .add {
      padding: 1.25rem 1rem;
      overflow-y: visible;
    }
  }
</style>
