<script lang="ts">
  import { type SavedPage, toSafeHttpUrl } from "@sendo-reader/core";
  import { useReader } from "../lib/context";
  import { describeError, describeSavedPageError } from "../lib/errors";
  import { formatDateTime, shortTime } from "../lib/format";
  import Dialog from "./Dialog.svelte";
  import Icon from "./Icon.svelte";

  const reader = useReader();
  const PAGE_SIZE = 20;
  let pages = $state<SavedPage[]>([]);
  let shown = $state(PAGE_SIZE);
  let addOpen = $state(false);
  let url = $state("");
  let error = $state<string | null>(null);
  let formError = $state<string | null>(null);
  let saving = $state(false);

  $effect(() => {
    let current = 0;
    async function load() {
      const request = ++current;
      try {
        const found = await reader.client.listSavedPages(true);
        if (request === current) pages = found;
      } catch {
        if (request === current) error = "保存したページを読み込めませんでした。";
      }
    }
    const unsubscribe = reader.client.onChange((tables) => {
      if (tables.has("savedPages") || tables.has("articles")) void load();
    });
    void load();
    return () => {
      ++current;
      unsubscribe();
    };
  });

  async function save(event: SubmitEvent) {
    event.preventDefault();
    saving = true;
    error = null;
    formError = null;
    try {
      await reader.client.savePage(url);
      url = "";
      addOpen = false;
    } catch (failure) {
      formError = describeError(failure);
    } finally {
      saving = false;
    }
  }

  async function remove(page: SavedPage) {
    error = null;
    try {
      await reader.client.unsavePage(page.id);
    } catch (failure) {
      error = describeError(failure);
    }
  }
</script>

<div class="saved-pages">
  <div class="actions">
    <button
      type="button"
      onclick={() => {
        formError = null;
        addOpen = true;
      }}
    >
      <Icon name="plus" />
      Save a URL
    </button>
  </div>
  {#if error !== null || reader.status?.savedPageError != null}
    <p class="error" role="alert">
      {error ?? describeSavedPageError(reader.status?.savedPageError)}
    </p>
  {/if}
  {#if pages.length > 0}
    <h2>Saved links</h2>
    <ul>
      {#each pages.slice(0, shown) as page (page.id)}
        {@const href = toSafeHttpUrl(page.url)}
        {#if href !== null}
          <li>
            <a {href} target="_blank" rel="noreferrer noopener">
              <span>{page.title ?? page.url}</span>
              {#if page.title !== null}
                <small>{page.url}</small>
              {/if}
            </a>
            <time
              datetime={new Date(page.savedAt).toISOString()}
              title={formatDateTime(page.savedAt)}
            >
              {shortTime(page.savedAt)}
            </time>
            <button
              type="button"
              class="icon-button"
              aria-label={`Remove saved link ${page.title ?? page.url}`}
              title="Remove saved link"
              onclick={() => void remove(page)}
            >
              <Icon name="close" />
            </button>
          </li>
        {/if}
      {/each}
    </ul>
    {#if pages.length > shown}
      <button type="button" class="link" onclick={() => (shown += PAGE_SIZE)}>
        Show more links
      </button>
    {/if}
  {/if}
</div>

<Dialog bind:open={addOpen} title="Save a URL" dismissible={!saving}>
  <form onsubmit={save}>
    <label for="saved-page-url">Page URL</label>
    <input
      id="saved-page-url"
      type="url"
      inputmode="url"
      maxlength="2048"
      required
      placeholder="https://example.com/article"
      bind:value={url}
      disabled={saving}
    >
    {#if formError !== null}
      <p class="error" role="alert">{formError}</p>
    {/if}
    <button type="submit" class="primary" disabled={saving}>Save</button>
  </form>
</Dialog>

<style>
  .saved-pages {
    padding: 0.75rem 1rem;
  }

  .actions {
    display: flex;
  }

  .actions button {
    display: inline-flex;
    align-items: center;
    gap: 0.35rem;
  }

  h2 {
    margin: 1rem 0 0.375rem;
    font-size: 0.85rem;
    color: var(--muted);
  }

  ul {
    list-style: none;
    margin: 0;
    padding: 0;
  }

  li {
    display: flex;
    align-items: center;
    gap: 0.5rem;
    border-top: 1px solid var(--border);
  }

  li a {
    min-width: 0;
    flex: 1;
    padding: 0.55rem 0;
    overflow-wrap: anywhere;
  }

  small {
    display: block;
  }

  small,
  time {
    color: var(--muted);
    font-size: 0.8rem;
  }

  time {
    white-space: nowrap;
  }

  .error {
    color: var(--danger);
    font-size: 0.9rem;
    margin: 0.5rem 0 0;
  }

  form {
    display: grid;
    gap: 0.75rem;
  }

  input {
    min-width: 0;
  }

  form .primary {
    justify-self: end;
  }
</style>
