import { describe, expect, test } from "vitest";
import { contentSecurityPolicy, renderHeadersFile } from "../security-headers";

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
