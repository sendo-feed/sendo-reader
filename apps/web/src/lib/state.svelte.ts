import {
  ApiError,
  type Feed,
  type Folder,
  feedName,
  type SyncStatus,
  type UnreadCounts,
  type User,
  type Workspace,
} from "@sendo-reader/core";
import { ProtocolMismatchError, type ReaderClient } from "@sendo-reader/core/web";
import { takeLoginError } from "./login";
import { loadWorkspaceSelection, saveWorkspaceSelection } from "./workspace-selection";

const emptyUnread = (): UnreadCounts => ({ total: 0, feeds: new Map(), folders: new Map() });

/**
 * 画面の状態。手元の DB を読み、変わったら読み直す（ネットワークは待たない）。
 * 記事の一覧は画面ごとに読むので、ここでは「記事が変わった」ことだけを数える。
 */
export class ReaderState {
  /** null はまだ分からない（起動したばかり） */
  signedIn = $state<boolean | null>(null);
  /** 手元に置いた、ログインしたユーザー */
  user = $state<User | null>(null);
  /** 起動したときに sendo に届かず、ログインしているかを確かめられなかった */
  offline = $state(false);
  /** sendo がログインに失敗して戻した理由（画面に出す文） */
  loginError = $state<string | null>(null);
  status = $state<SyncStatus | null>(null);
  #folders = $state.raw<Folder[]>([]);
  allFeeds = $state.raw<Feed[]>([]);
  workspaces = $state.raw<Workspace[]>([]);
  defaultWorkspaceId = $state<string | null>(null);
  defaultWorkspaceOnSubscribe = $state(false);
  workspacesAvailable = $state(false);
  workspaceIds = $state.raw<readonly string[] | undefined>([]);
  workspaceDataReady = $state(false);
  workspaceScopeComplete = $state(false);
  workspaceReadCursor = $state<string | null>(null);
  #selectedWorkspaces = $derived(
    this.workspaceIds?.filter((id) => this.workspaces.some((workspace) => workspace.id === id)),
  );
  visibleWorkspaceIds = $derived(
    this.workspaceIds === undefined
      ? undefined
      : this.workspaceDataReady
        ? this.#selectedWorkspaces
        : [],
  );
  scopeFeeds = $derived.by(() => {
    const ids = this.#selectedWorkspaces;
    if (ids === undefined) return this.allFeeds;
    const selected = new Set(ids);
    return this.allFeeds.filter(
      (feed) =>
        feed.subscriptionId !== undefined &&
        feed.workspaceId != null &&
        selected.has(feed.workspaceId),
    );
  });
  feeds = $derived(
    this.workspaceDataReady || this.workspaceIds === undefined ? this.scopeFeeds : [],
  );
  folders = $derived.by(() => {
    if (this.workspaceIds === undefined) return this.#folders;
    const visible = new Set(this.feeds.map((feed) => feed.folderId));
    return this.#folders.filter((folder) => visible.has(folder.id));
  });
  #createdFolderIds = $state.raw<readonly string[]>([]);
  folderDestinations = $derived.by(() => {
    const visible = new Set(this.folders.map((folder) => folder.id));
    return this.#folders.filter(
      (folder) => visible.has(folder.id) || this.#createdFolderIds.includes(folder.id),
    );
  });
  unread = $state<UnreadCounts>(emptyUnread());
  /** 今日（この端末の日付で）既読にした記事の数。進み具合の内訳に出す */
  readToday = $state(0);
  /** 記事が変わるたびに増える。一覧や記事の画面は、これを見て読み直す */
  articlesVersion = $state(0);
  /**
   * 版の違うタブが開いていて、代表のワーカーとやり取りできない（docs/decisions/local-first.md
   * の 5）。どの呼び出しの失敗でも覚え、番号の合う代表に替わって同期の様子が届いたら消す
   */
  versionMismatch = $state<ProtocolMismatchError | null>(null);

  readonly client: ReaderClient;
  /**
   * reader の外へページごと移る（Google のログイン、Discord の連携）。DB のワーカーを止めてから移る
   * （lib/back-forward-cache.ts）。移ったあとは client が答えない
   */
  readonly leave: (url: string) => Promise<void>;
  /**
   * leave で移ったのに、しばらくしてもページが残っている。DB のワーカーを止めているので、
   * 読み込み直せることを知らせる（components/LeaveStalled.svelte）
   */
  leaveStalled = $state(false);
  /** 起動の途中で、版の違うタブのために止まった。番号の合う代表に替わったら、起動し直す */
  #startBlocked = false;
  #workspaceRead = 0;
  #unreadRead = 0;

  constructor(client: ReaderClient, leave: (url: string) => Promise<void>) {
    this.leave = leave;
    this.client = watchVersionMismatch(client, (error) => {
      this.versionMismatch = error;
    });
    client.onChange((tables) => {
      if (tables.has("workspaces") || tables.has("feeds") || tables.has("folders")) {
        void this.#loadWorkspaceData();
      }
      if (
        tables.has("articles") ||
        tables.has("feeds") ||
        tables.has("workspaces") ||
        tables.has("folders")
      ) {
        void this.#loadUnread();
        this.articlesVersion += 1;
      }
    });
    client.onStatus((status) => {
      // 同期の様子は、番号の合う代表（か自分）からしか届かない
      this.versionMismatch = null;
      const syncFinished = this.status?.syncing === true && !status.syncing;
      this.status = status;
      const accountChanged = this.#setUser(status.user);
      if (this.#startBlocked) {
        // ログインしているかは、起動の続きで確かめる（Google のログインから戻ってきたときは、
        // sendo のセッションを見る）
        this.#startBlocked = false;
        void this.#start();
        return;
      }
      if (accountChanged || this.signedIn !== status.signedIn) {
        this.signedIn = status.signedIn;
        if (status.signedIn) void this.#loadAll();
      } else if (
        syncFinished &&
        status.error === null &&
        this.workspaceIds !== undefined &&
        !this.workspaceScopeComplete
      ) {
        void this.#loadWorkspaceData();
      } else if (syncFinished && this.workspaceIds !== undefined) {
        void this.#loadUnread();
      }
    });
  }

  /**
   * 起動したときに呼ぶ。手元にユーザーがいれば、ネットワークを待たずに画面を出す。いなければ
   * sendo のセッションを見る（Google のログインから戻ってきたとき）
   */
  async init(): Promise<void> {
    this.loginError = takeLoginError();
    await this.#start();
  }

  async #start(): Promise<void> {
    try {
      await this.#signIn();
    } catch (error) {
      // 版の違うタブのために止まったら、知らせを出し（versionMismatch）、番号の合う代表に
      // 替わるのを待つ
      if (error instanceof ProtocolMismatchError) {
        this.#startBlocked = true;
        return;
      }
      throw error;
    }
  }

  async #signIn(): Promise<void> {
    let signedIn: boolean;
    try {
      signedIn = await this.client.restoreSession();
    } catch (error) {
      if (error instanceof ProtocolMismatchError) throw error;
      // 手元にユーザーがいれば restoreSession は待たずに答えるので、ここに来るのは、手元に
      // いなくて sendo に聞けなかったとき
      this.offline = error instanceof ApiError && error.kind === "network";
      signedIn = await this.client.isSignedIn();
    }
    // 画面は、どのユーザーかが分かってから出す（設定の画面は、手元のユーザーと照らして sendo に聞く）
    this.#setUser(signedIn ? await this.client.currentUser() : null);
    this.signedIn = signedIn;
    if (signedIn) await this.#loadAll();
  }

  /** ログアウトする。この端末のデータをすぐ消し、sendo へは裏で送る（ネットワークを待たない） */
  async signOut(): Promise<void> {
    await this.client.signOut();
    this.signedIn = false;
    this.#setUser(null);
    this.loginError = null;
  }

  feedTitle(feedId: string): string {
    const feed = this.feeds.find((f) => f.id === feedId);
    return feed === undefined ? "（購読していないフィード）" : feedName(feed);
  }

  /** フィードのアイコンの URL（sendo が中継する画像。なければ null） */
  feedIcon(feedId: string): string | null {
    return this.feeds.find((f) => f.id === feedId)?.iconUrl ?? null;
  }

  #setUser(user: User | null): boolean {
    const changed = user?.id !== this.user?.id;
    if (changed) {
      ++this.#workspaceRead;
      ++this.#unreadRead;
      this.workspaceIds = user === null ? [] : loadWorkspaceSelection(user.id);
      this.workspaceDataReady = false;
      this.workspaceScopeComplete = false;
      this.workspaceReadCursor = null;
      this.workspacesAvailable = false;
      this.workspaces = [];
      this.defaultWorkspaceId = null;
      this.defaultWorkspaceOnSubscribe = false;
      this.#folders = [];
      this.#createdFolderIds = [];
      this.allFeeds = [];
      this.unread = emptyUnread();
      this.readToday = 0;
    }
    this.user = user;
    return changed;
  }

  selectWorkspaces(ids: readonly string[] | undefined): void {
    if (this.user === null) return;
    this.workspaceReadCursor = null;
    this.#createdFolderIds = [];
    this.workspaceIds = ids === undefined ? undefined : [...new Set(ids)].sort();
    saveWorkspaceSelection(this.user.id, this.workspaceIds);
    this.unread = emptyUnread();
    this.readToday = 0;
    void this.#loadUnread();
  }

  offerNewFolder(id: string): void {
    if (this.workspaceIds !== undefined) this.#createdFolderIds = [...this.#createdFolderIds, id];
  }

  async #loadAll(): Promise<void> {
    await Promise.all([this.#loadWorkspaceData(), this.#loadUnread()]);
  }

  async #loadWorkspaceData(): Promise<void> {
    if (this.user === null) return;
    const read = ++this.#workspaceRead;
    this.workspaceDataReady = false;
    if (this.workspaceIds !== undefined) {
      this.unread = emptyUnread();
      this.readToday = 0;
    }
    const {
      workspaces,
      available,
      defaultWorkspaceId,
      defaultWorkspaceOnSubscribe,
      feeds,
      folders,
      complete,
    } = await this.client.workspaceData();
    if (read !== this.#workspaceRead) return;
    this.workspaces = workspaces;
    this.defaultWorkspaceId = defaultWorkspaceId;
    this.defaultWorkspaceOnSubscribe = defaultWorkspaceOnSubscribe;
    this.workspacesAvailable = available;
    this.allFeeds = feeds;
    this.#folders = folders;
    this.workspaceScopeComplete = complete;
    this.workspaceDataReady = true;
    if (this.workspaceIds !== undefined) await this.#loadUnread();
  }

  async #loadUnread(): Promise<void> {
    if (this.user === null) return;
    const read = ++this.#unreadRead;
    if (this.workspaceIds !== undefined && !this.workspaceDataReady) return;
    const ids = this.visibleWorkspaceIds;
    const since = new Date().setHours(0, 0, 0, 0);
    if (ids !== undefined) {
      const { unread, readToday, cursor } = await this.client.workspaceReadCounts(ids, since);
      if (read !== this.#unreadRead) return;
      this.unread = unread;
      this.readToday = readToday;
      this.workspaceReadCursor = cursor;
    } else {
      const [unread, readToday] = await Promise.all([
        this.client.countUnread(),
        this.client.countReadSince(since),
      ]);
      if (read !== this.#unreadRead) return;
      this.unread = unread;
      this.readToday = readToday;
    }
  }
}

/**
 * 窓口の呼び出しの失敗のうち、版の違うタブのためのもの（ProtocolMismatchError）を知らせる。
 * 呼び出しの結果は変えない（呼んだ側は、今までどおり失敗を受ける。呼んだ側が失敗を受けなければ、
 * 今までどおり処理されなかった失敗として報告される）
 */
function watchVersionMismatch(
  client: ReaderClient,
  onMismatch: (error: ProtocolMismatchError) => void,
): ReaderClient {
  const watched: Record<string, unknown> = {};
  for (const [name, value] of Object.entries(client)) {
    if (typeof value !== "function") {
      watched[name] = value;
      continue;
    }
    const call = value as (...args: unknown[]) => unknown;
    watched[name] = (...args: unknown[]) => {
      const result = call(...args);
      if (!(result instanceof Promise)) return result;
      return result.catch((error: unknown) => {
        if (error instanceof ProtocolMismatchError) onMismatch(error);
        throw error;
      });
    };
  }
  return watched as ReaderClient;
}
