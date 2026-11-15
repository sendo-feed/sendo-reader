<script lang="ts">
  import Dialog from "./Dialog.svelte";

  let { open = $bindable(false) }: { open?: boolean } = $props();

  /** キーボードの操作の一覧（実際の割り当ては routes/Reader.svelte） */
  const GROUPS: { title: string; keys: [string[], string][] }[] = [
    {
      title: "記事を移る",
      keys: [
        [["j"], "次の記事を開く"],
        [["k"], "前の記事を開く"],
        [["n"], "次の記事を選ぶ（開かない）"],
        [["p"], "前の記事を選ぶ（開かない）"],
        [["o", "Enter"], "選んだ記事を開く"],
        [["Esc"], "記事を閉じる"],
      ],
    },
    {
      title: "記事の操作",
      keys: [
        [["m"], "既読・未読を切り替える"],
        [["s"], "スターを付ける・外す"],
        [["v"], "元の記事を新しいタブで開く"],
        [["Shift", "A"], "一覧をまとめて既読にする（取り消せる）"],
      ],
    },
    {
      title: "画面を移る",
      keys: [
        [["g", "u"], "未読"],
        [["g", "a"], "すべて"],
        [["g", "s"], "スター"],
        [["Shift", "J"], "次の、未読のあるフィード"],
        [["Shift", "K"], "前の、未読のあるフィード"],
        [["/"], "記事を探す"],
        [["g", "m"], "購読の管理"],
        [["r"], "今すぐ同期"],
        [["?"], "この一覧を出す"],
      ],
    },
  ];
</script>

<Dialog bind:open title="キーボードの操作">
  <div class="groups">
    <p class="touch">
      指では、一覧の行を左へはじくとスター、右へはじくと既読・未読。長く押す（右クリック）と、その記事の操作。
      記事を左右にはじくと次・前の記事。
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
