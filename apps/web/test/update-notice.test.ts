import { describe, expect, test } from "vitest";
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
