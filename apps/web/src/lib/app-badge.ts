import type { ReaderClient } from "@sendo-reader/core/web";

/** アプリのアイコンのバッジ（Badging API。ふだんは navigator） */
export interface AppBadge {
  setAppBadge(contents: number): Promise<void>;
  clearAppBadge(): Promise<void>;
}

/**
 * インストールしたアプリのアイコンに、手元の DB のすべての未読の数を出す（ネットワークを待たない）。
 * 起動したときと、記事の表が変わるたびに数え直す。表の変化はどのタブで変えても、同期で届いても、
 * すべてのタブに届くので、タブが 2 つでも同じ数になる。ログアウトで手元を消すと 0 になり、消す。
 *
 * 数の正は手元の DB で、数え直すたびに、前と同じ数でも書く（書いた数は覚えない）。前に出たときも
 * 数え直し、裏にある間や閉じている間に push の app_badge でブラウザーが書いた数を残さない。
 * 書けなければ（iOS では、通知を許可していないと失敗する）、画面には何も出さず、次に数え直したときに
 * また書く（docs/decisions/notifications.md の 5）。
 */
export function showUnreadBadge(
  client: Pick<ReaderClient, "countUnread" | "onChange">,
  badge: AppBadge,
  page: Pick<Document, "visibilityState" | "addEventListener">,
): void {
  let reads = 0;

  const update = async () => {
    const read = ++reads;
    let total: number;
    try {
      ({ total } = await client.countUnread());
    } catch {
      // 版の違うタブがあるなど。番号の合う代表に替わると、すべての表が変わったと届く
      return;
    }
    // 読んでいる間に、また変わった（あとの読み出しが書く）
    if (read !== reads) return;
    try {
      await (total === 0 ? badge.clearAppBadge() : badge.setAppBadge(total));
    } catch {
      // 次に数え直したときにまた書く
    }
  };

  client.onChange((tables) => {
    if (tables.has("articles")) void update();
  });
  page.addEventListener("visibilitychange", () => {
    if (page.visibilityState === "visible") void update();
  });
  void update();
}
