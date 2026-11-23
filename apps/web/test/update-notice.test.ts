import { describe, expect, test } from "vitest";
import { reloadGuard } from "../src/lib/reload-guard.svelte";
import { topNotice, updateNotice } from "../src/lib/update-notice.svelte";

const base = { leaveStalled: false, versionMismatch: false, updatePending: false, canReload: true };

describe("画面の上の知らせ", () => {
  test("新しい版の知らせは、閉じていない新しい版があり、読み込み直してよい画面でだけ出す", () => {
    expect(topNotice(base)).toBeNull();
    expect(topNotice({ ...base, updatePending: true })).toBe("updateReady");
    expect(topNotice({ ...base, updatePending: true, canReload: false })).toBeNull();
  });

  test("このタブがいま使えないことを言う知らせを、新しい版の知らせより先に出す", () => {
    expect(topNotice({ ...base, updatePending: true, versionMismatch: true })).toBe(
      "versionMismatch",
    );
    expect(
      topNotice({ ...base, updatePending: true, versionMismatch: true, leaveStalled: true }),
    ).toBe("leaveStalled");
  });

  test("閉じたら出さず、さらに新しい版に替わったら、また出す", () => {
    expect(updateNotice.pending).toBe(false);
    updateNotice.ready();
    expect(updateNotice.pending).toBe(true);
    updateNotice.dismiss();
    expect(updateNotice.pending).toBe(false);
    // 閉じたあとに何度閉じても、次の版までは出さない
    updateNotice.dismiss();
    expect(updateNotice.pending).toBe(false);
    updateNotice.ready();
    expect(updateNotice.pending).toBe(true);
  });
});

describe("読み込み直すと消えるものを出している間の印", () => {
  test("付けている間だけ held。重ねて付けたら、全部戻すまで held。同じ印を 2 回戻しても 1 回だけ", () => {
    expect(reloadGuard.held).toBe(false);
    const first = reloadGuard.hold();
    const second = reloadGuard.hold();
    expect(reloadGuard.held).toBe(true);
    first();
    first();
    expect(reloadGuard.held).toBe(true);
    second();
    expect(reloadGuard.held).toBe(false);
  });
});
