import { afterEach, describe, expect, test, vi } from "vitest";
import {
  OPEN_ARTICLE,
  OPEN_ARTICLE_WAIT_MS,
  type OpenArticleMessage,
} from "../src/lib/notification";
import {
  type NotificationClickEnvironment,
  openFromNotification,
  type WindowLike,
} from "../src/lib/notification-click";

const TAG = "bell:bell-1:article-1";
const ARTICLE_PATH = "/?article=article-1";

/**
 * にせものの窓。知らせを受けたら、answer のとおりに答える（accept は受け、decline は断り、silent は
 * 答えず、throw は知らせを受けられない）。前に出した回数を数える
 */
function fakeWindow(url: string, answer: "accept" | "decline" | "silent" | "throw" = "accept") {
  const messages: OpenArticleMessage[] = [];
  let focused = 0;
  let delivered = () => {};
  const received = new Promise<void>((resolve) => {
    delivered = resolve;
  });
  const window: WindowLike = {
    url: new URL(url, "https://reader.test").href,
    postMessage: (message, transfer) => {
      if (answer === "throw") throw new DOMException("閉じた", "InvalidStateError");
      messages.push(message);
      const port = transfer[0] as MessagePort;
      if (answer !== "silent") port.postMessage({ accepted: answer === "accept" });
      port.close();
      delivered();
    },
    focus: async () => {
      focused += 1;
    },
  };
  return { window, messages, focused: () => focused, received };
}

/** にせものの Service Worker。起きたことを順に events に覚える */
function setup(windows: readonly WindowLike[] | Error) {
  const events: string[] = [];
  const env: NotificationClickEnvironment = {
    windows: async () => {
      events.push("windows");
      if (windows instanceof Error) throw windows;
      return windows;
    },
    openWindow: async (url) => {
      events.push(`openWindow ${url}`);
      return null;
    },
    forgetTag: async (tag) => {
      events.push(`forget ${tag}`);
    },
  };
  return { env, events };
}

afterEach(() => {
  vi.useRealTimers();
});

describe("押された通知の記事を開く", () => {
  test("覚えた tag を外してから、最後に前に出ていた reader の画面に開かせ、受けたら前に出す", async () => {
    const first = fakeWindow("/");
    const second = fakeWindow("/?folder=f1");
    const { env, events } = setup([first.window, second.window]);
    await openFromNotification(env, TAG);
    expect(events).toEqual([`forget ${TAG}`, "windows"]);
    expect(first.messages).toEqual([
      { type: OPEN_ARTICLE, articleId: "article-1", sentAt: expect.any(Number) },
    ]);
    expect(first.focused()).toBe(1);
    expect(second.messages).toEqual([]);
  });

  test("読み込み直すと消えるものを出している画面（Settings）しか開いていなければ、記事の URL を新しい窓で開く", async () => {
    const settings = fakeWindow("/settings");
    const { env, events } = setup([settings.window]);
    await openFromNotification(env, TAG);
    expect(settings.messages).toEqual([]);
    expect(events).toEqual([`forget ${TAG}`, "windows", `openWindow ${ARTICLE_PATH}`]);
  });

  test("画面が開いていなければ、記事の URL を新しい窓で開く", async () => {
    const { env, events } = setup([]);
    await openFromNotification(env, TAG);
    expect(events).toEqual([`forget ${TAG}`, "windows", `openWindow ${ARTICLE_PATH}`]);
  });

  test("sendo のパスと OAuth の許可の画面は選ばず、その次の reader の画面に開かせる", async () => {
    const api = fakeWindow("/api/v1/sync");
    const mcp = fakeWindow("/mcp");
    const authorize = fakeWindow("/oauth/authorize?client_id=x");
    const reader = fakeWindow("/");
    const { env, events } = setup([api.window, mcp.window, authorize.window, reader.window]);
    await openFromNotification(env, TAG);
    expect([api, mcp, authorize].map((other) => other.messages)).toEqual([[], [], []]);
    expect(reader.messages).toHaveLength(1);
    expect(events).not.toContain(`openWindow ${ARTICLE_PATH}`);
  });

  test("断られたら、記事の URL を新しい窓で開き、断った画面は前に出さない", async () => {
    const declined = fakeWindow("/", "decline");
    const { env, events } = setup([declined.window]);
    await openFromNotification(env, TAG);
    expect(events.at(-1)).toBe(`openWindow ${ARTICLE_PATH}`);
    expect(declined.focused()).toBe(0);
  });

  test("画面が 0.5 秒のうちに答えなければ、ちょうど 0.5 秒で、記事の URL を新しい窓で開く", async () => {
    vi.useFakeTimers();
    const silent = fakeWindow("/", "silent");
    const { env, events } = setup([silent.window]);
    const opening = openFromNotification(env, TAG);
    await silent.received;
    await vi.advanceTimersByTimeAsync(OPEN_ARTICLE_WAIT_MS - 1);
    expect(events).not.toContain(`openWindow ${ARTICLE_PATH}`);
    await vi.advanceTimersByTimeAsync(1);
    await opening;
    expect(events.at(-1)).toBe(`openWindow ${ARTICLE_PATH}`);
    expect(silent.focused()).toBe(0);
  });

  test("画面を選ぶ途中や、知らせる途中で投げても、記事の URL を新しい窓で開く", async () => {
    const failing = setup(new DOMException("選べない", "InvalidStateError"));
    await openFromNotification(failing.env, TAG);
    expect(failing.events.at(-1)).toBe(`openWindow ${ARTICLE_PATH}`);

    const closed = fakeWindow("/", "throw");
    const throwing = setup([closed.window]);
    await openFromNotification(throwing.env, TAG);
    expect(throwing.events.at(-1)).toBe(`openWindow ${ARTICLE_PATH}`);
  });

  test("読めない tag なら、画面を選ばずに reader の先頭を新しい窓で開く", async () => {
    const reader = fakeWindow("/");
    const { env, events } = setup([reader.window]);
    await openFromNotification(env, "bell::article-1");
    expect(events).toEqual(["forget bell::article-1", "openWindow /"]);
    expect(reader.messages).toEqual([]);
  });
});
