<script lang="ts">
  import type { Snippet } from "svelte";

  /**
   * sendo が中継した画像（記事のサムネイル、フィードのアイコン）を出す（docs/decisions/images.md）。
   * 画像を出すところは、この部品にまとめる（あとで「回線によって出さない」などを足すときに、
   * ここだけを直せばよいように）。
   *
   * - src は、sendo から受け取った URL をそのまま渡す（組み立てない、書き換えない、中身を読まない）
   * - ない（null）ときと、読み込みに失敗したときは、同じ出し方にする。画像は出さず、fallback が
   *   あればそれを出す。壊れた画像の印は出さない
   * - 見えた分だけ取る（loading="lazy"）。大きさは、囲む側が CSS で決める
   * - alt は空にする。飾りで、すぐ隣に記事のタイトルやフィードの名前が文字で出ている
   */
  let { src, fallback }: { src: string | null; fallback?: Snippet } = $props();

  /** 読み込みに失敗した URL。src が替わったら、もう一度試す */
  let failed = $state<string | null>(null);
</script>

{#if src !== null && failed !== src}
  <img {src} alt="" loading="lazy" decoding="async" onerror={() => (failed = src)}>
{:else}
  {@render fallback?.()}
{/if}

<style>
  img {
    display: block;
    width: 100%;
    height: 100%;
    object-fit: cover;
  }
</style>
