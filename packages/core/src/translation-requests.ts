import type { Article, ArticleTranslation } from "./models";

/** 頼んだ印を外すまでの長さ（docs/decisions/translation.md の 6） */
export const TRANSLATION_MARK_MS = 60 * 1000;

/** この端末で頼んだ記事を覚えておく長さ（同じく 6） */
export const TRANSLATION_WATCH_MS = 60 * 60 * 1000;

interface Request {
  /** sendo が受け付けた時刻 */
  acceptedAt: number;
  /** 受け付けた時点で始まっていた同期の数。これより後に始めた同期が終わるまで、印を外さない */
  afterSync: number;
  /** 頼んだ印（Translating にして、押せなくする）が付いている */
  marked: boolean;
  /** 訳せなかった（sendo で、頼む前の状態に戻った）。失敗の文を出す */
  failed: boolean;
  /** 訳し直し（Opus）を頼んだ。でなければ、その場の翻訳 */
  retranslation: boolean;
}

/** 頼んだものが届いた（その場の翻訳なら訳文、訳し直しなら訳し直しの印。記事か翻訳がなくなったときも） */
function arrived(request: Request, translation: ArticleTranslation | null | undefined): boolean {
  if (translation == null) return true;
  return request.retranslation ? translation.retranslated : translation.translatedAt !== null;
}

/**
 * sendo で訳せずに、頼む前の状態に戻った（docs/decisions/translation.md の 6。sendo は 202 を返す前に
 * translating にするので、受け付けたあとの同期で見えるこの状態は、訳せずに戻ったもの）
 */
function returned(request: Request, translation: ArticleTranslation): boolean {
  return request.retranslation
    ? translation.status === "translated" && !translation.retranslated
    : translation.status === "untranslated";
}

/**
 * この端末で頼んだ、その場の翻訳と訳し直し（docs/decisions/translation.md の 6）。core のメモリーに
 * だけ置き、ログアウトとユーザーの切り替えで消す（代表のタブが替わったときも消える）。
 *
 * - 頼んだ印：sendo が受け付けたら付け、受け付けたあとに始めた同期が成功して終わったときか、
 *   1 分たったときに外す。印のある記事は Translating にする
 * - 頼んだ記事：そのあとの同期で、その場の翻訳なら untranslated、訳し直しなら訳し直しの印のない
 *   translated だったら、訳せなかったとして失敗にする。訳文（訳し直しなら印）が届くか、1 時間
 *   たったら忘れる
 */
export class TranslationRequests {
  readonly #requests = new Map<string, Request>();
  readonly #now: () => number;

  constructor(now: () => number) {
    this.#now = now;
  }

  /** sendo が受け付けた。startedSyncs は、今までに始めた同期の数 */
  accept(articleId: string, startedSyncs: number, retranslation = false): void {
    this.#requests.set(articleId, {
      acceptedAt: this.#now(),
      afterSync: startedSyncs,
      marked: true,
      failed: false,
      retranslation,
    });
  }

  /**
   * 同期が成功して終わった。syncNumber は、その同期が何番目に始めたものか。印を外し、手元の状態
   * （read が読む）で、訳せたか、訳せなかったかを決める。見え方が変わった記事があれば true
   */
  async afterSync(
    syncNumber: number,
    read: (ids: string[]) => Promise<Article[]>,
  ): Promise<boolean> {
    let changed = this.#expire();
    const due = [...this.#requests].filter(([, r]) => r.afterSync < syncNumber);
    if (due.length === 0) return changed;
    const articles = new Map((await read(due.map(([id]) => id))).map((a) => [a.id, a]));
    for (const [id, request] of due) {
      // 読んでいる間に、頼み直した ／ 消した
      if (this.#requests.get(id) !== request) continue;
      if (request.marked) {
        request.marked = false;
        changed = true;
      }
      const translation = articles.get(id)?.translation;
      if (translation == null || arrived(request, translation)) {
        // 訳文が届いた（または、記事か翻訳がなくなった）
        this.#requests.delete(id);
        changed = true;
      } else if (returned(request, translation)) {
        if (!request.failed) changed = true;
        request.failed = true;
      } else if (request.failed) {
        // 失敗の文を出したら忘れる（決定の 6）。そのあとにほかの人が頼んだ翻訳は、この端末で
        // 頼んだものではないので、失敗の文も、開いている見出しの入れ替えもしない（決定の 3）
        this.#requests.delete(id);
        changed = true;
      }
    }
    return changed;
  }

  /** 1 分たった印を外す。外したら true（画面に読み直してもらう） */
  expireMarks(): boolean {
    return this.#expire();
  }

  /** 次に印が外れる時刻（なければ null） */
  nextExpiry(): number | null {
    let next: number | null = null;
    for (const request of this.#requests.values()) {
      if (!request.marked) continue;
      const at = request.acceptedAt + TRANSLATION_MARK_MS;
      if (next === null || at < next) next = at;
    }
    return next;
  }

  /** 記事に、頼んだ印と訳せなかったことを重ねる（手元の DB から読んだ記事に） */
  overlay(article: Article): Article {
    const request = this.#requests.get(article.id);
    if (request === undefined) return article;
    if (this.#now() - request.acceptedAt >= TRANSLATION_WATCH_MS) {
      this.#requests.delete(article.id);
      return article;
    }
    const translation = article.translation;
    if (translation == null) return article;
    if (request.failed) {
      // 失敗の文を出したあとに状態が変わったのは、ほかの人の頼み。この端末で頼んだものとして
      // 見せない（次の同期の終わりに忘れる）
      return returned(request, translation)
        ? { ...article, translationRequest: "failed" }
        : article;
    }
    // 頼んだものが届いた（同期の終わりに忘れる）。この端末で頼んだものとして見せ続けると、画面が
    // あとで届くほかの人の訳文まで、頼んだものとして扱ってしまう
    if (arrived(request, translation)) return article;
    const marked = request.marked && this.#now() - request.acceptedAt < TRANSLATION_MARK_MS;
    if (marked) {
      return {
        ...article,
        translation: { ...translation, status: "translating" },
        translationRequest: "requested",
      };
    }
    return { ...article, translationRequest: "requested" };
  }

  clear(): void {
    this.#requests.clear();
  }

  #expire(): boolean {
    const now = this.#now();
    let changed = false;
    for (const [id, request] of this.#requests) {
      if (now - request.acceptedAt >= TRANSLATION_WATCH_MS) {
        this.#requests.delete(id);
        changed = true;
      } else if (request.marked && now - request.acceptedAt >= TRANSLATION_MARK_MS) {
        request.marked = false;
        changed = true;
      }
    }
    return changed;
  }
}
