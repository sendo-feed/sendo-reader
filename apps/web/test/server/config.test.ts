import { describe, expect, test } from "vitest";
import { parsePort, parseSendoUrl } from "../../server/config";

describe("SENDO_URL", () => {
  test("なければ compose の中の sendo", () => {
    expect(parseSendoUrl(undefined)).toBe("http://sendo:8787");
    expect(parseSendoUrl("  ")).toBe("http://sendo:8787");
  });

  test.each([
    ["http://sendo:8787", "http://sendo:8787"],
    ["http://127.0.0.1:8787/", "http://127.0.0.1:8787"],
    ["https://sendo.example.com", "https://sendo.example.com"],
  ])("%s を受ける", (value, origin) => {
    expect(parseSendoUrl(value)).toBe(origin);
  });

  test.each([
    "ftp://sendo:8787",
    "http://sendo:8787/api",
    "http://sendo:8787/?x=1",
    "http://user:pass@sendo:8787",
    "sendo:8787",
    "not a url",
  ])("%s は受けない", (value) => {
    expect(() => parseSendoUrl(value)).toThrow();
  });
});

describe("PORT", () => {
  test("なければ 8080", () => {
    expect(parsePort(undefined)).toBe(8080);
  });

  test.each(["0", "65536", "80a", "-1"])("%s は受けない", (value) => {
    expect(() => parsePort(value)).toThrow();
  });
});
