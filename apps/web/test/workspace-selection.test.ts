import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  chooseWorkspaceSelection,
  forgetLastWorkspaceSelections,
  loadWorkspaceSelection,
  settleWorkspaceSelection,
} from "../src/lib/workspace-selection";

/** タブごとの sessionStorage と、端末で共有する localStorage の代わり */
class MemoryStorage {
  #items = new Map<string, string>();
  get length() {
    return this.#items.size;
  }
  key(index: number) {
    return [...this.#items.keys()][index] ?? null;
  }
  getItem(key: string) {
    return this.#items.get(key) ?? null;
  }
  setItem(key: string, value: string) {
    this.#items.set(key, String(value));
  }
  removeItem(key: string) {
    this.#items.delete(key);
  }
}

let local: MemoryStorage;

/** 新しいタブを開く（sessionStorage だけを空にする） */
function openTab() {
  vi.stubGlobal("sessionStorage", new MemoryStorage());
}

beforeEach(() => {
  local = new MemoryStorage();
  vi.stubGlobal("localStorage", local);
  openTab();
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("ワークスペースの選択の置き場", () => {
  it("写しがなければ、新しいタブは All で始まる", () => {
    expect(loadWorkspaceSelection("u1")).toEqual({ ids: undefined, inherited: false });
  });

  it("選んだ範囲を、新しいタブが引き継ぐ。開いたタブは自分の選択を使う", () => {
    chooseWorkspaceSelection("u1", ["b", "a"]);
    expect(loadWorkspaceSelection("u1")).toEqual({ ids: ["a", "b"], inherited: false });

    openTab();
    expect(loadWorkspaceSelection("u1")).toEqual({ ids: ["a", "b"], inherited: true });
  });

  it("照らし終えて置いた選択は、写しが変わってもそのタブで使う", () => {
    chooseWorkspaceSelection("u1", ["a"]);
    openTab();
    const tab = sessionStorage;
    expect(loadWorkspaceSelection("u1")).toEqual({ ids: ["a"], inherited: true });
    settleWorkspaceSelection("u1", ["a"]);
    // ほかのタブで選び直す
    openTab();
    chooseWorkspaceSelection("u1", ["b"]);
    vi.stubGlobal("sessionStorage", tab);
    expect(loadWorkspaceSelection("u1")).toEqual({ ids: ["a"], inherited: false });
  });

  it("照らす前に読み込み直したら、写しではなく引き継いだときの選択から続ける", () => {
    chooseWorkspaceSelection("u1", ["a"]);
    openTab();
    const tab = sessionStorage;
    expect(loadWorkspaceSelection("u1")).toEqual({ ids: ["a"], inherited: true });
    // 照らす前に、ほかのタブが写しを広げる
    openTab();
    chooseWorkspaceSelection("u1", ["a", "b"]);
    vi.stubGlobal("sessionStorage", tab);
    expect(loadWorkspaceSelection("u1")).toEqual({ ids: ["a"], inherited: true });
  });

  it("照らして All にしたタブは、読み込み直しても写しから引き継ぎ直さない", () => {
    chooseWorkspaceSelection("u1", ["gone"]);
    openTab();
    expect(loadWorkspaceSelection("u1")).toEqual({ ids: ["gone"], inherited: true });
    settleWorkspaceSelection("u1", undefined);
    expect(loadWorkspaceSelection("u1")).toEqual({ ids: undefined, inherited: false });
  });

  it("All と 0 件選択は写さず、前の写しを消す", () => {
    chooseWorkspaceSelection("u1", ["a"]);
    chooseWorkspaceSelection("u1", undefined);
    openTab();
    expect(loadWorkspaceSelection("u1")).toEqual({ ids: undefined, inherited: false });

    chooseWorkspaceSelection("u1", ["a"]);
    chooseWorkspaceSelection("u1", []);
    // 0 件選択を選んだタブは、空の表示のまま
    expect(loadWorkspaceSelection("u1")).toEqual({ ids: [], inherited: false });
    openTab();
    expect(loadWorkspaceSelection("u1")).toEqual({ ids: undefined, inherited: false });
  });

  it.each([
    ["JSON でない", "{"],
    ["配列でない", '{"a":1}'],
    ["文字列でない ID がある", '["a",1]'],
    ["空の配列", "[]"],
  ])("写しが読めない（%s）なら All で始まる", (_, value) => {
    local.setItem("sendo.workspace-selection-last.u1", value);
    expect(loadWorkspaceSelection("u1")).toEqual({ ids: undefined, inherited: false });
  });

  it("タブ自身の選択が読めなければ、今までどおり空の表示にする", () => {
    chooseWorkspaceSelection("u1", ["a"]);
    openTab();
    sessionStorage.setItem("sendo.workspace-selection.u1", "{");
    expect(loadWorkspaceSelection("u1")).toEqual({ ids: [], inherited: false });
  });

  it("タブの置き場を使えなければ、今までどおり空の表示にする", () => {
    chooseWorkspaceSelection("u1", ["a"]);
    vi.stubGlobal("sessionStorage", {
      getItem: () => {
        throw new Error("denied");
      },
    });
    expect(loadWorkspaceSelection("u1")).toEqual({ ids: [], inherited: false });
  });

  it("写しはアカウントごとに分け、ログアウトとユーザーの切り替えですべて消す", () => {
    chooseWorkspaceSelection("u1", ["a"]);
    chooseWorkspaceSelection("u2", ["b"]);
    local.setItem("sendo.prefs.snapshot", "{}");
    openTab();
    expect(loadWorkspaceSelection("u2")).toEqual({ ids: ["b"], inherited: true });

    forgetLastWorkspaceSelections();
    openTab();
    expect(loadWorkspaceSelection("u1")).toEqual({ ids: undefined, inherited: false });
    expect(loadWorkspaceSelection("u2")).toEqual({ ids: undefined, inherited: false });
    // ほかの写しには触らない
    expect(local.getItem("sendo.prefs.snapshot")).toBe("{}");
  });

  it("写しを書けなければ前の写しを消し、新しいタブは All で始まる", () => {
    chooseWorkspaceSelection("u1", ["a", "b"]);
    const setItem = vi.spyOn(local, "setItem").mockImplementation(() => {
      throw new Error("quota");
    });
    chooseWorkspaceSelection("u1", ["a"]);
    setItem.mockRestore();
    openTab();
    expect(loadWorkspaceSelection("u1")).toEqual({ ids: undefined, inherited: false });
  });

  it("タブの選択を置けなくても、照らす前の印は外す（読み込み直して印の範囲から続けない）", () => {
    chooseWorkspaceSelection("u1", ["a", "b"]);
    openTab();
    expect(loadWorkspaceSelection("u1")).toEqual({ ids: ["a", "b"], inherited: true });
    const tab = sessionStorage;
    const setItem = vi.spyOn(tab, "setItem").mockImplementation(() => {
      throw new Error("quota");
    });
    chooseWorkspaceSelection("u1", ["a"]);
    setItem.mockRestore();
    expect(loadWorkspaceSelection("u1")).toEqual({ ids: ["a"], inherited: true });
  });

  it("照らした選択をタブに置けなければ印を残し、読み込み直したら印の範囲から照らし直す", () => {
    chooseWorkspaceSelection("u1", ["a"]);
    openTab();
    expect(loadWorkspaceSelection("u1")).toEqual({ ids: ["a"], inherited: true });
    const tab = sessionStorage;
    const setItem = vi.spyOn(tab, "setItem").mockImplementation(() => {
      throw new Error("quota");
    });
    settleWorkspaceSelection("u1", ["a"]);
    setItem.mockRestore();
    // その間に、ほかのタブが写しを広げる
    openTab();
    chooseWorkspaceSelection("u1", ["a", "b"]);
    vi.stubGlobal("sessionStorage", tab);
    expect(loadWorkspaceSelection("u1")).toEqual({ ids: ["a"], inherited: true });
  });

  it("localStorage を使えなければ、引き継がずに All で始まる", () => {
    vi.stubGlobal("localStorage", {
      getItem: () => {
        throw new Error("denied");
      },
      setItem: () => {
        throw new Error("denied");
      },
      removeItem: () => {
        throw new Error("denied");
      },
    });
    chooseWorkspaceSelection("u1", ["a"]);
    expect(loadWorkspaceSelection("u1")).toEqual({ ids: ["a"], inherited: false });
    openTab();
    expect(loadWorkspaceSelection("u1")).toEqual({ ids: undefined, inherited: false });
    expect(() => forgetLastWorkspaceSelections()).not.toThrow();
  });
});
