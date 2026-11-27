import { afterEach, describe, expect, test, vi } from "vitest";
import { pathProblems } from "../../../../scripts/check-sendo-paths";
import * as paths from "../../sendo-paths";

afterEach(() => vi.restoreAllMocks());

describe("sendo の実際のルートと中継先の検査", () => {
  test("パラメーター・ミドルウェア・ALL を含め、既存の中継先は通る", () => {
    expect(
      pathProblems([
        { method: "GET", path: "/healthz" },
        { method: "ALL", path: "/api/v1/*" },
        { method: "GET", path: "/api/v1/articles/:id" },
        { method: "ALL", path: "/mcp" },
        { method: "ALL", path: "/.well-known/oauth-authorization-server" },
        { method: "POST", path: "/oauth/token" },
      ]),
    ).toEqual([]);
  });

  test("新しい外向けのパスを足すと、HTML が返る場所を報告する", () => {
    const problems = pathProblems([
      { method: "POST", path: "/fever/" },
      { method: "GET", path: "/.well-known/new-protocol" },
    ]);
    expect(problems).toHaveLength(4);
    expect(problems.join("\n")).toContain("POST /fever/: コンテナが sendo に中継しません。");
    expect(problems.join("\n")).toContain("GET /.well-known/new-protocol: Service Worker");
  });

  test("ルートの取り出しに失敗しても、空の成功にしない", () => {
    expect(pathProblems([])).toEqual([
      "sendo のルートが 0 件です。ルートの取り出し方を確認してください。",
    ]);
  });

  test("コンテナだけに足して Service Worker に足し忘れても落とす", () => {
    vi.spyOn(paths.SENDO_NAVIGATION_DENYLIST, "some").mockReturnValue(false);
    expect(pathProblems([{ method: "POST", path: "/mcp" }])).toEqual([
      "POST /mcp: Service Worker が画面の HTML を返します。",
    ]);
  });

  test("広すぎる中継指定で画面が開けなくなる場合も落とす", () => {
    vi.spyOn(paths, "isSendoPath").mockReturnValue(true);
    expect(pathProblems([{ method: "POST", path: "/mcp" }])).toContain(
      "/oauth/authorize: reader の画面が sendo の中継先と重なっています。",
    );
  });
});
