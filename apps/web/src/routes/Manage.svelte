<script lang="ts">
  import AddFeed from "../components/manage/AddFeed.svelte";
  import Feeds from "../components/manage/Feeds.svelte";
  import Folders from "../components/manage/Folders.svelte";
  import ImportOpml from "../components/manage/ImportOpml.svelte";
</script>

<main class="manage">
  <h1>購読の管理</h1>
  <AddFeed />
  <Folders />
  <Feeds />
  <ImportOpml />
</main>

<style>
  .manage {
    display: grid;
    gap: 2rem;
    align-content: start;
    max-width: 48rem;
    padding: 1rem 1.5rem 3rem;
    overflow-y: auto;
  }

  h1 {
    margin: 0;
    font-size: 1.5rem;
  }
</style>
