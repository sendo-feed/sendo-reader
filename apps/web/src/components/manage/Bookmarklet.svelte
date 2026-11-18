<script lang="ts">
  import { bookmarkletFor } from "../../lib/bookmarklet";

  const bookmarklet = bookmarkletFor(location.origin);
  let notice = $state("");
  let field = $state<HTMLTextAreaElement>();

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

<details>
  <summary>Add to Sendo</summary>
  <div class="setup">
    <p>Chrome でブックマークを作り、名前を「Add to Sendo」、URL を下の文字列にします。</p>
    <p>追加したいページを開いて、そのブックマークを押してください。</p>
    <textarea
      aria-label="Bookmarklet URL"
      rows="2"
      readonly
      value={bookmarklet}
      bind:this={field}
    ></textarea>
    <button type="button" onclick={copy}>Copy bookmarklet</button>
    {#if notice !== ""}
      <p role="status">{notice}</p>
    {/if}
  </div>
</details>

<style>
  .setup {
    display: grid;
    gap: 0.5rem;
    max-width: 34rem;
    margin-top: 0.5rem;
  }

  p {
    font-size: 0.9rem;
    color: var(--muted);
    margin: 0;
  }

  button {
    justify-self: start;
  }
</style>
