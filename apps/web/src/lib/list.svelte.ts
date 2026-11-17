import {
  type Article,
  type ArticleCursor,
  type ArticleQuery,
  compareArticles,
} from "@sendo-reader/core";
import type { ReaderClient } from "@sendo-reader/core/web";

const PAGE = 50;

function cursorOf(article: Article | undefined): ArticleCursor | undefined {
  return article === undefined
    ? undefined
    : {
        id: article.id,
        publishedAt: article.publishedAt,
        readAt: article.readAt,
      };
}

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
  /** 条件を替えて開き直すたびに増える。一覧の部品は、これを見て先頭に戻す */
  opened = $state(0);
  /** キーボードで選んでいる記事（開いてはいない） */
  cursorId = $state<string | null>(null);

  readonly #client: ReaderClient;
  #query: ArticleQuery = {};
  /** 読み出した末尾の位置。既読・未読を変えても、続きを読む境界は動かさない */
  #after: ArticleCursor | undefined;
  /** 最近読んだ一覧から外れた記事の前後。開いている記事・選択中の記事から移るときに使う */
  readonly #removed = new Map<string, { previous: string | null; next: string | null }>();
  /** 何も出さない一覧にしている（show に null を渡した） */
  #empty = false;
  /**
   * 読み出しの世代。条件を変えて読み直すたびに増やし、それより前に始めた読み出し（前の条件の
   * 一覧を元にした読み直しなど）の結果は当てない
   */
  #generation = 0;
  /** この一覧で、未読として出たことのある記事 */
  readonly #seenUnread = new Set<string>();
  /** そのうち、いま既読の記事 */
  readonly #readHere = new Set<string>();

  /**
   * 一覧を最初から読み直す（別の一覧に替える、読み直す）たびに変わる番号。待っている間に、
   * 一覧が読み直されたかを見分けるのに使う
   */
  get generation(): number {
    return this.#generation;
  }

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

  /**
   * 条件を替えて、最初から読む。null なら、何も出さない一覧にする（探す言葉が空の検索）。
   * 画面に出していない記事を、キーボードの操作の相手にしない
   */
  show(query: ArticleQuery | null): Promise<void> {
    this.#empty = query === null;
    this.#query = query ?? {};
    this.opened += 1;
    this.cursorId = null;
    this.#removed.clear();
    this.#seenUnread.clear();
    this.#readHere.clear();
    this.done = 0;
    return this.load();
  }

  async load(): Promise<void> {
    const current = ++this.#generation;
    if (this.#empty) {
      this.#after = undefined;
      this.#articles = [];
      this.hasMore = false;
      this.fresh = 0;
      this.loading = false;
      return;
    }
    this.loading = true;
    const page = await this.#client.listArticles({ ...this.#query, limit: PAGE });
    if (current !== this.#generation) return;
    this.#removed.clear();
    this.#after = cursorOf(page.at(-1));
    this.#articles = page;
    this.hasMore = page.length === PAGE;
    this.fresh = 0;
    this.loading = false;
  }

  /** 続きを読む。読んでいる最中に頼まれたら、その読み出しが終わるのを待つ */
  loadMore(): Promise<void> {
    this.#more ??= this.#loadMore().finally(() => {
      this.#more = null;
    });
    return this.#more;
  }

  #more: Promise<void> | null = null;

  async #loadMore(): Promise<void> {
    const after = this.#after;
    if (after === undefined || !this.hasMore) return;
    const current = this.#generation;
    this.loadingMore = true;
    try {
      const page = await this.#client.listArticles({
        ...this.#query,
        limit: PAGE,
        after,
      });
      if (current !== this.#generation) return;
      // 待っている間に同期で境界の既読日時が変わった。古い境界の結果は使わず読み直す
      if (after !== this.#after) return await this.#loadMore();
      this.#after = cursorOf(page.at(-1)) ?? after;
      const shown = new Set(this.articles.map((article) => article.id));
      const added = page.filter((article) => !shown.has(article.id));
      const removedTail = this.#removed.get(after.id);
      if (removedTail?.next === null && added[0] !== undefined) removedTail.next = added[0].id;
      this.#articles = [...this.articles, ...added];
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
    if (this.#empty) return;
    if (this.articles.length === 0) {
      await this.load();
      return;
    }
    const current = this.#generation;
    const requested = this.articles.map((article) => article.id);
    const shown = new Set(requested);
    const boundaryId = this.#after?.id;
    const [latest, top] = await Promise.all([
      this.#client.getArticles(
        boundaryId !== undefined && !shown.has(boundaryId) ? [...requested, boundaryId] : requested,
      ),
      // 先頭のページ。出している記事の間や前に、条件に合う記事が加わっていないかを見る
      this.#client.listArticles({ ...this.#query, limit: PAGE }),
    ]);
    if (current !== this.#generation) return;
    const byId = new Map(latest.map((article) => [article.id, article]));
    const boundary = this.#after === undefined ? undefined : byId.get(this.#after.id);
    // 同期で手元の既読日時がサーバーの日時に変わったら、続きの境界も合わせる。
    // 未読に戻った・削除された境界は、既読だったときの日時を保つ
    if (
      this.#query.order === "recentlyRead" &&
      boundary?.readAt != null &&
      boundary.readAt !== this.#after?.readAt
    ) {
      this.#after = cursorOf(boundary);
    }
    const after = this.#after;
    // 末尾まで出していたら、その先に条件に合う記事が加わっていないかを、更新後の境界で見る
    const beyond =
      this.hasMore || after === undefined
        ? []
        : await this.#client.listArticles({ ...this.#query, limit: 1, after });
    if (current !== this.#generation) return;
    // 読み直した記事だけを差し替える（読み直している間に続きとして足した記事は残す。
    // 読み直して見つからなかった記事は、手元から消えたので外す）
    let articles = this.articles.flatMap((article) =>
      shown.has(article.id) ? (byId.get(article.id) ?? []) : [article],
    );
    if (this.#query.order === "recentlyRead") {
      articles = articles
        .filter((article) => article.readAt !== null)
        .sort((a, b) => compareArticles(a, b, this.#query.order));
      const kept = new Set(articles.map((article) => article.id));
      for (const [index, article] of this.articles.entries()) {
        if (!kept.has(article.id))
          this.#removed.set(article.id, {
            previous: this.articles[index - 1]?.id ?? null,
            next: this.articles[index + 1]?.id ?? null,
          });
      }
    }
    this.#articles = articles;
    if (beyond.length > 0) this.hasMore = true;
    // 並び順で、出している最後の記事より前に入る記事だけを、新しい記事として数える。最後の
    // 記事より先の記事は、続きとして読む（未読の一覧で記事を読むと、その分だけ先の記事が先頭の
    // ページに繰り上がるが、それは新しく加わったのではない）
    this.fresh = top.filter((article) => {
      if (shown.has(article.id)) return false;
      if (after === undefined) return true;
      return compareArticles(article, after, this.#query.order) < 0;
    }).length;
    if (this.articles.length === 0 && this.hasMore) await this.loadMore();
  }

  /**
   * 並び順で、その記事か、それより後ろにある最初の記事（前に見ていた位置に戻すとき。その記事が
   * 一覧から消えていたら、次の記事に合わせる）。出していなければ、続きを pages ページまで読んで探す。
   * 末尾まで来たら、最後の記事。探している間に一覧が読み直されたら null
   */
  async seek(anchor: ArticleCursor, pages = 10): Promise<Article | null> {
    const current = this.#generation;
    const before = (article: Article) => {
      if (article.id === anchor.id) return false;
      return compareArticles(article, anchor, this.#query.order) < 0;
    };
    for (let page = 0; ; page++) {
      const found = this.articles.find((article) => !before(article));
      if (found !== undefined) return found;
      if (!this.hasMore || page >= pages) return this.articles.at(-1) ?? null;
      await this.loadMore();
      if (current !== this.#generation) return null;
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

  /**
   * いくつかの記事をまとめて既読にする（一覧を動かして通り過ぎた記事）。すでに既読のものは
   * 飛ばす。押したときと同じく、画面にはすぐ出し、書けなかったら手元の DB の状態に戻す
   */
  async markRead(ids: readonly string[]): Promise<void> {
    const wanted = new Set(ids);
    const unread = this.articles.filter((a) => wanted.has(a.id) && a.readAt === null);
    if (unread.length === 0) return;
    const targets = new Set(unread.map((article) => article.id));
    const readAt = Date.now();
    this.#articles = this.articles.map((article) =>
      targets.has(article.id) ? { ...article, readAt } : article,
    );
    try {
      await this.#client.setReadMany([...targets], true);
    } catch (error) {
      await this.refresh();
      throw error;
    }
  }

  /** from の隣の記事（delta が 1 なら次、-1 なら前）。末尾まで来たら、続きを読んでから答える */
  async step(from: string | null, delta: 1 | -1): Promise<Article | null> {
    const index = from === null ? -1 : this.articles.findIndex((article) => article.id === from);
    if (index === -1) {
      const removed = from === null ? undefined : this.#removed.get(from);
      if (removed === undefined) return delta === 1 ? (this.articles[0] ?? null) : null;
      const side = delta === 1 ? "next" : "previous";
      let id = removed[side];
      const seen = new Set<string>();
      while (id !== null && !seen.has(id)) {
        seen.add(id);
        const article = this.find(id);
        if (article !== null) return article;
        id = this.#removed.get(id)?.[side] ?? null;
      }
      if (delta === 1 && this.hasMore) {
        const current = this.#generation;
        const count = this.articles.length;
        await this.loadMore();
        if (current !== this.#generation) return null;
        return this.articles[count] ?? null;
      }
      return null;
    }
    if (delta === 1 && index === this.articles.length - 1 && this.hasMore) await this.loadMore();
    return this.articles[index + delta] ?? null;
  }
}
