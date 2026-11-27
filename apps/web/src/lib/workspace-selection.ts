/**
 * ワークスペースの選択の置き場（docs/decisions/workspaces.md の 2）。タブの選択は sessionStorage に
 * 置く。利用者が選択を変えたら、このブラウザの「最後の選択」として localStorage にも写し、
 * sessionStorage に選択がないタブ（新しいタブ、ホーム画面のアプリの開き直しなど）の初めの値にする
 */
const prefix = "sendo.workspace-selection.";
/** 写しから引き継ぎ、まだ手元のワークスペースの一覧と照らしていない選択（タブの sessionStorage） */
const pendingPrefix = "sendo.workspace-selection-pending.";
/** 最後の選択の写し（localStorage） */
const lastPrefix = "sendo.workspace-selection-last.";

export interface StoredWorkspaceSelection {
  /** undefined は All */
  ids: readonly string[] | undefined;
  /** 写しから引き継ぎ、まだ照らしていない（照らし終えたら settleWorkspaceSelection で置く） */
  inherited: boolean;
}

export function loadWorkspaceSelection(userId: string): StoredWorkspaceSelection {
  let own: string | null;
  let pending: string | null;
  try {
    own = sessionStorage.getItem(prefix + userId);
    pending = own === null ? sessionStorage.getItem(pendingPrefix + userId) : null;
  } catch {
    // タブの置き場を使えない。今までどおり空の表示にして、利用者が範囲を選べるようにする
    return { ids: [], inherited: false };
  }
  if (own !== null) return { ids: parseOwnSelection(own), inherited: false };
  // 照らす前に読み込み直した。写しではなく、引き継いだときの選択から続ける（その間にほかのタブが
  // 写しを変えても、このタブの範囲は広がらない）
  if (pending !== null) return { ids: parseOwnSelection(pending) ?? [], inherited: true };
  const last = loadLastSelection(userId);
  if (last === undefined) {
    // 写しがなければ All で始め、All をこのタブの選択として置く（読み込み直したときに、その間に
    // ほかのタブが書いた写しを引き継がない）
    settleWorkspaceSelection(userId, undefined);
    return { ids: undefined, inherited: false };
  }
  try {
    sessionStorage.setItem(pendingPrefix + userId, JSON.stringify(last));
  } catch {
    // 置けなければ、読み込み直したときに写しから始め直す
  }
  return { ids: last, inherited: true };
}

/** タブの選択。null は All。読めない場合は空の表示にして、利用者が範囲を選べるようにする */
function parseOwnSelection(stored: string): readonly string[] | undefined {
  try {
    const parsed: unknown = JSON.parse(stored);
    if (parsed === null) return undefined;
    return isIdList(parsed) ? normalize(parsed) : [];
  } catch {
    return [];
  }
}

/** 最後の選択の写し。ない、読めない、空なら undefined（All で始める） */
function loadLastSelection(userId: string): readonly string[] | undefined {
  try {
    const stored = localStorage.getItem(lastPrefix + userId);
    if (stored === null) return undefined;
    const parsed: unknown = JSON.parse(stored);
    return isIdList(parsed) && parsed.length > 0 ? normalize(parsed) : undefined;
  } catch {
    return undefined;
  }
}

function isIdList(value: unknown): value is string[] {
  return Array.isArray(value) && value.every((id) => typeof id === "string");
}

function normalize(ids: readonly string[]): readonly string[] {
  return [...new Set(ids)].sort();
}

/**
 * 照らし終えた選択を、タブの選択として置き、照らす前の印を外す。All も置く（読み込み直したときに、
 * 写しから引き継ぎ直さない）。置けなければ印を残す（読み込み直したら、印の範囲から照らし直す）
 */
export function settleWorkspaceSelection(userId: string, ids: readonly string[] | undefined): void {
  try {
    sessionStorage.setItem(prefix + userId, JSON.stringify(ids ?? null));
    sessionStorage.removeItem(pendingPrefix + userId);
  } catch {
    // タブが開いている間の選択はメモリにある。保存を許可されない環境では読み込み直したときだけ失う。
  }
}

/**
 * 利用者が選んだ。タブの選択を置き、最後の選択としても写す。All と 0 件選択は写さず、前の写しを消す
 * （新しいタブは All で始まる）
 */
export function chooseWorkspaceSelection(userId: string, ids: readonly string[] | undefined): void {
  // 印は先に外す（タブの選択を置けなくても、読み込み直したときに、選ぶ前の印の範囲から続けない。
  // 写しには選んだ範囲が入る）
  try {
    sessionStorage.removeItem(pendingPrefix + userId);
  } catch {
    // 外せない環境では、読めもしない
  }
  settleWorkspaceSelection(userId, ids);
  try {
    if (ids === undefined || ids.length === 0) localStorage.removeItem(lastPrefix + userId);
    else localStorage.setItem(lastPrefix + userId, JSON.stringify(ids));
  } catch {
    // 写せなければ前の写しを消し、新しいタブは All で始める（最後の選択でない古い写しを使わない）
    try {
      localStorage.removeItem(lastPrefix + userId);
    } catch {
      // 消せない環境では、読めもしない
    }
  }
}

/**
 * ログアウトとユーザーの切り替えで、すべてのアカウントの最後の選択の写しを消す（画面が、手元の DB を
 * 消した知らせを受けたときに呼ぶ）
 */
export function forgetLastWorkspaceSelections(): void {
  try {
    const keys: string[] = [];
    for (let i = 0; i < localStorage.length; i++) {
      const key = localStorage.key(i);
      if (key?.startsWith(lastPrefix)) keys.push(key);
    }
    for (const key of keys) localStorage.removeItem(key);
  } catch {
    // 消せない環境では、読めもしない
  }
}
