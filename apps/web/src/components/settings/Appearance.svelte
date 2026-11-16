<script lang="ts">
  import { prefs, type TextSize, type Theme } from "../../lib/prefs.svelte";

  /** 表示の設定。sendo に預け、同じ種類の端末に引き継ぐ（lib/prefs.svelte.ts） */
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
  /** reading なら、読むときに変えたいもの（テーマと文字の大きさ）だけを出す。記事の画面から開く */
  let { reading = false }: { reading?: boolean } = $props();
</script>

<section aria-label="表示">
  {#if !reading}
    <h2>表示</h2>
    <p class="note">
      スマホと、それ以外（PC・タブレット）で、別々に覚えます。同じ種類の端末には、同期で引き継ぎます。
    </p>
  {/if}

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

  {#if !reading}
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
