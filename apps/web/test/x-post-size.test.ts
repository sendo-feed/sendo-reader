import { describe, expect, it } from "vitest";
import { MAX_X_POST_SIZES, parseXPostSizes } from "../src/lib/x-post-size";

/** 履歴の項目から読み戻した X の投稿の大きさ（docs/decisions/embeds.md の 5） */
describe("parseXPostSizes", () => {
  it("形の合うものだけを残す", () => {
    expect(
      parseXPostSizes([
        { id: "1234567890123456789", width: 550, height: 240 },
        { id: "1", width: 1, height: 4000 },
        // ID の形が違う
        { id: "", width: 550, height: 240 },
        { id: "123456789012345678901", width: 550, height: 240 },
        { id: "12a", width: 550, height: 240 },
        { id: 123, width: 550, height: 240 },
        // 幅と高さが範囲の外、整数でない、数でない
        { id: "2", width: 0, height: 240 },
        { id: "3", width: 550, height: 4001 },
        { id: "4", width: 550.5, height: 240 },
        { id: "5", width: "550", height: 240 },
        { id: "6", width: 550 },
        null,
        "7",
      ]),
    ).toEqual([
      { id: "1234567890123456789", width: 550, height: 240 },
      { id: "1", width: 1, height: 4000 },
    ]);
  });

  it("余計な項目は落とす", () => {
    expect(parseXPostSizes([{ id: "1", width: 300, height: 200, html: "<p>x</p>" }])).toEqual([
      { id: "1", width: 300, height: 200 },
    ]);
  });

  it("配列でなければ、空にする（古い形の履歴の項目には、ない）", () => {
    for (const value of [undefined, null, {}, "x", 1]) expect(parseXPostSizes(value)).toEqual([]);
  });

  it("上限を超えた分は捨てる", () => {
    const many = Array.from({ length: MAX_X_POST_SIZES + 5 }, (_, i) => ({
      id: String(i + 1),
      width: 550,
      height: 200,
    }));
    const parsed = parseXPostSizes(many);
    expect(parsed).toHaveLength(MAX_X_POST_SIZES);
    expect(parsed.at(-1)?.id).toBe(String(MAX_X_POST_SIZES));
  });
});
