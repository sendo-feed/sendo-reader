<script lang="ts">
  import type { Snippet } from "svelte";

  /**
   * sendo が中継した画像（記事のサムネイル、フィードのアイコン、本文の中の画像）を出す
   * （docs/decisions/images.md）。画像を出すところは、この部品にまとめる（あとで「回線によって
   * 出さない」などを足すときに、ここだけを直せばよいように）。
   *
   * - src は、sendo から受け取った URL をそのまま渡す（組み立てない、書き換えない、中身を読まない）
   * - ない（null）ときと、読み込みに失敗したときは、同じ出し方にする。画像は出さず、fallback が
   *   あればそれを出す。壊れた画像の印は出さない
   * - 見えた分だけ取る（loading="lazy"）
   * - サムネイルとアイコンは、囲む側が CSS で大きさを決め、alt は空にする（飾りで、すぐ隣に
   *   記事のタイトルやフィードの名前が文字で出ている）
   * - 本文の中の画像（inline）は、幅に収め、縦横比を保つ。width と height があれば、読み込む前に
   *   場所を取る（読み込みで本文が動かないように）。alt は、本文に書いてあったものを出す
   */
  let {
    src,
    fallback,
    alt = "",
    width,
    height,
    inline = false,
  }: {
    src: string | null;
    fallback?: Snippet;
    alt?: string;
    width?: number | undefined;
    height?: number | undefined;
    inline?: boolean;
  } = $props();

  /** 読み込みに失敗した URL。src が替わったら、もう一度試す */
  let failed = $state<string | null>(null);
</script>

{#if src !== null && failed !== src}
  <img
    {src}
    {alt}
    {width}
    {height}
    class:inline
    loading="lazy"
    decoding="async"
    onerror={() => (failed = src)}
  >
{:else}
  {@render fallback?.()}
{/if}

<style>
  img:not(.inline) {
    display: block;
    width: 100%;
    height: 100%;
    object-fit: cover;
  }

  /*
   * 幅に収める。幅は width の属性（なければ画像のもとの大きさ）から、高さは width ／ height の
   * 属性の比から決まる（読み込む前から）
   */
  img.inline {
    max-width: 100%;
    height: auto;
    border-radius: var(--radius-small);
    vertical-align: middle;
  }
</style>
