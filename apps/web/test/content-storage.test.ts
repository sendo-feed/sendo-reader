// 状態（content-storage.svelte.ts）は $state などのルーンを使う。ルーンの型は svelte が持つ
/// <reference types="svelte" />
import type { ContentStorage } from "@sendo-reader/core";
import { afterEach, describe, expect, test, vi } from "vitest";
import { ContentStorageState, formatBytes } from "../src/lib/content-storage.svelte";

/** Settings の Offline の欄の状態。画面の部品を通さず、偽の窓口で確かめる */

const MB = 1024 * 1024;

/** 手元の本文の量と上限を持つ偽の窓口。fail に入れた呼び出しは失敗させる */
function fakeClient(initial: ContentStorage) {
  let current = { ...initial };
  const fail = new Set<"get" | "set">();
  let release: (() => void) | null = null;
  const client = {
    async getContentStorage() {
      if (fail.has("get")) throw new Error("get failed");
      return { ...current };
    },
    async setContentStorageLimit(limit: number) {
      if (release === null) {
        // 止めていなければ、すぐ返す
      } else {
        await new Promise<void>((resolve) => {
          release = resolve;
        });
      }
      if (fail.has("set")) throw new Error("set failed");
      current = { ...current, limit };
      return { ...current };
    },
  };
  return {
    client,
    fail,
    setUsed(used: number) {
      current = { ...current, used };
    },
    /** 次の上限の変更を、release() を呼ぶまで止める */
    hold() {
      release = () => {};
      return () => release?.();
    },
  };
}

afterEach(() => {
  vi.useRealTimers();
});

describe("formatBytes", () => {
  test("選択肢と同じ単位と書き方にする", () => {
    expect(formatBytes(0)).toBe("0KB");
    expect(formatBytes(512 * 1024)).toBe("512KB");
    expect(formatBytes(1)).toBe("1KB");
    expect(formatBytes(MB - 1)).toBe("1MB");
    expect(formatBytes(1.25 * MB)).toBe("1.3MB");
    expect(formatBytes(50 * MB)).toBe("50MB");
    expect(formatBytes(200 * MB)).toBe("200MB");
    expect(formatBytes(1023.96 * MB)).toBe("1GB");
    expect(formatBytes(1024 * MB)).toBe("1GB");
    expect(formatBytes(1.5 * 1024 * MB)).toBe("1.5GB");
  });
});

describe("ContentStorageState", () => {
  test("読めなかったら load の失敗を出し、やり直せる", async () => {
    const fake = fakeClient({ limit: 200 * MB, used: 3 * MB });
    const state = new ContentStorageState(fake.client);
    fake.fail.add("get");
    await state.load();
    expect(state.failed).toBe("load");
    expect(state.storage).toBeNull();

    fake.fail.delete("get");
    await state.load();
    expect(state.failed).toBeNull();
    expect(state.storage).toEqual({ limit: 200 * MB, used: 3 * MB });
    expect(state.selected).toBe(String(200 * MB));
  });

  test("上限を変えられなかったら、選択欄を前の値に戻し、save の失敗を出す", async () => {
    const fake = fakeClient({ limit: 200 * MB, used: 0 });
    const state = new ContentStorageState(fake.client);
    await state.load();
    fake.fail.add("set");
    await state.select("0");
    expect(state.selected).toBe(String(200 * MB));
    expect(state.failed).toBe("save");

    // 変えられたら、失敗の表示を消す
    fake.fail.delete("set");
    await state.select("0");
    expect(state.selected).toBe("0");
    expect(state.storage?.limit).toBe(0);
    expect(state.failed).toBeNull();
  });

  test("開いている間は一定の間隔で読み直し、裏で増えた量を出す", async () => {
    vi.useFakeTimers();
    const fake = fakeClient({ limit: 200 * MB, used: 0 });
    const state = new ContentStorageState(fake.client);
    await state.load();
    state.start(5000);
    fake.setUsed(12 * MB);
    await vi.advanceTimersByTimeAsync(5000);
    expect(state.storage?.used).toBe(12 * MB);

    // 閉じたら読み直さない
    state.stop();
    fake.setUsed(20 * MB);
    await vi.advanceTimersByTimeAsync(10000);
    expect(state.storage?.used).toBe(12 * MB);
  });

  test("上限を変えている途中の読み直しは、選択欄を上書きしない", async () => {
    const fake = fakeClient({ limit: 200 * MB, used: 0 });
    const state = new ContentStorageState(fake.client);
    await state.load();
    const release = fake.hold();
    const saving = state.select(String(500 * MB));
    await state.refresh();
    expect(state.selected).toBe(String(500 * MB));
    release();
    await saving;
    expect(state.selected).toBe(String(500 * MB));
    expect(state.storage?.limit).toBe(500 * MB);
  });
});
