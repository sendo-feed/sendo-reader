<script lang="ts">
  import type { ContentNode } from "@sendo-reader/core";
  import ArticleBody from "../ArticleBody.svelte";
  import ArticleListItem from "../ArticleListItem.svelte";

  const title = "毎日の読む時間を、心地よく";
  const feedTitle = "Sendo Journal";
  const time = "Today";
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
  <div class="examples">
    <section aria-labelledby="list-preview-heading">
      <h3 id="list-preview-heading">List card</h3>
      <div class="list-card">
        <ArticleListItem {title} {feedTitle} {time} unread saved />
      </div>
    </section>
    <section aria-labelledby="article-preview-heading">
      <h3 id="article-preview-heading">Article</h3>
      <article aria-label="記事のプレビュー">
        <p class="meta">{feedTitle} · {time}</p>
        <h4>{title}</h4>
        <ArticleBody {nodes} />
      </article>
    </section>
  </div>
</section>

<style>
  .preview {
    container-type: inline-size;
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
  .examples {
    display: grid;
    grid-template-columns: minmax(0, 1fr);
    align-items: start;
    gap: 1.25rem;
    max-width: 64rem;
    margin-inline: auto;
  }
  @container (min-width: 42rem) {
    .examples {
      grid-template-columns: minmax(17rem, 2fr) minmax(0, 3fr);
    }
  }
  h3 {
    margin: 0 0 0.5rem;
    color: var(--muted);
    font-size: 0.875rem;
  }
  .list-card {
    position: relative;
    overflow: hidden;
    border: 1px solid var(--border);
    border-radius: var(--radius-small);
    background: var(--background);
  }
  .meta {
    margin: 0 0 0.5rem;
    color: var(--muted);
    font-size: 0.8125rem;
  }
  h4 {
    margin: 0 0 1.25rem;
    font-size: 1.625rem;
    line-height: 1.4;
  }
  article {
    max-width: 38rem;
  }
  @media (max-width: 56rem) {
    h4 {
      font-size: 1.375rem;
    }
  }
</style>
