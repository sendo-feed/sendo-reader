/**
 * ベルの言葉（sendo の docs/decisions/notifications.md の 6、7）。受けた文字列を NFKC にしてから
 * 空白で区切り、重なりを除いた形を保存する。決まりは sendo の src/notify/words.ts の parseBellWords
 * と同じにする（同じ値のテストで確かめる。test/bell-words.test.ts）。sendo に送る前に、ここで
 * 上限を確かめて画面で知らせる。
 */

/** 1 つのベルの言葉の数の上限 */
export const MAX_BELL_WORDS = 8;

/** 言葉の全体の長さの上限（保存する形の、区切りの空白を含むコードポイントの数） */
export const MAX_BELL_WORDS_LENGTH = 64;

/** 保存する言葉の形 */
export type BellWords = {
  /** 区切った言葉を半角の空白 1 つでつないだもの。大文字と小文字は入れたまま */
  words: string;
  /**
   * 照合用。言葉を小文字にし、コードポイントの順に並べてつないだもの。購読と照合用の言葉が同じ
   * ベルは、sendo では同じベル（同じ組）になる
   */
  matchKey: string;
};

/** 言葉を受けられない理由 */
export type BellWordsProblem = "empty" | "too_many_words" | "too_long" | "invalid_character";

/** 言葉が空でない理由ごとの、画面に出す文 */
export const BELL_WORDS_PROBLEMS: Record<Exclude<BellWordsProblem, "empty">, string> = {
  too_many_words: `言葉は ${MAX_BELL_WORDS} 個まで入れられます。`,
  too_long: `言葉は全体で ${MAX_BELL_WORDS_LENGTH} 文字まで入れられます。`,
  invalid_character: "言葉に使えない文字（制御文字など）が入っています。",
};

/** 空白（\s に当たる文字。全角の空白、タブ、改行を含む）の並び */
const SEPARATOR = /\s+/;

/** 制御文字。区切りの空白（タブ、改行など）は、区切ったあとの言葉には残らない */
const CONTROL = /\p{Cc}/u;

/**
 * 受けた文字列を、保存する言葉の形にする。NFKC にしてから空白の並びで区切り、小文字にして同じに
 * なる言葉は最初のものだけを残す。数と長さは、重なりを除いた形で数える
 *
 * @returns 保存する形。受けられなければ、その理由
 */
export function parseBellWords(input: string): BellWords | BellWordsProblem {
  const { kept, lowered } = split(input);
  if (kept.length === 0) return "empty";
  if (kept.some((word) => CONTROL.test(word) || !word.isWellFormed())) return "invalid_character";
  if (kept.length > MAX_BELL_WORDS) return "too_many_words";
  const words = kept.join(" ");
  if (Array.from(words).length > MAX_BELL_WORDS_LENGTH) return "too_long";
  return { words, matchKey: toMatchKey(lowered) };
}

/**
 * sendo から届いたベルの言葉（保存した形）の照合用の言葉。届いた値なので上限は確かめない
 * （sendo が上限を広げても、同期を止めない）
 */
export function bellMatchKey(words: string): string {
  return toMatchKey(split(words).lowered);
}

function split(input: string): { kept: string[]; lowered: Set<string> } {
  const kept: string[] = [];
  const lowered = new Set<string>();
  for (const word of input.normalize("NFKC").split(SEPARATOR)) {
    const lower = word.toLowerCase();
    if (word === "" || lowered.has(lower)) continue;
    kept.push(word);
    lowered.add(lower);
  }
  return { kept, lowered };
}

function toMatchKey(lowered: Set<string>): string {
  return [...lowered].sort(compareCodePoints).join(" ");
}

/** コードポイントの順に比べる（文字列の既定の比べ方は UTF-16 の単位の順で、サロゲートの扱いが違う） */
function compareCodePoints(a: string, b: string): number {
  const left = a[Symbol.iterator]();
  const right = b[Symbol.iterator]();
  for (;;) {
    const l = left.next();
    const r = right.next();
    if (l.done || r.done) return (l.done ? 0 : 1) - (r.done ? 0 : 1);
    const diff = (l.value.codePointAt(0) ?? 0) - (r.value.codePointAt(0) ?? 0);
    if (diff !== 0) return diff;
  }
}
