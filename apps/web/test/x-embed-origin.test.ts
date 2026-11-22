import { describe, expect, test } from "vitest";
import { contentSecurityPolicy, securityHeaders } from "../security-headers";
import { xEmbedOrigin } from "../src/lib/x-embed";
import { isXEmbedHost, toXEmbedOrigin, X_EMBED_ORIGIN_META } from "../x-embed-origin";

/** X の投稿の隔離フレームのオリジン（docs/decisions/embeds.md の 3） */

describe("値の形", () => {
  test.each([
    ["https://embed.example", "https://embed.example"],
    ["https://embed.example/", "https://embed.example"],
    ["https://EMBED.example", "https://embed.example"],
    ["https://embed.example:8443", "https://embed.example:8443"],
    ["https://embed.example:443", "https://embed.example"],
    ["https://192.0.2.1", "https://192.0.2.1"],
  ])("%s は %s", (value, origin) => {
    expect(toXEmbedOrigin(value, { allowDevelopment: false })).toBe(origin);
    expect(toXEmbedOrigin(value, { allowDevelopment: true })).toBe(origin);
  });

  test.each([
    "http://localhost",
    "http://localhost:5173",
    "http://127.0.0.1",
    "http://127.0.0.1:4173/",
  ])("開発用の %s は、dev サーバーと preview だけが受け付ける", (value) => {
    expect(toXEmbedOrigin(value, { allowDevelopment: true })).toBe(value.replace(/\/$/, ""));
    expect(toXEmbedOrigin(value, { allowDevelopment: false })).toBeNull();
  });

  test.each([
    "http://embed.example",
    "http://localhost.example",
    "http://sub.localhost",
    "http://127.0.0.2",
    "http://[::1]",
    "http://localhost/x",
    "https://embed.example/x",
    "https://embed.example?",
    "https://embed.example#",
    "https://embed.example/#id=1&theme=dark",
    "https://user@embed.example",
    "https://*.example",
    "https://embed.example.",
    "https://-embed.example",
    "https://embed.example/.",
    "https://embed.example/%2e",
    "https://embed.example/a/..",
    "https:embed.example",
    "https:/embed.example",
    "https://embed.example:",
    "https://a..b",
    "https://-a-.example",
    "javascript:alert(1)",
    "data:text/html,x",
    "",
    " ",
  ])("%s は受けない", (value) => {
    expect(toXEmbedOrigin(value, { allowDevelopment: true })).toBeNull();
  });
});

describe("Host の振り分け", () => {
  test("大文字・小文字、ポート、末尾の点によらず、同じホスト名なら隔離フレーム", () => {
    for (const host of ["embed.example", "Embed.EXAMPLE", "embed.example:8080", "embed.example."]) {
      expect(isXEmbedHost(host, "https://embed.example"), host).toBe(true);
    }
    for (const host of ["reader.example", "embed.example.com", "a.embed.example", "", null]) {
      expect(isXEmbedHost(host, "https://embed.example"), String(host)).toBe(false);
    }
    // 開発用は、localhost と 127.0.0.1 を見分ける
    expect(isXEmbedHost("127.0.0.1:4173", "http://127.0.0.1:4173")).toBe(true);
    expect(isXEmbedHost("localhost:4173", "http://127.0.0.1:4173")).toBe(false);
  });
});

describe("reader の CSP", () => {
  test("設定があるときだけ、frame-src を 1 つ足し、ほかは 1 文字も変えない", () => {
    for (const mode of ["production", "development"] as const) {
      const base = contentSecurityPolicy(mode);
      expect(base).not.toContain("frame-src");
      expect(contentSecurityPolicy(mode, { xEmbedOrigin: null })).toBe(base);
      expect(contentSecurityPolicy(mode, { xEmbedOrigin: "https://embed.example" })).toBe(
        `${base}; frame-src https://embed.example`,
      );
      const headers = securityHeaders(mode, { xEmbedOrigin: "https://embed.example" });
      const plain = securityHeaders(mode);
      expect({ ...headers, "Content-Security-Policy": "" }).toEqual({
        ...plain,
        "Content-Security-Policy": "",
      });
    }
  });
});

describe("画面の関数", () => {
  const page = (content: string | null, hostname = "reader.example") => ({
    doc: {
      querySelector: (selector: string) =>
        selector === `meta[name="${X_EMBED_ORIGIN_META}"]` && content !== null
          ? ({ getAttribute: (name: string) => (name === "content" ? content : null) } as Element)
          : null,
    },
    here: { hostname },
  });

  test("<meta> の値を返す。なければ未設定", () => {
    const set = page("https://embed.example");
    expect(xEmbedOrigin(set.doc, set.here)).toBe("https://embed.example");
    const unset = page(null);
    expect(xEmbedOrigin(unset.doc, unset.here)).toBeNull();
    const empty = page("");
    expect(xEmbedOrigin(empty.doc, empty.here)).toBeNull();
  });

  test("形の合わない値は、未設定として扱う", () => {
    for (const value of [
      "javascript:alert(1)",
      "https://embed.example/x",
      "http://embed.example",
    ]) {
      const set = page(value);
      expect(xEmbedOrigin(set.doc, set.here), value).toBeNull();
    }
  });

  test("開発用の値は、reader と違うホスト名なら使う", () => {
    const set = page("http://127.0.0.1:4173", "localhost");
    expect(xEmbedOrigin(set.doc, set.here)).toBe("http://127.0.0.1:4173");
  });

  test("reader と同じホスト名なら、ポートが違っても未設定として扱う", () => {
    for (const [value, hostname] of [
      ["https://reader.example", "reader.example"],
      ["https://reader.example:8443", "reader.example"],
      ["https://reader.example", "READER.example"],
      ["http://localhost:5174", "localhost"],
    ] as const) {
      const set = page(value, hostname);
      expect(xEmbedOrigin(set.doc, set.here), value).toBeNull();
    }
  });
});
