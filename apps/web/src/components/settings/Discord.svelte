<script lang="ts">
  import {
    ApiError,
    type DiscordIntegration,
    type DiscordSubscription,
    toSafeHttpUrl,
  } from "@sendo-reader/core";
  import { onDestroy, onMount } from "svelte";
  import { account } from "../../lib/account";
  import { useReader } from "../../lib/context";
  import { DISCORD_UNAVAILABLE, describeDiscordError } from "../../lib/errors";
  import Dialog from "../Dialog.svelte";
  import Problem from "./Problem.svelte";

  let {
    confirm,
    result,
  }: {
    confirm: (signal?: AbortSignal) => Promise<void>;
    result: string | null;
  } = $props();

  const reader = useReader();
  const controller = new AbortController();
  const { signal } = controller;
  onDestroy(() => controller.abort());

  let integration = $state<DiscordIntegration | null>(null);
  let loadError = $state<unknown>(null);
  let actionError = $state<unknown>(null);
  let busy = $state(false);
  let redirecting = $state(false);
  let channelUrl = $state("");
  let confirming = $state(false);
  let target = $state<DiscordSubscription | null>(null);
  let notice = $state<string | null>(null);
  const outcomes = new Map([
    ["connected", "Discord を接続しました。"],
    ["access_denied", "Discord の接続をキャンセルしました。"],
    ["invalid_state", "Discord の接続を続けられませんでした。もう一度接続してください。"],
    [
      "already_connected",
      "別の Discord アカウントが接続されています。切り替えるには、先に連携を解除してください。",
    ],
    ["provider_error", "Discord との通信に失敗しました。少し待ってからやり直してください。"],
  ]);
  const outcome = $derived(
    result === null ? "" : (outcomes.get(result) ?? "Discord を接続できませんでした。"),
  );
  const inviteUrl = $derived(discordAuthorizationUrl(integration?.inviteUrl));

  function discordAuthorizationUrl(value: string | null | undefined): string | null {
    const safe = toSafeHttpUrl(value);
    if (safe === null) return null;
    const url = new URL(safe);
    return url.origin === "https://discord.com" && url.pathname === "/oauth2/authorize"
      ? safe
      : null;
  }

  async function load() {
    loadError = null;
    try {
      await confirm(signal);
      signal.throwIfAborted();
      integration = await account.getDiscord(signal);
    } catch (error) {
      if (!signal.aborted) loadError = error;
    }
  }

  onMount(() => {
    void load();
  });

  async function run(action: () => Promise<void>) {
    if (busy || redirecting) return;
    busy = true;
    actionError = null;
    notice = "";
    try {
      await confirm(signal);
      signal.throwIfAborted();
      await action();
    } catch (error) {
      if (signal.aborted) return;
      actionError = error;
      if (
        error instanceof ApiError &&
        ["discord_not_connected", "feature_unavailable"].includes(error.code ?? "")
      ) {
        await load();
      }
    } finally {
      busy = false;
    }
  }

  function connect() {
    return run(async () => {
      const url = discordAuthorizationUrl(await account.connectDiscord("/settings", signal));
      signal.throwIfAborted();
      if (url === null) throw new ApiError("server", "Discord の認可 URL の形式が違います");
      location.assign(url);
      redirecting = true;
    });
  }

  function onPageShow(event: PageTransitionEvent) {
    if (event.persisted && redirecting) {
      redirecting = false;
      void load();
    }
  }

  function sync() {
    void reader.client.syncNow().catch(() => {});
  }

  function subscribe(event: SubmitEvent) {
    event.preventDefault();
    const url = channelUrl.trim();
    if (url === "") return;
    return run(async () => {
      await account.subscribeDiscord(url, signal);
      sync();
      channelUrl = "";
      notice = "チャンネルを購読しました。";
      await load();
    });
  }

  function ask(subscription: DiscordSubscription | null) {
    target = subscription;
    actionError = null;
    confirming = true;
  }

  function remove() {
    const subscription = target;
    return run(async () => {
      if (subscription === null) {
        await account.disconnectDiscord(signal);
        channelUrl = "";
        notice = "Discord の連携を解除しました。";
      } else {
        await account.unsubscribeDiscord(subscription.feedId, signal);
        notice = "チャンネルの購読を解除しました。";
      }
      sync();
      await load();
      confirming = false;
    });
  }
</script>

<svelte:window onpageshow={onPageShow} />

<section class="integration" aria-label="Discord">
  <h2>Discord</h2>
  <p class="notice" role="status">
    {redirecting
      ? "Discord の認可画面に移っています…"
      : busy
        ? "処理しています…"
        : (notice ?? outcome)}
  </p>
  {#if actionError !== null && !confirming}
    <p class="error" role="alert">{describeDiscordError(actionError)}</p>
  {/if}
  {#if loadError !== null}
    <Problem error={loadError} retry={load} />
  {:else if integration === null}
    <p class="note" role="status">読み込んでいます…</p>
  {:else}
    {#if integration.available}
      {#if inviteUrl !== null}
        <p class="note">
          Discord サーバーの管理者が
          <a href={inviteUrl} target="_blank" rel="noopener noreferrer">Invite bot</a>
          から Bot を招待し、チャンネルの閲覧とメッセージ履歴の読み取りを許可してください。
        </p>
      {/if}
      {#if !integration.connected}
        <p class="note">Discord を接続すると、選んだチャンネルの新着が受信箱に届きます。</p>
        <div>
          <button type="button" class="primary" disabled={busy || redirecting} onclick={connect}>
            Connect Discord
          </button>
        </div>
      {:else}
        <form onsubmit={subscribe}>
          <label for="discord-channel-url">Channel URL</label>
          <div class="actions">
            <input
              id="discord-channel-url"
              type="url"
              bind:value={channelUrl}
              maxlength={256}
              required
              placeholder="https://discord.com/channels/…"
              disabled={busy}
            >
            <button type="submit" class="primary" disabled={busy || channelUrl.trim() === ""}>
              Subscribe
            </button>
          </div>
        </form>
      {/if}
    {:else if !(actionError instanceof ApiError && actionError.code === "feature_unavailable")}
      <p class="note">{DISCORD_UNAVAILABLE}</p>
    {/if}
    {#if integration.connected}
      <h3>Subscribed channels</h3>
      {#if integration.subscriptions.length === 0}
        <p class="note">購読中のチャンネルはありません。</p>
      {:else}
        <ul>
          {#each integration.subscriptions as subscription (subscription.feedId)}
            {@const href = toSafeHttpUrl(subscription.url)}
            <li class="actions">
              <span class="channel">
                {#if href !== null}
                  <a {href} target="_blank" rel="noopener noreferrer"
                    >{subscription.name ?? subscription.url}</a
                  >
                {:else}
                  {subscription.name ?? subscription.url}
                {/if}
              </span>
              <button type="button" disabled={busy} onclick={() => ask(subscription)}>
                Unsubscribe…
              </button>
            </li>
          {/each}
        </ul>
      {/if}
      <div>
        <button type="button" disabled={busy} onclick={() => ask(null)}>Disconnect Discord…</button>
      </div>
    {/if}
  {/if}
</section>

{#if confirming}
  <Dialog
    bind:open={confirming}
    title={target === null ? "Disconnect Discord" : "Unsubscribe"}
    dismissible={!busy}
  >
    {#if target === null}
      <p>
        Discord との連携を解除すると、すべての Discord
        チャンネルの購読が解除され、取り込んだ投稿がスター付きも含めて削除されます。
      </p>
    {:else}
      <p class="channel">
        「{target.name ??
          target.url}」の購読を解除すると、このチャンネルから取り込んだ投稿がスター付きも含めて削除されます。
      </p>
    {/if}
    {#if actionError !== null}
      <p class="error" role="alert">{describeDiscordError(actionError)}</p>
    {/if}
    <div class="actions confirm-actions">
      <button type="button" disabled={busy} onclick={() => (confirming = false)}>Cancel</button>
      <button type="button" class="danger" disabled={busy} onclick={remove}>
        {busy ? "処理しています…" : target === null ? "Disconnect" : "Unsubscribe"}
      </button>
    </div>
  </Dialog>
{/if}

<style>
  .integration,
  form,
  ul {
    display: grid;
    gap: 0.75rem;
  }

  h2,
  h3,
  p,
  ul {
    margin: 0;
  }

  h2 {
    font-size: 1rem;
  }

  h3,
  label,
  .note {
    font-size: 0.875rem;
  }

  ul {
    padding: 0;
    list-style: none;
  }

  .note {
    color: var(--muted);
  }

  .notice:empty {
    display: none;
  }

  .actions {
    display: flex;
    flex-wrap: wrap;
    align-items: center;
    gap: 0.5rem;
  }

  input {
    flex: 1;
    min-width: min(14rem, 100%);
  }

  .channel {
    flex: 1;
    overflow-wrap: anywhere;
    min-width: 0;
  }

  .error,
  .danger {
    color: var(--danger);
  }

  .confirm-actions {
    margin-top: 0.5rem;
  }
</style>
