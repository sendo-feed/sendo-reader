<script lang="ts">
  import { prefs } from "../../lib/prefs.svelte";
  import { xEmbedOrigin } from "../../lib/x-embed";
  import OfflineStorage from "./OfflineStorage.svelte";
  import Swipes from "./Swipes.svelte";

  /**
   * 隔離フレームのオリジンが未設定なら、X の投稿の項目は出さない（切り替えても何も変わらない）。
   * 出さない間も、預けた値はそのまま残る（docs/decisions/settings.md）
   */
  const xEmbedAvailable = xEmbedOrigin() !== null;
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
{#if xEmbedAvailable}
  <section aria-labelledby="x-posts-heading">
    <h2 id="x-posts-heading">X posts</h2>
    <label>
      <input
        type="checkbox"
        checked={prefs.value.xPosts}
        onchange={(event) => prefs.set({ xPosts: event.currentTarget.checked })}
        aria-describedby="x-posts-note"
      >
      Load X posts
    </label>
    <p id="x-posts-note">
      記事の中の X の投稿を、表示されたときに X
      の公式ウィジェットで読み込みます。読み込むと、投稿ごとに、あなたの IP、開いた時刻、投稿の ID
      が X に伝わります。切ると、引用と X で開くリンクだけを出します。
    </p>
  </section>
{/if}
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
