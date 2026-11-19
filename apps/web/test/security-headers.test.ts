import { describe, expect, test } from "vitest";
import {
  contentSecurityPolicy,
  embedOriginFromHeaders,
  renderHeadersFile,
  xEmbedOrigin,
} from "../security-headers";

describe("CSP", () => {
  test("本番では、ほかのオリジンへの通信とインラインのスクリプトを許さない", () => {
    const csp = contentSecurityPolicy("production");
    expect(csp).toContain("default-src 'none'");
    expect(csp).toContain("connect-src 'self'");
    expect(csp).toContain("script-src 'self' 'wasm-unsafe-eval'");
    expect(csp).not.toContain("unsafe-inline");
    expect(csp).not.toContain("'unsafe-eval'");
    expect(csp).toContain("require-trusted-types-for 'script'");
  });

  test("手元では、Vite のために style の 'unsafe-inline' だけを足す", () => {
    const csp = contentSecurityPolicy("development");
    expect(csp).toContain("style-src 'self' 'unsafe-inline'");
    expect(csp).toContain("script-src 'self' 'wasm-unsafe-eval'");
    expect(csp).not.toContain("trusted-types");
  });

  test("_headers は、すべてのパスに本番のヘッダーを付ける", () => {
    const file = renderHeadersFile();
    expect(file.startsWith("/*\n")).toBe(true);
    expect(file).toContain(`  Content-Security-Policy: ${contentSecurityPolicy("production")}\n`);
    expect(file).toContain("  X-Content-Type-Options: nosniff\n");
  });
});

test("X の埋め込みのオリジンだけをフレームの CSP に追加する", () => {
  const embed = xEmbedOrigin("https://embed.example/");
  const csp = contentSecurityPolicy("production", embed);
  expect(csp).toContain("frame-src https://embed.example");
  expect(csp).toContain("script-src 'self' 'wasm-unsafe-eval'");
  expect(renderHeadersFile(embed)).toContain("frame-src https://embed.example");
  expect(embedOriginFromHeaders(renderHeadersFile(embed))).toBe(embed);
  expect(embedOriginFromHeaders(renderHeadersFile())).toBe("");
  expect(contentSecurityPolicy("production")).not.toContain("frame-src");
  expect(() => xEmbedOrigin("https://embed.example/path")).toThrow();
  expect(() => xEmbedOrigin("https://*.example")).toThrow();
});
