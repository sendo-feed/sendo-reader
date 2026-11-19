<script lang="ts">
  import { bookmarkletFor } from "../../lib/bookmarklet";
  import Icon from "../Icon.svelte";

  /**
   * ブックマークレットの案内。ふつうは、ボタンをブックマークバーへドラッグして入れてもらう。
   * ドラッグできないとき（スマホなど）のために、文字列をコピーする手段も残す
   */
  const bookmarklet = bookmarkletFor(location.origin);
  /** 指で使う端末では、ドラッグできないので、コピーする手段を最初から開いておく */
  const coarse = window.matchMedia("(pointer: coarse)").matches;

  let notice = $state("");
  let field = $state<HTMLTextAreaElement>();

  /** この画面で押しても動かない（CSP で止まる）。ドラッグして使うことを伝える */
  function onclick(event: MouseEvent) {
    event.preventDefault();
    notice = "このボタンは、ブックマークバーへドラッグして使います。";
  }

  async function copy() {
    try {
      await navigator.clipboard.writeText(bookmarklet);
      notice = "ブックマークレットをコピーしました。";
    } catch {
      field?.focus();
      field?.select();
      notice = "選択した文字列をコピーしてください。";
    }
  }
</script>

<section aria-labelledby="bookmarklet-heading">
  <h3 id="bookmarklet-heading">Bookmarklet</h3>
  <p>
    ほかのサイトを見ているときに押すと、そのサイトを購読したり、ページを Saved に残したりできます。
  </p>
  <div class="drag">
    <a class="bookmarklet" href={bookmarklet} {onclick} title="ブックマークバーへドラッグします">
      <Icon name="bookmark" />
      Add to Sendo
    </a>
    <span class="hint">← ブックマークバーへドラッグ</span>
  </div>
  <details open={coarse}>
    <summary>ドラッグできないとき</summary>
    <div class="manual">
      <p>ブックマークを作り、名前を「Add to Sendo」、URL を下の文字列にします。</p>
      <textarea
        aria-label="Bookmarklet URL"
        rows="3"
        readonly
        value={bookmarklet}
        bind:this={field}
        onfocus={(event) => event.currentTarget.select()}
      ></textarea>
      <button type="button" onclick={copy}>Copy bookmarklet</button>
    </div>
  </details>
  {#if notice !== ""}
    <p role="status">{notice}</p>
  {/if}
</section>

<style>
  section {
    display: grid;
    gap: 0.625rem;
  }

  h3 {
    margin: 0;
    font-size: 1rem;
  }

  p {
    margin: 0;
    color: var(--muted);
    font-size: 0.875rem;
    line-height: 1.6;
  }

  .drag {
    display: flex;
    flex-wrap: wrap;
    align-items: center;
    gap: 0.5rem 0.75rem;
  }

  .bookmarklet {
    display: inline-flex;
    align-items: center;
    gap: 0.375rem;
    padding: 0.5rem 0.875rem;
    border: 1px dashed var(--accent);
    border-radius: 999px;
    color: var(--accent);
    font-weight: 600;
    text-decoration: none;
    cursor: grab;
  }

  .bookmarklet:active {
    cursor: grabbing;
  }

  .hint {
    color: var(--muted);
    font-size: 0.8125rem;
  }

  @media (pointer: coarse) {
    .hint {
      display: none;
    }
  }

  summary {
    color: var(--muted);
    font-size: 0.875rem;
    cursor: pointer;
  }

  .manual {
    display: grid;
    gap: 0.5rem;
    margin-top: 0.5rem;
  }

  textarea {
    width: 100%;
    box-sizing: border-box;
    font-family: ui-monospace, monospace;
    font-size: 0.75rem;
    resize: none;
    word-break: break-all;
  }

  button {
    justify-self: start;
  }
</style>
