import { describe, expect, test } from "vitest";
import { releaseOnBackForwardCache } from "../src/lib/back-forward-cache";

/** にせものの window。pagehide ／ pageshow を起こせる */
function setup() {
  const listeners = new Map<string, (event: { persisted: boolean }) => void>();
  const state = { releases: 0, reloads: 0 };
  releaseOnBackForwardCache({
    window: {
      addEventListener: (type, listener) => {
        listeners.set(type, listener);
      },
    },
    release: () => {
      state.releases += 1;
    },
    reload: () => {
      state.reloads += 1;
    },
  });
  const fire = (type: "pagehide" | "pageshow", persisted: boolean) =>
    listeners.get(type)?.({ persisted });
  return { state, fire };
}

describe("releaseOnBackForwardCache", () => {
  test("bfcache に入るときにワーカーを止め、戻ったら読み込み直す", () => {
    const { state, fire } = setup();
    fire("pagehide", true);
    expect(state).toEqual({ releases: 1, reloads: 0 });
    fire("pageshow", true);
    expect(state).toEqual({ releases: 1, reloads: 1 });
  });

  test("bfcache に入らないとき（ページを捨てる・ふつうに開く）は、何もしない", () => {
    const { state, fire } = setup();
    fire("pageshow", false);
    fire("pagehide", false);
    expect(state).toEqual({ releases: 0, reloads: 0 });
  });

  test("ワーカーを止めていなければ、persisted の pageshow でも読み込み直さない", () => {
    const { state, fire } = setup();
    fire("pageshow", true);
    expect(state).toEqual({ releases: 0, reloads: 0 });
  });

  test("止めたワーカーは、もう一度止めない", () => {
    const { state, fire } = setup();
    fire("pagehide", true);
    fire("pagehide", true);
    expect(state.releases).toBe(1);
  });
});
