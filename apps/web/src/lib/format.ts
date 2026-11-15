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
