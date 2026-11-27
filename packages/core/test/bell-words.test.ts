import { describe, expect, test } from "vitest";
import { MAX_BELL_WORDS, MAX_BELL_WORDS_LENGTH, parseBellWords } from "../src";
import { bellMatchKey } from "../src/bell-words";

/*
 * ベルの言葉の受け方（sendo の docs/decisions/notifications.md の 6、7）。値は sendo の
 * test/notify/words.test.ts の「言葉を受ける」と同じにする（sendo に送る前に、同じ決まりで断るため）。
 */

describe("言葉を受ける", () => {
  test("NFKC にしてから空白の並び（全角の空白、タブ、改行を含む）で区切り、半角の空白 1 つでつなぐ", () => {
    expect(parseBellWords("  Azure　障害\t\n Ｇｏ  ")).toEqual({
      words: "Azure 障害 Go",
      matchKey: "azure go 障害",
    });
  });

  test("小文字にして同じになる言葉は最初のものだけを残し、大文字と小文字は入れたまま残す", () => {
    expect(parseBellWords("AWS aws Aws ＡＷＳ Lambda")).toEqual({
      words: "AWS Lambda",
      matchKey: "aws lambda",
    });
  });

  test("照合用の言葉は、並びや大文字と小文字によらず同じになる", () => {
    const keys = ["Azure 障害", "障害 azure", "AZURE　障害 Azure"].map(
      (words) => (parseBellWords(words) as { matchKey: string }).matchKey,
    );
    expect(new Set(keys)).toEqual(new Set(["azure 障害"]));
  });

  test("照合用の言葉は、UTF-16 の単位ではなくコードポイントの順に並べる", () => {
    // UTF-16 の単位では U+1F600 の上位サロゲート（U+D83D）が U+E000 より先、コードポイントでは
    // U+E000 が先
    expect(parseBellWords("\u{1F600} ")).toMatchObject({ matchKey: " \u{1F600}" });
  });

  test("引用符も言葉の文字として扱う", () => {
    expect(parseBellWords('"Azure 障害"')).toEqual({
      words: '"Azure 障害"',
      matchKey: '"azure 障害"',
    });
  });

  test(`言葉は ${MAX_BELL_WORDS} 個まで。重なりを除く前に ${MAX_BELL_WORDS + 1} 個でも、除いたあと ${MAX_BELL_WORDS} 個なら受ける`, () => {
    const eight = Array.from({ length: MAX_BELL_WORDS }, (_, i) => `w${i}`);
    expect(parseBellWords(eight.join(" "))).toMatchObject({ words: eight.join(" ") });
    expect(parseBellWords([...eight, "W0"].join(" "))).toMatchObject({ words: eight.join(" ") });
    expect(parseBellWords([...eight, "w8"].join(" "))).toBe("too_many_words");
  });

  test(`全体で ${MAX_BELL_WORDS_LENGTH} 文字（区切りの空白を含むコードポイントの数）まで。重なりを除いた形で数える`, () => {
    // 区切りの空白 1 つを含めて 64 文字。絵文字はサロゲートの組でも 1 文字
    const exact = `${"あ".repeat(31)} ${"\u{1F600}".repeat(32)}`;
    expect(Array.from(exact)).toHaveLength(MAX_BELL_WORDS_LENGTH);
    expect(parseBellWords(exact)).toMatchObject({ words: exact });
    expect(parseBellWords(`${exact}い`)).toBe("too_long");
    // 重なりを除く前は 64 文字を超えるが、除いたあとは 64 文字
    expect(parseBellWords(`${exact} ${"あ".repeat(31)}`)).toMatchObject({ words: exact });
    // 余分な空白は数えない
    expect(parseBellWords(`　${exact.replace(" ", "\t\t\t")}  `)).toMatchObject({
      words: exact,
    });
  });

  test("受ける文字列の長さでは断らない。区切ったあとの言葉が上限に収まれば受ける", () => {
    expect(parseBellWords(`Rust${" ".repeat(1021)}`)).toMatchObject({ words: "Rust" });
  });

  test("NFKC で長くなる文字は、長くなったあとの形で数える", () => {
    // 「㍿」は NFKC で「株式会社」（4 文字）になる
    expect(parseBellWords(`${"あ".repeat(60)}㍿`)).toMatchObject({
      words: `${"あ".repeat(60)}株式会社`,
    });
    expect(parseBellWords(`${"あ".repeat(61)}㍿`)).toBe("too_long");
  });

  test("空と、空白だけは受けない", () => {
    for (const words of ["", " ", "　\t\n"]) expect(parseBellWords(words)).toBe("empty");
  });

  test("制御文字と、対になっていないサロゲートを含む言葉は受けない", () => {
    for (const words of ["Azure\u0000", "a\u001fb", "\u007f", "\u0085障害", "\ud800", "a\udc00"]) {
      expect(parseBellWords(words), JSON.stringify(words)).toBe("invalid_character");
    }
  });
});

describe("sendo から届いた言葉の照合用の言葉", () => {
  test("受けた言葉と同じ照合用の言葉になる", () => {
    for (const input of ["Azure 障害", "AWS aws Lambda", "\u{1F600} ", '"Azure 障害"']) {
      const parsed = parseBellWords(input) as { words: string; matchKey: string };
      expect(bellMatchKey(parsed.words)).toBe(parsed.matchKey);
    }
  });

  test("上限を超えた言葉でも、照合用の言葉を作る（sendo が上限を広げても同期を止めない）", () => {
    const nine = Array.from({ length: MAX_BELL_WORDS + 1 }, (_, i) => `W${i}`).join(" ");
    expect(parseBellWords(nine)).toBe("too_many_words");
    expect(bellMatchKey(nine)).toBe(nine.toLowerCase());
  });
});
