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
