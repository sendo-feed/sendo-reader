import type { Article, ArticleQuery } from "@sendo-reader/core";
import type { ReaderClient } from "@sendo-reader/core/web";

const PAGE = 50;

/** 開いている一覧の進み具合（一覧の見出しと左のメニューの輪に出す） */
export interface ListProgress {
  title: string;
  /** この一覧を開いてから読んだ数 */
  done: number;
  /** この一覧の範囲に残っている未読の数 */
  remaining: number;
  /** done ÷（done ＋ remaining）。0〜100 */
  percent: number;
}

/**
 * 開いている一覧（読む画面に 1 つ）。一覧の部品、記事の部品、キーボードの操作が同じものを見る。
 * 手元の DB だけを読むので、ネットワークは待たない。
 */
export class ArticleListState {
  articles = $state<Article[]>([]);
  hasMore = $state(false);
  loading = $state(true);
  /** 続きを読んでいる（続けて頼んでも、同じページを二重に足さない） */
  loadingMore = $state(false);
  /** 一覧を読んだあとに届いた、条件に合う記事の数 */
  fresh = $state(0);
  /**
   * この一覧を開いてから読んだ記事の数（未読で出ていた記事が既読になった数。未読に戻したら減る）。
   * 残っている未読の数と合わせて、一覧の進み具合を出す
   */
  done = $state(0);
  /** キーボードで選んでいる記事（開いてはいない） */
  cursorId = $state<string | null>(null);

  readonly #client: ReaderClient;
  #query: ArticleQuery = {};
  /**
   * 読み出しの世代。条件を変えて読み直すたびに増やし、それより前に始めた読み出し（前の条件の
   * 一覧を元にした読み直しなど）の結果は当てない
   */
  #generation = 0;
  /** この一覧で、未読として出たことのある記事 */
  readonly #seenUnread = new Set<string>();
  /** そのうち、いま既読の記事 */
  readonly #readHere = new Set<string>();

  constructor(client: ReaderClient) {
    this.#client = client;
  }

  /** 一覧を差し替え、読んだ数を数え直す */
  set #articles(articles: Article[]) {
    for (const article of articles) {
      if (article.readAt === null) {
        this.#seenUnread.add(article.id);
        this.#readHere.delete(article.id);
      } else if (this.#seenUnread.has(article.id)) {
        this.#readHere.add(article.id);
      }
    }
    this.articles = articles;
    this.done = this.#readHere.size;
  }

  /** 条件を替えて、最初から読む */
  show(query: ArticleQuery): Promise<void> {
    this.#query = query;
    this.cursorId = null;
    this.#seenUnread.clear();
    this.#readHere.clear();
    this.done = 0;
    return this.load();
  }

  async load(): Promise<void> {
    const current = ++this.#generation;
    this.loading = true;
    const page = await this.#client.listArticles({ ...this.#query, limit: PAGE });
    if (current !== this.#generation) return;
    this.#articles = page;
    this.hasMore = page.length === PAGE;
    this.fresh = 0;
    this.loading = false;
  }

  async loadMore(): Promise<void> {
    const last = this.articles.at(-1);
    if (last === undefined || this.loadingMore || !this.hasMore) return;
    const current = this.#generation;
    this.loadingMore = true;
    try {
      const page = await this.#client.listArticles({
        ...this.#query,
        limit: PAGE,
        after: { publishedAt: last.publishedAt, id: last.id },
      });
      if (current !== this.#generation) return;
      const shown = new Set(this.articles.map((article) => article.id));
      this.#articles = [...this.articles, ...page.filter((article) => !shown.has(article.id))];
      this.hasMore = page.length === PAGE;
    } finally {
      this.loadingMore = false;
    }
  }

  /**
   * 記事が変わったら、出している記事の状態だけを読み直す（既読にした記事を、読んでいる途中の
   * 未読の一覧から消さない）。新しく届いた記事は数だけ出し、押したら読み直す。
   */
  async refresh(): Promise<void> {
    if (this.articles.length === 0) {
      await this.load();
      return;
    }
    const current = this.#generation;
    const requested = this.articles.map((article) => article.id);
    const shown = new Set(requested);
    const last = this.articles.at(-1);
    const oldest = this.#query.order === "oldest";
    // 新しい順なら、新しい記事は先頭に入る。古い順なら末尾に入るので、続きがあるかだけを見る
    const [latest, edge] = await Promise.all([
      this.#client.getArticles(requested),
      this.#client.listArticles(
        oldest && last !== undefined
          ? { ...this.#query, limit: 1, after: { publishedAt: last.publishedAt, id: last.id } }
          : { ...this.#query, limit: PAGE },
      ),
    ]);
    if (current !== this.#generation) return;
    // 読み直した記事だけを差し替える（読み直している間に続きとして足した記事は残す。
    // 読み直して見つからなかった記事は、手元から消えたので外す）
    const byId = new Map(latest.map((article) => [article.id, article]));
    this.#articles = this.articles.flatMap((article) =>
      shown.has(article.id) ? (byId.get(article.id) ?? []) : [article],
    );
    if (oldest) this.hasMore ||= edge.length > 0;
    else {
      // 出している最後の記事より新しいものだけを数える（未読の一覧で記事を読むと、その分だけ
      // 古い記事が先頭のページに繰り上がるが、それは続きとして読む記事で、新しく届いたのではない）
      this.fresh = edge.filter(
        (article) =>
          !shown.has(article.id) &&
          (last === undefined ||
            article.publishedAt > last.publishedAt ||
            (article.publishedAt === last.publishedAt && article.id > last.id)),
      ).length;
    }
  }

  find(id: string | null): Article | null {
    if (id === null) return null;
    return this.articles.find((article) => article.id === id) ?? null;
  }

  /** 出している記事を、手元の DB への書き込みを待たずに書き換える（楽観的な更新） */
  patch(id: string, change: Partial<Article>): void {
    this.#articles = this.articles.map((article) =>
      article.id === id ? { ...article, ...change } : article,
    );
  }

  /**
   * 既読・スターを切り替える。押したらすぐ画面に出し、手元の DB への書き込みはそのあとに待つ
   * （docs/decisions/performance.md の操作の反応 100ms）。書けなかったら、手元の DB の状態に戻す
   */
  async toggle(article: Article, field: "readAt" | "starredAt"): Promise<void> {
    const on = article[field] === null;
    this.patch(article.id, { [field]: on ? Date.now() : null });
    try {
      if (field === "readAt") await this.#client.setRead(article.id, on);
      else await this.#client.setStarred(article.id, on);
    } catch (error) {
      await this.refresh();
      throw error;
    }
  }

  /** from の隣の記事（delta が 1 なら次、-1 なら前）。末尾まで来たら、続きを読んでから答える */
  async step(from: string | null, delta: 1 | -1): Promise<Article | null> {
    const index = from === null ? -1 : this.articles.findIndex((article) => article.id === from);
    if (index === -1) return delta === 1 ? (this.articles[0] ?? null) : null;
    if (delta === 1 && index === this.articles.length - 1 && this.hasMore) await this.loadMore();
    return this.articles[index + delta] ?? null;
  }
}
