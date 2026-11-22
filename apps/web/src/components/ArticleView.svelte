<script lang="ts">
  import {
    type Article,
    type ArticleContent,
    type TranslatedContent,
    toSafeHttpUrl,
  } from "@sendo-reader/core";
  import { tick, untrack } from "svelte";
  import { useReader } from "../lib/context";
  import { describeTranslationError, TRANSLATION_FAILED } from "../lib/errors";
  import { formatDateTime } from "../lib/format";
  import { layout, reducedMotion, scrollTopOf, scrollToTop } from "../lib/layout.svelte";
  import type { ArticleListState } from "../lib/list.svelte";
  import { type ArticleSwipe, prefs } from "../lib/prefs.svelte";
  import { handleLink, router, viewHref } from "../lib/router.svelte";
  import { translationLabel } from "../lib/translation";
  import { xEmbedOrigin } from "../lib/x-embed";
  import { setXPostLoader, XPostLoader } from "../lib/x-post.svelte";
  import type { XPostSize } from "../lib/x-post-size";
  import ArticleBody from "./ArticleBody.svelte";
  import Dialog from "./Dialog.svelte";
  import Icon from "./Icon.svelte";

  let {
    articleId,
    list,
    onstep,
    onpeek = () => {},
    onviewchange = () => {},
  }: {
    articleId: string | null;
    list: ArticleListState;
    /** 一覧の前（-1）・次（1）の記事に移る */
    onstep: (delta: 1 | -1) => Promise<void> | void;
    /** スワイプで戻る間、記事の後ろに一覧を見せる（true）・見せるのをやめる（false） */
    onpeek?: (on: boolean) => void;
    /** 訳文と原文を切り替えた（履歴の項目に書いてもらう） */
    onviewchange?: () => void;
  } = $props();

  const reader = useReader();
  let article = $state<Article | null>(null);
  let missing = $state(false);
  let scroller = $state<HTMLElement>();
  let toolbarHeight = $state(0);
  /** 本文（見出しと本文）。X のウィジェットの中を押したあと、フォーカスをここに戻す */
  let contentElement = $state<HTMLElement>();

  /**
   * 本文の中の X の投稿を読み込む順番と時間（docs/decisions/embeds.md の 4）。隔離フレームの
   * オリジンが未設定なら、作らない（投稿は、元の引用と X で開くリンクだけ）
   */
  const embedOrigin = xEmbedOrigin();
  const xPosts = embedOrigin === null ? null : new XPostLoader(embedOrigin);
  setXPostLoader(xPosts);
  /**
   * 読書位置が決まった（下の、本文が出たら位置を戻す effect が済んだ）。決まるまでは、X の投稿を
   * 読み込まない。その effect は、開いたときの全文の自動の取得も待つので、全文を取りにいく記事では、
   * 全文に替わってから（取れなければ、取れないと決まってから）読み込む（替わる前の本文で読み込んだ
   * 枠は、作り直しになるため）
   */
  let positioned = $state(false);

  $effect(() => xPosts?.connect());

  /**
   * X のウィジェットの中を押すと、フォーカスが iframe に移り、キーボードの操作（j ／ k ／ Esc など）が
   * reader に届かなくなる。reader の窓からフォーカスが外れたとき、移った先がウィジェットの iframe なら、
   * 本文にフォーカスを戻す（embeds.md の 6）。押した操作そのものは、取り消さない。ほかの窓やタブへ
   * 移ったときは、何もしない。
   *
   * 戻すのは、blur を受けた処理が終わってから（ブラウザーが iframe にフォーカスを移し終える前に戻すと、
   * 文書の上では本文にフォーカスがあるのに、キーの入力は iframe に届いたままになる）
   */
  $effect(() => {
    if (xPosts === null) return;
    const loader = xPosts;
    const onBlur = () => {
      const active = document.activeElement;
      if (!(active instanceof HTMLIFrameElement) || !loader.contains(active)) return;
      setTimeout(() => contentElement?.focus({ preventScroll: true }), 0);
    };
    window.addEventListener("blur", onBlur);
    return () => window.removeEventListener("blur", onBlur);
  });

  /** 表示範囲は、スクロールする欄（狭い画面ではページ全体）から、ツールバーに隠れる分を除いたところ */
  $effect(() => {
    if (xPosts === null) return;
    const height = Math.ceil(toolbarHeight);
    // 狭い画面では、ツールバーは下にある
    if (layout.pageScroll) xPosts.setArea(null, `0px 0px -${height}px 0px`);
    else if (scroller !== undefined) xPosts.setArea(scroller, `-${height}px 0px 0px 0px`);
  });

  $effect(() => {
    xPosts?.setEnabled(prefs.value.xPosts);
  });

  $effect(() => {
    xPosts?.setReady(positioned);
  });

  async function load(id: string) {
    const found = await reader.client.getArticle(id);
    if (id !== articleId) return;
    article = found;
    missing = found === null;
  }

  /**
   * 本文（sendo の docs/decisions/content.md）。
   * - checking：手元を確かめている（すぐ終わる。本文のある記事では、要約を一瞬出さないよう待つ）
   * - ready：本文を出す
   * - loading：手元になく、sendo から取っている（取れるまで、要約を出しておく）
   * - unavailable：取れなかった（オフラインなど）。要約を出し、つながったら読めると伝える
   * - none：本文のない記事。要約を出す
   */
  let content = $state<ArticleContent | null>(null);
  let contentState = $state<"checking" | "ready" | "loading" | "unavailable" | "none">("none");
  let hasPageContent = $state(false);
  let pageLoading = $state(false);
  let pageNote = $state<string | null>(null);
  let preferFullText = $state(true);
  let pageAttempted = $state(false);
  let contentRequest = 0;

  async function loadContent(id: string, feedOnly = false) {
    if (feedOnly) preferFullText = false;
    const request = ++contentRequest;
    pageLoading = false;
    pageNote = null;
    try {
      // 一度取得した全文は、hasContent によらず、オフラインでも出す
      if (!feedOnly) {
        const page = await reader.client.getArticleContent(id, "page");
        if (id !== articleId || request !== contentRequest) return;
        if (page.status === "ready") {
          hasPageContent = true;
          content = page.content;
          contentState = "ready";
          return;
        }
      }
      // まず手元だけを読む（ネットワークを待たない）
      const local = await reader.client.getArticleContent(id);
      if (id !== articleId || request !== contentRequest) return;
      if (local.status === "ready") {
        content = local.content;
        contentState = "ready";
        return;
      }
      if (local.status === "none") {
        content = null;
        contentState = "none";
        return;
      }
      content = null;
      contentState = "loading";
      const fetched = await reader.client.fetchArticleContent(id);
      if (id !== articleId || request !== contentRequest) return;
      content = fetched;
      contentState = fetched === null ? "none" : "ready";
    } catch {
      if (id === articleId && request === contentRequest) {
        content = null;
        contentState = "unavailable";
      }
    }
  }

  /**
   * 自動で取りにいった全文が届かなかった（オフラインなど）。知らせは出さず、つながったら取り直す
   * （記事を開くたびに、取れなかったと出さないため）
   */
  let autoPageFailed = false;

  /**
   * 元ページの全文を取る。取っている間や失敗したときも、今読んでいる本文・要約を残す。
   * automatic は、開いたときの自動の取得（届かなくても知らせない）
   */
  async function loadFullText(id: string, automatic = false) {
    autoPageFailed = false;
    preferFullText = true;
    pageAttempted = true;
    const request = ++contentRequest;
    pageLoading = true;
    pageNote = null;
    try {
      const fetched = await reader.client.fetchArticleContent(id, "page");
      if (id !== articleId || request !== contentRequest) return;
      if (fetched === null) {
        pageNote = "全文を取得できませんでした。元の記事で続きを読めます。";
      } else {
        hasPageContent = true;
        content = fetched;
        contentState = "ready";
      }
    } catch {
      if (id !== articleId || request !== contentRequest) return;
      if (automatic) autoPageFailed = true;
      else pageNote = "全文を取得できませんでした。接続を確かめて、もう一度お試しください。";
    } finally {
      if (id === articleId && request === contentRequest) pageLoading = false;
    }
  }

  /** 手元の本文・要約を先に出し、そのあと開いた記事の全文を一度だけ自動取得する */
  $effect(() => {
    if (
      articleId === null ||
      link === null ||
      // 訳した本文を出している間は、全文を取らない（原文に切り替えたら取る。決定の 9）
      translatedBody ||
      !preferFullText ||
      hasPageContent ||
      pageAttempted ||
      contentState === "checking" ||
      contentState === "loading" ||
      // 本文も届かなかった（オフライン）。つながって本文を取り直してから取る
      contentState === "unavailable"
    )
      return;
    const id = articleId;
    untrack(() => void loadFullText(id, true));
  });

  /** つながったら、取れなかった本文・自動で取れなかった全文を取り直す */
  $effect(() => {
    const retry = () => {
      if (articleId === null) return;
      // 原文を出している間も取り直す（訳文に戻したときに、取れなかったままにしない）
      if (translatedState === "unavailable" && openedTranslation !== null) {
        void loadTranslatedContent(articleId, openedTranslation.translatedAt);
      }
      if (pageLoading) return;
      if (contentState === "unavailable") {
        // 本文が届いたら、上の自動の取得が全文も取る
        void loadContent(articleId);
      } else if (autoPageFailed) {
        // もう一度、自動で取らせる
        autoPageFailed = false;
        pageAttempted = false;
      }
    };
    window.addEventListener("online", retry);
    return () => window.removeEventListener("online", retry);
  });

  /**
   * 開いたときに一度だけ、未読なら既読にする。表示が間に合わないうちに次の記事へ移っても
   * （j を続けて押したとき）、通り過ぎた記事を既読にする。開いている間に未読に戻したら
   * （m）、そのままにする（記事が替わるまで、もう呼ばない）
   */
  async function markOnOpen(id: string) {
    const found = list.find(id) ?? (await reader.client.getArticle(id));
    if (found === null || found.readAt !== null) return;
    const readAt = Date.now();
    list.patch(id, { readAt });
    if (article?.id === id) article = { ...article, readAt };
    try {
      await reader.client.setRead(id, true);
    } catch (error) {
      // 開く前の表示に戻す（そのあとに別の操作で替わっていたら、そちらを残す）
      list.revert(id, "readAt", readAt, null);
      if (article?.id === id && article.readAt === readAt) article = { ...article, readAt: null };
      throw error;
    }
  }

  /**
   * 記事を替えたとき（次・前の記事、広い画面で一覧から選んだとき）に、中身を短く浮かび上がらせる。
   * 狭い画面で一覧から開いたときは、記事の画面ごと入れる（CSS）ので、ここでは動かさない。
   * スワイプで替えたときは、横から入れるので、これも動かさない
   */
  let fadeIn = $state(false);
  let shownId: string | null = null;
  let recordedOpen: string | null = null;
  let visible = $state(document.visibilityState === "visible");

  $effect(() => {
    const id = articleId;
    untrack(() => {
      fadeIn = id !== null && !settling && (shownId !== null || !layout.pageScroll);
      shownId = id;
      recordedOpen = null;
      saveError = null;
      actionsOpen = false;
      choosingFormat = false;
      exportError = null;
      contentRequest += 1;
      content = null;
      contentState = id === null ? "none" : "checking";
      pageLoading = false;
      pageNote = null;
      hasPageContent = false;
      preferFullText = true;
      pageAttempted = false;
      autoPageFailed = false;
      positioned = false;
      xPosts?.reset();
      openedTranslation = null;
      translationFor = null;
      translatedRequest += 1;
      translatedContent = null;
      translatedState = "none";
      originalStarted = false;
      showOriginal = false;
      requestSeen = false;
      translateError = null;
      if (id === null) {
        article = null;
        missing = false;
        content = null;
        contentState = "none";
      } else {
        // 一覧にある記事は、手元の DB を待たずにすぐ出す（そのあと読み直す）
        const listed = list.find(id);
        if (listed !== null) {
          article = listed;
          missing = false;
        }
        // 記事は先頭から出す（狭い画面では、ページ全体を動かしている）。読み込み直したときや、
        // 戻る・進むで来たときは、本文が出てから、前に見ていた位置に戻す
        scrollToTop(scroller);
        const entered = router.takeArticle(id);
        restoreTop = entered?.top ?? null;
        // 読み込み直したときや、戻る・進むで来たときは、前に出していた方（訳文か原文）に戻す
        showOriginal = entered?.original === true;
        // 前に出した X の投稿の大きさ。位置を戻す前に、その高さの枠を取る（embeds.md の 5）
        xPosts?.restore(entered?.xPosts ?? []);
        // 書けなかったら、開く前の表示に戻し、手元の DB の状態を読み直す
        markOnOpen(id).catch(() => void list.refreshAfterFailure());
        void load(id);
        // 本文は、訳文があるかが決まってから取る（訳文があれば、原文より先に訳した本文を取る）
      }
    });
  });

  // 実際に表示された記事だけを一度記録する。先読み、一覧の既読操作、本文の再取得では記録しない。
  $effect(() => {
    const id = articleId;
    if (!visible || id === null || article?.id !== id || recordedOpen === id) return;
    recordedOpen = id;
    void reader.client.recordArticleOpen(id).catch(() => {});
  });

  /** 本文が出たら戻す、前に見ていた位置（px） */
  let restoreTop: number | null = null;

  /**
   * 開いたときの訳文（docs/decisions/translation.md の 3）。訳した時刻が届いている記事だけ。開いて
   * いる間に訳文が届いたり替わったりしても、出している見出しを替えないよう、開いたときに決める
   */
  let openedTranslation = $state<OpenedTranslation | null>(null);
  interface OpenedTranslation {
    title: string | null;
    summary: string | null;
    translatedAt: number;
  }
  /** openedTranslation を決めた記事 */
  let translationFor = $state<string | null>(null);
  /** 訳文ではなく原文を出している */
  let showOriginal = $state(false);

  $effect(() => {
    const current = article;
    const id = articleId;
    if (current === null || current.id !== id || translationFor === id) return;
    untrack(() => {
      translationFor = id;
      openTranslation(id, current.translation);
    });
  });

  /**
   * 出す訳文を決め、その訳した本文を読む。訳した時刻のない記事は、訳文なし（原文の本文を出す）
   */
  function openTranslation(id: string, translation: Article["translation"]) {
    if (translation == null || translation.translatedAt === null) {
      openedTranslation = null;
      return;
    }
    openedTranslation = {
      title: translation.title,
      summary: translation.summary,
      translatedAt: translation.translatedAt,
    };
    void loadTranslatedContent(id, translation.translatedAt);
  }

  /**
   * 訳した本文（docs/decisions/translation.md の 3、8、9）。openedTranslation の訳した時刻のもの。
   * - checking：手元を確かめている（すぐ終わる）
   * - loading：手元になく、sendo から取っている（訳した要約を出す）
   * - ready：訳した本文を出す
   * - none：sendo が本文を訳さなかった（原文の本文を出す）
   * - waiting：sendo の訳文が替わっていた（同期で新しい訳した時刻が届くまで、訳した要約を出す）
   * - unavailable：取れなかった（オフラインなど。訳した要約を出し、つながったら取り直す）
   */
  let translatedContent = $state<ArticleContent | null>(null);
  let translatedState = $state<
    "checking" | "loading" | "ready" | "none" | "waiting" | "unavailable"
  >("none");
  let translatedRequest = 0;

  async function loadTranslatedContent(id: string, translatedAt: number) {
    const request = ++translatedRequest;
    const current = () => id === articleId && request === translatedRequest;
    translatedContent = null;
    translatedState = "checking";
    try {
      // まず手元だけを読む（ネットワークを待たない）
      const local = await reader.client.getTranslatedContent(id, translatedAt);
      if (!current()) return;
      if (local.status === "missing") {
        translatedState = "loading";
        const fetched = await reader.client.fetchTranslatedContent(id, translatedAt);
        if (!current()) return;
        showTranslatedContent(fetched);
      } else {
        showTranslatedContent(local);
      }
    } catch {
      if (current()) translatedState = "unavailable";
    }
  }

  function showTranslatedContent(result: TranslatedContent) {
    translatedContent = result.status === "ready" ? result.content : null;
    translatedState =
      result.status === "ready" ? "ready" : result.status === "none" ? "none" : "waiting";
  }

  /** 訳文を出していて、訳した本文の側で本文を出す（本文を訳さなかった記事では、原文の本文を出す） */
  const translatedBody = $derived(
    openedTranslation !== null && !showOriginal && translatedState !== "none",
  );

  /** この記事で、原文の本文を取り始めた */
  let originalStarted = false;

  /**
   * 原文の本文が要るようになったら（訳文のない記事、原文に切り替えた、本文を訳さなかった）、
   * 取り始める。訳文のある記事を開いただけでは、原文の本文を取らない（決定の 9）
   */
  $effect(() => {
    const id = articleId;
    if (id === null || translationFor !== id || translatedBody) return;
    untrack(() => {
      if (originalStarted) return;
      originalStarted = true;
      void loadContent(id);
    });
  });

  /**
   * 訳した要約を出して訳した本文を待っている間に、訳文が届いたり替わったりしたら、その訳文に
   * 替える（決定の 3。本文を出している間は替えない）
   */
  $effect(() => {
    const current = article;
    const opened = openedTranslation;
    if (current === null || current.id !== articleId || opened === null || !translatedBody) return;
    if (translatedState === "ready") return;
    const translatedAt = current.translation?.translatedAt ?? null;
    if (translatedAt === null || translatedAt === opened.translatedAt) return;
    untrack(() => openTranslation(current.id, current.translation));
  });

  /**
   * この記事をこの端末で訳してもらうよう頼んだ（頼んだ記事として core が覚えている）のを見た。
   * 頼んだ記事の訳文が届いたら、開いていても訳文に替える（docs/decisions/translation.md の 3）
   */
  let requestSeen = $state(false);

  $effect(() => {
    const current = article;
    if (current === null || current.id !== articleId) return;
    untrack(() => {
      const translation = current.translation;
      // core が覚えている間だけ、この端末で頼んだ記事として扱う。訳せなかったとき（失敗の文を出したら
      // 忘れる）と、core が忘れたあと（1 時間、ほかの人が頼んだ）に届いた訳文では替えない
      if (current.translationRequest === "requested") requestSeen = true;
      else if (current.translationRequest === "failed" || translation?.translatedAt == null) {
        requestSeen = false;
      }
      if (
        requestSeen &&
        openedTranslation === null &&
        translation != null &&
        translation.translatedAt !== null
      ) {
        showOriginal = false;
        openTranslation(current.id, translation);
        onviewchange();
      }
    });
  });

  /**
   * その場の翻訳を頼める（訳文がない。docs/decisions/translation.md の 4）。頼んだ印のある間は、
   * core が状態を translating にして返すので出ない。印が外れたら（1 分）、届いた状態でまた出す
   */
  const canTranslate = $derived(
    article !== null &&
      article.translation != null &&
      (article.translation.status === "queued" || article.translation.status === "untranslated"),
  );
  /** 頼んで、sendo の返事を待っている記事（記事ごと。ほかの記事の Translate は止めない） */
  let translatingIds = $state<string[]>([]);
  const translating = $derived(articleId !== null && translatingIds.includes(articleId));
  /** 頼めなかった理由（日本語の文） */
  let translateError = $state<string | null>(null);
  /** オフラインのときは頼めない（sendo に届かないとできない操作。決定の 6） */
  let online = $state(navigator.onLine);

  $effect(() => {
    const update = () => {
      online = navigator.onLine;
    };
    window.addEventListener("online", update);
    window.addEventListener("offline", update);
    return () => {
      window.removeEventListener("online", update);
      window.removeEventListener("offline", update);
    };
  });

  /** その場で訳してもらう（Translate と t） */
  async function translate(): Promise<void> {
    const id = articleId;
    if (id === null || !canTranslate || translating || !online) return;
    translatingIds = [...translatingIds, id];
    translateError = null;
    try {
      await reader.client.requestTranslation(id);
      // 受け付けられた。訳文がすぐ届いて、core が頼んだ記事を忘れたあとに読み直しても、このタブで
      // 頼んだ記事として訳文に替える（頼んだ印を読めるかどうかに頼らない）
      if (articleId === id) requestSeen = true;
    } catch (error) {
      if (articleId === id) translateError = describeTranslationError(error);
    } finally {
      translatingIds = translatingIds.filter((other) => other !== id);
    }
  }

  /** 見出しに出すタイトル。訳文を出していて訳したタイトルがあれば、それ */
  const heading = $derived(
    article === null
      ? null
      : !showOriginal && openedTranslation?.title
        ? openedTranslation.title
        : article.title,
  );

  /**
   * 訳文と原文を切り替える（More actions と t）。訳文がなく Translate を出している記事では、
   * Translate と同じ（docs/decisions/translation.md の 7）
   */
  export function toggleTranslation(): void {
    if (openedTranslation === null) {
      void translate();
      return;
    }
    showOriginal = !showOriginal;
    actionsOpen = false;
    // 訳文に戻したとき、訳した本文が取れていなければ取り直す（オフラインのときは、つながったら
    // 取り直すので、ここでは取らない）
    if (!showOriginal && translatedState === "unavailable" && online && articleId !== null) {
      void loadTranslatedContent(articleId, openedTranslation.translatedAt);
    }
    onviewchange();
  }

  /** 原文を出しているか。位置と一緒に、履歴の項目に覚える */
  export function showingOriginal(): boolean {
    return openedTranslation !== null && showOriginal;
  }

  $effect(() => {
    // 本文を確かめている間・取っている間は、高さが決まらないので待つ（取れなかったら、要約で戻す）
    const pending = translatedBody
      ? translatedState === "checking" || translatedState === "loading"
      : contentState === "checking" || contentState === "loading" || pageLoading;
    if (article === null || translationFor !== articleId || pending) return;
    untrack(() => {
      const top = restoreTop;
      restoreTop = null;
      if (top === null) {
        positioned = true;
        return;
      }
      const id = articleId;
      void tick().then(() => {
        // 待っている間に別の記事に替えた
        if (articleId !== id) return;
        // 読み始めていたら、戻さない
        if (scrollTopOf(scroller) === 0) scrollToTop(scroller, top);
        positioned = true;
      });
    });
  });

  /** いま見ている位置（px） */
  export function scrollTop(): number {
    return scrollTopOf(scroller);
  }

  /** 出した X の投稿の大きさ。位置と一緒に、履歴の項目に覚える（embeds.md の 5） */
  export function xPostSizes(): XPostSize[] {
    return xPosts?.sizes() ?? [];
  }

  $effect(() => {
    void reader.articlesVersion;
    untrack(() => {
      if (articleId !== null) void load(articleId);
    });
  });

  /**
   * 押したらすぐ画面に出し（楽観的な更新）、手元の DB への書き込みはそのあとに待つ
   * （docs/decisions/performance.md の操作の反応 100ms）
   */
  export async function toggle(field: "readAt" | "starredAt") {
    const current = article;
    if (current === null) return;
    const on = current[field] === null;
    const value = on ? Date.now() : null;
    const change = { [field]: value };
    article = { ...current, ...change };
    list.patch(current.id, change);
    saveError = null;
    try {
      if (field === "readAt") await reader.client.setRead(current.id, on);
      else await reader.client.setStarred(current.id, on);
    } catch {
      // 手元に書けなかった（容量不足など）。押す前の表示に戻してから、手元の DB の状態を読み直す
      // （版の違うタブのために代表とやり取りできないときは、読み直しも失敗するので、戻した表示の
      // ままにする）
      saveError = "保存できませんでした。";
      // 押したあとに別の操作（続けて押した、読み直した）で替わっていたら、そちらを残す
      list.revert(current.id, field, value, current[field]);
      if (article?.id === current.id && article[field] === value) {
        article = { ...article, [field]: current[field] };
      }
      void list.refreshAfterFailure();
      if (articleId === current.id) await load(current.id).catch(() => {});
    }
  }

  /** 元の記事を新しいタブで開く（リンクにできる URL のときだけ） */
  export function openOriginal() {
    if (link !== null) window.open(link, "_blank", "noopener,noreferrer");
  }

  /**
   * 指で記事を横にスワイプする。割り当ては設定で変えられる（既定は、右へスワイプすると一覧に
   * 戻る。左は何もしない）。縦に読み進める動きや、文字を選ぶ動きと取り違えないように、
   * はっきり横に動かし始めたときだけにする。
   *
   * 記事は指に付いて横に動き、離したら、外へ流して操作するか、元の位置へ戻す。戻る動きでは、
   * 狭い画面なら記事の後ろに一覧を見せる（onpeek）。次・前の記事へは、外へ流したあと、
   * 次の記事を反対の側から入れる。保存の切り替えでは、記事を外へ流さず、少しだけ動かして空いた
   * ところに、何をするかを出す。離したら、切り替えて元の位置へ戻す
   */

  /** 記事を、指で横に動かしている分（px） */
  let dragX = $state(0);
  /** 指で動かしている最中（動きを付けず、指にそのまま付いていく） */
  let dragging = $state(false);
  /** 指を離したあとの動きの最中（その間は、次のスワイプを受けない） */
  let settling = $state(false);
  /** 記事を、元の位置からずらしている */
  const moved = $derived(dragX !== 0 || settling);
  /** 保存を切り替える向きに動かしている（記事を欄の中で動かし、空いたところに印を出す） */
  let starring = $state(false);

  /** 外へ流す・元に戻す時間（ミリ秒）。CSS の transition と揃える */
  const SLIDE = 220;
  /** これだけ横に動かして離したら、操作する（px） */
  const SWIPE_DISTANCE = 80;
  /** これより短くても、これより速く（px/ミリ秒）はじいたら、操作する */
  const FLICK_DISTANCE = 30;
  const FLICK_SPEED = 0.5;
  /** 保存を切り替える向きには、これより先へは動かさない（px） */
  const STAR_REACH = 112;
  /** 保存を切り替えるところまで動かした */
  const starArmed = $derived(Math.abs(dragX) >= SWIPE_DISTANCE);

  interface Gesture {
    startX: number;
    startY: number;
    /** 横に動かしている（true）、縦に動かしている（false）、まだ分からない（null） */
    sideways: boolean | null;
    lastX: number;
    lastTime: number;
    /** 横に動かしている速さ（px/ミリ秒。右が正） */
    speed: number;
    /** 記事の後ろに一覧を見せている */
    peeking: boolean;
  }
  let gesture: Gesture | null = null;

  /** その向き（dx が正なら右へ）のスワイプに割り当てた操作 */
  function actionFor(dx: number): ArticleSwipe {
    return dx < 0 ? prefs.value.swipes.articleLeft : prefs.value.swipes.articleRight;
  }

  function startPeek(current: Gesture) {
    if (current.peeking) return;
    current.peeking = true;
    onpeek(true);
  }

  function onTouchStart(event: TouchEvent) {
    const touch = event.touches[0];
    if (event.touches.length !== 1 || touch === undefined) {
      // 2 本目の指が触れた（拡大など）。動かしていた記事は元に戻す
      abandon();
      return;
    }
    gesture =
      !settling && article !== null && !startsInSideScroller(event.target)
        ? {
            startX: touch.clientX,
            startY: touch.clientY,
            sideways: null,
            lastX: touch.clientX,
            lastTime: event.timeStamp,
            speed: 0,
            peeking: false,
          }
        : null;
  }

  /** 横に動かしている間は、ページを縦に動かさない（そのため、受け身でない listener で受ける） */
  function onTouchMove(event: TouchEvent) {
    const touch = event.touches[0];
    const current = gesture;
    if (current === null || touch === undefined || current.sideways === false) return;
    const dx = touch.clientX - current.startX;
    const dy = touch.clientY - current.startY;
    if (current.sideways === null) {
      if (Math.abs(dx) < 10 && Math.abs(dy) < 10) return;
      current.sideways =
        Math.abs(dx) > Math.abs(dy) * 2 &&
        getSelection()?.isCollapsed !== false &&
        actionFor(dx) !== "none";
      if (!current.sideways) return;
      dragging = true;
    }
    event.preventDefault();
    if (event.timeStamp > current.lastTime) {
      current.speed = (touch.clientX - current.lastX) / (event.timeStamp - current.lastTime);
      current.lastX = touch.clientX;
      current.lastTime = event.timeStamp;
    }
    const action = actionFor(dx);
    if (action === "back") startPeek(current);
    starring = action === "star";
    // 何も割り当てていない向きには、ほとんど動かさない（手ごたえだけ）
    dragX =
      action === "none"
        ? dx * 0.1
        : action === "star"
          ? Math.max(-STAR_REACH, Math.min(STAR_REACH, dx))
          : dx;
  }

  /**
   * 本文の中の、横に動かせるところ（幅の広い表、長い行のコード）から始まった動きか。そこでの
   * 横の動きは、中身を動かすためのものなので、記事のスワイプとして扱わない
   */
  function startsInSideScroller(target: EventTarget | null): boolean {
    for (
      let element = target instanceof Element ? target : null;
      element !== null && element !== scroller;
      element = element.parentElement
    ) {
      if (element.scrollWidth <= element.clientWidth) continue;
      const overflow = getComputedStyle(element).overflowX;
      if (overflow === "auto" || overflow === "scroll") return true;
    }
    return false;
  }

  function onTouchEnd(event: TouchEvent) {
    const touch = event.changedTouches[0];
    const current = gesture;
    gesture = null;
    if (current === null || touch === undefined || current.sideways === false) return;
    const dx = touch.clientX - current.startX;
    const dy = touch.clientY - current.startY;
    // 動かす途中を受け取らないまま離した（すばやくはじいた）なら、ここで向きを確かめる
    if (
      current.sideways === null &&
      (Math.abs(dx) <= Math.abs(dy) * 2 || getSelection()?.isCollapsed === false)
    ) {
      return;
    }
    const action = actionFor(dx);
    // 指を止めてから離したなら、はじいたことにはしない
    const speed = event.timeStamp - current.lastTime > 100 ? 0 : current.speed;
    const flick = Math.abs(dx) >= FLICK_DISTANCE && speed * Math.sign(dx) >= FLICK_SPEED;
    if (action === "none" || (Math.abs(dx) < SWIPE_DISTANCE && !flick)) {
      void settleBack(current.peeking);
      return;
    }
    if (action === "star") {
      void star(current.peeking);
      return;
    }
    if (action === "back") startPeek(current);
    void complete(action, dx < 0 ? -1 : 1, current.peeking);
  }

  function abandon() {
    const current = gesture;
    gesture = null;
    if (current?.sideways === true) void settleBack(current.peeking);
  }

  /** 記事を x まで、動きを付けて動かす。動き終わったら返る */
  function slide(x: number): Promise<void> {
    dragging = false;
    dragX = x;
    return new Promise((resolve) => setTimeout(resolve, reducedMotion() ? 0 : SLIDE));
  }

  /** 記事を x に、動きを付けずに置く（次に slide したときに、そこから動くように） */
  async function place(x: number) {
    dragging = true;
    dragX = x;
    await tick();
    // 置いた位置を、いったん描画の計算に乗せる（でないと、次の動きがここから始まらない）
    scroller?.getBoundingClientRect();
  }

  /** 足りないところで離した。元の位置に戻す */
  async function settleBack(peeking: boolean) {
    if (dragX === 0 && !peeking) {
      dragging = false;
      starring = false;
      return;
    }
    settling = true;
    await slide(0);
    if (peeking) onpeek(false);
    settling = false;
    starring = false;
  }

  /** 保存を切り替えるところまで動かして離した。切り替えてから、元の位置に戻す */
  async function star(peeking: boolean) {
    settling = true;
    if (peeking) onpeek(false);
    const on = article?.starredAt === null;
    void toggle("starredAt");
    showNotice(on ? "Saved に入れました。" : "Saved から外しました。");
    await slide(0);
    settling = false;
    starring = false;
  }

  /** 操作するところまで動かして離した。記事を外へ流してから、操作する */
  async function complete(
    action: Exclude<ArticleSwipe, "none">,
    direction: 1 | -1,
    peeking: boolean,
  ) {
    settling = true;
    starring = false;
    const from = articleId;
    const width = scroller?.clientWidth || window.innerWidth;
    await slide(direction * width);
    if (articleId !== from) {
      // 動いている間に、ほかの操作（ブラウザーの戻る、キーボード）で記事が替わった。
      // スワイプの操作はやめ、記事を元の位置に置く
      if (peeking) onpeek(false);
      await place(0);
    } else if (action === "back") {
      // 後ろに見せていた一覧は、Reader が、一覧に戻ったところで元に戻す
      router.openArticle(null);
      await place(0);
    } else {
      if (peeking) onpeek(false);
      await onstep(action === "next" ? 1 : -1);
      if (articleId !== from) {
        // 次の記事は、反対の側から入れる
        await place(-direction * width);
      }
      await slide(0);
    }
    settling = false;
  }

  $effect(() => {
    const node = scroller;
    if (node === undefined) return;
    node.addEventListener("touchmove", onTouchMove, { passive: false });
    return () => node.removeEventListener("touchmove", onTouchMove);
  });

  /** 共有したときなどの、少しの間出す知らせ */
  let notice = $state<string | null>(null);
  let noticeTimer: ReturnType<typeof setTimeout> | undefined;

  function showNotice(text: string) {
    clearTimeout(noticeTimer);
    notice = text;
    noticeTimer = setTimeout(() => (notice = null), 3000);
  }

  /**
   * 記事のリンクを共有する。端末の共有の窓（Web Share API）を開き、なければリンクをコピーする。
   * 渡すのは、記事のタイトルと、http ／ https だと確かめた URL だけ
   */
  export async function share() {
    if (article === null || link === null) return;
    try {
      if (typeof navigator.share === "function") {
        await navigator.share({ title: article.title ?? "", url: link });
      } else {
        await navigator.clipboard.writeText(link);
        showNotice("リンクをコピーしました。");
      }
    } catch (error) {
      // 共有の窓を閉じただけなら、何も出さない
      if (error instanceof DOMException && error.name === "AbortError") return;
      showNotice("共有できませんでした。");
    }
  }

  /** 本文が読みづらいときなどに使う補助操作 */
  let actionsOpen = $state(false);
  /** 補助操作の窓で、Download を押して、書き出す形式を選んでいる */
  let choosingFormat = $state(false);

  // 窓を閉じたら、次に開いたときは最初の操作から出す
  $effect(() => {
    if (!actionsOpen) choosingFormat = false;
  });

  /** 形式を選ぶ段に替わったら、最初の形式にフォーカスを移す（押したボタンは消える） */
  function focusFirst(node: HTMLElement) {
    node.focus();
  }

  function showContent(source: "feed" | "page") {
    actionsOpen = false;
    if (articleId === null) return;
    if (source === "feed") void loadContent(articleId, true);
    else void loadFullText(articleId);
  }

  /** 全文をファイルに書き出している（画像を取っている間、ボタンを押せなくする） */
  let exporting = $state<"html" | "markdown" | null>(null);
  let exportError = $state<string | null>(null);

  /**
   * 手元の全文を、HTML か Markdown の 1 つのファイルにしてダウンロードさせる。フィードの本文を
   * 出しているときも、書き出すのは全文。書き出しの部品は、使うときだけ読む（最初の JS に入れない）
   */
  async function download(format: "html" | "markdown") {
    const current = article;
    if (current === null || exporting !== null) return;
    exporting = format;
    exportError = null;
    try {
      const page = await reader.client.getArticleContent(current.id, "page");
      if (page.status !== "ready") {
        exportError = "全文が手元にないため、書き出せませんでした。";
        return;
      }
      const [{ exportArticle, fetchImageAsDataUrl }, { downloadText }] = await Promise.all([
        import("@sendo-reader/core/export"),
        import("../lib/download"),
      ]);
      const file = await exportArticle(
        {
          title: current.title,
          url: current.url,
          feedTitle: reader.feedTitle(current.feedId),
          author: current.author,
          publishedAt: current.publishedAt,
        },
        page.content.nodes,
        format,
        (src) => fetchImageAsDataUrl(src),
      );
      if (articleId !== current.id) return;
      downloadText(file.name, file.type, file.text);
      actionsOpen = false;
    } catch {
      exportError = "書き出せませんでした。";
    } finally {
      exporting = null;
    }
  }

  /** 書き込みに失敗したときの知らせ */
  let saveError = $state<string | null>(null);

  /** 記事の URL は、http ／ https のものだけをリンクにする（記事のデータは信頼できない） */
  const link = $derived(article === null ? null : toSafeHttpUrl(article.url));
  // 元の言語と翻訳の状態のラベル（docs/decisions/translation.md の 1）
  const translation = $derived(article === null ? null : translationLabel(article.translation));

  const feedHref = $derived(
    article === null ? "/" : viewHref({ kind: "feed", id: article.feedId }),
  );

  /**
   * 要約を出すか。本文が出せる間は出さない。本文のある記事で、手元を確かめている間（すぐ終わる）も
   * 出さない（要約が一瞬出て、本文に替わらないように）
   */
  const showSummary = $derived(
    contentState !== "ready" && !(contentState === "checking" && article?.hasContent === true),
  );

  /** 要約は、空行で段落に分けて出す（HTML としては出さない） */
  const toParagraphs = (summary: string | null | undefined) =>
    (summary ?? "")
      .split(/\n\s*\n/)
      .map((text) => text.trim())
      .filter((text) => text !== "");
  const paragraphs = $derived(toParagraphs(article?.summary));
  /** 訳した本文を待つ間に出す、訳した要約（なければ原文の要約） */
  const translatedParagraphs = $derived(
    toParagraphs(openedTranslation?.summary ?? article?.summary),
  );
</script>

<svelte:document onvisibilitychange={() => (visible = document.visibilityState === "visible")} />

<article
  class="article-view"
  aria-live="polite"
  bind:this={scroller}
  ontouchstart={onTouchStart}
  ontouchend={onTouchEnd}
  ontouchcancel={abandon}
  class:moved
  class:dragging
  class:starring
  style:--drag={`${dragX}px`}
>
  {#if article !== null}
    {#if starring}
      <!-- 保存を切り替える向きに動かしている間、空いたところに何をするかを出す -->
      <div
        class="star-hint"
        class:armed={starArmed}
        class:end={dragX < 0}
        style:opacity={Math.min(1, Math.abs(dragX) / SWIPE_DISTANCE)}
        aria-hidden="true"
      >
        <span>
          <Icon name="bookmark" filled={article.starredAt === null} />
          {article.starredAt === null ? "Save" : "Unsave"}
        </span>
      </div>
    {/if}
    <div class="toolbar" bind:offsetHeight={toolbarHeight}>
      <button
        type="button"
        class="icon-button back"
        aria-label="Back"
        title="Back (Esc)"
        onclick={() => router.openArticle(null)}
      >
        <Icon name="arrowLeft" />
      </button>
      <button
        type="button"
        class="icon-button close"
        aria-label="Close"
        title="Close (Esc)"
        onclick={() => router.openArticle(null)}
      >
        <Icon name="close" />
      </button>
      <button
        type="button"
        class="icon-button"
        aria-label="Previous"
        title="Previous (k)"
        onclick={() => onstep(-1)}
      >
        <Icon name="arrowUp" />
      </button>
      <button
        type="button"
        class="icon-button"
        aria-label="Next"
        title="Next (j)"
        onclick={() => onstep(1)}
      >
        <Icon name="arrowDown" />
      </button>
      <span class="spacer"
        >{#if saveError !== null}
          <span class="error" role="alert">{saveError}</span>
        {:else if notice !== null}
          <span class="notice" role="status">{notice}</span>
        {/if}</span
      >
      <button
        type="button"
        class="icon-button save"
        aria-pressed={article.starredAt !== null}
        aria-label={article.starredAt === null ? "Save" : "Unsave"}
        title={article.starredAt === null ? "Save (s)" : "Unsave (s)"}
        onclick={() => toggle("starredAt")}
      >
        <Icon name="bookmark" filled={article.starredAt !== null} />
      </button>
      {#if link !== null}
        <button type="button" class="icon-button" aria-label="Share" title="Share" onclick={share}>
          <Icon name="share" />
        </button>
      {/if}
      <!-- 訳文と原文の切り替えは More actions に置くので、リンクも全文もない記事でも出す -->
      {#if link !== null || hasPageContent || openedTranslation !== null}
        <button
          type="button"
          class="icon-button"
          aria-label="More actions"
          title="More actions"
          aria-haspopup="dialog"
          aria-expanded={actionsOpen}
          onclick={() => (actionsOpen = true)}
        >
          <Icon name="more" />
        </button>
      {/if}
    </div>

    {#key articleId}
      <div class="content" class:fade-in={fadeIn} tabindex="-1" bind:this={contentElement}>
        <header>
          <p class="meta">
            <a class="feed" href={feedHref} onclick={(e) => handleLink(e, feedHref)}>
              {reader.feedTitle(article.feedId)}
            </a>
          </p>
          <h1>
            {#if link !== null}
              <a
                class="original-title"
                href={link}
                target="_blank"
                rel="noopener noreferrer"
                title="Open original (v)"
              >
                {heading ?? "(Untitled)"}
                <Icon name="external" />
              </a>
            {:else}
              {heading ?? "(Untitled)"}
            {/if}
          </h1>
          <p class="meta">
            <time datetime={new Date(article.publishedAt).toISOString()}>
              {formatDateTime(article.publishedAt)}
            </time>
            {#if article.author !== null}
              <span>・ {article.author}</span>
            {/if}
            {#if translation !== null}
              <span class="translation">・ {translation}</span>
            {/if}
            {#if canTranslate}
              <!-- 訳文のない記事を、押したときだけ訳してもらう（ラベルのすぐ横。決定の 4） -->
              <button
                type="button"
                class="translate"
                disabled={translating || !online}
                title={online ? "Translate (t)" : "オフラインのときは訳してもらえません"}
                onclick={translate}
              >
                Translate
              </button>
            {/if}
          </p>
          {#if translateError !== null}
            <p class="content-note" role="alert">{translateError}</p>
          {:else if article.translationRequest === "failed" && !translating}
            <p class="content-note" role="alert">{TRANSLATION_FAILED}</p>
          {/if}
        </header>
        {#if translatedBody}
          <!-- 訳した本文。取っている間と手元にないときは、訳した要約を出す（決定の 3） -->
          {#if translatedContent !== null}
            <ArticleBody nodes={translatedContent.nodes} />
          {:else if translatedState !== "checking"}
            {#each translatedParagraphs as text, index (index)}
              <p class="summary">{text}</p>
            {/each}
            {#if translatedState === "unavailable"}
              <p class="content-note" role="status">訳した本文は、sendo につながったら読めます。</p>
            {/if}
          {/if}
        {:else}
          {#if pageLoading}
            <p class="content-note" role="status">全文を取得しています…</p>
          {:else if pageNote !== null}
            <p class="content-note" role="status">{pageNote}</p>
          {/if}
          {#if content !== null}
            <ArticleBody nodes={content.nodes} />
          {:else if showSummary}
            {#each paragraphs as text, index (index)}
              <p class="summary">{text}</p>
            {/each}
            {#if contentState === "unavailable"}
              <p class="content-note" role="status">
                この記事には本文があります。sendo につながったら読めます。
              </p>
            {/if}
          {/if}
        {/if}
      </div>
    {/key}
  {:else if missing}
    <div class="placeholder"><p>この記事は手元にありません。</p></div>
  {:else}
    <div class="placeholder">
      <Icon name="inbox" />
      <p>記事を選んでください。</p>
      <p class="hint"><kbd>j</kbd> <kbd>k</kbd> で次・前の記事、<kbd>?</kbd> で操作の一覧</p>
    </div>
  {/if}
</article>

<Dialog bind:open={actionsOpen} title="Article actions">
  <div class="content-actions">
    {#if openedTranslation !== null && !choosingFormat}
      <!-- 何語で読むかの切り替え。原文の中のどの本文を出すか（全文、フィード本文）とは別 -->
      <button type="button" onclick={toggleTranslation}>
        {showOriginal ? "Show translation" : "Show original text"}
      </button>
    {/if}
    {#if choosingFormat}
      <!-- Download を押したあと、書き出す形式を選ぶ（やり方の違いは、押したあとに選ぶ。ui.md の 8） -->
      <button
        type="button"
        disabled={exporting !== null}
        onclick={() => download("html")}
        use:focusFirst
      >
        {exporting === "html" ? "Downloading…" : "HTML"}
      </button>
      <button type="button" disabled={exporting !== null} onclick={() => download("markdown")}>
        {exporting === "markdown" ? "Downloading…" : "Markdown"}
      </button>
      <button
        type="button"
        class="link"
        disabled={exporting !== null}
        onclick={() => {
          choosingFormat = false;
          exportError = null;
        }}
      >
        Back
      </button>
    {:else if translatedBody}
      <!-- 訳文を出している間は、原文の中のどの本文を出すかを選ばせない（決定の 3） -->
    {:else if content?.source === "page" || pageLoading}
      <button type="button" onclick={() => showContent("feed")}>Show feed content</button>
    {:else if link !== null}
      <!-- 全文は元のページから抜くので、リンクにできる URL のない記事では出さない -->
      <button
        type="button"
        disabled={contentState === "checking" || contentState === "loading"}
        onclick={() => showContent("page")}
      >
        {pageNote === null ? "Show full text" : "Retry full text"}
      </button>
    {/if}
    {#if hasPageContent && !choosingFormat}
      <button type="button" onclick={() => (choosingFormat = true)}>Download</button>
    {/if}
    {#if exportError !== null}
      <p class="error" role="alert">{exportError}</p>
    {/if}
  </div>
</Dialog>

<style>
  .content-actions {
    display: grid;
  }

  .content-actions button {
    padding-block: 0.6rem;
  }

  .content-actions .link {
    justify-self: center;
    padding-block: 0.25rem;
  }

  .article-view {
    display: flex;
    flex-direction: column;
    min-width: 0;
    overflow-x: hidden;
    overflow-y: auto;
    background: var(--background);
  }

  /*
   * 指で横にスワイプしている間と、離したあとに外へ流す・元に戻す間。広い画面では、欄の中で
   * 中身を動かす（欄の外にははみ出さない）
   */
  .article-view.moved > :not(dialog, .star-hint) {
    transform: translateX(var(--drag));
    transition: transform 0.22s cubic-bezier(0.2, 0.8, 0.2, 1);
  }

  .article-view.dragging > :not(dialog, .star-hint) {
    transition: none;
  }

  @media (prefers-reduced-motion: reduce) {
    .article-view.moved > :not(dialog, .star-hint) {
      transition: none;
    }
  }

  /*
   * 保存を切り替える向きに動かしている間の印。動かない場所（欄の縦の真ん中あたり）に置き、
   * 記事が動いて空いたところの真ん中に出す
   */
  .star-hint {
    position: sticky;
    top: 0;
    flex: none;
    height: 0;
  }

  .star-hint > span {
    position: absolute;
    top: 35vh;
    left: calc(var(--drag) / 2);
    display: grid;
    justify-items: center;
    gap: 0.25rem;
    color: var(--muted);
    font-size: 0.8125rem;
    font-weight: 600;
    transform: translateX(-50%);
  }

  .star-hint.end > span {
    left: auto;
    right: calc(var(--drag) / -2);
    transform: translateX(50%);
  }

  .star-hint.armed > span {
    color: var(--accent);
  }

  .toolbar {
    position: sticky;
    top: 0;
    z-index: 1;
    display: flex;
    align-items: center;
    gap: 0.125rem;
    min-height: 3.25rem;
    padding: 0.5rem;
    border-bottom: 1px solid var(--border);
    background: var(--background);
  }

  /* 記事の欄が狭いとき（3 カラムで文字を大きくした、など）は、ボタンが縮んで収まる */
  .toolbar > :global(.icon-button) {
    flex: 0 1 auto;
    min-width: 0;
  }

  .spacer {
    flex: 1;
    min-width: 0;
    padding: 0 0.5rem;
    text-align: end;
  }

  .save[aria-pressed="true"] {
    color: var(--accent);
  }

  .notice {
    color: var(--muted);
    font-size: 0.875rem;
  }

  .content.fade-in {
    animation: content-in 0.16s ease-out;
  }

  @keyframes content-in {
    from {
      opacity: 0;
      transform: translateY(0.375rem);
    }
  }

  /* フォーカスを戻すための受け皿（tabindex="-1"。Tab では止まらない）。枠は出さない */
  .content:focus {
    outline: none;
  }

  .content {
    width: 100%;
    max-width: 44rem;
    margin: 0 auto;
    padding: 1.75rem 1.5rem calc(4rem + env(safe-area-inset-bottom, 0px));
  }

  h1 {
    margin: 0.375rem 0 0.5rem;
    font-size: 1.625rem;
    line-height: 1.4;
    letter-spacing: 0.01em;
    overflow-wrap: anywhere;
  }

  .meta {
    margin: 0;
    color: var(--muted);
    font-size: 0.875rem;
  }

  .feed {
    color: var(--accent);
    font-weight: 600;
    text-decoration: none;
  }

  .feed:hover {
    text-decoration: underline;
  }

  header {
    margin-bottom: 1.5rem;
    padding-bottom: 1.25rem;
    border-bottom: 1px solid var(--border);
  }

  .summary {
    margin: 0 0 1.25em;
    font-size: 1.0625rem;
    line-height: 1.9;
    white-space: pre-wrap;
    overflow-wrap: anywhere;
  }

  .content-note {
    margin: 0 0 1.25em;
    color: var(--muted);
    font-size: 0.875rem;
  }

  /* Translate はラベルの横に、メタと同じ大きさの文字で出す（決定の 4） */
  .translate {
    margin-left: 0.375rem;
    padding: 0;
    border: 0;
    background: none;
    color: var(--accent);
    font: inherit;
    cursor: pointer;
  }

  .translate:disabled {
    color: var(--faint);
    cursor: default;
  }

  .original-title {
    color: inherit;
    text-decoration: none;
  }

  .original-title:hover {
    text-decoration: underline;
  }

  .original-title :global(.icon) {
    display: inline;
    width: 0.65em;
    height: 0.65em;
    color: var(--muted);
  }

  .placeholder {
    display: grid;
    justify-items: center;
    gap: 0.5rem;
    margin: auto;
    padding: 2rem;
    color: var(--muted);
    text-align: center;
  }

  .placeholder :global(.icon) {
    width: 3rem;
    height: 3rem;
    color: var(--border-strong);
  }

  .placeholder p {
    margin: 0;
  }

  .hint {
    font-size: 0.8125rem;
    color: var(--faint);
  }

  .error {
    color: var(--danger);
    font-size: 0.875rem;
  }

  .back {
    display: none;
  }

  @media (max-width: 56rem) {
    /*
     * ページ全体を動かす（docs/decisions/ui.md の 6）。中身が短くても、記事の操作が画面の下に
     * 来るように、画面の高さまでは伸ばす
     */
    .article-view {
      min-height: 100dvh;
      overflow: visible;
      /* 一覧から開いたとき（出ていなかった記事の画面が出たとき）に、右から入れる */
      animation: article-in 0.22s cubic-bezier(0.2, 0.8, 0.2, 1);
    }

    @keyframes article-in {
      from {
        opacity: 0;
        transform: translateX(12%);
      }
    }

    /*
     * 狭い画面では、記事をまるごと動かす（戻る動きでは、後ろに一覧が見える）。
     * 横にはみ出した分は、Reader が切り取る。保存の切り替えでは、広い画面と同じく中身を動かす
     * （記事の画面は動かさず、空いたところに印を出す）
     */
    .article-view.moved:not(.starring) > :not(dialog) {
      transform: none;
      transition: none;
    }

    .article-view.moved:not(.starring) {
      box-shadow: var(--shadow);
      transform: translateX(var(--drag));
      transition: transform 0.22s cubic-bezier(0.2, 0.8, 0.2, 1);
    }

    .article-view.dragging {
      transition: none;
    }

    .back {
      display: inline-grid;
    }

    /* 狭い画面では、操作を親指の届く下に置く */
    .toolbar {
      order: 2;
      top: auto;
      bottom: 0;
      justify-content: space-between;
      margin-top: auto;
      padding: 0.375rem 0.75rem calc(0.375rem + env(safe-area-inset-bottom, 0px));
      border-top: 1px solid var(--border);
      border-bottom: 0;
    }

    .spacer:empty {
      display: none;
    }

    /* ボタンは幅を分け合う。文字を大きくしても、狭い画面からはみ出さない */
    .toolbar {
      gap: 0;
    }

    .toolbar > :global(.icon-button) {
      flex: 1 1 0;
      width: auto;
      min-width: 0;
      max-width: 3.5rem;
    }

    .close,
    .hint {
      display: none;
    }

    /* 知らせは、下のバーの上に浮かせる */
    .spacer {
      position: absolute;
      right: 0;
      bottom: 100%;
      left: 0;
      padding: 0.375rem 1rem;
      background: var(--background);
      text-align: center;
    }

    .content {
      padding-inline: 1.125rem;
    }

    h1 {
      font-size: 1.375rem;
    }
  }

  @media (max-width: 56rem) and (prefers-reduced-motion: reduce) {
    .article-view,
    .article-view.moved {
      transition: none;
      animation: none;
    }
  }

  @media (prefers-reduced-motion: reduce) {
    .content.fade-in {
      animation: none;
    }
  }
</style>
