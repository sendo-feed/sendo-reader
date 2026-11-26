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
 * 数の正は手元の DB で、ここには最後に出した数だけを覚え、変わったときだけ書く。書けなければ
 * （iOS では、通知を許可していないと失敗する）、画面には何も出さず、次に数え直したときに書き直す。
 */
export function showUnreadBadge(
  client: Pick<ReaderClient, "countUnread" | "onChange">,
  badge: AppBadge,
): void {
  /** 最後に出した数。分からない（起動したばかり、書けなかった）ときは undefined */
  let shown: number | undefined;
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
    if (read !== reads || total === shown) return;
    shown = total;
    try {
      await (total === 0 ? badge.clearAppBadge() : badge.setAppBadge(total));
    } catch {
      if (shown === total) shown = undefined;
    }
  };

  client.onChange((tables) => {
    if (tables.has("articles")) void update();
  });
  void update();
}
