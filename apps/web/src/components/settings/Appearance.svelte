<script lang="ts">
  import { type ListLayout, prefs, type TextSize, type Theme } from "../../lib/prefs.svelte";

  /** 表示の設定。この端末だけに置き、sendo には送らない（lib/prefs.svelte.ts） */
  const THEMES: [Theme, string][] = [
    ["auto", "端末に合わせる"],
    ["light", "ライト"],
    ["dark", "ダーク"],
  ];
  const SIZES: [TextSize, string][] = [
    ["small", "小"],
    ["medium", "中"],
    ["large", "大"],
  ];
  const LAYOUTS: [ListLayout, string][] = [
    ["comfortable", "要約も出す"],
    ["compact", "タイトルだけ"],
  ];
</script>

<section aria-labelledby="appearance-heading">
  <h2 id="appearance-heading">表示</h2>
  <p class="note">この端末だけの設定です。</p>

  <fieldset>
    <legend>テーマ</legend>
    {#each THEMES as [value, label] (value)}
      <label>
        <input
          type="radio"
          name="theme"
          {value}
          checked={prefs.value.theme === value}
          onchange={() => prefs.set({ theme: value })}
        >
        {label}
      </label>
    {/each}
  </fieldset>

  <fieldset>
    <legend>文字の大きさ</legend>
    {#each SIZES as [value, label] (value)}
      <label>
        <input
          type="radio"
          name="text-size"
          {value}
          checked={prefs.value.textSize === value}
          onchange={() => prefs.set({ textSize: value })}
        >
        {label}
      </label>
    {/each}
  </fieldset>

  <fieldset>
    <legend>記事の一覧</legend>
    {#each LAYOUTS as [value, label] (value)}
      <label>
        <input
          type="radio"
          name="layout"
          {value}
          checked={prefs.value.layout === value}
          onchange={() => prefs.set({ layout: value })}
        >
        {label}
      </label>
    {/each}
  </fieldset>

  <fieldset>
    <legend>既読にするとき</legend>
    <label class="check">
      <input
        type="checkbox"
        checked={prefs.value.markReadOnScroll}
        onchange={(e) => prefs.set({ markReadOnScroll: e.currentTarget.checked })}
      >
      一覧を動かして通り過ぎた記事を、既読にする
    </label>
  </fieldset>
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

  fieldset {
    display: flex;
    flex-wrap: wrap;
    gap: 0.5rem;
    margin: 0;
    padding: 0;
    border: 0;
  }

  legend {
    margin-bottom: 0.25rem;
    padding: 0;
    color: var(--muted);
    font-size: 0.875rem;
  }

  label {
    display: inline-flex;
    align-items: center;
    padding: 0.3rem 0.9rem;
    border: 1px solid var(--border-strong);
    border-radius: 999px;
    cursor: pointer;
  }

  label:has(input:checked) {
    border-color: var(--accent);
    background: var(--selected);
    font-weight: 600;
  }

  label.check {
    gap: 0.5rem;
    border-radius: var(--radius-small);
  }

  label:has(input:focus-visible) {
    outline: 2px solid var(--accent);
    outline-offset: 2px;
  }

  input[type="radio"] {
    position: absolute;
    opacity: 0;
    pointer-events: none;
  }
</style>
