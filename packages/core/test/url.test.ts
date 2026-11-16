import { describe, expect, test } from "vitest";
import { toSafeHttpUrl, toSameOriginUrl } from "../src";

describe("toSafeHttpUrl", () => {
  test("http と https の URL はそのまま返す", () => {
    expect(toSafeHttpUrl("https://example.com/a?b=1#c")).toBe("https://example.com/a?b=1#c");
    expect(toSafeHttpUrl("http://example.com")).toBe("http://example.com/");
  });

  test.each([
    "javascript:alert(1)",
    " JavaScript:alert(1)",
    "java\tscript:alert(1)",
    "data:text/html,<script>alert(1)</script>",
    "vbscript:msgbox(1)",
    "file:///etc/passwd",
    "ftp://example.com/",
  ])("http ／ https 以外は null にする：%s", (raw) => {
    expect(toSafeHttpUrl(raw)).toBeNull();
  });

  test("URL として読めないもの、空、null は null にする", () => {
    expect(toSafeHttpUrl("/relative/path")).toBeNull();
    expect(toSafeHttpUrl("")).toBeNull();
    expect(toSafeHttpUrl(null)).toBeNull();
    expect(toSafeHttpUrl(undefined)).toBeNull();
  });
});

describe("toSameOriginUrl", () => {
  test("同じオリジンを指す URL は、受け取った文字列のまま通す", () => {
    const relayed =
      "/api/v1/images?url=https%3A%2F%2Fexample.com%2Fa.png&sig=0123456789abcdefghijkl";
    expect(toSameOriginUrl(relayed)).toBe(relayed);
    // 形は決めつけない（sendo は、あとで形を変えることがある）
    expect(toSameOriginUrl("/api/v1/articles/a1/thumbnail")).toBe("/api/v1/articles/a1/thumbnail");
    expect(toSameOriginUrl("images/a.png")).toBe("images/a.png");
  });

  test("ほかのオリジンを指す URL は null にする", () => {
    expect(toSameOriginUrl("https://evil.example/a.png")).toBeNull();
    expect(toSameOriginUrl("//evil.example/a.png")).toBeNull();
    // 基準にしたオリジンと同じ絶対 URL も、通さない（実際のオリジンではない）
    expect(toSameOriginUrl("https://a.invalid/a.png")).toBeNull();
    expect(toSameOriginUrl("https://b.invalid/a.png")).toBeNull();
  });

  test("形はパスでも、ブラウザが別のオリジンに解決する値は null にする", () => {
    expect(toSameOriginUrl("/\\evil.example/a.png")).toBeNull();
    expect(toSameOriginUrl("\\\\evil.example/a.png")).toBeNull();
    expect(toSameOriginUrl("/\t/evil.example/a.png")).toBeNull();
    expect(toSameOriginUrl("/\n/evil.example/a.png")).toBeNull();
    expect(toSameOriginUrl(" //evil.example/a.png")).toBeNull();
  });

  test("http ／ https でないもの、ないものは null にする", () => {
    expect(toSameOriginUrl("javascript:alert(1)")).toBeNull();
    expect(toSameOriginUrl("data:image/png;base64,AAAA")).toBeNull();
    expect(toSameOriginUrl("")).toBeNull();
    expect(toSameOriginUrl(null)).toBeNull();
    expect(toSameOriginUrl(undefined)).toBeNull();
  });
});
