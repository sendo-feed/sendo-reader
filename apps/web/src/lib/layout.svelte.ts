/**
 * 狭い画面では、一覧も記事もページ全体をスクロールする（docs/decisions/ui.md の 6）。
 * iPhone の「画面のいちばん上を押すと先頭に戻る」は、ページそのもののスクロールにしか効かないため。
 * 広い画面（3 列）では、欄ごとに動かす。
 *
 * 切り替わる幅は、各部品の CSS の `@media (max-width: 56rem)` と同じにする。
 */
export const NARROW_QUERY = "(max-width: 56rem)";

class Layout {
  /** ページ全体をスクロールしている（狭い画面） */
  pageScroll = $state(false);

  constructor() {
    const query = window.matchMedia(NARROW_QUERY);
    this.pageScroll = query.matches;
    query.addEventListener("change", (event) => {
      this.pageScroll = event.matches;
    });
  }
}

export const layout = new Layout();

/** 動きを減らす設定（prefers-reduced-motion）にしている。そのときは、動きを付けずに切り替える */
export function reducedMotion(): boolean {
  return window.matchMedia("(prefers-reduced-motion: reduce)").matches;
}

/** 動きを減らす設定なら、なめらかに動かさない */
function scrollBehavior(smooth: boolean): ScrollBehavior {
  if (!smooth) return "auto";
  return reducedMotion() ? "auto" : "smooth";
}

/** 狭い画面ならページの、広い画面なら欄（element）の、いまの位置 */
export function scrollTopOf(element: HTMLElement | undefined): number {
  return layout.pageScroll ? window.scrollY : (element?.scrollTop ?? 0);
}

/** 狭い画面ならページを、広い画面なら欄（element）を、top まで動かす */
export function scrollToTop(element: HTMLElement | undefined, top = 0, smooth = false): void {
  const options: ScrollToOptions = { top, behavior: scrollBehavior(smooth) };
  if (layout.pageScroll) window.scrollTo(options);
  else element?.scrollTo(options);
}
