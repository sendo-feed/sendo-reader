import { describe, expect, test } from "vitest";
import { reloadGuard } from "../src/lib/reload-guard.svelte";
import { selectNotice, updateNotice } from "../src/lib/update-notice.svelte";

const base = { leaveStalled: false, versionMismatch: false, update: null, canReload: true };

describe("画面に出す知らせ", () => {
  test("新しい版の知らせは、閉じていない新しい版があり、読み込み直してよい画面でだけ出す", () => {
    expect(selectNotice(base)).toBeNull();
    expect(selectNotice({ ...base, update: "ready" })).toBe("ready");
    expect(selectNotice({ ...base, update: "failed" })).toBe("failed");
    expect(selectNotice({ ...base, update: "ready", canReload: false })).toBeNull();
  });

  test("このタブがいま使えないことを言う知らせを、新しい版の知らせより先に出す", () => {
    expect(selectNotice({ ...base, update: "ready", versionMismatch: true })).toBe(
      "versionMismatch",
    );
    expect(
      selectNotice({ ...base, update: "ready", versionMismatch: true, leaveStalled: true }),
    ).toBe("leaveStalled");
  });

  test("閉じたら出さず、さらに新しい版に替わったら、また出す", () => {
    expect(updateNotice.visible).toBeNull();
    updateNotice.show("ready");
    expect(updateNotice.visible).toBe("ready");
    updateNotice.dismiss();
    expect(updateNotice.visible).toBeNull();
    // 閉じたあとに何度閉じても、次の版までは出さない
    updateNotice.dismiss();
    expect(updateNotice.visible).toBeNull();
    updateNotice.show("ready");
    expect(updateNotice.visible).toBe("ready");
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
