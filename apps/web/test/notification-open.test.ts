import { describe, expect, test } from "vitest";
import { OPEN_ARTICLE, OPEN_ARTICLE_MAX_AGE_MS } from "../src/lib/notification";
import {
  type NotificationOpenEnvironment,
  noteNotificationOpen,
  takeNotificationOpen,
  watchNotificationOpens,
} from "../src/lib/notification-open";
import type { ShownTag } from "../src/lib/notification-store";

/**
 * にせものの画面。覚えた tag（remembered）と、通知センターに出ている tag（shown）はテストが決める。
 * 開いた記事を opened に覚える
 */
function setup(
  options: {
    remembered?: ShownTag[];
    shown?: string[];
    visibility?: DocumentVisibilityState;
    marked?: boolean;
    vanishedOpens?: boolean;
  } = {},
) {
  let now = 10_000;
  const state = {
    remembered: [...(options.remembered ?? [])],
    shown: [...(options.shown ?? [])],
    visibility: options.visibility ?? "visible",
    canOpen: true,
    opened: [] as string[],
    replies: [] as unknown[],
  };
  const container = new EventTarget();
  let started = false;
  const env: NotificationOpenEnvironment = {
    serviceWorker: {
      addEventListener: container.addEventListener.bind(container),
      startMessages: () => {
        started = true;
      },
    },
    shownTags: async () => state.shown,
    listTags: async () => state.remembered,
    forgetTag: async (tag) => {
      state.remembered = state.remembered.filter((remembered) => remembered.tag !== tag);
    },
    now: () => now,
    visibility: () => state.visibility,
    takeAutoReloadMark: () => options.marked ?? false,
    vanishedOpens: options.vanishedOpens ?? true,
    canOpen: () => state.canOpen,
    open: (articleId) => state.opened.push(articleId),
  };
  const watcher = watchNotificationOpens(env);
  /** Service Worker が、押された通知の記事を開かせる知らせを送る */
  const post = (articleId: string, sentAt: number) => {
    const port = { postMessage: (reply: unknown) => state.replies.push(reply) };
    const event = new MessageEvent("message", {
      data: { type: OPEN_ARTICLE, articleId, sentAt },
    });
    Object.defineProperty(event, "ports", { value: [port] });
    container.dispatchEvent(event);
  };
  return {
    state,
    watcher,
    post,
    started: () => started,
    advance: (ms: number) => {
      now += ms;
    },
  };
}

/** 比べ終えるのを待つ */
const settle = () => new Promise((resolve) => setTimeout(resolve, 0));

const tag = (articleId: string) => `bell:bell-1:${articleId}`;

describe("押したことが Service Worker に届いたとき", () => {
  test("受けたことを返し、その記事へ移る", () => {
    const app = setup();
    expect(app.started()).toBe(true);
    app.post("a1", 10_000 - 100);
    expect(app.state.replies).toEqual([{ accepted: true }]);
    expect(app.state.opened).toEqual(["a1"]);
  });

  test("0.3 秒より古い知らせは断り、移らない（Service Worker が新しい窓で開く）", () => {
    const app = setup();
    app.post("a1", 10_000 - OPEN_ARTICLE_MAX_AGE_MS);
    app.post("a2", 10_000 - OPEN_ARTICLE_MAX_AGE_MS - 1);
    expect(app.state.replies).toEqual([{ accepted: true }, { accepted: false }]);
    expect(app.state.opened).toEqual(["a1"]);
  });

  test("読み込み直すと消えるものを出している画面は断る", () => {
    const app = setup();
    app.state.canOpen = false;
    app.post("a1", 10_000);
    expect(app.state.replies).toEqual([{ accepted: false }]);
    expect(app.state.opened).toEqual([]);
  });
});

describe("消えた通知で見分ける（iPhone と iPad のホーム画面のアプリ）", () => {
  test("起動したときは、消えた tag を外すだけで開かない", async () => {
    const app = setup({ remembered: [{ tag: tag("a1"), at: 1 }], shown: [] });
    await settle();
    expect(app.state.remembered).toEqual([]);
    expect(app.state.opened).toEqual([]);
  });

  test("前に出たときに 1 件だけ消えていたら、押されたものとみなして開く", async () => {
    const app = setup({
      remembered: [
        { tag: tag("a1"), at: 1 },
        { tag: tag("a2"), at: 2 },
      ],
      shown: [tag("a1"), tag("a2")],
    });
    await settle();
    app.state.shown = [tag("a1")];
    app.watcher.onVisible(false);
    await settle();
    expect(app.state.opened).toEqual(["a2"]);
    expect(app.state.remembered).toEqual([{ tag: tag("a1"), at: 1 }]);
  });

  test("2 件以上消えていたら、どれも開かずに外す", async () => {
    const app = setup({
      remembered: [
        { tag: tag("a1"), at: 1 },
        { tag: tag("a2"), at: 2 },
      ],
      shown: [tag("a1"), tag("a2")],
    });
    await settle();
    app.state.shown = [];
    app.watcher.onVisible(false);
    await settle();
    expect(app.state.opened).toEqual([]);
    expect(app.state.remembered).toEqual([]);
  });

  test("自動で読み込み直すと決めた前に出たことでは比べない", async () => {
    const app = setup({ remembered: [{ tag: tag("a1"), at: 1 }], shown: [tag("a1")] });
    await settle();
    app.state.shown = [];
    app.watcher.onVisible(true);
    await settle();
    expect(app.state.remembered).toHaveLength(1);
    expect(app.state.opened).toEqual([]);
  });

  test("自動で読み込み直したあと、前に出ている起動は、前に出たときと同じに扱う", async () => {
    const app = setup({ remembered: [{ tag: tag("a1"), at: 1 }], shown: [], marked: true });
    await settle();
    expect(app.state.opened).toEqual(["a1"]);
  });

  test("自動で読み込み直したあと、裏で起動したら比べず、次に前に出たときにいつもどおり扱う", async () => {
    const app = setup({
      remembered: [{ tag: tag("a1"), at: 1 }],
      shown: [],
      marked: true,
      visibility: "hidden",
    });
    await settle();
    expect(app.state.remembered).toHaveLength(1);
    app.state.visibility = "visible";
    app.watcher.onVisible(false);
    await settle();
    expect(app.state.opened).toEqual(["a1"]);
  });

  test("取り直し始めたあとに覚えた tag は比べない", async () => {
    const app = setup();
    await settle();
    // 前に出たのと同じころに届いた通知（覚えた時刻が、取り直し始めた時刻と同じ）
    app.state.remembered = [{ tag: tag("a1"), at: 10_000 }];
    app.watcher.onVisible(false);
    await settle();
    expect(app.state.remembered).toHaveLength(1);
    expect(app.state.opened).toEqual([]);
  });

  test("読み込み直すと消えるものを出している画面では、外すが開かない", async () => {
    const app = setup({ remembered: [{ tag: tag("a1"), at: 1 }], shown: [tag("a1")] });
    await settle();
    app.state.shown = [];
    app.state.canOpen = false;
    app.watcher.onVisible(false);
    await settle();
    expect(app.state.remembered).toEqual([]);
    expect(app.state.opened).toEqual([]);
  });

  test("ほかの環境では、消えた tag を外すだけで開かない（押したことは Service Worker に届く）", async () => {
    const app = setup({
      remembered: [{ tag: tag("a1"), at: 1 }],
      shown: [tag("a1")],
      vanishedOpens: false,
    });
    await settle();
    app.state.shown = [];
    app.watcher.onVisible(false);
    await settle();
    expect(app.state.remembered).toEqual([]);
    expect(app.state.opened).toEqual([]);
  });

  test("起動したときと前に出たときが重なっても、同じ tag を 2 度数えない", async () => {
    const app = setup({ remembered: [{ tag: tag("a1"), at: 1 }], shown: [] });
    // 起動したときの比べが終わる前に、前に出た
    app.watcher.onVisible(false);
    await settle();
    expect(app.state.opened).toEqual([]);
  });
});

describe("通知から開こうとした記事", () => {
  test("覚えた記事のときだけ true を返し、覚えは消す", () => {
    noteNotificationOpen("a1");
    expect(takeNotificationOpen("a2")).toBe(false);
    expect(takeNotificationOpen("a1")).toBe(true);
    expect(takeNotificationOpen("a1")).toBe(false);
  });
});
