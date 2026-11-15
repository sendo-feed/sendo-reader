<script lang="ts">
  import {
    ApiError,
    AuthorizationError,
    type AuthorizationRequest,
    type User,
  } from "@sendo-reader/core";
  import { onMount } from "svelte";
  import { account } from "../lib/account";
  import { AUTHORIZE_PATH, saveAuthorizeQuery, takeAuthorizeQuery } from "../lib/authorize";
  import { describeError } from "../lib/errors";
  import { truncate } from "../lib/format";
  import { goToSignIn } from "../lib/login";

  /**
   * OAuth の許可の画面（docs/decisions/account.md の 5、sendo の docs/decisions/mcp.md の 4）。
   *
   * sendo のセッションだけで動き、reader の手元のデータ（ログインしたユーザー、同期）は使わない。
   * 許可か拒否かは、毎回、利用者が押して決め、sendo が返したリダイレクト先へだけ移る。
   */
  type View =
    | { kind: "loading" }
    | { kind: "ready"; request: AuthorizationRequest; user: User }
    /** ログインしていない */
    | { kind: "signIn" }
    /** 認可のリクエストが正しくなく、クライアントに返す先もない。どこへも移らない */
    | { kind: "invalid"; message: string }
    /** sendo で OAuth を使う設定がない */
    | { kind: "disabled" }
    /** 認可のリクエストがない */
    | { kind: "missing" }
    /** 届かないなど。やり直せる */
    | { kind: "failed"; message: string }
    /** クライアントへ移っている */
    | { kind: "leaving" };

  const query = takeAuthorizeQuery(location.search);
  // ログインから戻ってきたら、置いておいたクエリを URL に戻す（読み込み直しても続けられるように）
  if (query !== null && location.search !== query) {
    history.replaceState(null, "", `${AUTHORIZE_PATH}${query}`);
  }

  let view = $state<View>(query === null ? { kind: "missing" } : { kind: "loading" });
  let busy = $state(false);
  let decideError = $state<string | null>(null);

  const SCOPES = {
    read: "購読、フォルダ、記事、未読の数を読む",
    write: "購読する・やめる、既読やスターを付けるなど、変更する",
  } as const;

  const INVALID: Record<string, string> = {
    invalid_client: "つなごうとしているアプリを確かめられませんでした。",
    invalid_redirect_uri: "許可したあとに戻る先が、アプリに登録されたものと違います。",
  };

  onMount(() => {
    void check();
  });

  async function check() {
    if (query === null) return;
    view = { kind: "loading" };
    try {
      const request = await account.checkAuthorization(query);
      // 許可するアカウントが分かるまで、許可の操作は出さない（分からなければ、やり直してもらう）
      const user = await account.me();
      view = { kind: "ready", request, user };
    } catch (error) {
      handle(error);
    }
  }

  async function decide(approved: boolean) {
    if (query === null || busy) return;
    busy = true;
    decideError = null;
    try {
      leave(await account.decideAuthorization(query, approved));
    } catch (error) {
      busy = false;
      // 届かないなどなら、この画面のまま、もう一度押せるようにする
      if (error instanceof ApiError && (error.kind === "network" || error.kind === "server")) {
        decideError = describeError(error);
      } else {
        handle(error);
      }
    }
  }

  function handle(error: unknown) {
    if (error instanceof AuthorizationError) {
      if (error.redirectTo !== null) {
        // 誤りをクライアントに返す（sendo が返した先へだけ移る）
        leave(error.redirectTo);
      } else {
        view = {
          kind: "invalid",
          message: INVALID[error.code] ?? "許可のリクエストが正しくありません。",
        };
      }
    } else if (error instanceof ApiError && error.kind === "unauthorized") {
      view = { kind: "signIn" };
    } else if (error instanceof ApiError && error.code === "oauth_disabled") {
      view = { kind: "disabled" };
    } else {
      view = { kind: "failed", message: describeError(error) };
    }
  }

  function leave(url: string) {
    view = { kind: "leaving" };
    location.assign(url);
  }

  /** ログインに回し、この画面に戻す（クエリは、そのタブの sessionStorage に置く） */
  function signIn() {
    if (query === null) return;
    saveAuthorizeQuery(query);
    goToSignIn(AUTHORIZE_PATH);
  }
</script>

<main class="authorize">
  {#if view.kind === "ready"}
    {@const client = view.request.client}
    <h1>sendo へのアクセスを許可しますか？</h1>
    <p class="lead">
      <strong class="client">{truncate(client.name ?? client.id)}</strong>
      が、あなたの sendo を使おうとしています。
    </p>
    {#if client.kind === "registered"}
      <p class="warn">この名前は、アプリが名乗ったもので、sendo は確かめていません。</p>
    {/if}
    <dl>
      {#if client.host !== null}
        <dt>アプリ</dt>
        <dd>{truncate(client.host)}</dd>
      {/if}
      <dt>許可したあとに戻る先</dt>
      <dd>{truncate(view.request.redirectHost)}</dd>
      <dt>許可すること</dt>
      <dd>
        <ul>
          {#each view.request.scopes as scope (scope)}
            <li>{SCOPES[scope]}</li>
          {/each}
        </ul>
      </dd>
      <dt>許可するアカウント</dt>
      <dd>{view.user.email}</dd>
    </dl>
    {#if view.request.loopbackRedirect}
      <p class="warn">
        戻る先は、この端末（{truncate(
          view.request.redirectHost,
        )}）です。この端末で動いているほかのアプリも、許可を受け取れます。心当たりがなければ、拒否してください。
      </p>
    {/if}
    <p class="hint">許可は、あとから設定の画面で取り消せます。</p>
    <div class="actions">
      <button type="button" class="primary" onclick={() => decide(true)} disabled={busy}>
        許可する
      </button>
      <button type="button" onclick={() => decide(false)} disabled={busy}>拒否する</button>
    </div>
    {#if decideError !== null}
      <p class="error" role="alert">{decideError}</p>
    {/if}
  {:else}
    <h1>sendo へのアクセスの許可</h1>
    {#if view.kind === "loading"}
      <p class="hint" aria-live="polite">確かめています…</p>
    {:else if view.kind === "leaving"}
      <p class="hint" aria-live="polite">アプリに戻っています…</p>
    {:else if view.kind === "signIn"}
      <p>許可するには、sendo にログインしてください。ログインしたら、この画面に戻ります。</p>
      <div class="actions">
        <button type="button" class="primary" onclick={signIn}>ログインして続ける</button>
      </div>
    {:else if view.kind === "invalid"}
      <p class="error" role="alert">{view.message}</p>
      <p class="hint">つなごうとしたアプリに戻って、やり直してください。</p>
    {:else if view.kind === "disabled"}
      <p class="error" role="alert">この sendo では、OAuth でつなぐ設定がされていません。</p>
      <p class="hint">MCP 用のトークンを、sendo-reader の設定の画面で発行して使ってください。</p>
    {:else if view.kind === "missing"}
      <p class="error" role="alert">許可のリクエストがありません。</p>
      <p class="hint">つなごうとしたアプリから、もう一度始めてください。</p>
    {:else if view.kind === "failed"}
      <p class="error" role="alert">{view.message}</p>
      <div class="actions">
        <button type="button" onclick={check}>やり直す</button>
      </div>
    {/if}
  {/if}
</main>

<style>
  .authorize {
    display: grid;
    gap: 0.75rem;
    max-width: 32rem;
    margin: 3rem auto;
    padding: 0 1rem 3rem;
  }

  h1 {
    margin: 0;
    font-size: 1.4rem;
  }

  p {
    margin: 0;
  }

  .client {
    overflow-wrap: anywhere;
  }

  dl {
    display: grid;
    grid-template-columns: max-content 1fr;
    gap: 0.25rem 1rem;
    margin: 0;
  }

  dt {
    color: var(--muted);
  }

  dd {
    margin: 0;
    overflow-wrap: anywhere;
  }

  ul {
    margin: 0;
    padding-left: 1.25rem;
  }

  .warn {
    padding: 0.5rem 0.75rem;
    border-left: 3px solid var(--danger);
    background: var(--surface);
  }

  .hint {
    color: var(--muted);
    font-size: 0.9rem;
  }

  .actions {
    display: flex;
    flex-wrap: wrap;
    gap: 0.5rem;
  }

  .primary {
    font-weight: 600;
  }

  .error {
    color: var(--danger);
  }
</style>
