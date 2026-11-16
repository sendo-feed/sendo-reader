<script lang="ts">
  import {
    ARTICLE_SWIPES,
    type ArticleSwipe,
    LIST_SWIPES,
    type ListSwipe,
    prefs,
    type Swipes,
  } from "../../lib/prefs.svelte";

  /** 指でのスワイプの割り当て。sendo に預け、同じ種類の端末に引き継ぐ（lib/prefs.svelte.ts） */
  const LIST_LABELS: Record<ListSwipe, string> = {
    none: "None",
    read: "Toggle read",
    star: "Save / Unsave",
  };
  const ARTICLE_LABELS: Record<ArticleSwipe, string> = {
    none: "None",
    back: "Back",
    next: "Next",
    previous: "Previous",
  };

  const ROWS: { key: keyof Swipes; label: string; options: [string, string][] }[] = [
    { key: "listRight", label: "List: swipe right", options: entries(LIST_SWIPES, LIST_LABELS) },
    { key: "listLeft", label: "List: swipe left", options: entries(LIST_SWIPES, LIST_LABELS) },
    {
      key: "articleRight",
      label: "Article: swipe right",
      options: entries(ARTICLE_SWIPES, ARTICLE_LABELS),
    },
    {
      key: "articleLeft",
      label: "Article: swipe left",
      options: entries(ARTICLE_SWIPES, ARTICLE_LABELS),
    },
  ];

  function entries<T extends string>(values: readonly T[], labels: Record<T, string>) {
    return values.map((value): [string, string] => [value, labels[value]]);
  }

  function change(key: keyof Swipes, value: string) {
    // 選べる値かどうかは、置いた値を読むときに確かめる（parsePrefs）
    prefs.set({ swipes: { ...prefs.value.swipes, [key]: value } as Swipes });
  }
</script>

<section aria-labelledby="swipes-heading">
  <h2 id="swipes-heading">Swipe</h2>
  <p class="note">指で横に動かしたときにすることを選びます。</p>
  {#each ROWS as row (row.key)}
    <label>
      <span>{row.label}</span>
      <select
        value={prefs.value.swipes[row.key]}
        onchange={(e) => change(row.key, e.currentTarget.value)}
      >
        {#each row.options as [value, label] (value)}
          <option {value}>{label}</option>
        {/each}
      </select>
    </label>
  {/each}
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

  .note {
    margin: 0;
    color: var(--muted);
    font-size: 0.875rem;
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
