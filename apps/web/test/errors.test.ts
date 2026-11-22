import { PROTOCOL_VERSION, ProtocolMismatchError } from "@sendo-reader/core/web";
import { describe, expect, test, vi } from "vitest";
import { describeError, isOlderThanPeer } from "../src/lib/errors";

// errors.ts が読み込むアカウントの窓口は、読み込むときに同じオリジンの API の場所を決める
vi.hoisted(() => {
  Object.assign(globalThis, { location: { href: "https://reader.test/" } });
});

/** 版の違うタブが開いているときの失敗の文（docs/decisions/local-first.md の 5） */
describe("版が合わない失敗", () => {
  const reloadThisTab = "このタブを読み込み直してください";
  const reloadOtherTab = "そのタブを読み込み直すか閉じると";

  test("相手の番号のほうが新しければ、このタブを読み込み直すよう知らせる", () => {
    const error = new ProtocolMismatchError(PROTOCOL_VERSION + 1);
    expect(isOlderThanPeer(error)).toBe(true);
    expect(describeError(error)).toContain(reloadThisTab);
  });

  test("相手の番号のほうが古ければ、ほかのタブを読み込み直すか閉じるよう知らせる", () => {
    const error = new ProtocolMismatchError(PROTOCOL_VERSION - 1);
    expect(isOlderThanPeer(error)).toBe(false);
    expect(describeError(error)).toContain(reloadOtherTab);
  });

  test("相手が番号を名乗らない（この決まりより前の版）なら、相手が古いとみなす", () => {
    const error = new ProtocolMismatchError(null);
    expect(isOlderThanPeer(error)).toBe(false);
    expect(describeError(error)).toContain(reloadOtherTab);
  });

  test("ワーカーから届いた形でも見分ける", async () => {
    const { deserializeError, serializeError } = await import(
      "../../../packages/core/src/web/protocol"
    );
    const error = deserializeError(serializeError(new ProtocolMismatchError(PROTOCOL_VERSION + 1)));
    expect(describeError(error)).toContain(reloadThisTab);
  });
});
