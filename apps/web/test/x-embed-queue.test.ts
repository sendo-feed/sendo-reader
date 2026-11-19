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
