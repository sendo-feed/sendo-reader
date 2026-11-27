import { isSendoPath } from "../../sendo-paths";
import {
  articleIdFromTag,
  notificationPath,
  OPEN_ARTICLE,
  OPEN_ARTICLE_WAIT_MS,
  type OpenArticleMessage,
} from "./notification";
import { canReloadPage } from "./reload-paths";

/**
 * 押された通知の記事を開く（docs/decisions/push-receive.md の 3）。Service Worker（sw/sw.ts）の
 * notificationclick から呼ぶ。Service Worker の型（webworker）と画面の型（dom）の両方で調べるので、
 * 使うものだけを形で受ける（テストでは、にせものを渡す）。
 */

/** 開いている窓（WindowClient のうち、使うところ） */
export interface WindowLike {
  readonly url: string;
  postMessage(message: OpenArticleMessage, transfer: Transferable[]): void;
  focus(): Promise<unknown>;
}

export interface NotificationClickEnvironment {
  /** 開いている窓を、最後に前に出ていたものから並べる（clients.matchAll） */
  windows(): Promise<readonly WindowLike[]>;
  openWindow(url: string): Promise<unknown>;
  /** 覚えた tag を外す（docs/decisions/push-receive.md の 4） */
  forgetTag(tag: string): Promise<void>;
}

/**
 * 覚えた tag を外してから、開いている reader の画面に開かせる。選べる画面がない、断られた、0.5 秒の
 * うちに受けたことが返らない、選んで知らせる途中で投げたときは、新しい窓で開く。記事の ID は tag から
 * 読み、読めなければ reader の先頭を開く（iOS で取り直した通知は data が空）
 */
export async function openFromNotification(
  env: NotificationClickEnvironment,
  tag: string,
): Promise<void> {
  await env.forgetTag(tag).catch(() => {});
  const articleId = articleIdFromTag(tag);
  if (articleId !== null) {
    try {
      const client = await readerWindow(env);
      if (client !== null && (await askToOpen(client, articleId))) {
        await client.focus().catch(() => {});
        return;
      }
    } catch {
      // 画面に開かせられなかったので、新しい窓で開く
    }
  }
  await env.openWindow(notificationPath(tag));
}

/**
 * 開いている reader の画面を、最後に前に出ていたものから選ぶ。sendo のパス（中継した sendo の応答を
 * 出している窓）、OAuth の許可の画面、読み込み直すと消えるものを出している画面（パスで分かるもの）は
 * 選ばない
 */
async function readerWindow(env: NotificationClickEnvironment): Promise<WindowLike | null> {
  const windows = await env.windows();
  return (
    windows.find((client) => {
      const { pathname } = new URL(client.url);
      return !isSendoPath(pathname) && canReloadPage(pathname, false);
    }) ?? null
  );
}

/** 画面に記事を開かせ、受けたことが返ったら true。断られた、待つ時間を過ぎた、送れなかったら false */
function askToOpen(client: WindowLike, articleId: string): Promise<boolean> {
  return new Promise((resolve) => {
    const channel = new MessageChannel();
    const finish = (accepted: boolean) => {
      clearTimeout(timer);
      channel.port1.close();
      resolve(accepted);
    };
    const timer = setTimeout(() => finish(false), OPEN_ARTICLE_WAIT_MS);
    channel.port1.onmessage = (event: MessageEvent) => {
      finish((event.data as { accepted?: unknown } | null)?.accepted === true);
    };
    const message: OpenArticleMessage = { type: OPEN_ARTICLE, articleId, sentAt: Date.now() };
    try {
      client.postMessage(message, [channel.port2]);
    } catch {
      finish(false);
    }
  });
}
