import { describe, expect, test } from "vitest";
import { isSendoPath, SENDO_NAVIGATION_DENYLIST } from "../../sendo-paths";

const SENDO_PATHS = [
  "/api",
  "/api/v1/sync",
  "/api/v1/auth/google/callback",
  "/mcp",
  "/.well-known/oauth-protected-resource/mcp",
  "/.well-known/oauth-authorization-server",
  "/oauth/token",
  "/oauth/register",
  "/accounts/ClientLogin",
  "/reader/api/0/stream/contents/user/-/state/com.google/reading-list",
  "/healthz",
];

/** 画面のルート（src/lib/router.svelte.ts）と、画面のファイル。sendo に回さない */
const READER_PATHS = [
  "/",
  "/index.html",
  "/sw.js",
  "/assets/index-abc.js",
  "/starred",
  "/search",
  "/manage",
  "/settings",
  "/feeds/abc",
  "/folders/abc",
  "/oauth/authorize",
  // 前に付く文字が同じでも、別のパス
  "/apis",
  "/api2",
  "/mcp/",
  "/mcpx",
  "/oauth",
  "/oauth/",
  "/reader/api/1/x",
  "/.well-known/assetlinks.json",
  "/healthz/x",
];

describe("sendo のパス", () => {
  test.each(SENDO_PATHS)("%s は sendo に中継する", (path) => {
    expect(isSendoPath(path)).toBe(true);
  });

  test.each(READER_PATHS)("%s は画面のもの", (path) => {
    expect(isSendoPath(path)).toBe(false);
  });

  const denied = (url: string) => SENDO_NAVIGATION_DENYLIST.some((pattern) => pattern.test(url));

  test.each([
    ...SENDO_PATHS,
    "/mcp?x=1",
    "/oauth/token?x=1",
    "/api/v1/auth/google/callback?code=a&state=b",
  ])("Service Worker は %s へのページの移動を横取りしない", (url) => {
    expect(denied(url)).toBe(true);
  });

  test.each([...READER_PATHS, "/oauth/authorize?client_id=x", "/settings?tab=tokens"])(
    "Service Worker は %s へのページの移動に index.html を返す",
    (url) => {
      expect(denied(url)).toBe(false);
    },
  );
});
