<script lang="ts">
  import {
    type AccessToken,
    type IssuedAccessToken,
    MAX_TOKEN_NAME_LENGTH,
    type TokenPurpose,
  } from "@sendo-reader/core";
  import { onDestroy } from "svelte";
  import { account } from "../../lib/account";
  import { describeError } from "../../lib/errors";
  import { truncate } from "../../lib/format";
  import Dialog from "../Dialog.svelte";

  let {
    open = $bindable(true),
    confirm,
    oncreated,
  }: {
    open?: boolean;
    confirm: (signal?: AbortSignal) => Promise<void>;
    oncreated: (token: AccessToken) => void;
  } = $props();

  const fieldId = $props.id();
  const controller = new AbortController();
  onDestroy(() => controller.abort());
  let name = $state("");
  let purpose = $state<TokenPurpose>("reader");
  let write = $state(false);
  let busy = $state(false);
  let message = $state<string | null>(null);
  // 中身はこの窓にだけ持つ。閉じたら部品ごと捨て、再表示も保存もしない。
  let issued = $state<IssuedAccessToken | null>(null);
  let copied = $state(false);

  async function create(event: SubmitEvent) {
    event.preventDefault();
    if (busy || name.trim() === "") return;
    busy = true;
    message = null;
    try {
      await confirm(controller.signal);
      if (controller.signal.aborted) return;
      const result = await account.createToken(
        {
          name: name.trim(),
          purpose,
          ...(purpose === "mcp" ? { scopes: write ? ["read", "write"] : ["read"] } : {}),
        },
        controller.signal,
      );
      if (controller.signal.aborted) return;
      issued = result;
      oncreated(result.accessToken);
    } catch (error) {
      if (!controller.signal.aborted) message = describeError(error);
    } finally {
      busy = false;
    }
  }

  async function copy() {
    if (issued === null) return;
    try {
      await navigator.clipboard.writeText(issued.secret);
      copied = true;
    } catch {
      message = "コピーできませんでした。選んでコピーしてください。";
    }
  }
</script>

<Dialog bind:open title={issued === null ? "New token" : "Token created"} dismissible={!busy}>
  {#if issued !== null}
    <div class="issued">
      <p>
        「{truncate(
          issued.accessToken.name,
        )}」を発行しました。トークンは一度だけ表示します。コピーしてから閉じてください。
      </p>
      <code class="secret">{issued.secret}</code>
      <div class="actions">
        <button type="button" onclick={copy}>{copied ? "Copied" : "Copy"}</button>
        <button type="button" class="primary" onclick={() => (open = false)}>Done</button>
      </div>
    </div>
  {:else}
    <form onsubmit={create}>
      <div class="field">
        <label for={`${fieldId}-name`}>Name</label>
        <input
          id={`${fieldId}-name`}
          bind:value={name}
          maxlength={MAX_TOKEN_NAME_LENGTH}
          placeholder="Reeder（iPhone）"
          disabled={busy}
          required
        >
      </div>
      <div class="field">
        <label for={`${fieldId}-purpose`}>Use with</label>
        <select id={`${fieldId}-purpose`} bind:value={purpose} disabled={busy}>
          <option value="reader">Reader app</option>
          <option value="mcp">MCP client</option>
        </select>
      </div>
      <p class="hint">
        {purpose === "reader"
          ? "Reeder や NetNewsWire のパスワード欄に入れます。"
          : "Claude Code などのMCPクライアントで使います（sendo の /mcp 専用）。"}
      </p>
      {#if purpose === "mcp"}
        <div class="field">
          <label for={`${fieldId}-access`}>Access</label>
          <select id={`${fieldId}-access`} bind:value={write} disabled={busy}>
            <option value={false}>Read only</option>
            <option value={true}>Read &amp; write</option>
          </select>
        </div>
        <p class="hint">Read &amp; write は、購読や既読などの変更も許可します。</p>
      {/if}
      <div class="actions">
        <button type="button" disabled={busy} onclick={() => (open = false)}>Cancel</button>
        <button type="submit" class="primary" disabled={busy || name.trim() === ""}>
          {busy ? "Creating…" : "Create token"}
        </button>
      </div>
    </form>
  {/if}
  {#if message !== null}
    <p class="error" role="alert">{message}</p>
  {/if}
</Dialog>

<style>
  form,
  .issued {
    display: grid;
    gap: 0.75rem;
  }
  .field {
    display: grid;
    gap: 0.3rem;
  }
  input,
  select {
    width: 100%;
    min-width: 0;
  }
  p {
    margin: 0;
  }
  .hint {
    color: var(--muted);
    font-size: 0.875rem;
  }
  .actions {
    display: flex;
    flex-wrap: wrap;
    justify-content: flex-end;
    gap: 0.5rem;
    margin-top: 0.5rem;
  }
  .secret {
    padding: 0.75rem;
    border-radius: var(--radius-small);
    background: var(--surface);
    word-break: break-all;
    user-select: all;
  }
  .error {
    margin-top: 0.75rem;
    color: var(--danger);
  }
</style>
