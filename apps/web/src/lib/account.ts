import { createAccountApi, type User } from "@sendo-reader/core";

/**
 * アカウントの画面（設定、OAuth の許可）が使う sendo の API（docs/decisions/account.md）。
 * sendo にしかないものを扱うので、手元の DB を通さず、画面から core の API の窓口で直接呼ぶ。
 * 同じオリジンの /api（reader Worker が sendo に中継する）に送り、セッションのクッキーが付く。
 */
export const account = createAccountApi({ baseUrl: "/api/v1" });

/** 用途の名前 */
export const PURPOSE_LABELS = {
  reader: "リーダーアプリ用",
  mcp: "MCP 用",
} as const;

/** 範囲の説明 */
export function describeScopes(scopes: readonly string[]): string {
  return scopes.includes("write") ? "読み書き（購読や既読などの変更も）" : "読むだけ";
}

/**
 * sendo のセッションが、手元のユーザーと別のユーザーのものだった（別のタブなどでログインし直した）。
 * 操作は送らない。手元のユーザーの切り替えは同期に任せる（docs/decisions/local-first.md の 6）
 */
export class AccountChangedError extends Error {
  constructor() {
    super("sendo のセッションが、手元のユーザーと違う");
    this.name = "AccountChangedError";
  }
}

/**
 * 設定の画面で sendo に聞く前に、セッションのユーザーが手元のユーザーと同じかを確かめる。
 * 違えば onChanged（同期を頼む）を呼んで、AccountChangedError を投げる
 */
export async function confirmAccount(
  expected: User | null,
  onChanged: () => void,
  signal?: AbortSignal,
): Promise<void> {
  const current = await account.me(signal);
  if (expected === null || current.id !== expected.id) {
    onChanged();
    throw new AccountChangedError();
  }
}
