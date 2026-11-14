import { describe, expect, test } from "vitest";
import { toSafeHttpUrl } from "../src";

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
