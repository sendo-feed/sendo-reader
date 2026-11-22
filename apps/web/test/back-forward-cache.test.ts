import { describe, expect, test } from "vitest";
import { watchBackForwardCache } from "../src/lib/back-forward-cache";

const LOCK = "sendo-reader:leader";

/**
 * にせものの window と Web Locks。holder は代表のロックを持っているクライアント（null なら空き）。
 * release（ワーカーを止める）で、afterRelease に替わる（ほかのタブに渡る・空く）。
 * releaseDelay は、止めてからロックが離れるまでの時間（ミリ秒）
 */
function setup(
  options: {
    holder?: string | null;
    afterRelease?: string | null;
    releaseDelay?: number;
    queryFails?: boolean;
  } = {},
) {
  const listeners = new Map<string, (event: { persisted: boolean }) => void>();
  const log: string[] = [];
  let clock = 0;
  let holder = options.holder === undefined ? "self" : options.holder;
  let releasedAt: number | null = null;
  const page = watchBackForwardCache({
    window: {
      addEventListener: (type, listener) => {
        listeners.set(type, listener);
      },
    },
    locks: {
      query: async () => {
        if (options.queryFails) throw new Error("locks が使えない");
        if (releasedAt !== null && clock >= releasedAt + (options.releaseDelay ?? 0)) {
          holder = options.afterRelease === undefined ? null : options.afterRelease;
        }
        return { held: holder === null ? [] : [{ name: LOCK, clientId: holder }] };
      },
    },
    leaderLock: LOCK,
    release: () => {
      log.push("release");
      releasedAt = clock;
    },
    reload: () => log.push("reload"),
    assign: (url) => log.push(`assign ${url} at ${clock}`),
    sleep: async (ms) => {
      clock += ms;
    },
    now: () => clock,
  });
  const fire = (type: "pagehide" | "pageshow", persisted: boolean) =>
    listeners.get(type)?.({ persisted });
  return { page, log, fire };
}

describe("leave（reader の外へ移る）", () => {
  test("ワーカーを止め、代表のロックが離れてから移る", async () => {
    const { page, log } = setup({ releaseDelay: 100 });
    await page.leave("/login");
    expect(log).toEqual(["release", "assign /login at 100"]);
  });

  test("止めた途端にロックが離れていれば、待たずに移る", async () => {
    const { page, log } = setup();
    await page.leave("/login");
    expect(log).toEqual(["release", "assign /login at 0"]);
  });

  test("待っていたほかのタブにロックが渡ったら、離れたとみなして移る", async () => {
    const { page, log } = setup({ afterRelease: "other", releaseDelay: 40 });
    await page.leave("/login");
    expect(log).toEqual(["release", "assign /login at 40"]);
  });

  test("誰もロックを持っていなければ（代表がまだ決まっていない）、待たずに移る", async () => {
    const { page, log } = setup({ holder: null });
    await page.leave("/login");
    expect(log).toEqual(["release", "assign /login at 0"]);
  });

  test("ほかのタブが代表でロックが離れないときは、上限（1 秒）まで待って移る", async () => {
    const { page, log } = setup({ holder: "other", afterRelease: "other" });
    await page.leave("/login");
    expect(log).toEqual(["release", "assign /login at 1000"]);
  });

  test("ロックを調べるのに失敗しても、ワーカーを止めて移る", async () => {
    const { page, log } = setup({ queryFails: true });
    await expect(page.leave("/login")).rejects.toThrow();
    expect(log).toEqual(["release", "assign /login at 0"]);
  });

  test("移ったあと bfcache から戻ったら、読み込み直す", async () => {
    const { page, log, fire } = setup();
    await page.leave("/login");
    fire("pagehide", true);
    fire("pageshow", true);
    expect(log).toEqual(["release", "assign /login at 0", "reload"]);
  });
});

describe("bfcache（reader が始めない移動）", () => {
  test("bfcache に入るときにワーカーを止め、戻ったら読み込み直す", () => {
    const { log, fire } = setup();
    fire("pagehide", true);
    expect(log).toEqual(["release"]);
    fire("pageshow", true);
    expect(log).toEqual(["release", "reload"]);
  });

  test("bfcache に入らないとき（ページを捨てる・ふつうに開く）は、何もしない", () => {
    const { log, fire } = setup();
    fire("pageshow", false);
    fire("pagehide", false);
    expect(log).toEqual([]);
  });

  test("ワーカーを止めていなければ、persisted の pageshow でも読み込み直さない", () => {
    const { log, fire } = setup();
    fire("pageshow", true);
    expect(log).toEqual([]);
  });

  test("止めたワーカーは、もう一度止めない", () => {
    const { log, fire } = setup();
    fire("pagehide", true);
    fire("pagehide", true);
    expect(log).toEqual(["release"]);
  });
});
