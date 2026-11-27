/**
 * ベルの通知（docs/decisions/push-receive.md の 2〜6）。Service Worker（sw/sw.ts）と画面の両方が使う。
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

/** 通知から開いたことの印（docs/decisions/push-receive.md の 3）。記事の URL に付ける */
const FROM_PARAM = "from";
const FROM_NOTIFICATION = "notification";

/**
 * 通知を押したときに開く、自分のオリジンの URL（出し直した通知の navigate と openWindow）。記事の URL に、
 * 通知から開いたことの印を付ける。tag を読めなければ reader の先頭（印は付けない）
 */
export function notificationPath(tag: string): string {
  const articleId = articleIdFromTag(tag);
  if (articleId === null) return "/";
  return `/?${new URLSearchParams({ article: articleId, [FROM_PARAM]: FROM_NOTIFICATION })}`;
}

/**
 * URL から、通知から開いたことの印を外す。印があれば、外した URL と、印の付いていた記事の ID（記事の
 * URL でなければ null）を返す。印がなければ null
 */
export function takeNotificationMark(url: URL): { url: URL; articleId: string | null } | null {
  if (url.searchParams.get(FROM_PARAM) !== FROM_NOTIFICATION) return null;
  const next = new URL(url);
  next.searchParams.delete(FROM_PARAM);
  return { url: next, articleId: next.searchParams.get("article") };
}

/**
 * Service Worker が、押された通知の記事を開かせる知らせ（docs/decisions/push-receive.md の 3）。画面は
 * 知らせに付けたポートで OpenArticleReply を返す。形は変えない（変えるときは、別の名前の知らせにする。
 * 古い版の画面は答えず、Service Worker が新しい窓で開く）
 */
export const OPEN_ARTICLE = "sendo-reader:open-article";

export interface OpenArticleMessage {
  type: typeof OPEN_ARTICLE;
  articleId: string;
  /** Service Worker が送った時刻（ミリ秒） */
  sentAt: number;
}

export interface OpenArticleReply {
  accepted: boolean;
}

/** Service Worker が、画面が受けたことを待つ時間 */
export const OPEN_ARTICLE_WAIT_MS = 500;

/**
 * 画面が知らせを受ける上限。待つ時間より、受けたことの返事が届く分だけ短くする（待つのをやめて
 * 新しい窓で開いたあとに、遅れて届いた知らせで移ると、2 か所で開く）
 */
export const OPEN_ARTICLE_MAX_AGE_MS = 300;

export function isOpenArticleMessage(value: unknown): value is OpenArticleMessage {
  if (typeof value !== "object" || value === null) return false;
  const message = value as Partial<OpenArticleMessage>;
  return (
    message.type === OPEN_ARTICLE &&
    typeof message.articleId === "string" &&
    message.articleId !== "" &&
    typeof message.sentAt === "number"
  );
}
