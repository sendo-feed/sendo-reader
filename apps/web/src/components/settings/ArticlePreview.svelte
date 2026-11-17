<script lang="ts">
  import type { ContentNode } from "@sendo-reader/core";
  import ArticleBody from "../ArticleBody.svelte";

  const nodes: ContentNode[] = [
    {
      tag: "p",
      children: [
        "いつもの記事を、心地よい見た目で。テーマと文字の大きさを変えて、読みやすさを確かめてみてください。",
      ],
    },
    {
      tag: "p",
      children: [
        "朝のひと休みにも、夜のじっくり読む時間にも。",
        { tag: "strong", children: ["自分に合った読み心地"] },
        "で、気になる話題を追いかけましょう。",
      ],
    },
  ];
</script>

<section class="preview" aria-labelledby="preview-heading">
  <p class="eyebrow" id="preview-heading">Preview</p>
  <article aria-label="記事のプレビュー">
    <p class="meta">Sendo Journal · Today</p>
    <h3>毎日の読む時間を、心地よく</h3>
    <ArticleBody {nodes} />
  </article>
</section>

<style>
  .preview {
    padding: 1.25rem;
    border: 1px solid var(--border);
    border-radius: var(--radius-small);
    background: var(--surface);
  }
  .eyebrow {
    margin: 0 0 1.5rem;
    color: var(--muted);
    font-size: 0.75rem;
  }
  .meta {
    margin: 0 0 0.5rem;
    color: var(--muted);
    font-size: 0.8125rem;
  }
  h3 {
    margin: 0 0 1.25rem;
    font-size: 1.625rem;
    line-height: 1.4;
  }
  article {
    max-width: 38rem;
    margin-inline: auto;
  }
  @media (max-width: 56rem) {
    h3 {
      font-size: 1.375rem;
    }
  }
</style>
