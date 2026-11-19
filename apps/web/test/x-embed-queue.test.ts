import { expect, test } from "vitest";
import { createXEmbedQueue } from "../src/lib/x-embed-queue";

test("復元待ちより、表示された X の投稿を先に読み込む", () => {
  const enqueue = createXEmbedQueue();
  const started: string[] = [];
  const finish = new Map<string, () => void>();
  function add(id: string, visible = false) {
    return enqueue((done) => {
      started.push(id);
      finish.set(id, done);
    }, visible);
  }

  for (let i = 1; i <= 4; i += 1) add(`restore-${i}`);
  expect(started).toEqual(["restore-1", "restore-2", "restore-3"]);
  const newlyVisible = add("newly-visible");
  add("visible", true);
  newlyVisible.prioritize();
  expect(started.at(-1)).toBe("visible");

  finish.get("restore-1")?.();
  expect(started.at(-1)).toBe("newly-visible");
  finish.get("restore-2")?.();
  expect(started.at(-1)).toBe("newly-visible");

  finish.get("visible")?.();
  expect(started.at(-1)).toBe("restore-4");
});

test("画面外に出た投稿は、復元に必要な場合だけ待ち行列に残す", () => {
  const enqueue = createXEmbedQueue();
  const started: string[] = [];
  const finish = new Map<string, () => void>();
  const add = (id: string) =>
    enqueue((done) => {
      started.push(id);
      finish.set(id, done);
    }, false);
  const active = add("active");
  add("second");
  add("third");
  enqueue((done) => finish.set("visible", done), true);
  const offscreen = enqueue(() => started.push("offscreen"), true);
  const promoted = add("restore");
  promoted.prioritize();
  promoted.deprioritize();

  expect(offscreen.cancelPending()).toBe(true);
  expect(active.cancelPending()).toBe(false);
  finish.get("active")?.();
  expect(started).toEqual(["active", "second", "third"]);
  finish.get("visible")?.();
  expect(started).toEqual(["active", "second", "third", "restore"]);
});
