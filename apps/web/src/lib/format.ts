const dateTime = new Intl.DateTimeFormat("ja", { dateStyle: "medium", timeStyle: "short" });
const relative = new Intl.RelativeTimeFormat("ja", { numeric: "auto" });

/** 「3 時間前」のような、今からの相対の時刻 */
export function fromNow(ms: number, now = Date.now()): string {
  const minutes = Math.round((ms - now) / 60_000);
  if (Math.abs(minutes) < 60) return relative.format(minutes, "minute");
  const hours = Math.round(minutes / 60);
  if (Math.abs(hours) < 24) return relative.format(hours, "hour");
  const days = Math.round(hours / 24);
  if (Math.abs(days) < 7) return relative.format(days, "day");
  return dateTime.format(ms);
}

const shortDate = new Intl.DateTimeFormat("ja", { month: "numeric", day: "numeric" });
const longDate = new Intl.DateTimeFormat("ja", { dateStyle: "medium" });

/** 一覧に出す短い時刻。この 1 週間は「3 時間前」、それより前は日付（今年でなければ年も） */
export function shortTime(ms: number, now = Date.now()): string {
  if (Math.abs(now - ms) < 7 * 86_400_000) return fromNow(ms, now);
  const sameYear = new Date(ms).getFullYear() === new Date(now).getFullYear();
  return (sameYear ? shortDate : longDate).format(ms);
}

const weekday = new Intl.DateTimeFormat("ja", { month: "long", day: "numeric", weekday: "short" });
const month = new Intl.DateTimeFormat("ja", { year: "numeric", month: "long" });

/** 一覧を日付で区切るときの見出し。今日、昨日、この 1 週間は日付、それより前は月 */
export function dayLabel(ms: number, now = Date.now()): string {
  const startOfDay = (time: number) => new Date(time).setHours(0, 0, 0, 0);
  const days = Math.round((startOfDay(now) - startOfDay(ms)) / 86_400_000);
  if (days <= 0) return "今日";
  if (days === 1) return "昨日";
  if (days < 7) return weekday.format(ms);
  return month.format(ms);
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
