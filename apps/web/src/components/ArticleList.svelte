<script lang="ts">
  import {
    type Article,
    BELL_WORDS_PROBLEMS,
    parseBellWords,
    wordBellChange,
  } from "@sendo-reader/core";
  import { tick, untrack } from "svelte";
  import { BellList } from "../lib/bells.svelte";
  import { useReader } from "../lib/context";
  import { describeError } from "../lib/errors";
  import { compactCount, dayLabel, shortTime } from "../lib/format";
  import {
    layout,
    reducedMotion,
    scrollToTop as scrollPage,
    scrollTopOf,
  } from "../lib/layout.svelte";
  import type { ArticleListState, ListProgress } from "../lib/list.svelte";
  import { notificationSuggestion } from "../lib/notification-suggestion.svelte";
  import { prefs, type ViewOptions } from "../lib/prefs.svelte";
  import { handleLink, isPlainClick, type ListAnchor, router } from "../lib/router.svelte";
  import { listTitle, translationLabel } from "../lib/translation";
  import ArticleListItem from "./ArticleListItem.svelte";
  import Icon from "./Icon.svelte";
  import ReadCelebration from "./ReadCelebration.svelte";
  import SavedPages from "./SavedPages.svelte";

  let {
    list,
    title,
    kind,
    unread,
    onmarkall,
    progress,
    onprogress,
    search,
    onsearch,
    options,
    onoption,
    next,
  }: {
    list: ArticleListState;
    title: string;
    /** 開いている一覧の種類。空のときの文と、出す操作を決める */
    kind: "all" | "recentlyRead" | "starred" | "feed" | "folder" | "search";
    /** 検索の画面で探している言葉（検索でなければ null） */
    search: string | null;
    onsearch: (query: string) => void;
    /** この一覧の範囲にある未読の数（まとめて既読にできないなら null） */
    unread: number | null;
    onmarkall: () => void;
    /** この一覧の進み具合（出さない一覧は null） */
    progress: ListProgress | null;
    onprogress: () => void;
    /** この一覧の表示の設定（一覧ごとに覚える） */
    options: ViewOptions;
    onoption: (patch: Partial<ViewOptions>) => void;
    /** 一覧の終わりに出す、次へ進むボタン（出さないなら null） */
    next: { label: string; go: () => void } | null;
  } = $props();

  const reader = useReader();

  /** 未読だけに絞れる一覧（スターと検索は、絞らない） */
  const filterable = $derived(kind === "all" || kind === "feed" || kind === "folder");

  /** 一覧の中で、いま開いている（開いていなければ、キーボードで選んでいる）記事 */
  const currentId = $derived(router.articleId ?? list.cursorId);

  /** 記事と、その前に日付の見出しを出すなら、その文 */
  const rows = $derived.by(() => {
    const now = Date.now();
    let previous = "";
    const ids =
      reader.workspaceIds === undefined ? null : new Set(reader.scopeFeeds.map((feed) => feed.id));
    return list.articles
      .filter((article) => ids === null || ids.has(article.feedId))
      .map((article) => {
        const label = dayLabel(
          kind === "recentlyRead" ? (article.readAt ?? article.publishedAt) : article.publishedAt,
          now,
        );
        const heading = label === previous ? null : label;
        previous = label;
        return { article, heading };
      });
  });

  function articleHref(id: string): string {
    const url = new URL(router.url);
    url.searchParams.set("article", id);
    return url.pathname + url.search;
  }

  function open(event: MouseEvent, id: string) {
    if (!isPlainClick(event)) return;
    event.preventDefault();
    router.openArticle(id);
  }

  let scroller = $state<HTMLElement>();

  // 開いている（選んでいる）記事が替わったら、一覧の中で見えるところまで動かす
  $effect(() => {
    const id = currentId;
    if (id === null || scroller === undefined) return;
    for (const row of scroller.querySelectorAll<HTMLElement>(".row[data-article]")) {
      if (row.dataset.article === id) {
        row.scrollIntoView({ block: "nearest" });
        break;
      }
    }
  });

  /**
   * 一覧を動かして、見出しの下へ入りはじめた未読の記事を、既読にする（設定で切れる）。
   * 行がすっかり消えるのを待たず、行の上の端が見出しの下に隠れたら既読にする（Feedly と同じ。
   * 動かすのをやめたときに、上に半分残っている行も、もう読み終えた行だから）。
   * 見るのは記事の行（.row）で、その上に付く日付の見出しは数えない。
   * 行ごとに位置を測らず、IntersectionObserver の知らせで拾う。少しためてから、まとめて書く
   */
  let observer: IntersectionObserver | undefined;
  /** 見ている行（狭い画面と広い画面を行き来したら、見る相手を替えて、見直す） */
  const watched = new Set<HTMLElement>();
  /**
   * 上の端まで見えていたことのある行。そうでない行（別の一覧に替えた直後に上にある行、開いたときから
   * 上が切れている行）は、通り過ぎたのではないので数えない
   */
  let seen = new WeakSet<Element>();
  const passed = new Set<string>();
  let flushTimer: ReturnType<typeof setTimeout> | undefined;
  /** スクロールで残りの未読を読み切り、手元への書き込みも終えた一覧 */
  let finishedScroll = $state<number | null>(null);
  let completed = $state(false);
  const endCompleted = $derived(
    completed &&
      !list.loading &&
      !list.hasMore &&
      (unread === 0 || list.fresh > 0) &&
      list.articles.every((article) => article.readAt !== null),
  );
  const showNewAtEnd = $derived(endCompleted && list.fresh > 0);
  // 最後の行が見出しを通り過ぎても、そのままブラウザの慣性で進める距離（px）
  const endScrollSpace = $derived(filterable && prefs.value.markReadOnScroll ? 72 : 0);
  const END_SWIPE_THRESHOLD = 64;

  async function flushPassed() {
    const targets = new Set(passed);
    const ids = [...targets];
    passed.clear();
    const generation = list.generation;
    const finishes =
      filterable &&
      !list.hasMore &&
      list.articles.some((article) => article.readAt === null && targets.has(article.id)) &&
      list.articles.every((article) => article.readAt !== null || targets.has(article.id));
    try {
      await list.markRead(ids);
      if (finishes && generation === list.generation) finishedScroll = generation;
    } catch {
      // 書けなかったら、一覧が手元の DB の状態に戻る。完了にはしない
    }
  }

  // 新着を取り込む前も、表示中の最後の未読をスクロールで読み切ったら祝う。
  // 既読にした行は残るので、戻ってもう一度通っても、同じ一覧では繰り返さない
  $effect(() => {
    if (
      finishedScroll === list.generation &&
      !completed &&
      !list.loading &&
      !list.hasMore &&
      router.articleId === null &&
      (unread === 0 || list.fresh > 0) &&
      list.articles.length > 0 &&
      list.articles.every((article) => article.readAt !== null)
    )
      completed = true;
  });

  /** 最後の行も見出しを通過できるだけの余白。表示しただけでは既読にせず、いつもと同じ判定を使う */
  function endSpace(
    node: HTMLElement,
    options: { enabled: boolean; pageScroll: boolean; extra: number },
  ) {
    function measure() {
      const viewport = options.pageScroll ? window.innerHeight : (scroller?.clientHeight ?? 0);
      const header = scroller?.querySelector("header")?.offsetHeight ?? 0;
      // 狭い画面ではページ末尾に下のバーの余白もある。その分を引き、完了表示が見出しの裏へ
      // 行きすぎないようにする（安全領域は --tabs-height に含まれる）
      node.style.minHeight = options.enabled
        ? `calc(${Math.max(0, viewport - header + 2 + options.extra)}px - ${options.pageScroll ? "var(--tabs-height, 0px)" : "0px"})`
        : "";
    }
    const resize = new ResizeObserver(measure);
    const header = scroller?.querySelector("header");
    if (header !== null && header !== undefined) resize.observe(header);
    if (!options.pageScroll && scroller !== undefined) resize.observe(scroller);
    window.addEventListener("resize", measure);
    measure();
    return {
      update(value: typeof options) {
        options = value;
        if (scroller !== undefined) {
          resize.unobserve(scroller);
          if (!options.pageScroll) resize.observe(scroller);
        }
        measure();
      },
      destroy() {
        resize.disconnect();
        window.removeEventListener("resize", measure);
      },
    };
  }

  function onPass(entries: IntersectionObserverEntry[]) {
    if (list.loading) return;
    for (const entry of entries) {
      const bounds = entry.rootBounds;
      const rect = entry.boundingClientRect;
      // 一覧を出していないとき（狭い画面で記事を開いている）は、位置が分からないので何もしない
      if (bounds === null || bounds.height === 0 || rect.height === 0) continue;
      // 上の端が見出しより下にある。見えているなら覚えておく（下にあって見えていない行は、まだ）
      if (rect.top >= bounds.top - 1) {
        if (entry.isIntersecting) seen.add(entry.target);
        continue;
      }
      // 監視を始めたときの知らせなど、上の端まで見えたことのない行は、通り過ぎたのではない
      if (!seen.has(entry.target)) continue;
      const id = (entry.target as HTMLElement).dataset.article;
      // 検索と最近読んだ一覧では、見返しているだけなので、通り過ぎても既読にしない
      if (
        id !== undefined &&
        prefs.value.markReadOnScroll &&
        kind !== "search" &&
        kind !== "recentlyRead"
      )
        passed.add(id);
    }
    if (passed.size === 0) return;
    clearTimeout(flushTimer);
    flushTimer = setTimeout(flushPassed, 250);
  }

  /**
   * 行を見る IntersectionObserver。狭い画面ではページ全体が動くので画面（root: null）を、
   * 広い画面では一覧の欄を相手にする。どちらも、貼り付いた見出しの分だけ上を狭める
   */
  function passObserver(): IntersectionObserver {
    if (observer !== undefined) return observer;
    const header = scroller?.querySelector("header");
    observer = new IntersectionObserver(onPass, {
      root: layout.pageScroll ? null : (scroller ?? null),
      rootMargin: `-${header?.offsetHeight ?? 0}px 0px 0px 0px`,
      // 上の端が隠れはじめたとき（すべて見えている → 一部）にも知らせてもらう。端数で 1 に
      // ならない行のために、少し手前にも置く
      threshold: [0, 0.9, 1],
    });
    return observer;
  }

  function watchPass(node: HTMLElement) {
    watched.add(node);
    passObserver().observe(node);
    return {
      destroy: () => {
        watched.delete(node);
        observer?.unobserve(node);
      },
    };
  }

  /** 行を見直す。forget なら、上の端まで見えていた行も忘れる（いまの位置から数え直す） */
  function rewatch(forget = false) {
    // まだ届けていない知らせも捨てる（見直す前の位置の知らせで、既読にしない）
    observer?.takeRecords();
    observer?.disconnect();
    observer = undefined;
    if (forget) seen = new WeakSet();
    for (const node of watched) passObserver().observe(node);
  }

  // 狭い画面と広い画面を行き来したら（窓の幅を変えた、端末を回した）、見る相手を替える
  $effect(() => {
    void layout.pageScroll;
    untrack(() => rewatch());
  });

  // 別の一覧に替えたら、先頭に戻す（前の一覧の位置のまま、新しい一覧の途中を出さない）
  $effect(() => {
    void list.opened;
    passed.clear();
    finishedScroll = null;
    completed = false;
    scrollPage(scroller);
    return () => clearTimeout(flushTimer);
  });

  /** 探す言葉を打つたびに探す。打っている途中で何度も探さないように、少し待つ */
  let searchTimer: ReturnType<typeof setTimeout> | undefined;

  function onSearchInput(event: Event & { currentTarget: HTMLInputElement }) {
    const value = event.currentTarget.value;
    typed = value;
    clearTimeout(searchTimer);
    searchTimer = setTimeout(() => onsearch(value), 200);
  }

  // 検索の画面を離れたら（別の一覧に替えた、購読の管理へ移った）、待っている検索を捨てる。
  // 残しておくと、移った先から検索の画面に引き戻してしまう
  $effect(() => {
    if (search === null) clearTimeout(searchTimer);
    return () => clearTimeout(searchTimer);
  });

  /**
   * 探す言葉のベル（言葉だけのベル。sendo の docs/decisions/notifications.md の 1）。言葉が空なら
   * 出さない。押したらすぐ出し、手元の DB と操作キューに積む（sendo へは同期で送る）。sendo の上限を
   * 超える言葉は、積む前に知らせる
   */
  const bellList = new BellList(reader.client);
  const searching = $derived(search !== null);
  const userId = $derived(reader.user?.id);
  $effect(() => {
    if (!searching || userId === undefined) return;
    return bellList.watch();
  });
  /**
   * 入力にある言葉（探すのを待っている間も、打った値）。ベルを出すか、その見込み、押したときの言葉は、
   * これで決める（空の検索から打ってすぐ押せるように）。探す言葉が替わったら（探し終えた、戻る・
   * 進む、別の画面から来た）、それにそろう
   */
  let typed = $derived(search);
  const searchBell = $derived(typed === null ? null : bellFor(typed));
  /** 押して付けられなかった理由（その言葉が入力にある間だけ出す） */
  let bellError = $state<{ search: string; message: string } | null>(null);

  /** その言葉のベル。言葉が空なら null */
  function bellFor(query: string) {
    const parsed = parseBellWords(query);
    if (parsed === "empty") return null;
    if (typeof parsed === "string") return { label: query.trim(), problem: parsed, on: false };
    const on = bellList.bells.some(
      (bell) => bell.feedId === null && bell.matchKey === parsed.matchKey,
    );
    return { label: parsed.words, words: parsed, problem: null, on };
  }

  async function toggleSearchBell() {
    // 打ってすぐ押したら、待っている検索を先に流し、入力にある言葉に付ける
    const input = typed;
    if (input === null) return;
    if (input !== search) {
      clearTimeout(searchTimer);
      onsearch(input);
    }
    const bell = bellFor(input);
    if (bell === null) return;
    if (bell.problem !== null) {
      bellError = { search: input, message: BELL_WORDS_PROBLEMS[bell.problem] };
      return;
    }
    const words = bell.words;
    const on = !bell.on;
    bellError = null;
    try {
      await bellList.change(
        (bells) => wordBellChange(bells, words, on),
        () => reader.client.setWordBell(input, on),
      );
      // 付けたら、この端末で通知を受けていなければ勧める（docs/decisions/notifications.md の 1）。
      // 確かめている間にもう一度押して外したら、勧めない
      if (on) {
        void notificationSuggestion.offer(() =>
          bellList.bells.some((bell) => bell.feedId === null && bell.matchKey === words.matchKey),
        );
      }
    } catch (error) {
      bellError = { search: input, message: describeError(error) };
    }
  }

  /** Enter か Esc で、入力から抜ける（そのあと j / k で結果を移れる。スマホではキーボードを閉じる） */
  function onSearchKeydown(event: KeyboardEvent & { currentTarget: HTMLInputElement }) {
    if (event.isComposing || (event.key !== "Enter" && event.key !== "Escape")) return;
    event.preventDefault();
    event.currentTarget.blur();
  }

  /** 検索の画面を開いたら、すぐ打てるようにする */
  function focusOnOpen(node: HTMLInputElement) {
    node.focus();
  }

  /** 一覧の終わりが近づいたら、続きを読む */
  function autoload(node: HTMLElement, pageScroll: boolean) {
    let observer: IntersectionObserver | undefined;
    function watch(pageScroll: boolean) {
      observer?.disconnect();
      observer = new IntersectionObserver(
        (entries) => {
          if (entries.some((entry) => entry.isIntersecting)) void list.loadMore();
        },
        { root: pageScroll ? null : node.closest(".article-list"), rootMargin: "600px" },
      );
      observer.observe(node);
    }
    watch(pageScroll);
    return { update: watch, destroy: () => observer?.disconnect() };
  }

  /** その向き（dx が正なら右へ）のスワイプに割り当てた操作（設定で変えられる） */
  function swipeAction(dx: number) {
    return dx > 0 ? prefs.value.swipes.listRight : prefs.value.swipes.listLeft;
  }

  /** これだけ横に動かして離したら、操作する（px） */
  const SWIPE = 72;
  /** 離したあと、行が元の位置に戻るまで（ミリ秒）。CSS の transition と揃える */
  const SETTLE = 200;

  /**
   * 指で行を横にスワイプする。割り当ては設定で変えられる（既定は、右でスター、左で既読・未読）。
   * 縦に動かし始めたら、一覧を動かすだけにする（行は touch-action: pan-y）
   */
  function swipe(node: HTMLElement, article: Article) {
    let current = article;
    let startX = 0;
    let startY = 0;
    let dx = 0;
    let tracking = false;
    let sideways = false;
    /** 指で触れている間。この間の contextmenu（長く押したとき）は止める */
    let touching = false;

    /**
     * 指で長く押したときに、ブラウザが出すリンクのメニューを止める（Android の Chrome は
     * -webkit-touch-callout を見ない）。マウスの右クリックは、ブラウザの既定のメニューに任せる
     */
    function onContextMenu(event: MouseEvent) {
      const pointer = (event as PointerEvent).pointerType;
      if (touching || pointer === "touch" || pointer === "pen") event.preventDefault();
    }

    /** 離したあと、行を元の位置に戻し終えるまでの待ち */
    let settleTimer: ReturnType<typeof setTimeout> | undefined;

    function reset() {
      clearTimeout(settleTimer);
      tracking = false;
      sideways = false;
      // class は Svelte が書き直すので、data 属性で持つ
      delete node.dataset.swiping;
      delete node.dataset.armed;
      delete node.dataset.settling;
      node.style.removeProperty("--swipe");
    }

    /**
     * 指を離した。行を、なめらかに元の位置へ戻す（一瞬で戻すと、動きが硬く見える）。
     * 戻るまでは、下に出した操作（色と文字）も残し、何をしたかが分かるようにする
     */
    function settle() {
      if (node.dataset.swiping === undefined || reducedMotion()) return reset();
      tracking = false;
      sideways = false;
      node.dataset.settling = "";
      node.style.setProperty("--swipe", "0px");
      settleTimer = setTimeout(reset, SETTLE);
    }

    function onStart(event: TouchEvent) {
      const touch = event.touches[0];
      // 戻している最中に触れたら、戻し終えたことにして、新しく始める
      if (node.dataset.settling !== undefined) reset();
      touching = true;
      if (event.touches.length !== 1 || touch === undefined) return reset();
      startX = touch.clientX;
      startY = touch.clientY;
      dx = 0;
      tracking = true;
      sideways = false;
    }

    function onMove(event: TouchEvent) {
      const touch = event.touches[0];
      if (!tracking || touch === undefined) return;
      const x = touch.clientX - startX;
      const y = touch.clientY - startY;
      if (!sideways) {
        if (Math.abs(x) < 10 && Math.abs(y) < 10) return;
        if (Math.abs(y) >= Math.abs(x)) return reset();
        sideways = true;
        node.dataset.swiping = "";
      }
      dx = Math.max(-SWIPE * 1.6, Math.min(SWIPE * 1.6, x));
      const action = swipeAction(dx);
      // その向きに何も割り当てていなければ、行は動かさない
      if (action === "none") return reset();
      node.dataset.swipe = action;
      node.dataset.swipeSide = dx > 0 ? "start" : "end";
      node.dataset.swipeLabel =
        action === "read"
          ? current.readAt === null
            ? "Mark as read"
            : "Mark as unread"
          : current.starredAt === null
            ? "Save"
            : "Unsave";
      node.style.setProperty("--swipe", `${dx}px`);
      if (Math.abs(dx) >= SWIPE) node.dataset.armed = "";
      else delete node.dataset.armed;
    }

    function onCancel() {
      touching = false;
      settle();
    }

    function onEnd() {
      touching = false;
      const action = swipeAction(dx);
      if (sideways && Math.abs(dx) >= SWIPE && action !== "none") {
        toggle(current, action === "read" ? "readAt" : "starredAt");
      }
      settle();
    }

    node.addEventListener("touchstart", onStart, { passive: true });
    node.addEventListener("touchmove", onMove, { passive: true });
    node.addEventListener("touchend", onEnd);
    node.addEventListener("touchcancel", onCancel);
    node.addEventListener("contextmenu", onContextMenu);
    return {
      update(next: Article) {
        current = next;
      },
      destroy() {
        node.removeEventListener("touchstart", onStart);
        node.removeEventListener("touchmove", onMove);
        node.removeEventListener("touchend", onEnd);
        node.removeEventListener("touchcancel", onCancel);
        node.removeEventListener("contextmenu", onContextMenu);
        clearTimeout(settleTimer);
      },
    };
  }

  /**
   * 一覧の先頭に戻る（見出しを押したとき、下のバーで今の画面をもう一度押したとき）。
   * 狭い画面では、iPhone の「画面のいちばん上を押す」でも戻る（ページ全体を動かしているので）
   */
  export function scrollToTop() {
    scrollPage(scroller, 0, true);
  }

  /**
   * 狭い画面で、記事を横に動かして戻る間、記事の後ろに一覧を見せる（Reader が一覧を画面に
   * 固定する）。その間はページではなく一覧の欄を、記事を開く前の位置まで動かしておく
   */
  export function peekAt(top: number) {
    if (scroller !== undefined) scroller.scrollTop = top;
  }

  /** 一覧の見えている範囲の上の端（貼り付いた見出しのすぐ下） */
  function visibleTop(): number {
    return scroller?.querySelector("header")?.getBoundingClientRect().bottom ?? 0;
  }

  function rowOf(id: string): HTMLElement | null {
    if (scroller === undefined) return null;
    for (const row of scroller.querySelectorAll<HTMLElement>(".row[data-article]")) {
      if (row.dataset.article === id) return row;
    }
    return null;
  }

  /**
   * いま見ている位置（見出しのすぐ下に出ている行の記事）。先頭にいるなら null。
   * 読み込み直したり戻ったりしたときに、restore で同じ位置に戻す
   */
  export function anchor(): ListAnchor | null {
    if (scroller === undefined || scrollTopOf(scroller) <= 0) return null;
    const top = visibleTop();
    let target: HTMLElement | undefined;
    let offset = 0;
    for (const row of scroller.querySelectorAll<HTMLElement>(".row[data-article]")) {
      const rect = row.getBoundingClientRect();
      if (rect.height === 0) continue;
      target = row;
      offset = rect.top - top;
      if (rect.bottom > top) break;
    }
    // 末尾の余白では、すべての行が見出しより上にある。最後の記事からの距離で位置を覚える
    const article = list.find(target?.dataset.article ?? null);
    if (article === null) return null;
    return { id: article.id, publishedAt: article.publishedAt, readAt: article.readAt, offset };
  }

  /**
   * anchor で覚えた位置に戻す。その記事が一覧から消えていたら（未読だけの一覧で既読にした）、
   * 並び順で次の記事を、見出しのすぐ下に出す。戻す前に動かし始めていたら、何もしない。
   * 戻すときに飛び越えた行は、通り過ぎたのではないので、既読にしない
   */
  export async function restore(anchor: ListAnchor): Promise<void> {
    const generation = list.generation;
    const url = router.url;
    const target = await list.seek(anchor);
    if (target === null || list.generation !== generation) return;
    // 見ていた記事より前が、すべて一覧から消えていた。先頭のまま出す
    if (target.id !== anchor.id && target.id === list.articles[0]?.id) return;
    await tick();
    // 狭い画面ではページ全体を動かす。待っている間に画面が替わったら、戻ってきていても動かさない
    if (layout.pageScroll && (router.url !== url || router.articleId !== null)) return;
    const row = rowOf(target.id);
    if (row === null || scrollTopOf(scroller) > 0) return;
    const offset = target.id === anchor.id ? anchor.offset : 0;
    const delta = row.getBoundingClientRect().top - visibleTop() - offset;
    scrollPage(scroller, scrollTopOf(scroller) + delta);
    passed.clear();
    rewatch(true);
  }

  export async function reload() {
    // 読み直す直前までに通り過ぎた行も、まとめて既読にする
    clearTimeout(flushTimer);
    if (passed.size > 0) void flushPassed();
    list.reloaded += 1;
    const loading = list.load();
    const generation = list.generation;
    try {
      await loading;
    } catch (error) {
      // 待つ間は行の通知を処理しなかったので、いま見えている位置から見直す
      if (generation === list.generation) rewatch(true);
      throw error;
    }
    if (generation !== list.generation) return;
    finishedScroll = null;
    completed = false;
    list.cursorId = null;
    passed.clear();
    // 狭い画面で記事を読んでいる間は、一覧だけを更新し、本文の位置は動かさない
    if (!layout.pageScroll || router.articleId === null) scrollPage(scroller);
    rewatch(true);
  }

  /** 引いた長さ（px）が、これを超えて指を離したら、更新する */
  const PULL_THRESHOLD = 72;
  const PULL_MAX = 260;
  /** 同期を待つ上限。届かなくても、手元の一覧は読み直す */
  const PULL_SYNC_TIMEOUT_MS = 8000;

  /** 一覧の先頭で、下に引いている長さ（px）。引いていなければ 0 */
  let pull = $state(0);
  /** 指で引いている最中（一覧を、指の動きにそのまま付いていかせる。離したら、なめらかに戻す） */
  let dragging = $state(false);
  let refreshing = $state(false);

  /**
   * 一覧を読み直して、同期する（先頭で下に引いたとき）。まず手元を読み直すので、ネットワークを
   * 待たずに、既読にした記事が消えて未読の先頭に戻る。そのあと同期し、届いた記事も入れる
   */
  async function refresh() {
    if (refreshing) return;
    refreshing = true;
    try {
      await reload();
      const loaded = list.generation;
      // 届かない、時間がかかる、のどちらでも、待つのはここまで
      await Promise.race([
        reader.client.syncNow().catch(() => {}),
        new Promise((resolve) => setTimeout(resolve, PULL_SYNC_TIMEOUT_MS)),
      ]);
      // 待っている間に、読み進めたり、別の一覧に移ったりしていたら、読み直さない（位置を先頭に
      // 戻さない、移った先の一覧を巻き込まない）。届いた記事は「新しい記事 N 件」で知らせる
      if (list.generation === loaded && scrollTopOf(scroller) <= 0) await reload();
    } catch {
      // 読み直せなくても、一覧は前のまま使える
    } finally {
      refreshing = false;
    }
  }

  /** 一覧の先頭で、指で下に引いたら更新する（マウスでは、何もしない） */
  function pullToRefresh(node: HTMLElement) {
    let startX = 0;
    let startY = 0;
    /** null はまだ向きが分からない。false は、引く動きではない（横のスワイプ、上への動き） */
    let pulling: boolean | null = false;

    function onStart(event: TouchEvent) {
      const touch = event.touches[0];
      pulling = false;
      if (event.touches.length !== 1 || touch === undefined) return;
      if (scrollTopOf(node) > 0 || refreshing) return;
      startX = touch.clientX;
      startY = touch.clientY;
      pulling = null;
    }

    function onMove(event: TouchEvent) {
      const touch = event.touches[0];
      if (pulling === false || touch === undefined) return;
      const dx = touch.clientX - startX;
      const dy = touch.clientY - startY;
      if (pulling === null) {
        if (Math.abs(dx) < 8 && Math.abs(dy) < 8) return;
        // 横に動かした（行のスワイプ）、上に動かした、途中で一覧が動いた、なら引く動きではない
        pulling = dy > 0 && Math.abs(dy) > Math.abs(dx) && scrollTopOf(node) <= 0;
        if (!pulling) return;
      }
      dragging = true;
      // 指より少し遅れて付いてくる（引いている手ごたえ）
      pull = Math.max(0, Math.min(PULL_MAX, dy * 0.6));
    }

    function onEnd() {
      const reached = pulling === true && pull >= PULL_THRESHOLD;
      onCancel();
      if (reached) void refresh();
    }

    /** ブラウザや OS がタッチを取り消した。引いた分を戻すだけで、更新はしない */
    function onCancel() {
      pulling = false;
      dragging = false;
      pull = 0;
    }

    node.addEventListener("touchstart", onStart, { passive: true });
    node.addEventListener("touchmove", onMove, { passive: true });
    node.addEventListener("touchend", onEnd);
    node.addEventListener("touchcancel", onCancel);
    return {
      destroy() {
        node.removeEventListener("touchstart", onStart);
        node.removeEventListener("touchmove", onMove);
        node.removeEventListener("touchend", onEnd);
        node.removeEventListener("touchcancel", onCancel);
      },
    };
  }

  /** 末尾で指を上に動かした分だけ完了欄を引く。読み切った後のスワイプで新着を開く */
  function pullPastEnd(footer: HTMLElement, _opened: number) {
    const listNode = footer.closest<HTMLElement>(".article-list");
    if (listNode === null) return;

    let start: Touch | undefined;
    let scrollRoot: Element | null = null;
    let lastY = 0;
    let remaining = 0;
    let upward = false;
    let distance = 0;
    let canContinue = false;

    function release() {
      start = undefined;
      scrollRoot = null;
      distance = 0;
      canContinue = false;
      footer.removeAttribute("data-end-dragging");
      footer.style.removeProperty("--end-pull");
    }

    function onStart(event: TouchEvent) {
      release();
      const touch = event.touches[0];
      if (event.touches.length !== 1 || touch === undefined) return;
      scrollRoot = layout.pageScroll ? document.scrollingElement : listNode;
      if (scrollRoot === null) return;
      remaining = scrollRoot.scrollHeight - scrollRoot.clientHeight - scrollRoot.scrollTop;
      // 読み切った指の動きがそのまま続いても開かず、末尾で始めた次のスワイプを待つ
      canContinue = layout.pageScroll && showNewAtEnd && remaining <= endScrollSpace + 2;
      if (!canContinue && reducedMotion()) return;
      start = touch;
      lastY = touch.clientY;
      upward = false;
    }

    function onMove(event: TouchEvent) {
      if (start === undefined || scrollRoot === null) return;
      const touch = event.touches.length === 1 ? event.touches[0] : undefined;
      if (touch === undefined || touch.identifier !== start.identifier) return release();
      const dy = lastY - touch.clientY;
      lastY = touch.clientY;
      if (!upward) {
        const x = Math.abs(touch.clientX - start.clientX);
        const y = start.clientY - touch.clientY;
        if (x < 10 && Math.abs(y) < 10) return;
        if (y <= x) return release();
        upward = true;
      }

      const before = remaining;
      const limit = scrollRoot.scrollHeight - scrollRoot.clientHeight;
      remaining = limit - scrollRoot.scrollTop;
      if (limit <= 0 || remaining > 1) {
        if (distance > 0) release();
        return;
      }

      // 末尾へ着いたタッチイベントは、通常のスクロールで使った分を引く
      const pastEnd = dy > 0 && before > 1 ? Math.max(0, dy - before) : dy;
      distance = Math.max(0, distance + pastEnd);
      if (reducedMotion()) return;
      footer.toggleAttribute("data-end-dragging", distance > 0);
      // 最初は指に付いていき、引くほど抵抗を強くする。見出しに隠れないように 24px まで
      footer.style.setProperty("--end-pull", `${(-24 * distance) / (64 + distance)}px`);
    }

    function onEnd() {
      const loadNew = canContinue && distance >= END_SWIPE_THRESHOLD && showNewAtEnd;
      release();
      if (loadNew) void reload();
    }

    listNode.addEventListener("touchstart", onStart, { passive: true });
    listNode.addEventListener("touchmove", onMove, { passive: true });
    listNode.addEventListener("touchend", onEnd);
    listNode.addEventListener("touchcancel", release);
    return {
      update: release,
      destroy() {
        release();
        listNode.removeEventListener("touchstart", onStart);
        listNode.removeEventListener("touchmove", onMove);
        listNode.removeEventListener("touchend", onEnd);
        listNode.removeEventListener("touchcancel", release);
      },
    };
  }

  function toggle(article: Article, field: "readAt" | "starredAt") {
    // 書けなかったら、一覧が手元の DB の状態に戻る
    list.toggle(article, field).catch(() => {});
  }
</script>

<section
  class="article-list"
  class:scope-checking={reader.workspaceIds !== undefined && !reader.workspaceDataReady}
  aria-label={title}
  bind:this={scroller}
  use:pullToRefresh
>
  <header>
    {#if progress !== null}
      <button
        type="button"
        class="gauge"
        aria-label={`Progress ${progress.percent}%`}
        title="Progress"
        onclick={onprogress}
      >
        <svg viewBox="0 0 36 36" aria-hidden="true">
          <circle class="track" cx="18" cy="18" r="15.9155" />
          {#if progress.percent > 0}
            <circle
              class="bar"
              cx="18"
              cy="18"
              r="15.9155"
              stroke-dasharray={`${progress.percent} 100`}
            />
          {/if}
        </svg>
        <span class="gauge-count" aria-hidden="true">{compactCount(progress.remaining)}</span>
      </button>
    {/if}
    {#if search !== null}
      <input
        class="search"
        type="search"
        enterkeyhint="search"
        autocomplete="off"
        placeholder="Search articles"
        aria-label="Search articles"
        value={search}
        oninput={onSearchInput}
        onkeydown={onSearchKeydown}
        use:focusOnOpen
      >
      {#if searchBell !== null}
        <button
          type="button"
          class="icon-button"
          aria-label="Bell: {searchBell.label}"
          aria-pressed={searchBell.on}
          title={searchBell.on ? "Turn off bell" : "Turn on bell"}
          onclick={toggleSearchBell}
        >
          <Icon name="bell" filled={searchBell.on} />
        </button>
      {/if}
    {:else}
      <h2>
        <button type="button" class="to-top" title="Back to top" onclick={scrollToTop}>
          <span class="name">{title}</span>
          {#if unread !== null && unread > 0}
            <span class="count">{unread}</span>
          {/if}
        </button>
      </h2>
    {/if}
    {#if filterable || kind === "recentlyRead"}
      <button
        type="button"
        class="icon-button"
        aria-pressed={options.unreadOnly}
        disabled={kind === "recentlyRead"}
        aria-label="Unread only"
        title="Unread only"
        onclick={() => onoption({ unreadOnly: !options.unreadOnly })}
      >
        <Icon name="filter" />
      </button>
    {/if}
    {#if unread !== null}
      <button
        type="button"
        class="icon-button"
        aria-label="Mark all as read"
        title="Mark all as read (Shift + A)"
        disabled={unread === 0}
        onclick={onmarkall}
      >
        <Icon name="checkAll" />
      </button>
    {/if}
  </header>
  {#if searchBell?.on}
    <p class="bell-note">
      <Icon name="bell" filled />
      <span>「{searchBell.label}」を含む新しい記事を、どのフィードでも知らせます。</span>
    </p>
  {/if}
  {#if bellError !== null && bellError.search === typed}
    <p class="bell-error" role="alert">{bellError.message}</p>
  {/if}

  <!--
    先頭で下に引いたときの、すき間。引いた分だけ一覧を下に押し、まんなかに、回る印だけを出す
    （文字は出さない）。離すと、更新している間は小さなすき間を残し、終わったら閉じる
  -->
  <div
    class="pull"
    class:dragging
    class:pull-busy={refreshing}
    style:height={refreshing ? undefined : `${pull}px`}
  >
    {#if pull > 0 || refreshing}
      <svg
        class="spinner"
        class:ready={pull >= PULL_THRESHOLD}
        viewBox="0 0 24 24"
        aria-hidden="true"
        style:opacity={refreshing ? undefined : String(Math.min(1, pull / PULL_THRESHOLD))}
        style:transform={refreshing ? undefined : `rotate(${Math.round(pull * 3)}deg)`}
      >
        <path d="M12 3a9 9 0 1 0 9 9" />
      </svg>
    {/if}
    {#if refreshing}
      <span class="visually-hidden" role="status">Refreshing…</span>
    {/if}
  </div>
  {#if list.fresh > 0}
    <button type="button" class="fresh" onclick={reload}>{list.fresh} new</button>
  {/if}

  {#if kind === "starred"}
    {#if reader.workspaceIds === undefined}
      <SavedPages />
    {/if}
  {/if}

  {#if search !== null && search.trim() === ""}
    <div class="empty">
      <Icon name="search" />
      <p>タイトル・要約・著者から、手元の記事を探します。</p>
      <p class="hint">空白で区切ると、すべての言葉が入っている記事だけを出します。</p>
    </div>
  {:else if list.loading && list.articles.length === 0}
    <div class="skeleton" aria-hidden="true">
      {#each [0, 1, 2, 3, 4, 5] as n (n)}
        <div></div>
      {/each}
    </div>
    <p class="visually-hidden" role="status">Loading…</p>
  {:else if list.articles.length === 0}
    <div class="empty">
      {#if kind === "recentlyRead"}
        <Icon name="history" />
        <p>まだ読んだ記事はありません。</p>
      {:else if kind === "starred"}
        <Icon name="bookmark" />
        <p>スターを付けた記事が、ここに並びます。</p>
      {:else if reader.feeds.length === 0}
        <Icon name="rss" />
        <p>まだフィードを購読していません。</p>
        <a href="/manage" onclick={(e) => handleLink(e, "/manage")}>Add a feed</a>
      {:else if filterable && options.unreadOnly}
        <Icon name="check" />
        <p>すべて読み終えました。</p>
      {:else if kind === "search"}
        <Icon name="search" />
        <p>見つかりませんでした。</p>
      {:else}
        <p>記事はありません。</p>
      {/if}
      {#if next !== null}
        <button type="button" class="primary" onclick={next.go}>{next.label}</button>
      {/if}
    </div>
  {:else}
    <ol>
      {#each rows as { article, heading } (article.id)}
        <li>
          {#if heading !== null}
            <h3>{heading}</h3>
          {/if}
          <div
            class="row"
            class:unread={article.readAt === null}
            class:current={currentId === article.id}
            data-article={article.id}
            use:watchPass
            use:swipe={article}
          >
            <ArticleListItem
              title={listTitle(article) ?? "(Untitled)"}
              translationLabel={translationLabel(article.translation)}
              feedTitle={reader.feedTitle(article.feedId)}
              time={shortTime(
                kind === "recentlyRead"
                  ? (article.readAt ?? article.publishedAt)
                  : article.publishedAt,
              )}
              unread={article.readAt === null}
              saved={article.starredAt !== null}
              feedIconUrl={reader.feedIcon(article.feedId)}
              thumbnailUrl={article.thumbnailUrl}
              href={articleHref(article.id)}
              current={router.articleId === article.id}
              onopen={(event) => open(event, article.id)}
            />
            <span class="actions">
              <button
                type="button"
                class="icon-button"
                aria-label={article.readAt === null ? "Mark as read" : "Mark as unread"}
                title={article.readAt === null ? "Mark as read" : "Mark as unread"}
                onclick={() => toggle(article, "readAt")}
              >
                <Icon name={article.readAt === null ? "check" : "circle"} />
              </button>
              <button
                type="button"
                class="icon-button save"
                aria-pressed={article.starredAt !== null}
                aria-label={article.starredAt === null ? "Save" : "Unsave"}
                title={article.starredAt === null ? "Save" : "Unsave"}
                onclick={() => toggle(article, "starredAt")}
              >
                <Icon name="bookmark" filled={article.starredAt !== null} />
              </button>
            </span>
          </div>
        </li>
      {/each}
    </ol>
    {#if list.hasMore}
      <button
        type="button"
        class="more"
        use:autoload={layout.pageScroll}
        onclick={() => list.loadMore()}
        disabled={list.loadingMore}
      >
        {list.loadingMore ? "Loading…" : "Load more"}
      </button>
    {:else}
      <div
        class="end"
        class:completed={endCompleted}
        style:padding-top={endScrollSpace > 0 ? `calc(1.5rem + ${endScrollSpace}px)` : undefined}
        use:endSpace={{
          enabled:
            prefs.value.markReadOnScroll &&
            (reader.workspaceIds === undefined || reader.workspaceDataReady) &&
            kind !== "search" &&
            kind !== "recentlyRead",
          pageScroll: layout.pageScroll,
          extra: endScrollSpace,
        }}
      >
        <div class="end-content" use:pullPastEnd={list.opened}>
          {#if endCompleted}
            <Icon name="checkAll" />
            <p role="status">
              {showNewAtEnd ? "表示中の記事を読み終えました。" : "すべて読み終えました。"}
            </p>
          {:else}
            <p>End of list</p>
          {/if}
          {#if showNewAtEnd}
            <button type="button" class="primary" onclick={reload}>Load new articles</button>
          {:else if next !== null}
            <button type="button" class="primary" onclick={next.go}>{next.label}</button>
          {/if}
        </div>
      </div>
    {/if}
  {/if}
</section>

{#if completed}
  <ReadCelebration />
{/if}

<style>
  .scope-checking {
    visibility: hidden;
  }

  .article-list {
    display: flex;
    flex-direction: column;
    min-width: 0;
    overflow-y: auto;
    /*
     * 端まで動かしたときに、外側（ページ）を動かさず、ブラウザ自身の引っぱり（ゴムのような戻り）も
     * 出さない。先頭で下に引く動きは、更新に使う（すき間は、こちらで作る）
     */
    overscroll-behavior-y: none;
    border-right: 1px solid var(--border);
    background: var(--background);
  }

  /*
   * 狭い画面では、一覧の欄ではなくページ全体を動かす（docs/decisions/ui.md の 6。iPhone の
   * 「画面のいちばん上を押すと先頭に戻る」を効かせるため）。見出しは画面の上に貼り付く
   */
  @media (max-width: 56rem) {
    .article-list {
      overflow-y: visible;
      border-right: 0;
    }
  }

  /* 先頭で下に引いたときの、すき間。引いた分だけ、一覧を下に押す */
  .pull {
    display: flex;
    flex: none;
    align-items: center;
    justify-content: center;
    height: 0;
    overflow: hidden;
    transition: height 0.2s ease-out;
  }

  /* 引いている最中は、指の動きにそのまま付いていく */
  .pull.dragging {
    transition: none;
  }

  .pull-busy {
    height: 3.25rem;
  }

  .spinner {
    flex: none;
    width: 1.25rem;
    height: 1.25rem;
    fill: none;
    stroke: var(--faint);
    stroke-width: 2;
    stroke-linecap: round;
  }

  /* 離せば更新する、ところまで引いた */
  .spinner.ready {
    stroke: var(--accent);
  }

  .pull-busy .spinner {
    stroke: var(--muted);
    animation: pull-spin 0.8s linear infinite;
  }

  @keyframes pull-spin {
    to {
      transform: rotate(360deg);
    }
  }

  @media (prefers-reduced-motion: reduce) {
    .pull {
      transition: none;
    }

    .pull-busy .spinner {
      animation: none;
    }
  }

  header {
    position: sticky;
    top: 0;
    z-index: 1;
    display: flex;
    align-items: center;
    gap: 0.125rem;
    min-height: 3.25rem;
    padding: 0.5rem 0.5rem 0.5rem 1rem;
    border-bottom: 1px solid var(--border);
    background: var(--background);
  }

  /* この一覧の進み具合の輪。広い画面では左のメニューに出すので、狭い画面でだけ出す */
  .gauge {
    display: none;
    flex: none;
    position: relative;
    width: 2.5rem;
    height: 2.5rem;
    margin-right: 0.375rem;
    padding: 0.125rem;
    border: 0;
    border-radius: 50%;
    background: none;
  }

  /* 輪の中に、残っている未読の数を出す */
  .gauge-count {
    position: absolute;
    inset: 0;
    display: grid;
    place-items: center;
    color: var(--muted);
    font-size: 0.625rem;
    font-weight: 700;
    font-variant-numeric: tabular-nums;
  }

  .gauge svg {
    display: block;
    transform: rotate(-90deg);
    fill: none;
    stroke-width: 3.5;
  }

  .track {
    stroke: var(--hover);
  }

  .bar {
    stroke: var(--accent);
    stroke-linecap: round;
  }

  @media (max-width: 56rem) {
    .gauge {
      display: block;
    }

    /* 数は輪の中に出している */
    h2 .count {
      display: none;
    }
  }

  .search {
    flex: 1;
    min-width: 0;
    margin-right: 0.25rem;
    padding: 0.4rem 0.75rem;
    border-radius: 999px;
    background: var(--surface);
  }

  .bell-note,
  .bell-error {
    margin: 0;
    padding: 0.625rem 1rem;
    font-size: 0.8125rem;
    line-height: 1.6;
  }

  .bell-note {
    display: flex;
    gap: 0.5rem;
    align-items: flex-start;
    background: var(--selected);
    color: var(--accent-strong);
  }

  .bell-error {
    color: var(--danger);
  }

  .empty .hint {
    font-size: 0.8125rem;
    color: var(--faint);
  }

  h2 {
    display: flex;
    flex: 1;
    min-width: 0;
    margin: 0;
    font-size: 1.0625rem;
  }

  /* 見出しは、押すと一覧の先頭に戻る。見た目は見出しのまま、押せる範囲を見出しの幅いっぱいにする */
  h2 .to-top {
    display: flex;
    flex: 1;
    align-items: baseline;
    gap: 0.5rem;
    min-width: 0;
    min-height: 2.25rem;
    padding: 0;
    border: 0;
    background: none;
    font-weight: inherit;
    text-align: start;
  }

  h2 .to-top:hover {
    background: none;
  }

  h2 .name {
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }

  h2 .count {
    flex: none;
    color: var(--muted);
    font-size: 0.8125rem;
    font-weight: 500;
    font-variant-numeric: tabular-nums;
  }

  ol {
    list-style: none;
    margin: 0;
    padding: 0;
  }

  /* 画面の外の行は、描くのを後回しにする（長い一覧でも、動かしたときに重くしない） */
  li {
    content-visibility: auto;
    contain-intrinsic-size: auto 6.5rem;
  }

  h3 {
    margin: 0;
    padding: 0.875rem 1rem 0.25rem;
    color: var(--faint);
    font-size: 0.75rem;
    font-weight: 600;
    letter-spacing: 0.04em;
  }

  .row {
    position: relative;
    overflow: hidden;
    border-bottom: 1px solid var(--border);
    touch-action: pan-y;
  }

  /*
   * 行に色を付けるのは、マウスで指しているとき ／ 押しているときだけ。指で触る画面では付けない
   * （一覧を動かそうと触っただけで :active になり、触っている行が選んだように見えるため。
   * 押して開いた行は、開いた記事の画面に替わるので、押した手ごたえの色は要らない）
   */
  @media (hover: hover) {
    .row:hover,
    .row:active {
      background: var(--hover);
    }
  }

  .row.current {
    background: var(--selected);
  }

  /* 行の操作（既読、保存）。マウスでは、行に乗せたときと、キーボードで入ったときだけ出す */
  .actions {
    position: absolute;
    top: 0.125rem;
    right: 0.375rem;
    display: flex;
    border-radius: var(--radius-small);
    background: var(--raised);
    box-shadow: 0 1px 4px rgb(0 0 0 / 18%);
  }

  .actions .icon-button {
    width: 1.875rem;
    height: 1.875rem;
  }

  .save[aria-pressed="true"] {
    color: var(--accent);
  }

  @media (hover: hover) {
    .actions {
      opacity: 0;
      pointer-events: none;
    }

    .row:hover .actions,
    .actions:focus-within {
      opacity: 1;
      pointer-events: auto;
    }
  }

  /* 指で使う画面では、操作は記事の画面とスワイプに任せる */
  @media (hover: none) {
    .actions {
      display: none;
    }
  }

  .empty {
    display: grid;
    justify-items: center;
    gap: 0.5rem;
    margin: auto;
    padding: 3rem 1.5rem;
    color: var(--muted);
    text-align: center;
  }

  .empty :global(.icon) {
    width: 2.5rem;
    height: 2.5rem;
    color: var(--faint);
  }

  .empty p {
    margin: 0;
  }

  .empty button {
    max-width: 100%;
    margin-top: 0.5rem;
    padding: 0.6rem 1rem;
    overflow-wrap: anywhere;
  }

  /* 新しい記事の知らせ。読む画面の没入感を優先し、色で塗らず、影も付けない */
  .fresh {
    position: sticky;
    top: 3.75rem;
    z-index: 1;
    align-self: center;
    margin: 0.5rem 0 -2.5rem;
    border-color: var(--border-strong);
    border-radius: 999px;
    background: var(--background);
    color: var(--muted);
    font-size: 0.8125rem;
  }

  .fresh:hover:not(:disabled) {
    background: var(--hover);
    color: var(--text);
  }

  .more {
    margin: 1rem;
  }

  .end {
    display: grid;
    flex: none;
    align-content: start;
    justify-items: center;
    padding: 1.5rem 1rem calc(2rem + env(safe-area-inset-bottom, 0px));
    color: var(--faint);
    font-size: 0.8125rem;
    text-align: center;
  }

  .end-content {
    display: grid;
    justify-items: center;
    gap: 0.75rem;
    min-width: 0;
    transform: translateY(var(--end-pull, 0px));
    transition: transform 280ms ease-out;
  }

  .end-content:global([data-end-dragging]) {
    transition: none;
  }

  @media (prefers-reduced-motion: reduce) {
    .end-content {
      transform: none;
      transition: none;
    }
  }

  .end p {
    margin: 0;
  }

  .end.completed {
    color: var(--accent);
  }

  .end button {
    max-width: 100%;
    padding: 0.6rem 1rem;
    font-size: 0.9375rem;
    overflow-wrap: anywhere;
  }

  .skeleton div {
    height: 4.5rem;
    margin: 0.75rem 1rem;
    border-radius: var(--radius);
    background: var(--surface);
  }

  /* 指で横にはじいている間。行を指に合わせて動かし、下に何をするかを出す */
  .row:global([data-swiping]) {
    background: var(--hover);
  }

  .row:global([data-swiping][data-armed][data-swipe="read"]) {
    background: var(--accent);
    color: var(--on-accent);
  }

  .row:global([data-swiping][data-armed][data-swipe="star"]) {
    background: var(--accent);
    color: var(--on-accent);
  }

  .row:global([data-swiping])::after {
    content: attr(data-swipe-label);
    position: absolute;
    top: 50%;
    transform: translateY(-50%);
    font-size: 0.8125rem;
    font-weight: 600;
  }

  .row:global([data-swiping][data-swipe-side="start"])::after {
    left: 1rem;
  }

  .row:global([data-swiping][data-swipe-side="end"])::after {
    right: 1rem;
  }

  .row:global([data-swiping]) > :global(.item) {
    position: relative;
    z-index: 1;
    background: var(--background);
    transform: translateX(var(--swipe, 0));
  }

  .row:global([data-swiping]) .actions {
    display: none;
  }

  /* 指を離したあと、元の位置へなめらかに戻す */
  .row:global([data-settling]) > :global(.item) {
    transition: transform 0.2s ease-out;
  }

  @media (prefers-reduced-motion: reduce) {
    .row:global([data-settling]) > :global(.item) {
      transition: none;
    }
  }
  .scope-checking header {
    visibility: visible;
  }
</style>
