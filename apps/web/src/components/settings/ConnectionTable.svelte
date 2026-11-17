<script lang="ts">
  import { ApiError } from "@sendo-reader/core";
  import { onDestroy, type Snippet, tick } from "svelte";
  import { AccountChangedError } from "../../lib/account";
  import { describeError } from "../../lib/errors";
  import { formatDateTime, truncate } from "../../lib/format";
  import Dialog from "../Dialog.svelte";
  import type { ConnectionRow } from "./connection";
  import Problem from "./Problem.svelte";

  let {
    title,
    kind,
    rows,
    loadError,
    reload,
    confirm,
    revoke,
    onremoved,
    actions,
  }: {
    title: string;
    kind: "tokens" | "grants";
    rows: readonly ConnectionRow[] | null;
    loadError: unknown;
    reload: () => Promise<void>;
    confirm: (signal?: AbortSignal) => Promise<void>;
    revoke: (id: string, signal: AbortSignal) => Promise<void>;
    onremoved: (ids: readonly string[]) => void;
    actions?: Snippet<[boolean]>;
  } = $props();

  const controller = new AbortController();
  onDestroy(() => controller.abort());
  let selected = $state<string[]>([]);
  const chosen = $derived(rows?.filter((row) => selected.includes(row.id)) ?? []);
  const allSelected = $derived(rows !== null && rows.length > 0 && chosen.length === rows.length);
  let confirming = $state(false);
  let targets = $state<ConnectionRow[]>([]);
  let busy = $state(false);
  let completed = $state(0);
  let error = $state<unknown>(null);
  let status = $state("");
  let heading = $state<HTMLHeadingElement>();

  function toggle(id: string, checked: boolean) {
    selected = checked ? [...selected, id] : selected.filter((value) => value !== id);
  }

  function ask() {
    targets = [...chosen];
    error = null;
    confirming = true;
  }

  /**
   * 確認した項目だけを順に送る。各送信の前にセッションを確かめ、成功したものだけを一覧から外す。
   * 途中で届かなくなったときやアカウントが替わったときは止め、未処理・失敗したものを残す。
   */
  async function revokeChosen() {
    if (busy || targets.length === 0) return;
    busy = true;
    error = null;
    status = "";
    completed = 0;
    const removed = new Set<string>();
    const current = [...targets];
    try {
      for (const row of current) {
        if (controller.signal.aborted) return;
        try {
          await confirm(controller.signal);
        } catch (failure) {
          error ??= failure;
          break;
        }
        if (controller.signal.aborted) return;
        try {
          await revoke(row.id, controller.signal);
        } catch (failure) {
          if (controller.signal.aborted) return;
          // 別の画面ですでに取り消されていても、目的は達成している
          if (!(failure instanceof ApiError && failure.kind === "not_found")) {
            error ??= failure;
            if (
              failure instanceof AccountChangedError ||
              (failure instanceof ApiError &&
                (failure.kind === "unauthorized" || failure.kind === "network"))
            )
              break;
            continue;
          }
        }
        if (controller.signal.aborted) return;
        removed.add(row.id);
        completed += 1;
        selected = selected.filter((id) => id !== row.id);
        onremoved([row.id]);
      }
      if (controller.signal.aborted) return;
      targets = current.filter((row) => !removed.has(row.id));
      if (targets.length === 0) {
        confirming = false;
        status = `${removed.size}件を取り消しました。`;
        await tick();
        // 選択がなくなると Revoke ボタンも消えるので、一覧の見出しに戻す
        heading?.focus({ preventScroll: true });
      }
    } finally {
      busy = false;
    }
  }
</script>

<section class="connections" aria-label={title}>
  <header class="section-header">
    <h2 bind:this={heading} tabindex="-1">
      {title}
      {#if rows !== null}
        <span class="count">{rows.length}</span>
      {/if}
    </h2>
    <div class="actions">
      {#if chosen.length > 0}
        <button type="button" class="link" disabled={busy} onclick={() => (selected = [])}>
          Clear
        </button>
        <button type="button" class="revoke" disabled={busy} onclick={ask}>
          Revoke {chosen.length}…
        </button>
      {/if}
      {#if actions}
        {@render actions(busy)}
      {/if}
    </div>
  </header>
  {#if loadError !== null}
    <Problem error={loadError} retry={reload} />
  {:else if rows === null}
    <p class="muted" role="status">読み込んでいます…</p>
  {:else if rows.length === 0}
    <p class="muted">
      {kind === "tokens"
        ? "発行したトークンはまだありません。"
        : "許可したクライアントはまだありません。"}
    </p>
  {:else}
    <table aria-label={title}>
      <thead>
        <tr>
          <th class="select" scope="col">
            <label class="selection">
              <input
                type="checkbox"
                aria-label={kind === "tokens"
                  ? "Select all access tokens"
                  : "Select all connected apps"}
                checked={allSelected}
                indeterminate={chosen.length > 0 && !allSelected}
                disabled={busy}
                onchange={(event) =>
                  (selected = event.currentTarget.checked ? rows.map((row) => row.id) : [])}
              >
              <span class="mobile-select-label" aria-hidden="true">Select all</span>
            </label>
          </th>
          <th scope="col" class="name">Name</th>
          <th scope="col" class="access">Access</th>
          <th scope="col" class="date">Last used</th>
          <th scope="col" class="date">{kind === "tokens" ? "Created" : "Authorized"}</th>
        </tr>
      </thead>
      <tbody>
        {#each rows as row (row.id)}
          <tr class:selected={selected.includes(row.id)}>
            <td class="select">
              <label class="selection">
                <input
                  type="checkbox"
                  aria-label={`Select ${truncate(row.name)}`}
                  checked={selected.includes(row.id)}
                  disabled={busy}
                  onchange={(event) => toggle(row.id, event.currentTarget.checked)}
                >
              </label>
            </td>
            <td class="name">
              <span>{truncate(row.name)}</span>
              {#if row.detail}
                <span class="detail">{truncate(row.detail)}</span>
              {/if}
              {#if row.note}
                <span class="detail">{row.note}</span>
              {/if}
            </td>
            <td class="access">{row.access}</td>
            <td class="date last" data-label="Last used">
              {#if row.lastUsedAt === null}
                Never
              {:else}
                <time datetime={new Date(row.lastUsedAt).toISOString()}
                  >{formatDateTime(row.lastUsedAt)}</time
                >
              {/if}
            </td>
            <td class="date created" data-label={kind === "tokens" ? "Created" : "Authorized"}>
              <time datetime={new Date(row.createdAt).toISOString()}
                >{formatDateTime(row.createdAt)}</time
              >
            </td>
          </tr>
        {/each}
      </tbody>
    </table>
  {/if}
  {#if status}
    <p class="muted" role="status">{status}</p>
  {/if}
</section>

{#if confirming}
  <Dialog
    bind:open={confirming}
    title={kind === "tokens" ? "Revoke tokens" : "Revoke connections"}
    dismissible={!busy}
  >
    <div class="confirmation">
      <ul>
        {#each targets as row (row.id)}
          <li>
            {truncate(row.name)}
            {#if row.detail}
              <span class="detail">{truncate(row.detail)}</span>
            {/if}
          </li>
        {/each}
      </ul>
      <p>
        {kind === "tokens"
          ? "選んだトークンはすぐに使えなくなります。元には戻せません。"
          : "選んだアプリからの接続がすぐに使えなくなります。再接続には、もう一度許可が必要です。"}
      </p>
      {#if busy}
        <p class="muted" role="status">取り消しています… {completed} / {targets.length}</p>
      {/if}
      {#if error !== null}
        <div role="alert" class="failure">
          <p>{targets.length}件を取り消せませんでした。選択を残しています。</p>
          <p>{describeError(error)}</p>
        </div>
      {/if}
      <div class="dialog-actions">
        <button type="button" disabled={busy} onclick={() => (confirming = false)}>Cancel</button>
        <button type="button" class="danger" disabled={busy} onclick={revokeChosen}>
          Revoke {targets.length}
        </button>
      </div>
    </div>
  </Dialog>
{/if}

<style>
  .connections {
    min-width: 0;
    container-type: inline-size;
  }
  .section-header {
    display: flex;
    align-items: center;
    justify-content: space-between;
    flex-wrap: wrap;
    gap: 0.5rem 1rem;
    margin-bottom: 0.75rem;
  }
  h2 {
    margin: 0;
    font-size: 1.125rem;
  }
  .count {
    color: var(--muted);
    font-weight: 400;
    font-size: 0.875rem;
  }
  .actions,
  .dialog-actions {
    display: flex;
    align-items: center;
    flex-wrap: wrap;
    gap: 0.5rem;
  }
  .danger {
    background: var(--danger);
    border-color: var(--danger);
    color: var(--background);
  }
  .revoke {
    color: var(--danger);
  }
  table {
    width: 100%;
    table-layout: fixed;
    border-collapse: collapse;
    font-size: 0.875rem;
  }
  th,
  td {
    text-align: left;
    border-bottom: 1px solid var(--border);
    padding: 0.65rem 0.5rem;
    vertical-align: middle;
    overflow-wrap: anywhere;
  }
  th {
    color: var(--muted);
    font-weight: 400;
    font-size: 0.75rem;
  }
  .select {
    width: 2.25rem;
    padding: 0;
  }
  .name {
    width: 27%;
  }
  .access {
    width: 23%;
  }
  .date {
    font-variant-numeric: tabular-nums;
  }
  .selection {
    display: flex;
    align-items: center;
    justify-content: center;
    min-height: 2.25rem;
    cursor: pointer;
  }
  input {
    width: 1rem;
    height: 1rem;
    margin: 0;
    accent-color: var(--accent);
  }
  tr.selected {
    background: var(--selected);
  }
  .detail {
    display: block;
    color: var(--muted);
    font-size: 0.8125rem;
    font-weight: 400;
  }
  .muted {
    margin: 0;
    color: var(--muted);
    font-size: 0.875rem;
  }
  .confirmation {
    display: grid;
    gap: 1rem;
  }
  .confirmation p {
    margin: 0;
    overflow-wrap: anywhere;
  }
  ul {
    margin: 0;
    padding-left: 1.25rem;
  }
  li {
    overflow-wrap: anywhere;
  }
  .failure {
    display: grid;
    gap: 0.25rem;
    color: var(--danger);
  }
  .dialog-actions {
    justify-content: flex-end;
  }
  .mobile-select-label {
    display: none;
  }
  @container (max-width: 36rem) {
    thead,
    thead tr {
      display: block;
    }
    thead th.select {
      display: block;
      width: auto;
    }
    thead .selection {
      display: grid;
      grid-template-columns: 2.25rem minmax(0, 1fr);
      gap: 0.5rem;
    }
    thead input {
      justify-self: center;
    }
    .mobile-select-label {
      display: inline;
    }
    thead th:not(.select) {
      position: absolute;
      width: 1px;
      height: 1px;
      overflow: hidden;
      clip-path: inset(50%);
    }
    tbody {
      display: block;
    }
    tbody tr {
      display: grid;
      grid-template-columns: 2.25rem minmax(0, 1fr);
      gap: 0.2rem 0.5rem;
      padding: 0.75rem 0;
      border-bottom: 1px solid var(--border);
    }
    td {
      width: auto;
      padding: 0;
      border: 0;
    }
    td.select {
      grid-column: 1;
      grid-row: 1 / span 4;
    }
    td.name,
    td.access,
    td.date {
      grid-column: 2;
      width: auto;
    }
    .date::before {
      content: attr(data-label) " ";
      color: var(--muted);
    }
    .date,
    .access {
      font-size: 0.8125rem;
    }
  }
  @media (pointer: coarse) {
    .selection {
      min-height: 2.75rem;
    }
  }
</style>
