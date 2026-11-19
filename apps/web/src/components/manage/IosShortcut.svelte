<script lang="ts">
  import { capturePrefixFor } from "../../lib/bookmarklet";

  /**
   * iPhone のショートカット App で「Add to Sendo」を作る手順。iPhone の Safari は PWA の共有先に
   * 対応していないので、ショートカットを共有シートに出して、追加画面を開く。開く先は reader ごとに
   * 違うので、このサイトの URL を手順に埋めて出す（ブックマークレットと同じ形で渡す）
   */
  const prefix = capturePrefixFor(location.origin);

  let notice = $state("");
  let field = $state<HTMLInputElement>();

  async function copy() {
    try {
      await navigator.clipboard.writeText(prefix);
      notice = "コピーしました。";
    } catch {
      field?.focus();
      field?.select();
      notice = "選択した文字列をコピーしてください。";
    }
  }
</script>

<section>
  <p>
    ショートカット App で「Add to Sendo」を一度作っておくと、Safari
    やほかのアプリの共有から、見ているページを Sendo に追加できます。
  </p>

  <h3>作り方</h3>
  <ol>
    <li>
      ショートカット App を開き、右上の「+」で新しいショートカットを作ります。名前は「Add to
      Sendo」にします。
    </li>
    <li>
      下の「ⓘ」（詳細）で「共有シートに表示」をオンにします。受け取る種類は「URL」と「Safari Web
      ページ」にします。
    </li>
    <li>
      「URL エンコード」のアクションを足し、エンコードするものに「ショートカットの入力」を選びます。
    </li>
    <li>
      「URL」のアクションを足し、下の文字列を貼り付けます。その後ろに、変数で「URL
      エンコード」の結果を入れます。
      <div class="copy">
        <input
          aria-label="Shortcut URL"
          readonly
          value={prefix}
          bind:this={field}
          onfocus={(event) => event.currentTarget.select()}
        >
        <button type="button" onclick={copy}>Copy</button>
      </div>
      {#if notice !== ""}
        <p role="status">{notice}</p>
      {/if}
    </li>
    <li>「URL を開く」のアクションを足します（開くものは、前の「URL」）。</li>
  </ol>

  <h3>使い方</h3>
  <p>
    追加したいページで共有を押し、一覧から「Add to Sendo」を選びます。Sendo の追加画面が Safari
    で開くので、購読するか、Saved に残すかを選びます。
  </p>
  <p>
    ホーム画面の Sendo と Safari では、ログインが別々です。初めて使うときは、Safari
    でもログインしてください。Saved に残したページは、同期でホーム画面の Sendo にも届きます。
  </p>
</section>

<style>
  section {
    display: grid;
    /* 入力欄の幅で、列が窓より広がらないようにする */
    grid-template-columns: minmax(0, 1fr);
    gap: 0.75rem;
    max-width: 34rem;
  }

  h3 {
    margin: 0.5rem 0 0;
    font-size: 1rem;
  }

  p {
    margin: 0;
    color: var(--muted);
    font-size: 0.875rem;
    line-height: 1.6;
  }

  ol {
    display: grid;
    grid-template-columns: minmax(0, 1fr);
    gap: 0.625rem;
    margin: 0;
    padding-left: 1.5rem;
    font-size: 0.9375rem;
    line-height: 1.6;
  }

  .copy {
    display: flex;
    gap: 0.5rem;
    margin-top: 0.5rem;
  }

  .copy input {
    flex: 1;
    min-width: 0;
    font-family: ui-monospace, monospace;
    /* iPhone で、押したときに拡大しない大きさにする */
    font-size: max(16px, 0.8125rem);
  }

  li p {
    margin-top: 0.25rem;
  }
</style>
