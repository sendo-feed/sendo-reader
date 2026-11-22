/**
 * 記事の中の X の投稿を、隔離フレームの公式ウィジェットで出す順番と時間を決める
 * （docs/decisions/embeds.md の 2 と 4）。
 *
 * 記事の画面（ArticleView）が 1 つ作り、本文の中の投稿の部品（XPost）が、自分を登録する。
 *
 * - 投稿が表示範囲（ツールバーの下は数えない）に入ったら、iframe の src を付けて読み込みを始める。
 *   読書位置が決まる前（setReady の前）と、オフラインの間は、始めない
 * - 同時に読み込む（rendered か失敗を待つ）のは 4 つまで。空いたら、表示範囲に入っているものから
 *   始める。読み込み中に表示範囲から出たものは、iframe を外して元の引用に戻し、数から外す
 *   （入り直したら、最初から読み込む）
 * - 成功は、最初の rendered。失敗は、failed か、表示範囲に入ったまま 10 秒たったとき。失敗した投稿は、
 *   その記事を開いている間（reset まで）、やり直さない
 * - メッセージは、送り元のオリジンが隔離フレームのオリジンで、送り元の窓がその投稿の iframe のもの
 *   だけを受ける
 */
import { getContext, setContext } from "svelte";

/** 同時に読み込む数の上限 */
export const X_POST_LOADING_LIMIT = 4;
/** 表示範囲に入ったまま、これだけたっても rendered が来なければ、失敗にする（ms） */
export const X_POST_TIMEOUT_MS = 10_000;
/** 受ける高さの上限（px） */
export const X_POST_MAX_HEIGHT = 4000;

const HELLO = "sendo:x-post:hello";
const RENDERED = "sendo:x-post:rendered";
const FAILED = "sendo:x-post:failed";

/** reader の今のテーマ（ライト ／ ダーク）。<html data-theme> がなければ、OS の設定に従う */
function currentTheme(): "light" | "dark" {
  const theme = document.documentElement.dataset.theme;
  if (theme === "light" || theme === "dark") return theme;
  return window.matchMedia("(prefers-color-scheme: dark)").matches ? "dark" : "light";
}

/** rendered の高さとして受ける値か（1〜4000 の整数） */
export function isXPostHeight(value: unknown): value is number {
  return (
    Number.isInteger(value) && (value as number) >= 1 && (value as number) <= X_POST_MAX_HEIGHT
  );
}

/** 本文の中の投稿 1 つ。部品は src と height を見て、iframe と元の引用を出し分ける */
export class XPostFrame {
  /** iframe の src。null の間は、iframe を置かない */
  src = $state<string | null>(null);
  /** ウィジェットの高さ（px）。null の間は、元の引用を出し、iframe は場所を取らない */
  height = $state<number | null>(null);

  phase: "idle" | "loading" | "shown" | "failed" = "idle";
  /** 表示範囲に入っている */
  visible = false;
  /** 読み込んでいる iframe（load のあと）。メッセージの送り元を確かめるのに使う */
  frame: HTMLIFrameElement | null = null;
  timer: ReturnType<typeof setTimeout> | null = null;

  constructor(
    readonly id: string,
    readonly element: Element,
    readonly origin: string,
  ) {}

  /** 枠の load で、隔離フレームに挨拶する（送り先は、隔離フレームのオリジンだけ） */
  hello(frame: HTMLIFrameElement): void {
    if (this.src === null) return;
    this.frame = frame;
    frame.contentWindow?.postMessage({ type: HELLO }, this.origin);
  }
}

export class XPostLoader {
  readonly #origin: string;
  readonly #posts = new Set<XPostFrame>();
  readonly #byElement = new Map<Element, XPostFrame>();
  /** この記事で失敗した投稿の ID（本文を全文に替えても、やり直さない） */
  readonly #failed = new Set<string>();
  #ready = false;
  #online = navigator.onLine;
  #observer: IntersectionObserver | null = null;
  #root: Element | null = null;
  #margin = "0px";

  constructor(origin: string) {
    this.#origin = origin;
  }

  /** 窓のイベント（メッセージ、オンライン ／ オフライン）を受け始める。戻り値で止める */
  connect(): () => void {
    const onMessage = (event: MessageEvent) => this.#receive(event);
    const onOnline = () => {
      this.#online = true;
      this.#pump();
    };
    const onOffline = () => {
      this.#online = false;
      // 読み込み中のものは、失敗にせず取り消す。つながったら、表示範囲に入っているものから始め直す
      for (const post of this.#posts) if (post.phase === "loading") this.#cancel(post);
    };
    window.addEventListener("message", onMessage);
    window.addEventListener("online", onOnline);
    window.addEventListener("offline", onOffline);
    return () => {
      window.removeEventListener("message", onMessage);
      window.removeEventListener("online", onOnline);
      window.removeEventListener("offline", onOffline);
      this.#observer?.disconnect();
      this.#observer = null;
      for (const post of this.#posts) this.#cancel(post);
    };
  }

  /**
   * 表示範囲を決める。root は、スクロールする欄（ページ全体なら null）。margin は、ツールバーに
   * 隠れる分を外す rootMargin
   */
  setArea(root: Element | null, margin: string): void {
    if (root === this.#root && margin === this.#margin && this.#observer !== null) return;
    this.#root = root;
    this.#margin = margin;
    this.#observe();
  }

  /**
   * 読書位置が決まったか。決まったら、表示範囲を測り直してから始める（位置を戻す前の、先頭に
   * 一瞬見えた投稿を読み込まない）
   */
  setReady(ready: boolean): void {
    if (ready === this.#ready) return;
    this.#ready = ready;
    if (!ready) {
      for (const post of this.#posts) if (post.phase === "loading") this.#cancel(post);
      return;
    }
    this.#observe();
  }

  /** 記事が替わった。失敗の覚えを捨てる */
  reset(): void {
    this.#failed.clear();
  }

  /** 本文の中の投稿を登録する */
  add(id: string, element: Element): XPostFrame {
    const post = new XPostFrame(id, element, this.#origin);
    this.#posts.add(post);
    this.#byElement.set(element, post);
    this.#observer?.observe(element);
    return post;
  }

  /** 本文から投稿が消えた（本文の差し替え、記事の切り替え）。待ちと時間を残さない */
  remove(post: XPostFrame): void {
    this.#stopTimer(post);
    post.frame = null;
    this.#posts.delete(post);
    if (this.#byElement.get(post.element) === post) this.#byElement.delete(post.element);
    this.#observer?.unobserve(post.element);
    this.#pump();
  }

  /** 見張りを作り直す。表示範囲の判定は、最初の知らせが来るまで「入っていない」とする */
  #observe(): void {
    this.#observer?.disconnect();
    this.#observer = null;
    for (const post of this.#posts) post.visible = false;
    if (typeof IntersectionObserver === "undefined") return;
    this.#observer = new IntersectionObserver((entries) => this.#seen(entries), {
      root: this.#root,
      rootMargin: this.#margin,
    });
    for (const post of this.#posts) this.#observer.observe(post.element);
  }

  #seen(entries: IntersectionObserverEntry[]): void {
    for (const entry of entries) {
      const post = this.#byElement.get(entry.target);
      if (post === undefined) continue;
      post.visible = entry.isIntersecting;
      // 読み込み中に出たら、iframe を外して数から外す（Chromium は、画面の外の枠を解決させない）
      if (!post.visible && post.phase === "loading") this.#cancel(post);
    }
    this.#pump();
  }

  /** 空いている分だけ、表示範囲に入っている投稿の読み込みを始める */
  #pump(): void {
    if (!this.#ready || !this.#online) return;
    let loading = 0;
    for (const post of this.#posts) if (post.phase === "loading") loading += 1;
    for (const post of this.#posts) {
      if (loading >= X_POST_LOADING_LIMIT) return;
      if (post.phase !== "idle" || !post.visible || this.#failed.has(post.id)) continue;
      this.#start(post);
      loading += 1;
    }
  }

  #start(post: XPostFrame): void {
    post.phase = "loading";
    post.frame = null;
    post.height = null;
    // 渡すのは、投稿の ID とテーマだけ
    post.src = `${this.#origin}/#id=${post.id}&theme=${currentTheme()}`;
    post.timer = setTimeout(() => this.#fail(post), X_POST_TIMEOUT_MS);
  }

  /** 読み込みを取り消して、元の引用に戻す（失敗にはしない） */
  #cancel(post: XPostFrame): void {
    this.#stopTimer(post);
    post.phase = "idle";
    post.frame = null;
    post.src = null;
    post.height = null;
  }

  #fail(post: XPostFrame): void {
    this.#stopTimer(post);
    post.phase = "failed";
    post.frame = null;
    post.src = null;
    post.height = null;
    this.#failed.add(post.id);
    this.#pump();
  }

  #stopTimer(post: XPostFrame): void {
    if (post.timer !== null) clearTimeout(post.timer);
    post.timer = null;
  }

  #receive(event: MessageEvent): void {
    if (event.origin !== this.#origin || event.source === null) return;
    let post: XPostFrame | undefined;
    for (const candidate of this.#posts) {
      if (candidate.frame !== null && candidate.frame.contentWindow === event.source) {
        post = candidate;
        break;
      }
    }
    if (post === undefined) return;
    const data: unknown = event.data;
    if (typeof data !== "object" || data === null) return;
    const { type, height } = data as { type?: unknown; height?: unknown };
    if (type === RENDERED) {
      if (!isXPostHeight(height)) return;
      if (post.phase === "loading") {
        this.#stopTimer(post);
        post.phase = "shown";
        post.height = height;
        this.#pump();
      } else if (post.phase === "shown") {
        // 2 回目からは、高さを付け直すだけ
        post.height = height;
      }
    } else if (type === FAILED) {
      if (post.phase === "loading") this.#fail(post);
    }
  }
}

const KEY = Symbol("x-post-loader");

/** 記事の画面が、本文の中の投稿に渡す。隔離フレームのオリジンが未設定なら null（iframe を作らない） */
export function setXPostLoader(loader: XPostLoader | null): void {
  setContext(KEY, loader);
}

export function useXPostLoader(): XPostLoader | null {
  return getContext<XPostLoader | null | undefined>(KEY) ?? null;
}
