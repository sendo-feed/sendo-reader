const prefix = "sendo.workspace-selection.";

export function loadWorkspaceSelection(userId: string): readonly string[] | undefined {
  try {
    const stored = sessionStorage.getItem(prefix + userId);
    if (stored === null) return undefined;
    const parsed: unknown = JSON.parse(stored);
    return Array.isArray(parsed) && parsed.every((id) => typeof id === "string")
      ? [...new Set<string>(parsed)].sort()
      : [];
  } catch {
    return [];
  }
}

export function saveWorkspaceSelection(userId: string, ids: readonly string[] | undefined): void {
  try {
    if (ids === undefined) sessionStorage.removeItem(prefix + userId);
    else sessionStorage.setItem(prefix + userId, JSON.stringify(ids));
  } catch {
    // タブが開いている間の選択はメモリにある。保存を許可されない環境では読み込み直したときだけ失う。
  }
}
