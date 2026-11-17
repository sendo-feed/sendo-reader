<script lang="ts">
  import { prefs, TEXT_SIZES, type Theme } from "../../lib/prefs.svelte";

  /** 表示の設定。sendo に預け、同じ種類の端末に引き継ぐ（lib/prefs.svelte.ts） */
  const THEMES: [Theme, string][] = [
    ["auto", "Auto"],
    ["light", "Light"],
    ["dark", "Dark"],
  ];
  /** 文字の大きさのスライダーの、読み上げる値（真ん中が既定） */
  const SIZE_LABELS = ["Smallest", "Small", "Medium", "Large", "Largest"];
  const sizeIndex = $derived(Math.max(0, TEXT_SIZES.indexOf(prefs.value.textSize)));

  function setSize(index: number) {
    const textSize = TEXT_SIZES[index];
    if (textSize !== undefined && textSize !== prefs.value.textSize) prefs.set({ textSize });
  }
  /** reading なら、読むときに変えたいもの（テーマと文字の大きさ）だけを出す。記事の画面から開く */
  let { reading = false }: { reading?: boolean } = $props();
</script>

<section aria-label="Appearance">
  {#if !reading}
    <h2>Appearance</h2>
    <p class="note">
      スマホと、それ以外（PC・タブレット）で、別々に覚えます。同じ種類の端末には、同期で引き継ぎます。
    </p>
  {/if}

  <fieldset>
    <legend>Theme</legend>
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
    <legend>Text size</legend>
    <div class="size">
      <span class="a small" aria-hidden="true">A</span>
      <input
        type="range"
        aria-label="Text size"
        min="0"
        max={TEXT_SIZES.length - 1}
        step="1"
        value={sizeIndex}
        aria-valuetext={SIZE_LABELS[sizeIndex]}
        oninput={(e) => setSize(e.currentTarget.valueAsNumber)}
      >
      <span class="a large" aria-hidden="true">A</span>
    </div>
  </fieldset>

  {#if !reading}
    <fieldset>
      <legend>Mark as read</legend>
      <label class="check">
        <input
          type="checkbox"
          checked={prefs.value.markReadOnScroll}
          onchange={(e) => prefs.set({ markReadOnScroll: e.currentTarget.checked })}
        >
        Mark as read on scroll
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

  .size {
    display: flex;
    flex: 1;
    align-items: center;
    gap: 0.75rem;
    max-width: 22rem;
  }

  .size input {
    flex: 1;
    min-width: 0;
    min-height: 2.25rem;
    margin: 0;
    accent-color: var(--accent);
  }

  .a {
    flex: none;
    color: var(--muted);
    line-height: 1;
  }

  .a.small {
    font-size: 0.8125rem;
  }

  .a.large {
    font-size: 1.25rem;
  }

  input[type="radio"] {
    position: absolute;
    opacity: 0;
    pointer-events: none;
  }
</style>
