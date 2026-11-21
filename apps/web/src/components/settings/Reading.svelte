<script lang="ts">
  import { prefs } from "../../lib/prefs.svelte";
  import OfflineStorage from "./OfflineStorage.svelte";
  import Swipes from "./Swipes.svelte";
</script>

<section aria-labelledby="reading-heading">
  <h2 id="reading-heading">Mark as read</h2>
  <label>
    <input
      type="checkbox"
      checked={prefs.value.markReadOnScroll}
      onchange={(event) => prefs.set({ markReadOnScroll: event.currentTarget.checked })}
      aria-describedby="mark-read-note"
    >
    Mark as read on scroll
  </label>
  <p id="mark-read-note">一覧を下へスクロールすると、画面の上を通り過ぎた記事を既読にします。</p>
</section>
<Swipes />
<OfflineStorage />

<style>
  section {
    display: grid;
    gap: 0.75rem;
  }
  h2 {
    margin: 0;
    font-size: 1.125rem;
  }
  label {
    display: flex;
    align-items: center;
    gap: 0.5rem;
    cursor: pointer;
  }
  input {
    accent-color: var(--accent);
    flex: none;
  }
  p {
    margin: 0;
    color: var(--muted);
    font-size: 0.875rem;
    line-height: 1.7;
  }
</style>
