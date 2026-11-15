<script lang="ts">
  import {
    type AccessToken,
    type IssuedAccessToken,
    MAX_TOKEN_NAME_LENGTH,
    type TokenPurpose,
  } from "@sendo-reader/core";
  import { onDestroy, onMount } from "svelte";
  import { account, describeScopes, PURPOSE_LABELS } from "../../lib/account";
  import { describeError } from "../../lib/errors";
  import { formatDateTime, truncate } from "../../lib/format";
  import Problem from "./Problem.svelte";

  /** 画面を離れたら、読み込みや送信を止める */
  const controller = new AbortController();
  onDestroy(() => controller.abort());

  /** null は読み込み中 */
  let tokens = $state<AccessToken[] | null>(null);
  let loadError = $state<unknown>(null);
  let name = $state("");
  let purpose = $state<TokenPurpose>("reader");
  let write = $state(false);
  let busy = $state(false);
  let message = $state<string | null>(null);
  /**
   * 発行したばかりのトークン。中身はここにだけ持ち、閉じたら（画面を離れたら）消える。
   * どこにも保存しない（docs/decisions/account.md の 4）
   */
  let issued = $state<IssuedAccessToken | null>(null);
  let copied = $state(false);
  /** 取り消す前に、もう一度押してもらうトークン */
  let confirming = $state<string | null>(null);

  async function load() {
    loadError = null;
    try {
      tokens = await account.listTokens(controller.signal);
    } catch (error) {
      if (!controller.signal.aborted) loadError = error;
    }
  }

  onMount(() => {
    void load();
  });

  async function create(event: SubmitEvent) {
    event.preventDefault();
    busy = true;
    message = null;
    try {
      issued = await account.createToken(
        {
          name: name.trim(),
          purpose,
          ...(purpose === "mcp" ? { scopes: write ? ["read", "write"] : ["read"] } : {}),
        },
        controller.signal,
      );
      copied = false;
      name = "";
      await load();
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

  function closeIssued() {
    issued = null;
    copied = false;
  }

  async function revoke(token: AccessToken) {
    if (confirming !== token.id) {
      confirming = token.id;
      return;
    }
    confirming = null;
    message = null;
    try {
      await account.revokeToken(token.id, controller.signal);
      await load();
    } catch (error) {
      if (!controller.signal.aborted) message = describeError(error);
    }
  }
</script>

<section>
  <h2>アクセストークン</h2>
  <p class="hint">
    リーダーアプリ用は、Reeder や NetNewsWire のパスワードの欄に入れます。MCP 用は、Claude Code
    などの MCP のクライアントに入れます（sendo の /mcp でだけ使えます）。
  </p>

  {#if issued !== null}
    <div class="issued" role="status">
      <p>
        <strong>「{truncate(issued.accessToken.name)}」を発行しました。</strong>
        トークンは今しか出しません。控えてから閉じてください。
      </p>
      <code class="secret">{issued.secret}</code>
      <div class="row">
        <button type="button" onclick={copy}>{copied ? "コピーしました" : "コピー"}</button>
        <button type="button" onclick={closeIssued}>控えたので閉じる</button>
      </div>
    </div>
  {/if}

  <form onsubmit={create}>
    <label>
      名前
      <input
        bind:value={name}
        maxlength={MAX_TOKEN_NAME_LENGTH}
        placeholder="Reeder（iPhone）"
        disabled={busy}
      >
    </label>
    <label>
      用途
      <select bind:value={purpose} disabled={busy}>
        <option value="reader">{PURPOSE_LABELS.reader}（Reeder、NetNewsWire など）</option>
        <option value="mcp">{PURPOSE_LABELS.mcp}（Claude Code など）</option>
      </select>
    </label>
    {#if purpose === "mcp"}
      <label class="check">
        <input type="checkbox" bind:checked={write} disabled={busy}>
        購読や既読などの変更も許す（外すと、読むだけ）
      </label>
    {/if}
    <button type="submit" disabled={busy || name.trim() === ""}>
      {busy ? "発行しています…" : "発行する"}
    </button>
  </form>

  {#if loadError !== null}
    <Problem error={loadError} retry={load} />
  {:else if tokens === null}
    <p class="hint" aria-live="polite">読み込んでいます…</p>
  {:else}
    <ul>
      {#each tokens as token (token.id)}
        <li>
          <div class="about">
            <span class="name">{truncate(token.name)}</span>
            <span class="meta">
              {PURPOSE_LABELS[token.purpose]}{token.purpose === "mcp"
                ? `・${describeScopes(token.scopes)}`
                : ""}
              ／ 作った日時：{formatDateTime(token.createdAt)}
              ／ 最後に使った日時：{token.lastUsedAt === null
                ? "まだ使っていない"
                : formatDateTime(token.lastUsedAt)}
            </span>
          </div>
          <button type="button" onclick={() => revoke(token)}>
            {confirming === token.id ? "本当に取り消す" : "取り消す"}
          </button>
        </li>
      {:else}
        <li class="empty">発行したトークンはまだありません。</li>
      {/each}
    </ul>
    <p class="hint">取り消したトークンは、すぐに使えなくなります。</p>
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

  form {
    display: grid;
    gap: 0.5rem;
    justify-items: start;
  }

  label {
    display: grid;
    gap: 0.25rem;
  }

  .check {
    display: flex;
    gap: 0.5rem;
    align-items: center;
  }

  .issued {
    display: grid;
    gap: 0.5rem;
    padding: 0.75rem;
    border: 1px solid var(--accent);
    border-radius: 0.5rem;
  }

  .issued p {
    margin: 0;
  }

  .secret {
    padding: 0.5rem;
    border-radius: 0.375rem;
    background: var(--surface);
    word-break: break-all;
    user-select: all;
  }

  .row {
    display: flex;
    flex-wrap: wrap;
    gap: 0.5rem;
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
