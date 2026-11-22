import type { Article } from "./models";

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
  /** 訳せなかった（sendo で untranslated に戻った）。失敗の文を出す */
  failed: boolean;
}

/**
 * この端末で頼んだ、その場の翻訳（docs/decisions/translation.md の 6）。core のメモリーにだけ置き、
 * ログアウトとユーザーの切り替えで消す（代表のタブが替わったときも消える）。
 *
 * - 頼んだ印：sendo が受け付けたら付け、受け付けたあとに始めた同期が成功して終わったときか、
 *   1 分たったときに外す。印のある記事は Translating にする
 * - 頼んだ記事：そのあとの同期で untranslated だったら、訳せなかったとして失敗にする。訳文が
 *   届くか、1 時間たったら忘れる
 */
export class TranslationRequests {
  readonly #requests = new Map<string, Request>();
  readonly #now: () => number;

  constructor(now: () => number) {
    this.#now = now;
  }

  /** sendo が受け付けた。startedSyncs は、今までに始めた同期の数 */
  accept(articleId: string, startedSyncs: number): void {
    this.#requests.set(articleId, {
      acceptedAt: this.#now(),
      afterSync: startedSyncs,
      marked: true,
      failed: false,
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
    this.#expire();
    const due = [...this.#requests].filter(([, r]) => r.afterSync < syncNumber && !r.failed);
    if (due.length === 0) return false;
    const articles = new Map((await read(due.map(([id]) => id))).map((a) => [a.id, a]));
    let changed = false;
    for (const [id, request] of due) {
      // 読んでいる間に、頼み直した ／ 消した
      if (this.#requests.get(id) !== request) continue;
      if (request.marked) {
        request.marked = false;
        changed = true;
      }
      const translation = articles.get(id)?.translation;
      if (translation == null || translation.translatedAt !== null) {
        // 訳文が届いた（または、記事か翻訳がなくなった）
        this.#requests.delete(id);
        changed = true;
      } else if (translation.status === "untranslated") {
        request.failed = true;
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
    if (request.failed) return { ...article, translationRequest: "failed" };
    const marked = request.marked && this.#now() - request.acceptedAt < TRANSLATION_MARK_MS;
    if (marked && translation.translatedAt === null) {
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
