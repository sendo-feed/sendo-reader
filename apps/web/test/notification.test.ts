import { describe, expect, test } from "vitest";
import {
  articleIdFromTag,
  articlePath,
  notificationPath,
  readPush,
  takeNotificationMark,
} from "../src/lib/notification";

/** 宣言型の push を読まないブラウザーの event（中身は event.data の JSON） */
function dataEvent(body: unknown) {
  return {
    data: {
      json: () => (typeof body === "string" ? JSON.parse(body) : body),
    },
  };
}

const notification = {
  title: "Azure 障害 · Publickey",
  body: "<b>Azure</b> の東日本リージョンで障害",
  navigate: "https://evil.example/",
  tag: "bell:b1:a1",
  data: { bellId: "b1", articleId: "a1", count: 1 },
};

describe("push の中身", () => {
  test("宣言型の push を読むブラウザーでは event.notification から、文字のまま読む", () => {
    expect(readPush({ notification, data: null })).toEqual({
      declarative: true,
      payload: {
        title: notification.title,
        body: notification.body,
        tag: notification.tag,
        data: notification.data,
      },
    });
  });

  test("読まないブラウザーでは event.data の JSON の notification から読む", () => {
    const event = dataEvent({ web_push: 8030, notification, app_badge: 12, mutable: true });
    expect(readPush(event)).toMatchObject({
      declarative: false,
      payload: { title: notification.title, body: notification.body, tag: notification.tag },
    });
  });

  test.each([
    ["title が文字列でない", { ...notification, title: 1 }],
    ["tag が文字列でない", { ...notification, tag: null }],
    ["notification がない", undefined],
  ])("%s なら、形に合わない", (_name, value) => {
    expect(readPush({ notification: value, data: null }).payload).toBeNull();
    expect(readPush(dataEvent({ notification: value })).payload).toBeNull();
  });

  test("JSON でない中身と、中身のない push は、形に合わない", () => {
    expect(readPush(dataEvent("{not json")).payload).toBeNull();
    expect(readPush({ data: null })).toEqual({ declarative: false, payload: null });
  });

  test("body が文字列でなければ、本文なしとして出す", () => {
    expect(readPush({ notification: { ...notification, body: 3 }, data: null }).payload?.body).toBe(
      undefined,
    );
  });
});

describe("tag と開く URL", () => {
  test.each([
    ["bell:b1:a1", "a1"],
    // 記事の ID に : があっても、ベルの ID の次の : までで分ける
    ["bell:b1:a:1", "a:1"],
    ["bell::a1", null],
    ["bell:b1:", null],
    ["bell:b1", null],
    ["other:b1:a1", null],
    ["", null],
  ])("%s の記事の ID は %s", (tag, expected) => {
    expect(articleIdFromTag(tag)).toBe(expected);
  });

  test("記事の URL は、記事の ID を符号化して組み立てる", () => {
    expect(articlePath("a1")).toBe("/?article=a1");
    expect(articlePath("a&b=c/d")).toBe("/?article=a%26b%3Dc%2Fd");
  });

  test("通知から開く URL には、通知から開いたことの印を付ける。tag を読めなければ、reader の先頭を開く", () => {
    expect(notificationPath("bell:b1:a1")).toBe("/?article=a1&from=notification");
    expect(notificationPath("bell:b1:a&b=c")).toBe("/?article=a%26b%3Dc&from=notification");
    expect(notificationPath("broken")).toBe("/");
  });

  test("印を外した URL と、印の付いていた記事を返す", () => {
    const base = "https://reader.example";
    const marked = takeNotificationMark(new URL(notificationPath("bell:b1:a1"), base));
    expect(marked?.url.href).toBe(`${base}/?article=a1`);
    expect(marked?.articleId).toBe("a1");
    expect(takeNotificationMark(new URL("/?from=notification", base))).toEqual({
      url: new URL("/", base),
      articleId: null,
    });
    // 印のない URL と、ほかの値の from は、そのまま
    expect(takeNotificationMark(new URL("/?article=a1", base))).toBeNull();
    expect(takeNotificationMark(new URL("/?article=a1&from=elsewhere", base))).toBeNull();
  });
});
