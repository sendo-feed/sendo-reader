<script lang="ts">
  import type { Snippet } from "svelte";
  import Icon from "./Icon.svelte";

  /** 画面の上に重ねて出す窓（<dialog>。Esc と、外側を押すと閉じる） */
  let {
    open = $bindable(false),
    title,
    children,
    dismissible = true,
  }: { open?: boolean; title: string; children: Snippet; dismissible?: boolean } = $props();

  let element = $state<HTMLDialogElement>();

  $effect(() => {
    if (element === undefined) return;
    if (open && !element.open) element.showModal();
    else if (!open && element.open) element.close();
  });

  /** 窓の外側（::backdrop）を押したら閉じる。中身は .body が覆っているので、届くのは外側だけ */
  function onPointerDown(event: PointerEvent) {
    if (dismissible && event.target === element) open = false;
  }
</script>

<dialog
  bind:this={element}
  aria-label={title}
  oncancel={(event) => {
    if (!dismissible) event.preventDefault();
  }}
  onclose={() => (open = false)}
  onpointerdown={onPointerDown}
>
  <div class="body">
    <header>
      <h2>{title}</h2>
      <button
        type="button"
        class="icon-button"
        aria-label="Close"
        disabled={!dismissible}
        onclick={() => (open = false)}
      >
        <Icon name="close" />
      </button>
    </header>
    {@render children()}
  </div>
</dialog>

<style>
  dialog {
    width: min(34rem, calc(100vw - 2rem));
    max-height: calc(100dvh - 2rem);
    padding: 0;
    border: 1px solid var(--border);
    border-radius: 0.75rem;
    background: var(--raised);
    color: var(--text);
    box-shadow: var(--shadow);
  }

  /* 開くときに、少し小さく薄いところから出し、後ろを暗くしていく */
  dialog[open] {
    animation: dialog-in 0.18s ease-out;
  }

  dialog[open]::backdrop {
    animation: backdrop-in 0.18s ease-out;
  }

  @keyframes dialog-in {
    from {
      opacity: 0;
      transform: scale(0.96);
    }
  }

  @keyframes backdrop-in {
    from {
      opacity: 0;
    }
  }

  @media (prefers-reduced-motion: reduce) {
    dialog[open],
    dialog[open]::backdrop {
      animation: none;
    }
  }

  dialog::backdrop {
    background: var(--scrim);
  }

  .body {
    padding: 1rem 1.25rem 1.25rem;
  }

  header {
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: 0.5rem;
    margin-bottom: 0.75rem;
  }

  h2 {
    min-width: 0;
    margin: 0;
    font-size: 1.125rem;
    overflow-wrap: anywhere;
  }
</style>
