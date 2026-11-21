/**
 * 手元に置く本文の量の上限（docs/decisions/local-first.md の「記事の本文」）。端末ごとに選び、
 * sendo には預けない（docs/decisions/settings.md の 4）。
 */

const MB = 1024 * 1024;

/** 選べる上限（バイト）。0 は Off（先に取らない。開いたときの取得はこれまでどおり） */
export const CONTENT_STORAGE_LIMITS: readonly number[] = [
  0,
  50 * MB,
  100 * MB,
  200 * MB,
  500 * MB,
  1024 * MB,
];

export const DEFAULT_CONTENT_STORAGE_LIMIT = 200 * MB;

/** 手元の本文の量と、その上限（どちらもバイト） */
export interface ContentStorage {
  limit: number;
  used: number;
}

/** 置いてあった値を読む。なかったり、選べる値でなかったりしたら、既定にする */
export function parseContentStorageLimit(value: string | null): number {
  const limit = Number(value);
  return value !== null && CONTENT_STORAGE_LIMITS.includes(limit)
    ? limit
    : DEFAULT_CONTENT_STORAGE_LIMIT;
}
