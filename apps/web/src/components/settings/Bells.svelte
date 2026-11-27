<script lang="ts">
  import { type Bell, bellRemoval, type Feed, feedName } from "@sendo-reader/core";
  import { BellList } from "../../lib/bells.svelte";
  import { useReader } from "../../lib/context";
  import { describeError } from "../../lib/errors";
  import Icon from "../Icon.svelte";
  import RemoteImage from "../RemoteImage.svelte";

  /**
   * 付けたベルの一覧（購読だけ、購読 AND 言葉、言葉だけ）。押すと外す。ベルはほかの操作と同じく
   * 手元の DB から読み、外すのも手元に積んで同期で送る（ネットワークを待たない）。購読のベルは、
   * 選んでいるワークスペースの範囲の購読のものだけを出す（範囲の外のフィード名を出さない。
   * docs/decisions/workspaces.md の 3）
   */
  const reader = useReader();
  const bellList = new BellList(reader.client);
  let message = $state<string | null>(null);

  $effect(() => bellList.watch());

  const rows = $derived(
    bellList.bells.flatMap((bell): { bell: Bell; feed: Feed | null }[] => {
      if (bell.feedId === null) return [{ bell, feed: null }];
      const feed = reader.feeds.find((item) => item.id === bell.feedId);
      return feed === undefined ? [] : [{ bell, feed }];
    }),
  );
  /** 範囲の外の購読のベルがあるか（あることだけ知らせ、名前は出さない） */
  const hidden = $derived(rows.length < bellList.bells.length);

  function title(bell: Bell, feed: Feed | null): string {
    return feed === null ? (bell.words ?? "") : feedName(feed);
  }

  function detail(bell: Bell, feed: Feed | null): string {
    if (feed === null) return "どのフィードでも";
    return bell.words === null ? "すべての新しい記事" : `${bell.words} を含むときだけ`;
  }

  function label(bell: Bell, feed: Feed | null): string {
    return feed !== null && bell.words !== null
      ? `${feedName(feed)} · ${bell.words}`
      : title(bell, feed);
  }

  async function remove(bell: Bell) {
    message = null;
    try {
      await bellList.change(
        (bells) => bellRemoval(bells, bell.id),
        () => reader.client.removeBell(bell.id),
      );
    } catch (error) {
      message = describeError(error);
    }
  }
</script>

<section class="bells" aria-labelledby="notifications-bells">
  <h2 id="notifications-bells">Bells</h2>
  {#if rows.length === 0}
    <p class="note">
      ベルはまだありません。Manage feeds の購読や Search の言葉にベルを付けると、ここに並びます。
    </p>
  {:else}
    <ul>
      {#each rows as { bell, feed } (bell.id)}
        <li>
          <span class="avatar" aria-hidden="true">
            {#if feed === null}
              <Icon name="search" />
            {:else}
              <RemoteImage src={feed.iconUrl}>
                {#snippet fallback()}
                  {feedName(feed).trim().slice(0, 1).toUpperCase() || "?"}
                {/snippet}
              </RemoteImage>
            {/if}
          </span>
          <div class="name">
            <span class="title">{title(bell, feed)}</span>
            <span class="detail">{detail(bell, feed)}</span>
          </div>
          <button
            type="button"
            class="icon-button bell"
            aria-label="Turn off bell: {label(bell, feed)}"
            title="Turn off bell"
            onclick={() => remove(bell)}
          >
            <Icon name="bell" filled />
          </button>
        </li>
      {/each}
    </ul>
  {/if}
  {#if hidden}
    <p class="note">選んでいないワークスペースの購読のベルは、ここに出していません。</p>
  {/if}
  {#if message !== null}
    <p class="error" role="alert">{message}</p>
  {/if}
</section>

<style>
  .bells {
    display: grid;
    gap: 0.75rem;
  }

  h2,
  p {
    margin: 0;
  }

  h2 {
    font-size: 1rem;
  }

  ul {
    list-style: none;
    margin: 0;
    padding: 0;
  }

  li {
    display: flex;
    gap: 0.75rem;
    align-items: center;
    padding: 0.75rem 0;
    border-bottom: 1px solid var(--border);
  }

  .avatar {
    display: grid;
    place-items: center;
    flex: none;
    width: 2rem;
    height: 2rem;
    border-radius: var(--radius-small);
    overflow: hidden;
    background: var(--surface);
    color: var(--muted);
    font-size: 0.875rem;
    font-weight: 600;
  }

  .name {
    display: grid;
    flex: 1;
    min-width: 0;
  }

  .title {
    overflow-wrap: anywhere;
    font-weight: 600;
  }

  .detail,
  .note {
    color: var(--muted);
    font-size: 0.8125rem;
    line-height: 1.7;
  }

  .detail {
    overflow-wrap: anywhere;
  }

  .bell {
    color: var(--accent);
  }

  .error {
    color: var(--danger);
  }
</style>
