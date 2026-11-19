const dateTime = new Intl.DateTimeFormat("ja", { dateStyle: "medium", timeStyle: "short" });
/** 「3h」「5m」「2d」のような、今からの相対の時刻。1 分以内は now。1 週間より前は、日付と時刻 */
export function fromNow(ms: number, now = Date.now()): string {
  const minutes = Math.round(Math.abs(now - ms) / 60_000);
  if (minutes < 1) return "now";
  if (minutes < 60) return `${minutes}m`;
  const hours = Math.round(minutes / 60);
  if (hours < 24) return `${hours}h`;
  const days = Math.round(hours / 24);
  if (days < 7) return `${days}d`;
  return dateTime.format(ms);
}

const shortDate = new Intl.DateTimeFormat("ja", { month: "numeric", day: "numeric" });
const longDate = new Intl.DateTimeFormat("ja", { dateStyle: "medium" });

/** 一覧に出す短い時刻。この 1 週間は「3h」、それより前は日付（今年でなければ年も） */
export function shortTime(ms: number, now = Date.now()): string {
  if (Math.abs(now - ms) < 7 * 86_400_000) return fromNow(ms, now);
  const sameYear = new Date(ms).getFullYear() === new Date(now).getFullYear();
  return (sameYear ? shortDate : longDate).format(ms);
}

const weekday = new Intl.DateTimeFormat("ja", { month: "long", day: "numeric", weekday: "short" });
const month = new Intl.DateTimeFormat("ja", { year: "numeric", month: "long" });
const startOfDay = (time: number) => new Date(time).setHours(0, 0, 0, 0);

/** 一覧を日付で区切るときの見出し。今日、昨日、この 1 週間は日付、それより前は月 */
export function dayLabel(ms: number, now = Date.now()): string {
  const days = Math.round((startOfDay(now) - startOfDay(ms)) / 86_400_000);
  if (days <= 0) return "Today";
  if (days === 1) return "Yesterday";
  if (days < 7) return weekday.format(ms);
  return month.format(ms);
}

export function formatDate(ms: number): string {
  return longDate.format(ms);
}

/** 公開日から過ぎた日数、月数、年数。未来の公開日には経過期間を出さない */
export function formatArticleAge(ms: number, now = Date.now()): string | null {
  const days = Math.round((startOfDay(now) - startOfDay(ms)) / 86_400_000);
  if (days < 0) return null;
  if (days === 0) return "今日";
  const today = new Date(now);
  const published = new Date(ms);
  const months =
    (today.getFullYear() - published.getFullYear()) * 12 +
    today.getMonth() -
    published.getMonth() -
    (today.getDate() < published.getDate() ? 1 : 0);
  if (months >= 12) return `${Math.floor(months / 12)}年以上前`;
  if (months > 0) return `${months}か月前`;
  return `${days}日前`;
}

export function formatDateTime(ms: number): string {
  return dateTime.format(ms);
}

/**
 * 外から来た長い文字列（クライアントの名前など）を、画面に出せる長さに切る
 * （docs/decisions/account.md の 6）。サロゲートペアの途中では切らない
 */
export function truncate(text: string, max = 80): string {
  const chars = [...text];
  return chars.length <= max ? text : `${chars.slice(0, max).join("")}…`;
}

/** 狭いところに出す数。1,000 以上は「1K+」のように丸める */
export function compactCount(count: number): string {
  return count < 1000 ? String(count) : `${Math.floor(count / 1000)}K+`;
}
