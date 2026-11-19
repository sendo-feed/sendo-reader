<script lang="ts">
  import { type Folder, feedName } from "@sendo-reader/core";
  import Dialog from "../components/Dialog.svelte";
  import Icon from "../components/Icon.svelte";
  import AddFeed from "../components/manage/AddFeed.svelte";
  import Bookmarklet from "../components/manage/Bookmarklet.svelte";
  import Feeds from "../components/manage/Feeds.svelte";
  import Folders from "../components/manage/Folders.svelte";
  import ImportOpml from "../components/manage/ImportOpml.svelte";
  import { useReader } from "../lib/context";

  const reader = useReader();
  let query = $state("");
  let addOpen = $state(false);
  let importOpen = $state(false);
  let folderOpen = $state(false);
  let editing = $state<Folder | null>(null);
  let notice = $state("");
  let feedsView = $state<Feeds>();

  function editFolder(folder: Folder | null) {
    editing = folder;
    folderOpen = true;
  }
</script>

<main class="manage">
  <header>
    <div>
      <h1>Manage feeds</h1>
      <p class="counts">{reader.feeds.length} feeds · {reader.folders.length} folders</p>
    </div>
    <button type="button" class="primary add" onclick={() => (addOpen = true)}>
      <Icon name="plus" />
      Add feed
    </button>
  </header>

  <div class="toolbar">
    <label class="search">
      <Icon name="search" />
      <span class="visually-hidden">Find a feed</span>
      <input type="search" placeholder="Find a feed…" bind:value={query}>
    </label>
    <button type="button" class="new-folder" onclick={() => editFolder(null)}>
      <Icon name="plus" />
      New folder
    </button>
  </div>

  <Feeds bind:this={feedsView} {query} oneditfolder={editFolder} onadd={() => (addOpen = true)} />

  <footer>
    <button type="button" class="link" onclick={() => (importOpen = true)}>Import OPML</button>
  </footer>
  <p class="notice" role="status">{notice}</p>
</main>

<Dialog bind:open={addOpen} title="Add feed">
  <AddFeed
    onsubscribed={(feed) => {
      addOpen = false;
      query = "";
      feedsView?.reveal(feed.folderId);
      notice = `${feedName(feed)} を購読しました。`;
    }}
  />
  <div class="bookmarklet">
    <Bookmarklet />
  </div>
  <div class="import-link">
    <button
      type="button"
      class="link"
      onclick={() => {
        addOpen = false;
        importOpen = true;
      }}
    >
      Import OPML
    </button>
  </div>
</Dialog>

<Dialog bind:open={folderOpen} title={editing === null ? "New folder" : editing.name}>
  {#if folderOpen}
    <Folders
      folder={editing}
      oncomplete={(message) => {
        folderOpen = false;
        notice = message;
      }}
      oncancel={() => (folderOpen = false)}
    />
  {/if}
</Dialog>

<Dialog bind:open={importOpen} title="Import OPML">
  <ImportOpml />
</Dialog>

<style>
  .manage {
    display: grid;
    gap: 1.5rem;
    align-content: start;
    padding: 2rem 2.5rem 3rem;
    overflow-y: auto;
  }

  /* 狭い画面では、ページ全体を動かす（docs/decisions/ui.md の 6） */
  @media (max-width: 56rem) {
    .manage {
      padding: 1.5rem 1rem 2rem;
      overflow-y: visible;
    }
  }

  h1 {
    margin: 0;
    font-size: 1.5rem;
    letter-spacing: -0.025em;
  }

  header,
  .toolbar {
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: 1rem;
    flex-wrap: wrap;
  }

  .counts {
    margin: 0.25rem 0 0;
    color: var(--muted);
    font-size: 0.8125rem;
  }

  .add,
  .new-folder {
    display: inline-flex;
    align-items: center;
    justify-content: center;
    gap: 0.375rem;
  }

  .new-folder {
    border-color: transparent;
    background: none;
    color: var(--muted);
  }

  .search {
    display: flex;
    align-items: center;
    gap: 0.5rem;
    width: min(100%, 22rem);
    color: var(--muted);
  }

  .search input {
    width: 100%;
    min-width: 0;
    background: var(--surface);
    border-color: transparent;
    font-size: 0.875rem;
  }

  footer {
    display: flex;
    justify-content: flex-end;
    padding-top: 0.5rem;
    font-size: 0.8125rem;
  }

  .notice {
    margin: 0;
    color: var(--muted);
    font-size: 0.875rem;
  }

  .notice:empty {
    display: none;
  }

  .bookmarklet,
  .import-link {
    margin-top: 1.25rem;
    padding-top: 1rem;
    border-top: 1px solid var(--border);
    font-size: 0.875rem;
  }

  @media (max-width: 28rem) {
    header {
      gap: 0.75rem;
    }

    h1 {
      font-size: 1.25rem;
    }

    .toolbar {
      gap: 0.5rem;
    }

    .search {
      width: 100%;
    }
  }
</style>
