/**
 * 記事の中の X の投稿の、出したときの大きさ（docs/decisions/embeds.md の 5）。記事の位置と一緒に、
 * 履歴の項目（history.state）に覚え、読み込み直し・戻る・進むで記事を開いたときに、読み込む前から
 * その高さの枠を取る（位置が、今のスクロール量のままで合う）。
 *
 * 履歴の項目は、前の版や、ほかのコードが書いたものかもしれない。読み戻すときは形を確かめ、合わない
 * ものは捨てる。
 */

/** 投稿 1 つの大きさ。幅は、出したときの枠の幅（px、整数） */
export interface XPostSize {
  id: string;
  width: number;
  height: number;
}

/** 1 つの記事で覚える投稿の数の上限 */
export const MAX_X_POST_SIZES = 100;
/** 覚える幅と高さの上限（px）。高さは、隔離フレームから受ける上限と同じ */
export const MAX_X_POST_LENGTH = 4000;

const POST_ID = /^[0-9]{1,20}$/;

function isLength(value: unknown): value is number {
  return (
    Number.isInteger(value) && (value as number) >= 1 && (value as number) <= MAX_X_POST_LENGTH
  );
}

/** 履歴の項目から読み戻した値を確かめる。形が合わないものは捨てる。上限を超えた分も捨てる */
export function parseXPostSizes(value: unknown): XPostSize[] {
  if (!Array.isArray(value)) return [];
  const sizes: XPostSize[] = [];
  for (const entry of value) {
    if (sizes.length >= MAX_X_POST_SIZES) break;
    if (typeof entry !== "object" || entry === null) continue;
    const { id, width, height } = entry as Record<string, unknown>;
    if (typeof id !== "string" || !POST_ID.test(id) || !isLength(width) || !isLength(height)) {
      continue;
    }
    sizes.push({ id, width, height });
  }
  return sizes;
}
