import {
  articleIdFromTag,
  isOpenArticleMessage,
  OPEN_ARTICLE_MAX_AGE_MS,
  type OpenArticleReply,
} from "./notification";
import type { ShownTag } from "./notification-store";

/**
 * 押された通知の記事を、開いている画面で開く（docs/decisions/push-receive.md の 3・4）。
 *
 * - 押したことが Service Worker に届いたら（notificationclick）、Service Worker が知らせてくるので、
 *   読み込み直すと消えるものを出していなければ受け、その記事へ移る
 * - iPhone と iPad のホーム画面のアプリで、裏で動いているときに押された通知は、どこにも届かない。
 *   前に出たときに、覚えた tag のうち通知センターから消えたものを見分け、1 件だけなら押されたと
 *   みなして開く。ほかの環境でも、消えた tag は覚えから外すが、開かない
 */

const AUTO_RELOAD_MARK = "sendo-reader:auto-reload";

/**
 * 新しい版への切り替えで、自動で読み込み直す前に置く印（中身は入れない）。読み込み直したあとの起動を、
 * 前に出たときと同じに扱うため（押した通知で前に出たときに読み込み直しても、押した記事を開く）
 */
export function markAutoReload(): void {
  try {
    sessionStorage.setItem(AUTO_RELOAD_MARK, "");
  } catch {
    // 置けなければ、読み込み直したあとは起動として扱う（消えた通知の記事は開かない）
  }
}

/** 自動で読み込み直す前に置いた印があれば消して true */
export function takeAutoReloadMark(): boolean {
  try {
    const marked = sessionStorage.getItem(AUTO_RELOAD_MARK) !== null;
    sessionStorage.removeItem(AUTO_RELOAD_MARK);
    return marked;
  } catch {
    return false;
  }
}

/** 使うものだけを、形で受ける（テストでは、にせものを渡す） */
export interface NotificationOpenEnvironment {
  /** Service Worker からの知らせ（navigator.serviceWorker）。使えなければ null */
  serviceWorker: Pick<ServiceWorkerContainer, "addEventListener" | "startMessages"> | null;
  /** 出ている reader の通知の tag（registration.getNotifications()）。登録がなければ空 */
  shownTags(): Promise<string[]>;
  listTags(): Promise<ShownTag[]>;
  forgetTag(tag: string): Promise<void>;
  now(): number;
  visibility(): DocumentVisibilityState;
  takeAutoReloadMark(): boolean;
  /**
   * 消えた通知で、押された記事を開く環境か。iPhone と iPad のホーム画面のアプリ（navigator.standalone が
   * true で、触れる画面）だけ。押したことが届く環境で開くと、OS が片付けた通知の記事まで開く
   */
  vanishedOpens: boolean;
  /** 読み込み直すと消えるものを出していない（自動の読み込み直しと同じ条件） */
  canOpen(): boolean;
  /** 記事を開く（/?article=<記事の ID> へ移る） */
  open(articleId: string): void;
}

/**
 * Service Worker の知らせを受け始め、起動したときの消えた通知を比べる。返した onVisible は、前に出た
 * ときに、自動で読み込み直すかが決まってから呼ぶ（lib/app-update.ts の onVisible）
 */
export function watchNotificationOpens(env: NotificationOpenEnvironment): {
  onVisible(reloading: boolean): void;
} {
  env.serviceWorker?.addEventListener("message", (event) => {
    if (!isOpenArticleMessage(event.data)) return;
    const port = event.ports[0];
    if (port === undefined) return;
    // 古い知らせを断る（Service Worker が待つのをやめて新しい窓で開いたあとに移ると、2 か所で開く）
    const accepted = env.now() - event.data.sentAt <= OPEN_ARTICLE_MAX_AGE_MS && env.canOpen();
    port.postMessage({ accepted } satisfies OpenArticleReply);
    if (accepted) env.open(event.data.articleId);
  });
  env.serviceWorker?.startMessages();

  // 比べるのは 1 つずつ（起動したときと前に出たときが重なっても、同じ tag を 2 度数えない）
  let comparing = Promise.resolve();
  const compare = (open: boolean) => {
    comparing = comparing.then(() => compareVanished(env, open)).catch(() => {});
  };

  // 起動したときは、消えた tag を外すだけで開かない（終了しているときに押されたなら、通知の navigate
  // で開いている）。自動で読み込み直したあとの起動は、前に出ていれば前に出たときと同じに扱い、裏で
  // 起動したなら、次に前に出たときにいつもどおり扱う
  if (!env.takeAutoReloadMark()) compare(false);
  else if (env.visibility() === "visible") compare(env.vanishedOpens);

  return {
    onVisible(reloading) {
      // 読み込み直すと決めたら、この前に出たことでは比べない（読み込み直したあとの起動で比べる）
      if (!reloading) compare(env.vanishedOpens);
    },
  };
}

async function compareVanished(env: NotificationOpenEnvironment, open: boolean): Promise<void> {
  // 取り直し始めたあとに覚えた tag は比べない（まだ取り直しに入っていないだけで、消えたように見える）
  const startedAt = env.now();
  const shown = new Set(await env.shownTags());
  const vanished = (await env.listTags()).filter(
    (remembered) => remembered.at < startedAt && !shown.has(remembered.tag),
  );
  for (const { tag } of vanished) await env.forgetTag(tag);
  // 2 件以上なら、どれも開かない（まとめて消してから開いたことが多く、押していない記事を既読にしない）
  const [only] = vanished;
  if (!open || only === undefined || vanished.length !== 1 || !env.canOpen()) return;
  const articleId = articleIdFromTag(only.tag);
  if (articleId !== null) env.open(articleId);
}

/** 通知から開こうとした記事（選んでいるワークスペースの範囲の外なら、知らせを出す） */
let openedFromNotification: string | null = null;

/** 通知から記事を開く前に、その記事を覚える */
export function noteNotificationOpen(articleId: string): void {
  openedFromNotification = articleId;
}

/**
 * その記事が、通知から開こうとした記事なら true（覚えは消す）。範囲の外の記事を出さないと決めたときに
 * 呼び、知らせを出すかを決める（docs/decisions/push-receive.md の 5）
 */
export function takeNotificationOpen(articleId: string): boolean {
  const opened = openedFromNotification === articleId;
  if (opened) openedFromNotification = null;
  return opened;
}

/**
 * 記事の画面を離れたときに呼ぶ。その記事が通知から開こうとした記事なら、届かないまま待ちを終えたので
 * 覚えを消す（あとで同じ記事の URL を開いても、通知の知らせを出さない）
 */
export function leaveNotificationOpen(articleId: string): void {
  if (openedFromNotification === articleId) openedFromNotification = null;
}
