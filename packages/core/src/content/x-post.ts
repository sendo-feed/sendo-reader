/**
 * 記事の中の X の投稿（docs/decisions/embeds.md）。
 *
 * sendo は、X の公式の埋め込みコードの引用に、投稿の ID の印（`blockquote` の `data-x-post`）を
 * 付けて渡す。reader は、この値だけを見て投稿を見分け、引用の中の文字やリンクから照合しない。
 */

/** 投稿の ID の形。数としては扱わない（桁があふれる） */
const X_POST_ID = /^[0-9]{1,20}$/;

/** 印の値が投稿の ID の形なら、その値。そうでなければ null（印がないものとして扱う） */
export function toXPostId(value: string | undefined): string | null {
  return value !== undefined && X_POST_ID.test(value) ? value : null;
}

/**
 * 投稿を X で開く URL。ID から組み立てる（引用の中のリンクや、印の値をそのまま使わない）。
 * ID の形でない値には、null を返す
 */
export function xPostUrl(id: string): string | null {
  return toXPostId(id) === null ? null : `https://x.com/i/web/status/${id}`;
}
