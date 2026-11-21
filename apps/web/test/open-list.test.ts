import { describe, expect, test } from "vitest";
import { openListScope } from "../src/lib/open-list";

/** 先読みの順のために core に知らせる、開いている一覧の範囲 */
describe("openListScope", () => {
  test("一覧ごとの範囲にし、未読だけの絞り込みは入れない", () => {
    expect(openListScope({ kind: "all" }, "")).toEqual({});
    expect(openListScope({ kind: "feed", id: "f1" }, "")).toEqual({ feedId: "f1" });
    expect(openListScope({ kind: "folder", id: "d1" }, "")).toEqual({ folderId: "d1" });
    expect(openListScope({ kind: "starred" }, "")).toEqual({ starred: true });
    expect(openListScope({ kind: "search" }, "rust wasm")).toEqual({ search: "rust wasm" });
  });

  test("Recently Read と、一覧を出さない画面は null", () => {
    for (const kind of ["recentlyRead", "manage", "add", "settings"] as const) {
      expect(openListScope({ kind }, "rust")).toBeNull();
    }
  });
});
