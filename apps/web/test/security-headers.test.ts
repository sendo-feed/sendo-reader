import { describe, expect, test } from "vitest";
import { contentSecurityPolicy } from "../security-headers";

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

  test("X の投稿の隔離フレームのオリジンがあるときだけ、frame-src を 1 つ足し、ほかは変えない", () => {
    for (const mode of ["production", "development"] as const) {
      const base = contentSecurityPolicy(mode);
      expect(base).not.toContain("frame-src");
      expect(contentSecurityPolicy(mode, { xEmbedOrigin: null })).toBe(base);
      expect(contentSecurityPolicy(mode, { xEmbedOrigin: "https://embed.example" })).toBe(
        `${base}; frame-src https://embed.example`,
      );
    }
  });
});
