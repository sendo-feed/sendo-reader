<script lang="ts">
  import Appearance from "../components/settings/Appearance.svelte";
  import Grants from "../components/settings/Grants.svelte";
  import Reading from "../components/settings/Reading.svelte";
  import Tokens from "../components/settings/Tokens.svelte";
  import { confirmAccount } from "../lib/account";
  import { useReader } from "../lib/context";
  import { scrollToTop } from "../lib/layout.svelte";
  import { detectDeviceType } from "../lib/prefs.svelte";

  /**
   * Connections（docs/decisions/account.md）は、sendo にしかないもの（アクセストークン、OAuth の許可）を
   * 扱うので、ネットワークが要る。手元の DB には置かず、このカテゴリを開くたびに sendo に聞く。
   *
   * 出しているアカウントは手元のユーザーで、sendo には今のクッキーで送る。別のタブなどでログインし
   * 直していると食い違うので、聞く前と送る前に、セッションのユーザーが手元のユーザーと同じかを
   * 確かめる（違えば送らず、同期に切り替えを任せる）。手元のユーザーが替わったら、一覧も発行した
   * 中身も捨てて作り直す。
   */
  const reader = useReader();

  const categories = ["Appearance", "Reading", "Connections"] as const;
  type Category = (typeof categories)[number];
  let active = $state<Category>("Appearance");
  let main = $state<HTMLElement>();
  const device = detectDeviceType() === "mobile" ? "スマホ" : "PC・タブレット";

  function select(category: Category) {
    active = category;
    scrollToTop(main);
  }

  function navigate(event: KeyboardEvent, index: number) {
    let next: number;
    switch (event.key) {
      case "ArrowRight":
        next = (index + 1) % categories.length;
        break;
      case "ArrowLeft":
        next = (index + categories.length - 1) % categories.length;
        break;
      case "Home":
        next = 0;
        break;
      case "End":
        next = categories.length - 1;
        break;
      default:
        return;
    }
    event.preventDefault();
    const category = categories[next];
    if (category === undefined) return;
    select(category);
    document.getElementById(`settings-tab-${category}`)?.focus();
  }

  /** 動いている版。PWA が新しい版に替わったかを、ここで確かめられる */
  const version = __APP_VERSION__;
  const builtAt = new Date(version.builtAt).toLocaleString(undefined, {
    dateStyle: "medium",
    timeStyle: "short",
  });

  function confirm(signal?: AbortSignal): Promise<void> {
    return confirmAccount(reader.user, () => void reader.client.syncNow(), signal);
  }
</script>

<main class="settings" bind:this={main}>
  <h1>Settings</h1>
  <div class="categories" role="tablist" aria-label="Settings">
    {#each categories as category, index (category)}
      <button
        id={`settings-tab-${category}`}
        type="button"
        role="tab"
        aria-selected={active === category}
        aria-controls={`settings-panel-${category}`}
        tabindex={active === category ? 0 : -1}
        onclick={() => select(category)}
        onkeydown={(event) => navigate(event, index)}
      >
        {category}
      </button>
    {/each}
  </div>
  {#each categories as category (category)}
    <div
      class="panel"
      role="tabpanel"
      id={`settings-panel-${category}`}
      aria-labelledby={`settings-tab-${category}`}
      hidden={active !== category}
    >
      {#if active === category}
        {#if category === "Connections"}
          <p class="note">ほかのアプリからのアクセスを管理します。インターネット接続が必要です。</p>
          {#key reader.user?.id}
            {#if reader.user !== null}
              <p class="account">ログインしているアカウント：{reader.user.email}</p>
              <Tokens {confirm} />
              <Grants {confirm} />
            {/if}
          {/key}
        {:else}
          <p class="note">
            {device}向けの設定です。変更は自動で保存し、同期で同じ種類の端末に引き継ぎます。
          </p>
          {#if category === "Appearance"}
            <Appearance />
          {:else}
            <Reading />
          {/if}
        {/if}
      {/if}
    </div>
  {/each}
  <p class="version">
    Version {version.commit} (<time datetime={version.builtAt}>{builtAt}</time>)
  </p>
</main>

<style>
  .settings {
    display: grid;
    /* 中身の一番広いもの（スワイプの選択肢など）で、列が画面より広がらないようにする */
    grid-template-columns: minmax(0, 1fr);
    gap: 1.5rem;
    align-content: start;
    width: 100%;
    max-width: 48rem;
    padding: 1rem 1.5rem 3rem;
    overflow-y: auto;
  }

  /* 狭い画面では、ページ全体を動かす（docs/decisions/ui.md の 6） */
  @media (max-width: 56rem) {
    .settings {
      padding-inline: 1rem;
      overflow-y: visible;
    }
  }

  .categories {
    display: grid;
    grid-template-columns: repeat(3, auto);
    padding: 0.25rem;
    border: 1px solid var(--border);
    border-radius: var(--radius-small);
    background: var(--surface);
  }

  .categories button {
    min-width: 0;
    padding: 0.6rem 0.1rem;
    border: 0;
    background: transparent;
    color: var(--muted);
    font-size: 0.75rem;
    min-height: 2.75rem;
  }

  .categories button[aria-selected="true"] {
    background: var(--selected);
    color: var(--accent);
    font-weight: 600;
  }

  .panel {
    display: grid;
    gap: 1.5rem;
    min-width: 0;
  }

  .panel[hidden] {
    display: none;
  }

  .note {
    margin: 0;
    color: var(--muted);
    font-size: 0.8125rem;
    line-height: 1.7;
  }

  .version {
    margin: 0;
    color: var(--faint);
    font-size: 0.75rem;
    font-variant-numeric: tabular-nums;
  }

  h1 {
    margin: 0;
    font-size: 1.5rem;
  }

  .account {
    margin: 0;
    color: var(--muted);
    overflow-wrap: anywhere;
    font-size: 0.875rem;
  }
</style>
