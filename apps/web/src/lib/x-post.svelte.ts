/**
 * 記事の中の X の投稿を、隔離フレームの公式ウィジェットで出す順番と時間を決める
 * （docs/decisions/embeds.md の 2 と 4）。
 *
 * 記事の画面（ArticleView）が 1 つ作り、本文の中の投稿の部品（XPost）が、自分を登録する。
 *
 * - 投稿が表示範囲（ツールバーの下は数えない）に入ったら、iframe の src を付けて読み込みを始める。
 *   読者の設定（reader.xPosts）で切ってあるとき、読書位置が決まる前（setReady の前）、オフラインの
 *   間、文書が裏に回っている間は、始めない
 * - 同時に読み込む（rendered か失敗を待つ）のは 4 つまで。空いたら、表示範囲に入っているものから
 *   始める。読み込み中に表示範囲から出たもの（裏に回ったときも）は、iframe を外して数から外し、
 *   元の引用に戻す。覚えた高さの枠を取っていたものは、その高さの空の枠に戻す（入り直したら、最初から
 *   読み込む）
 * - 読み込み直し・戻る・進むで記事を開いたときは、前に出した投稿の高さの枠を、読み込む前から取る
 *   （embeds.md の 5）。読み込めなくなったら（オフライン、設定を切った）、失敗したら、元の引用に戻す
 * - 成功は、最初の rendered。失敗は、failed か、表示範囲に入ったまま 10 秒たったとき。失敗した投稿は、
 *   その記事を開いている間（reset まで）、やり直さない
 * - メッセージは、送り元のオリジンが隔離フレームのオリジンで、送り元の窓がその投稿の iframe のもの
 *   だけを受ける
 */
import { getContext, setContext } from "svelte";
import { MAX_X_POST_SIZES, type XPostSize } from "./x-post-size";

/** 同時に読み込む数の上限 */
export const X_POST_LOADING_LIMIT = 4;
/** 表示範囲に入ったまま、これだけたっても rendered が来なければ、失敗にする（ms） */
export const X_POST_TIMEOUT_MS = 10_000;
/** 枠の幅の上限（px）。X のウィジェットは 550px で止まる（XPost.svelte の CSS と同じ） */
export const X_POST_MAX_WIDTH = 550;
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
  /**
   * 読み込みを始めた回数。部品は、これが替わるたびに iframe を作り直す（取り消してすぐ始め直したとき、
   * src が同じでも、前の iframe を使い続けない）
   */
  attempt = $state(0);
  /** ウィジェットの高さ（px）。null の間は、元の引用を出し、iframe は場所を取らない */
  height = $state<number | null>(null);
  /**
   * 覚えた高さ（px。embeds.md の 5）。読み込み直し・戻る・進むで記事を開いたときに、前に出したときと
   * 同じ幅なら、出るまで（height が付くまで）元の引用の代わりに、この高さの枠を取る
   */
  reserved = $state<number | null>(null);

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
  /** 読者の設定（reader.xPosts）。切ってあれば、読み込まない */
  #enabled = true;
  #online = navigator.onLine;
  /** 文書が見えている。裏に回ったタブやアプリでは、表示範囲に入っているとは数えない */
  #shown = document.visibilityState === "visible";
  #observer: IntersectionObserver | null = null;
  #root: Element | null = null;
  #margin = "0px";
  /** 記事を開いたときに読み戻した、前に出した投稿の大きさ。読書位置が決まるまで、枠を取るのに使う */
  #restoring: Map<string, XPostSize> | null = null;
  /** この記事で出した投稿の大きさ。位置と一緒に、履歴の項目に覚える */
  #sizes = new Map<string, XPostSize>();

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
      // 読み込み中のものは、失敗にせず取り消す。覚えた高さの枠も、元の引用に戻す（embeds.md の 5）。
      // つながったら、表示範囲に入っているものから、元の引用から読み込む
      this.#cancelLoading();
      this.#dropReserved();
    };
    const onVisibility = () => {
      this.#shown = document.visibilityState === "visible";
      // 裏に回った間は、ブラウザーが枠の描画を止め、rendered が来ない。表示範囲から出たのと同じに、
      // 読み込み中のものは失敗にせず外し、前に出たら、表示範囲に入っているものから始め直す
      if (this.#shown) this.#pump();
      else for (const post of this.#posts) if (post.phase === "loading") this.#release(post);
    };
    window.addEventListener("message", onMessage);
    document.addEventListener("visibilitychange", onVisibility);
    window.addEventListener("online", onOnline);
    window.addEventListener("offline", onOffline);
    return () => {
      window.removeEventListener("message", onMessage);
      window.removeEventListener("online", onOnline);
      window.removeEventListener("offline", onOffline);
      document.removeEventListener("visibilitychange", onVisibility);
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
      this.#cancelLoading();
      return;
    }
    // 覚えた高さの枠を取るのは、位置を戻すまで。そのあとに替わった本文には当てない
    this.#restoring = null;
    this.#observe();
  }

  /**
   * 読者の設定で、読み込むか。切ったら、出ているウィジェットも読み込み中のものも外して、元の引用に
   * 戻す（そのあとは X へ通信しない）。入れたら、表示範囲に入っているものから始める
   */
  setEnabled(enabled: boolean): void {
    if (enabled === this.#enabled) return;
    this.#enabled = enabled;
    if (enabled) {
      this.#pump();
      return;
    }
    for (const post of this.#posts) {
      if (post.phase === "loading" || post.phase === "shown") this.#cancel(post);
    }
    this.#dropReserved();
  }

  /** 記事が替わった。失敗の覚えと、出した投稿の大きさを捨てる */
  reset(): void {
    this.#failed.clear();
    this.#sizes.clear();
    this.#restoring = null;
  }

  /**
   * 記事を開いたときに、履歴の項目から読み戻した投稿の大きさを渡す。読書位置が決まるまでに出た
   * 投稿は、同じ幅なら、その高さの枠を取る。まだ出していない投稿の大きさも、次に覚えるときまで残す
   */
  restore(sizes: readonly XPostSize[]): void {
    this.#restoring = sizes.length > 0 ? new Map(sizes.map((size) => [size.id, size])) : null;
    this.#sizes = new Map(sizes.map((size) => [size.id, size]));
  }

  /**
   * 出した投稿の大きさ（履歴の項目に覚える）。元の引用に戻した投稿のものは、書かない（元の引用の
   * 高さで決まった位置と、食い違う）。本文から消えた投稿のものは残る（その本文を出すときにだけ当たる）。
   * 上限を超えたら、新しく覚えたものを残す
   */
  sizes(): XPostSize[] {
    return [...this.#sizes.values()].slice(-MAX_X_POST_SIZES);
  }

  /** 本文の中の投稿を登録する */
  add(id: string, element: Element): XPostFrame {
    const post = new XPostFrame(id, element, this.#origin);
    // 覚えた高さの枠は、読み込めるときで、幅が前と同じときだけ取る（幅が違うと、高さも違う）
    const remembered = this.#restoring?.get(id);
    if (remembered !== undefined && this.#enabled && this.#online) {
      if (frameWidth(element) === remembered.width) post.reserved = remembered.height;
    }
    // 枠を取らなかった投稿は、元の引用を出すので、大きさを覚えておかない。枠を取ったら、覚え直す
    // （位置が決まる前に本文が替わり、同じ投稿を登録し直したとき）
    if (post.reserved === null) this.#sizes.delete(id);
    else if (remembered !== undefined) this.#sizes.set(id, remembered);
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
      if (!post.visible && post.phase === "loading") this.#release(post);
    }
    this.#pump();
  }

  /** 空いている分だけ、表示範囲に入っている投稿の読み込みを始める */
  #pump(): void {
    if (!this.#enabled || !this.#ready || !this.#online || !this.#shown) return;
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
    post.attempt += 1;
    post.frame = null;
    post.height = null;
    // 渡すのは、投稿の ID とテーマだけ
    post.src = `${this.#origin}/#id=${post.id}&theme=${currentTheme()}`;
    post.timer = setTimeout(() => this.#fail(post), X_POST_TIMEOUT_MS);
  }

  #cancelLoading(): void {
    for (const post of this.#posts) if (post.phase === "loading") this.#cancel(post);
  }

  /**
   * 読み込み中の投稿が、表示範囲から出た（裏に回った）。iframe を外して、数から外す（失敗にはしない）。
   * 覚えた高さの枠を取っていた投稿は、その高さの空の枠に戻し（位置を動かさない）、大きさも覚えたまま
   * にする。ほかは、元の引用に戻す（embeds.md の 4、5）
   */
  #release(post: XPostFrame): void {
    if (post.reserved === null) {
      this.#cancel(post);
      return;
    }
    this.#stopTimer(post);
    post.phase = "idle";
    post.frame = null;
    post.src = null;
    post.height = null;
  }

  /** 読み込んでいない投稿の、覚えた高さの枠を外して、元の引用に戻す（読み込めなくなった） */
  #dropReserved(): void {
    for (const post of this.#posts) {
      if (post.phase !== "idle" || post.reserved === null) continue;
      post.reserved = null;
      this.#sizes.delete(post.id);
    }
  }

  /** 読み込みを取り消して、元の引用に戻す（失敗にはしない） */
  #cancel(post: XPostFrame): void {
    // 元の引用に戻すので、大きさも忘れる（出しているときに、位置と一緒に覚え直す）
    if (post.phase !== "idle" || post.reserved !== null) this.#sizes.delete(post.id);
    this.#stopTimer(post);
    post.phase = "idle";
    post.frame = null;
    post.src = null;
    post.height = null;
    post.reserved = null;
  }

  #fail(post: XPostFrame): void {
    this.#stopTimer(post);
    post.phase = "failed";
    post.frame = null;
    post.src = null;
    post.height = null;
    post.reserved = null;
    this.#failed.add(post.id);
    // 失敗した投稿の大きさは覚えない。同じ投稿がほかにもあれば（同じ投稿を 2 回引いた記事）、
    // やり直さないので、覚えた高さの空の枠も元の引用に戻す
    this.#sizes.delete(post.id);
    for (const other of this.#posts) {
      if (other.id === post.id && other.phase === "idle") other.reserved = null;
    }
    this.#pump();
  }

  /** 表示範囲の中で受けた大きさを覚える（画面の外で受けた高さは、覚えない） */
  #remember(post: XPostFrame, height: number): void {
    if (!post.visible || post.frame === null) return;
    const width = Math.round(post.frame.getBoundingClientRect().width);
    this.#sizes.delete(post.id);
    this.#sizes.set(post.id, { id: post.id, width, height });
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
        post.reserved = null;
        this.#remember(post, height);
        this.#pump();
      } else if (post.phase === "shown") {
        // 2 回目からは、高さを付け直すだけ
        post.height = height;
        this.#remember(post, height);
      }
    } else if (type === FAILED) {
      if (post.phase === "loading") this.#fail(post);
    }
  }
}

/** 投稿の枠の幅（px、整数）。本文の幅に合わせ、上限は 550px */
function frameWidth(element: Element): number {
  return Math.round(Math.min(element.getBoundingClientRect().width, X_POST_MAX_WIDTH));
}

const KEY = Symbol("x-post-loader");

/** 記事の画面が、本文の中の投稿に渡す。隔離フレームのオリジンが未設定なら null（iframe を作らない） */
export function setXPostLoader(loader: XPostLoader | null): void {
  setContext(KEY, loader);
}

export function useXPostLoader(): XPostLoader | null {
  return getContext<XPostLoader | null | undefined>(KEY) ?? null;
}
