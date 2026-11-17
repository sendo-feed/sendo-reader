<script lang="ts">
  import Dialog from "./Dialog.svelte";

  let { open = $bindable(false) }: { open?: boolean } = $props();

  /** キーボードの操作の一覧（実際の割り当ては routes/Reader.svelte） */
  const GROUPS: { title: string; keys: [string[], string][] }[] = [
    {
      title: "Navigate",
      keys: [
        [["j"], "Open next"],
        [["k"], "Open previous"],
        [["n"], "Select next"],
        [["p"], "Select previous"],
        [["o", "Enter"], "Open selected"],
        [["Esc"], "Close"],
      ],
    },
    {
      title: "Actions",
      keys: [
        [["m"], "Toggle read"],
        [["s"], "Save / Unsave"],
        [["v"], "Open original in new tab"],
        [["Shift", "A"], "Mark all as read"],
      ],
    },
    {
      title: "Go to",
      keys: [
        [["g", "a"], "All"],
        [["g", "r"], "Recently Read"],
        [["g", "s"], "Saved"],
        [["Shift", "J"], "Next unread feed"],
        [["Shift", "K"], "Previous unread feed"],
        [["/"], "Search articles"],
        [["g", "m"], "Manage feeds"],
        [["r"], "Sync now"],
        [["?"], "Show shortcuts"],
      ],
    },
  ];
</script>

<Dialog bind:open title="Keyboard shortcuts">
  <div class="groups">
    <p class="touch">
      指では、一覧の行を右へスワイプすると
      Save、左へスワイプすると既読・未読。長く押す（右クリック）と、
      その記事の操作。記事を右へスワイプすると一覧に戻る。スワイプの割り当ては、Settings
      で変えられます。
    </p>
    {#each GROUPS as group (group.title)}
      <section>
        <h3>{group.title}</h3>
        <dl>
          {#each group.keys as [keys, label] (label)}
            <div>
              <dt>
                {#each keys as key (key)}
                  <kbd>{key}</kbd>
                {/each}
              </dt>
              <dd>{label}</dd>
            </div>
          {/each}
        </dl>
      </section>
    {/each}
  </div>
</Dialog>

<style>
  .groups {
    display: grid;
    gap: 1rem;
  }

  .touch {
    margin: 0;
    color: var(--muted);
    font-size: 0.875rem;
  }

  h3 {
    margin: 0 0 0.25rem;
    color: var(--muted);
    font-size: 0.8125rem;
  }

  dl {
    margin: 0;
  }

  dl div {
    display: flex;
    align-items: center;
    gap: 0.75rem;
    padding: 0.25rem 0;
  }

  dt {
    display: flex;
    flex: none;
    gap: 0.25rem;
    width: 6.5rem;
  }

  dd {
    margin: 0;
    font-size: 0.9375rem;
  }
</style>
