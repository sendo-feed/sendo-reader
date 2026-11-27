/**
 * ベルの通知（docs/decisions/notifications.md の 6〜10）。Service Worker（sw/sw.ts）と画面の両方が使う。
 * ブラウザーでも Service Worker でも動く（画面だけの API を使わない）。
 *
 * 中身の形は sendo の決定（notifications.md の 14）が正。title と body は信頼できない文字で、通知に
 * そのまま出すだけにする（HTML として組み立てず、手も加えず、どこにも残さない）。
 */

/** 通知の中身のうち、通知に出すもの */
export interface PushPayload {
  title: string;
  body: string | undefined;
  /** bell:<ベルの ID>:<記事の ID> */
  tag: string;
  data: unknown;
}

/** push の event のうち、読むところ */
export interface PushEventLike {
  /** 宣言型の push（web_push: 8030）を読むブラウザーでは、ここに中身が入る（event.data は null） */
  readonly notification?: unknown;
  readonly data: { json(): unknown } | null;
}

/**
 * push の中身を読む。declarative は、宣言型の push を読むブラウザーで、宣言した通知がもう決まっている
 * （出し直せなくても、それが出る）。payload は、形に合わない（title か tag が文字列でない）と null
 */
export function readPush(event: PushEventLike): {
  declarative: boolean;
  payload: PushPayload | null;
} {
  if (event.notification != null) {
    return { declarative: true, payload: toPayload(event.notification) };
  }
  let body: unknown;
  try {
    body = event.data?.json();
  } catch {
    body = undefined;
  }
  const notification =
    typeof body === "object" && body !== null
      ? (body as { notification?: unknown }).notification
      : undefined;
  return { declarative: false, payload: toPayload(notification) };
}

function toPayload(value: unknown): PushPayload | null {
  if (typeof value !== "object" || value === null) return null;
  const { title, body, tag, data } = value as Record<string, unknown>;
  if (typeof title !== "string" || typeof tag !== "string") return null;
  return { title, body: typeof body === "string" ? body : undefined, tag, data };
}

/**
 * 通知の tag（bell:<ベルの ID>:<記事の ID>）から、記事の ID を読む。bell: の次の : までがベルの ID、
 * 残りが記事の ID。bell: で始まらない、どちらかの ID が空なら null（iOS で取り直した通知は data が
 * 空になるので、data からは読まない）
 */
export function articleIdFromTag(tag: string): string | null {
  const prefix = "bell:";
  if (!tag.startsWith(prefix)) return null;
  const rest = tag.slice(prefix.length);
  const separator = rest.indexOf(":");
  if (separator <= 0) return null;
  const articleId = rest.slice(separator + 1);
  return articleId === "" ? null : articleId;
}

/** reader が記事を開く URL（/?article=<記事の ID>）。値は URLSearchParams で符号化する */
export function articlePath(articleId: string): string {
  return `/?${new URLSearchParams({ article: articleId })}`;
}

/** 通知を押したときに開く、自分のオリジンの URL。tag を読めなければ reader の先頭 */
export function notificationPath(tag: string): string {
  const articleId = articleIdFromTag(tag);
  return articleId === null ? "/" : articlePath(articleId);
}
