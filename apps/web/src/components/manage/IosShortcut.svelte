<script lang="ts">
  import { capturePrefixFor } from "../../lib/bookmarklet";

  /**
   * iPhone のショートカット App で「Add to Sendo」を作ってもらう案内。iPhone の Safari は PWA の
   * 共有先に対応していないので、ショートカットを共有シートに出して、追加画面を開く。
   *
   * ショートカット App は、Siri に説明して作ってもらう形になっていて、画面の作りも版ごとに変わる。
   * なので、ボタンの場所は書かず、Siri に渡す文を出す（自分で組むときも、この文のとおりに組む）。
   * 開く先は reader ごとに違うので、このサイトの URL を文に埋める（ブックマークレットと同じ形で渡す）
   */
  const prefix = capturePrefixFor(location.origin);
  const prompt = [
    "「Add to Sendo」という名前のショートカットを作って。",
    "",
    "- 共有シートに表示し、入力は共有シートから受け取る。受け取るのは URL と Safari の Web ページ",
    "- 受け取ったページの URL を、URL エンコード（パーセントエンコード）する。「:」「/」「?」「&」「=」「#」もエンコードされるようにする",
    `- 「${prefix}」の後ろに、エンコードした文字列をつなげて、1 つの URL にする`,
    "- できた URL を Safari で開く",
    "- 共有から受け取ったものがないときは、何もせずに終わる",
  ].join("\n");

  let notice = $state("");
  let field = $state<HTMLTextAreaElement>();

  async function copy() {
    try {
      await navigator.clipboard.writeText(prompt);
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
  <p>
    ショートカット App で新しいショートカットを作り、Siri
    に下の文を渡して作ってもらいます。自分で組むときも、この文のとおりに組みます。
  </p>
  <textarea
    aria-label="Shortcut prompt"
    rows="9"
    readonly
    value={prompt}
    bind:this={field}
    onfocus={(event) => event.currentTarget.select()}
  ></textarea>
  <button type="button" onclick={copy}>Copy</button>
  {#if notice !== ""}
    <p role="status">{notice}</p>
  {/if}
  <p>
    できたら、共有の一覧に「Add to
    Sendo」が出るかを確かめます。出ないときは、入力を受け取る場所が共有シートになっているかを見てください。
  </p>

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

  textarea {
    width: 100%;
    box-sizing: border-box;
    padding: 0.45rem 0.6rem;
    border: 1px solid var(--border-strong);
    border-radius: var(--radius-small);
    background: var(--background);
    color: inherit;
    font-family: inherit;
    resize: vertical;
    line-height: 1.5;
    /* iPhone で、押したときに拡大しない大きさにする */
    font-size: max(16px, 0.8125rem);
  }

  button {
    justify-self: start;
  }
</style>
