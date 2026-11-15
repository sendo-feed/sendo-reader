<script lang="ts">
  import type { OAuthGrant } from "@sendo-reader/core";
  import { onDestroy, onMount } from "svelte";
  import { account, describeScopes } from "../../lib/account";
  import { describeError } from "../../lib/errors";
  import { formatDateTime, truncate } from "../../lib/format";
  import Problem from "./Problem.svelte";

  const controller = new AbortController();
  onDestroy(() => controller.abort());

  /** null は読み込み中 */
  let grants = $state<OAuthGrant[] | null>(null);
  let loadError = $state<unknown>(null);
  let message = $state<string | null>(null);
  /** 取り消す前に、もう一度押してもらう許可 */
  let confirming = $state<string | null>(null);

  async function load() {
    loadError = null;
    try {
      grants = await account.listGrants(controller.signal);
    } catch (error) {
      if (!controller.signal.aborted) loadError = error;
    }
  }

  onMount(() => {
    void load();
  });

  /** クライアントの ID が URL なら、そのホスト（なりすましを見分ける手がかり） */
  function clientHost(grant: OAuthGrant): string | null {
    if (grant.clientKind !== "metadata_document") return null;
    try {
      return new URL(grant.clientId).host;
    } catch {
      return null;
    }
  }

  async function revoke(grant: OAuthGrant) {
    if (confirming !== grant.id) {
      confirming = grant.id;
      return;
    }
    confirming = null;
    message = null;
    try {
      await account.revokeGrant(grant.id, controller.signal);
      await load();
    } catch (error) {
      if (!controller.signal.aborted) message = describeError(error);
    }
  }
</script>

<section>
  <h2>OAuth で許可したクライアント</h2>
  <p class="hint">Claude.ai や ChatGPT などから sendo につなぐと、ここに出ます。</p>

  {#if loadError !== null}
    <Problem error={loadError} retry={load} />
  {:else if grants === null}
    <p class="hint" aria-live="polite">読み込んでいます…</p>
  {:else}
    <ul>
      {#each grants as grant (grant.id)}
        {@const host = clientHost(grant)}
        <li>
          <div class="about">
            <span class="name">
              {truncate(grant.clientName ?? grant.clientId)}
              {#if grant.clientKind === "registered"}
                <span class="note">（クライアントが名乗った名前）</span>
              {/if}
            </span>
            <span class="meta">
              {#if host !== null}
                {truncate(host)}
                ／
              {/if}
              {describeScopes(grant.scopes)}
              ／
              許可した日時：{formatDateTime(grant.createdAt)}
              ／ 最後に使った日時：{grant.lastUsedAt === null
                ? "まだ使っていない"
                : formatDateTime(grant.lastUsedAt)}
            </span>
          </div>
          <button type="button" onclick={() => revoke(grant)}>
            {confirming === grant.id ? "本当に取り消す" : "取り消す"}
          </button>
        </li>
      {:else}
        <li class="empty">許可したクライアントはまだありません。</li>
      {/each}
    </ul>
    <p class="hint">取り消すと、そのクライアントはすぐに使えなくなります。</p>
  {/if}
  {#if message !== null}
    <p class="error" role="alert">{message}</p>
  {/if}
</section>

<style>
  section {
    display: grid;
    gap: 0.75rem;
  }

  h2 {
    margin: 0;
    font-size: 1.15rem;
  }

  ul {
    list-style: none;
    margin: 0;
    padding: 0;
    display: grid;
    gap: 0.5rem;
  }

  li {
    display: flex;
    flex-wrap: wrap;
    gap: 0.5rem;
    align-items: center;
    justify-content: space-between;
  }

  .about {
    display: grid;
    min-width: 0;
  }

  .name {
    overflow-wrap: anywhere;
  }

  .note,
  .meta,
  .empty,
  .hint {
    margin: 0;
    color: var(--muted);
    font-size: 0.85rem;
  }

  .error {
    margin: 0;
    color: var(--danger);
  }
</style>
