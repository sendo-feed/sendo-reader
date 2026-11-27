import { describe, expect, test, vi } from "vitest";
import {
  NotificationSuggestion,
  type SuggestionDevice,
} from "../src/lib/notification-suggestion.svelte";
import type { DeviceState, TurnOnResult } from "../src/lib/push";

// account.ts のアカウントの窓口は、読み込むときに同じオリジンの API の場所を決める
vi.hoisted(() => {
  Object.assign(globalThis, { location: { href: "https://reader.test/" } });
});

const OFF: DeviceState = { kind: "off", publicKey: "key" };

/** 返すのを止めておける Promise */
function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

/** この端末の操作のにせもの。確かめと Turn on は、テストが答えるまで返さない */
function device() {
  const checks: ReturnType<typeof deferred<DeviceState>>[] = [];
  const turnOns: ReturnType<typeof deferred<TurnOnResult>>[] = [];
  const fake: SuggestionDevice = {
    check: () => {
      const check = deferred<DeviceState>();
      checks.push(check);
      return check.promise;
    },
    turnOn: () => {
      const turnOn = deferred<TurnOnResult>();
      turnOns.push(turnOn);
      return turnOn.promise;
    },
  };
  return { fake, checks, turnOns };
}

describe("ベルを付けたときの勧め", () => {
  test("確かめ終えたときに、付けたベルがまだ付いていれば勧め、外れていれば勧めない", async () => {
    const { fake, checks } = device();
    const suggestion = new NotificationSuggestion(fake);
    let belled = true;
    const offering = suggestion.offer(() => belled);
    // 確かめている間に、もう一度押して外した
    belled = false;
    checks[0]?.resolve(OFF);
    await offering;
    expect(suggestion.current).toBeNull();

    belled = true;
    const again = suggestion.offer(() => belled);
    checks[1]?.resolve(OFF);
    await again;
    expect(suggestion.current).toEqual({ kind: "turn-on", publicKey: "key" });
  });
});

describe("ログアウトとユーザーの切り替えで手元を消したとき", () => {
  test("出している勧めと、閉じた印を残さない", async () => {
    const { fake, checks } = device();
    const suggestion = new NotificationSuggestion(fake);
    const shown = suggestion.offer(() => true);
    checks[0]?.resolve(OFF);
    await shown;
    expect(suggestion.current).not.toBeNull();
    suggestion.reset();
    expect(suggestion.current).toBeNull();

    // 前の人が閉じていても、次の人には勧める
    suggestion.dismiss();
    await suggestion.offer(() => true);
    expect(checks).toHaveLength(1);
    suggestion.reset();
    const next = suggestion.offer(() => true);
    checks[1]?.resolve(OFF);
    await next;
    expect(suggestion.current).toEqual({ kind: "turn-on", publicKey: "key" });
  });

  test("前の人のために確かめていた勧めは、確かめ終えても出さない", async () => {
    const { fake, checks } = device();
    const suggestion = new NotificationSuggestion(fake);
    const offering = suggestion.offer(() => true);
    suggestion.reset();
    checks[0]?.resolve(OFF);
    await offering;
    expect(suggestion.current).toBeNull();
  });

  test("前の人が押していた Turn on の結果は、次の人に出さず、次の人はすぐ押せる", async () => {
    const { fake, checks, turnOns } = device();
    const suggestion = new NotificationSuggestion(fake);
    const shown = suggestion.offer(() => true);
    checks[0]?.resolve(OFF);
    await shown;
    suggestion.turnOn("key");
    expect(suggestion.busy).toBe(true);
    suggestion.reset();
    expect(suggestion.busy).toBe(false);

    // 次の人に勧めて押す。前の人の結果があとから返っても、次の人の表示を変えない
    const next = suggestion.offer(() => true);
    checks[1]?.resolve(OFF);
    await next;
    suggestion.turnOn("key");
    turnOns[0]?.resolve({ kind: "subscribe-failed" });
    await turnOns[0]?.promise;
    await Promise.resolve();
    expect(suggestion.failure).toBeNull();
    expect(suggestion.busy).toBe(true);
    expect(suggestion.current).not.toBeNull();

    turnOns[1]?.resolve({ kind: "on" });
    await vi.waitFor(() => expect(suggestion.busy).toBe(false));
    expect(suggestion.current).toBeNull();
  });
});
