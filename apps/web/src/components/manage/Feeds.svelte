<script lang="ts">
  import { type Feed, type FeedFetchTimes, type Folder, feedName } from "@sendo-reader/core";
  import { useReader } from "../../lib/context";
  import { describeError } from "../../lib/errors";
  import { formatArticleAge, formatDate, formatDateTime } from "../../lib/format";
  import { notificationSuggestion } from "../../lib/notification-suggestion.svelte";
  import Dialog from "../Dialog.svelte";
  import Icon from "../Icon.svelte";
  import RemoteImage from "../RemoteImage.svelte";
  import FeedName from "./FeedName.svelte";

  let {
    query,
    oldestFirst,
    oneditfolder,
    onadd,
  }: {
    query: string;
    oldestFirst: boolean;
    oneditfolder: (folder: Folder) => void;
    onadd: () => void;
  } = $props();

  const reader = useReader();
  let collapsed = $state<string[]>([]);
  let message = $state<string | null>(null);
  let movingWorkspace = $state(false);
  let workspaceDestination = $state("");
  let moving = $state(false);
  let notice = $state("");
  let selectedId = $state<string | null>(null);
  let menuOpen = $state(false);
  let confirming = $state(false);
  let fetchTimes = $state<FeedFetchTimes | null>(null);
  let fetchTimesStatus = $state<"loading" | "ready" | "unavailable">("loading");
  let latestArticleDates = $state.raw<Map<string, number> | null>(null);
  /** 購読だけのベルを付けたフィード（手元の DB を読んだもの） */
  let belledFeeds = $state.raw<ReadonlySet<string>>(new Set());
  /**
   * 押してから、手元の DB を読み直すまでの間に出す状態（楽観的な更新。docs/decisions/performance.md の
   * 操作の反応 100ms）
   */
  let pressedBells = $state.raw<ReadonlyMap<string, { on: boolean; press: number }>>(new Map());
  let lastBellPress = 0;
  let lastBellRead = 0;
  const userId = $derived(reader.user?.id);
  const selected = $derived(reader.feeds.find((feed) => feed.id === selectedId));
  const term = $derived(query.trim().toLowerCase());
  const matches = $derived(
    reader.feeds.filter((feed) =>
      `${feed.displayName ?? ""} ${feed.title ?? ""} ${feed.url}`.toLowerCase().includes(term),
    ),
  );
  const groups = $derived(
    oldestFirst
      ? [{ id: null, name: "Feeds", folder: null, feeds: [...matches].sort(compareLatestArticles) }]
      : [
          ...reader.folders.map((folder) => ({
            id: folder.id,
            name: folder.name,
            folder,
            feeds: matches.filter((feed) => feed.folderId === folder.id),
          })),
          {
            id: "",
            name: "No folder",
            folder: null,
            feeds: matches.filter((feed) => feed.folderId === null),
          },
        ],
  );

  $effect(() => {
    if (selected === undefined) menuOpen = false;
  });

  $effect(() => {
    latestArticleDates = null;
    if (userId === undefined) return;
    let active = true;
    let lastRead = 0;
    function readLatestArticles() {
      const read = ++lastRead;
      void reader.client
        .listLatestArticleDates()
        .then((dates) => {
          if (active && read === lastRead) latestArticleDates = dates;
        })
        .catch(() => {});
    }
    const off = reader.client.onChange((tables) => {
      if (tables.has("articles") || tables.has("feeds")) readLatestArticles();
    });
    readLatestArticles();
    return () => {
      active = false;
      off();
    };
  });

  $effect(() => {
    belledFeeds = new Set();
    pressedBells = new Map();
    if (userId === undefined) return;
    const off = reader.client.onChange((tables) => {
      if (tables.has("bells")) void readBells().catch(() => {});
    });
    void readBells().catch(() => {});
    return () => {
      lastBellRead += 1;
      off();
    };
  });

  async function readBells(): Promise<void> {
    const read = ++lastBellRead;
    const bells = await reader.client.listBells();
    if (read !== lastBellRead) return;
    belledFeeds = new Set(
      bells.flatMap((bell) => (bell.words === null && bell.feedId !== null ? [bell.feedId] : [])),
    );
  }

  function hasBell(feed: Feed): boolean {
    return pressedBells.get(feed.id)?.on ?? belledFeeds.has(feed.id);
  }

  /**
   * ベルを付け外しする。押したらすぐ出し、手元の DB への書き込みはそのあとに待つ。sendo へは同期で
   * 送る（断られたら、同期のあとに手元の DB が戻り、読み直した表示も戻る）。付けたら、この端末で
   * 通知を受けていなければ勧める（docs/decisions/notifications.md の 1。ベルの操作は待たせない）
   */
  async function toggleBell(feed: Feed) {
    const on = !hasBell(feed);
    const press = ++lastBellPress;
    pressedBells = new Map(pressedBells).set(feed.id, { on, press });
    message = null;
    try {
      await reader.client.setFeedBell(feed.id, on);
      if (on) void notificationSuggestion.offer();
    } catch (error) {
      message = describeError(error);
    }
    await readBells().catch(() => {});
    // 待っている間にもう一度押していたら、そちらの書き込みのあとに任せる
    if (pressedBells.get(feed.id)?.press === press) {
      const next = new Map(pressedBells);
      next.delete(feed.id);
      pressedBells = next;
    }
  }

  $effect(() => {
    const feedId = selectedId;
    fetchTimes = null;
    fetchTimesStatus = "loading";
    if (!menuOpen || feedId === null || userId === undefined) return;
    let active = true;
    void (async () => {
      try {
        const cached = await reader.client.getFeedFetchTimes(feedId);
        if (!active) return;
        fetchTimes = cached;
        const latest = await reader.client.refreshFeedFetchTimes(feedId);
        if (!active) return;
        if (latest !== null) fetchTimes = latest;
        fetchTimesStatus = latest === null ? "unavailable" : "ready";
      } catch {
        if (active) fetchTimesStatus = "unavailable";
      }
    })();
    return () => {
      active = false;
    };
  });

  function hostOf(feed: Feed): string {
    try {
      return new URL(feed.url).host;
    } catch {
      return feed.url;
    }
  }

  function compareLatestArticles(a: Feed, b: Feed): number {
    const first = latestArticleDates?.get(a.id) ?? Infinity;
    const second = latestArticleDates?.get(b.id) ?? Infinity;
    return first === second ? 0 : first - second;
  }

  function toggle(id: string) {
    collapsed = collapsed.includes(id)
      ? collapsed.filter((value) => value !== id)
      : [...collapsed, id];
  }

  export function reveal(folderId: string | null) {
    collapsed = collapsed.filter((id) => id !== (folderId ?? ""));
  }

  function openMenu(feed: Feed) {
    selectedId = feed.id;
    confirming = false;
    movingWorkspace = false;
    workspaceDestination = feed.workspaceId ?? "";
    message = null;
    menuOpen = true;
  }

  async function move(feed: Feed, event: Event) {
    const value = (event.currentTarget as HTMLSelectElement).value;
    message = null;
    try {
      await reader.client.moveFeed(feed.id, value === "" ? null : value);
      collapsed = collapsed.filter((id) => id !== value);
      notice = "フォルダを変更しました。";
      menuOpen = false;
    } catch (error) {
      message = describeError(error);
    }
  }

  async function moveWorkspace(feed: Feed) {
    moving = true;
    message = null;
    try {
      if (feed.subscriptionId === undefined) return;
      await reader.client.moveFeedToWorkspace(
        feed.id,
        feed.subscriptionId,
        workspaceDestination || null,
      );
      menuOpen = false;
      notice = "購読のワークスペースを変更しました。";
    } catch (error) {
      message = describeError(error);
    } finally {
      moving = false;
    }
  }

  async function unsubscribe() {
    if (selected === undefined) return;
    message = null;
    try {
      await reader.client.unsubscribe(selected.id);
      menuOpen = false;
      notice = "購読をやめました。";
    } catch (error) {
      message = describeError(error);
    }
  }
</script>

{#snippet folderOptions()}
  <option value="">No folder</option>
  {#each reader.folderDestinations as folder (folder.id)}
    <option value={folder.id}>{folder.name}</option>
  {/each}
{/snippet}

{#snippet fetchTime(time: number | null)}
  {#if time === null}
    <span class="fetch-times-note">No record</span>
  {:else}
    <time datetime={new Date(time).toISOString()}>{formatDateTime(time)}</time>
  {/if}
{/snippet}

{#snippet latestArticle(feedId: string)}
  {@const date = latestArticleDates?.get(feedId)}
  最新記事：
  {#if date !== undefined}
    {@const age = formatArticleAge(date)}
    <time datetime={new Date(date).toISOString()}
      >{`${formatDate(date)}${age === null ? "" : `（${age}）`}`}</time
    >
  {:else}
    {latestArticleDates === null ? "—" : "同期済みの記事なし"}
  {/if}
{/snippet}

<div class="groups">
  {#if reader.feeds.length === 0 && reader.folders.length === 0}
    <div class="empty-start">
      <Icon name="rss" />
      <h2>購読しているフィードはまだありません。</h2>
      <p>気になるサイトを追加して、ここに記事を集めましょう。</p>
      <button type="button" onclick={onadd}>Add your first feed</button>
    </div>
  {:else if term !== "" && matches.length === 0}
    <p class="empty">一致するフィードがありません。</p>
  {:else}
    {#each groups as group (group.id)}
      {#if term === "" || group.feeds.length > 0}
        {@const groupId = group.id}
        {@const closed = groupId !== null && term === "" && collapsed.includes(groupId)}
        {@const groupContentsId =
          groupId === null ? undefined : `manage-folder-${groupId || "none"}`}
        <section class="folder-group" aria-label={group.name}>
          {#if groupId !== null}
            <div class="group-heading">
              <h2>
                <button
                  type="button"
                  class="group-toggle"
                  aria-expanded={!closed}
                  aria-controls={groupContentsId}
                  onclick={() => toggle(groupId)}
                >
                  <Icon name={closed ? "chevronRight" : "chevronDown"} />
                  <Icon name={group.folder === null ? "inbox" : "folder"} />
                  <span>{group.name}</span>
                  <span class="count">{group.feeds.length}</span>
                </button>
              </h2>
              {#if group.folder !== null}
                <button
                  type="button"
                  class="icon-button"
                  aria-label="Folder options: {group.name}"
                  title="Folder options"
                  onclick={() => group.folder !== null && oneditfolder(group.folder)}
                >
                  <Icon name="more" />
                </button>
              {/if}
            </div>
          {/if}
          <div id={groupContentsId} hidden={closed}>
            <ul>
              {#each group.feeds as feed (feed.id)}
                {@const belled = hasBell(feed)}
                <li class="feed-row">
                  <span class="avatar" aria-hidden="true">
                    <RemoteImage src={feed.iconUrl}>
                      {#snippet fallback()}
                        {(feed.displayName ?? feed.title ?? hostOf(feed))
                          .trim()
                          .slice(0, 1)
                          .toUpperCase() || "?"}
                      {/snippet}
                    </RemoteImage>
                  </span>
                  <div class="name">
                    <FeedName {feed} />
                    <span class="host">{hostOf(feed)}</span>
                    <span class="latest-article">{@render latestArticle(feed.id)}</span>
                  </div>
                  <select
                    class="move"
                    aria-label="Move {feedName(feed)} to folder"
                    value={feed.folderId ?? ""}
                    onchange={(event) => move(feed, event)}
                  >
                    {@render folderOptions()}
                  </select>
                  <button
                    type="button"
                    class="icon-button bell"
                    aria-label="Bell: {feedName(feed)}"
                    aria-pressed={belled}
                    title={belled ? "Turn off bell" : "Turn on bell"}
                    onclick={() => toggleBell(feed)}
                  >
                    <Icon name="bell" filled={belled} />
                  </button>
                  <button
                    type="button"
                    class="icon-button feed-menu"
                    aria-label="Feed options: {feedName(feed)}"
                    title="Feed options"
                    onclick={() => openMenu(feed)}
                  >
                    <Icon name="more" />
                  </button>
                </li>
              {:else}
                <li class="empty">このフォルダにはフィードがありません。</li>
              {/each}
            </ul>
          </div>
        </section>
      {/if}
    {/each}
  {/if}
</div>

<p class="notice" role="status">{notice}</p>
{#if message !== null && !menuOpen}
  <p class="error" role="alert">{message}</p>
{/if}

<Dialog
  bind:open={menuOpen}
  dismissible={!moving}
  title={selected === undefined ? "Feed options" : feedName(selected)}
>
  {#if selected !== undefined}
    {#if confirming}
      {#if selected.url === selected.siteUrl &&
        /^https:\/\/discord\.com\/channels\/\d+\/\d+$/.test(selected.url)}
        <p>このチャンネルの購読を解除すると、取り込んだ投稿がスター付きも含めて削除されます。</p>
      {:else}
        <p>このフィードの購読をやめますか？ スターを付けた記事だけが残ります。</p>
      {/if}
      <div class="actions">
        <button type="button" onclick={() => (confirming = false)}>Cancel</button>
        <button type="button" class="danger" onclick={unsubscribe}>Unsubscribe</button>
      </div>
    {:else}
      <p class="detail-latest-article">{@render latestArticle(selected.id)}</p>
      {#if menuOpen}
        {#if fetchTimes !== null}
          <dl class="fetch-times">
            <dt>Last checked</dt>
            <dd>{@render fetchTime(fetchTimes.lastFetchedAt)}</dd>
            <dt>Last successful fetch</dt>
            <dd>{@render fetchTime(fetchTimes.lastSuccessfulFetchAt)}</dd>
          </dl>
        {:else if fetchTimesStatus === "loading"}
          <p class="fetch-times-note" role="status">取得時刻を確認しています…</p>
        {/if}
        {#if fetchTimesStatus === "unavailable"}
          <p class="fetch-times-note" role="status">
            {fetchTimes === null
              ? "取得時刻を確認できませんでした。"
              : "取得時刻を更新できなかったため、前回の記録を表示しています。"}
          </p>
        {/if}
      {/if}
      <p class="url">{selected.url}</p>
      {#if reader.workspacesAvailable && selected.subscriptionId !== undefined}
        {#if movingWorkspace}
          <label for="workspace-destination">Workspace</label>
          <select id="workspace-destination" bind:value={workspaceDestination} disabled={moving}>
            <option value="">No workspace</option>
            {#each reader.workspaces as workspace (workspace.id)}
              <option value={workspace.id}>{workspace.name}</option>
            {/each}
          </select>
          <div class="actions">
            <button type="button" disabled={moving} onclick={() => (movingWorkspace = false)}>
              Cancel
            </button>
            <button
              type="button"
              disabled={moving || workspaceDestination === (selected.workspaceId ?? "")}
              onclick={() => selected && moveWorkspace(selected)}
            >
              Move feed
            </button>
          </div>
        {:else}
          <button type="button" onclick={() => (movingWorkspace = true)}>Move to workspace…</button>
        {/if}
      {/if}
      <div class="unsubscribe">
        <button
          type="button"
          class="link danger"
          disabled={moving}
          onclick={() => (confirming = true)}
        >
          Unsubscribe…
        </button>
      </div>
    {/if}
    {#if message !== null}
      <p class="error" role="alert">{message}</p>
    {/if}
  {/if}
</Dialog>

<style>
  .groups {
    display: grid;
    gap: 1.5rem;
  }

  .group-heading {
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: 0.5rem;
    padding-bottom: 0.5rem;
    border-bottom: 1px solid var(--border);
  }

  h2 {
    min-width: 0;
    margin: 0;
    font-size: 0.875rem;
    font-weight: 600;
  }

  .group-toggle {
    display: flex;
    align-items: center;
    gap: 0.5rem;
    max-width: 100%;
    padding: 0.375rem 0;
    border: 0;
    background: none;
    text-align: left;
    overflow-wrap: anywhere;
  }

  .count {
    color: var(--muted);
    font-size: 0.75rem;
    font-weight: 400;
    font-variant-numeric: tabular-nums;
  }

  ul {
    list-style: none;
    margin: 0;
    padding: 0;
  }

  .feed-row {
    display: flex;
    gap: 0.75rem;
    align-items: center;
    padding: 0.875rem 0.25rem;
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
    font-size: 0.875rem;
    font-weight: 600;
  }

  .name {
    flex: 1;
    min-width: 0;
  }

  .host {
    display: block;
    overflow-wrap: anywhere;
  }

  .host,
  .latest-article,
  .url {
    color: var(--muted);
    font-size: 0.75rem;
  }

  .latest-article {
    display: block;
    margin-top: 0.125rem;
  }

  .detail-latest-article {
    margin: 0;
    font-weight: 600;
  }

  .move {
    width: auto;
    max-width: 11rem;
    border-color: transparent;
    background: none;
    color: var(--muted);
    font-size: 0.75rem;
  }

  .move:hover,
  .move:focus-visible {
    border-color: var(--border-strong);
  }

  .empty {
    margin: 0;
    padding: 1.25rem 0.25rem;
    color: var(--muted);
    font-size: 0.875rem;
  }

  .empty-start {
    display: grid;
    justify-items: center;
    gap: 1rem;
    padding: 2rem 0;
    text-align: center;
    color: var(--muted);
  }

  .empty-start p {
    margin: 0;
    font-size: 0.875rem;
  }

  .url {
    overflow-wrap: anywhere;
  }

  .fetch-times {
    display: grid;
    grid-template-columns: minmax(0, 1fr) minmax(0, 1fr);
    gap: 0.375rem 0.75rem;
    font-size: 0.875rem;
  }

  .fetch-times dt,
  .fetch-times-note {
    color: var(--muted);
  }

  .fetch-times dd {
    margin: 0;
  }

  .fetch-times-note {
    font-size: 0.875rem;
  }

  .unsubscribe {
    border-top: 1px solid var(--border);
    margin-top: 1.25rem;
    padding-top: 1rem;
    font-size: 0.875rem;
  }

  .actions {
    display: flex;
    flex-wrap: wrap;
    justify-content: flex-end;
    gap: 0.5rem;
    margin-top: 1rem;
  }

  .danger,
  .error {
    color: var(--danger);
  }

  .notice {
    color: var(--muted);
    font-size: 0.875rem;
    margin: 0;
  }

  .notice:empty {
    display: none;
  }

  @media (max-width: 40rem) {
    .feed-row {
      display: grid;
      grid-template-columns: 2rem minmax(0, 1fr) auto auto;
      gap: 0.125rem 0.625rem;
    }

    .avatar {
      grid-row: 1 / 3;
    }

    .move {
      grid-column: 2;
      grid-row: 2;
      justify-self: start;
      max-width: 100%;
    }

    .bell {
      grid-column: 3;
      grid-row: 1 / 3;
    }

    .feed-menu {
      grid-column: 4;
      grid-row: 1 / 3;
    }
  }

  @media (pointer: coarse) {
    .group-toggle,
    .move {
      min-height: 2.75rem;
    }
  }
</style>
