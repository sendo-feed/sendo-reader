import {
  ApiError,
  type Feed,
  type Folder,
  type SyncStatus,
  type UnreadCounts,
  type User,
} from "@sendo-reader/core";
import type { ReaderClient } from "@sendo-reader/core/web";
import { takeLoginError } from "./login";

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
  /** ログアウトを sendo に送れず、この端末のデータだけを消した */
  signOutPending = $state(false);
  status = $state<SyncStatus | null>(null);
  folders = $state<Folder[]>([]);
  feeds = $state<Feed[]>([]);
  unread = $state<UnreadCounts>({ total: 0, feeds: new Map(), folders: new Map() });
  /** 記事が変わるたびに増える。一覧や記事の画面は、これを見て読み直す */
  articlesVersion = $state(0);

  readonly client: ReaderClient;

  constructor(client: ReaderClient) {
    this.client = client;
    client.onChange((tables) => {
      if (tables.has("folders")) void this.#loadFolders();
      if (tables.has("feeds") || tables.has("folders")) void this.#loadFeeds();
      if (tables.has("articles") || tables.has("feeds")) {
        void this.#loadUnread();
        this.articlesVersion += 1;
      }
    });
    client.onStatus((status) => {
      this.status = status;
      this.user = status.user;
      if (this.signedIn !== status.signedIn) {
        this.signedIn = status.signedIn;
        if (status.signedIn) void this.#loadAll();
      }
    });
  }

  /**
   * 起動したときに呼ぶ。手元にユーザーがいれば、ネットワークを待たずに画面を出す。いなければ
   * sendo のセッションを見る（Google のログインから戻ってきたとき）
   */
  async init(): Promise<void> {
    this.loginError = takeLoginError();
    try {
      this.signedIn = await this.client.restoreSession();
    } catch (error) {
      // 手元にユーザーがいれば restoreSession は待たずに答えるので、ここに来るのは、手元に
      // いなくて sendo に聞けなかったとき
      this.offline = error instanceof ApiError && error.kind === "network";
      this.signedIn = await this.client.isSignedIn();
    }
    if (this.signedIn) {
      this.user = await this.client.currentUser();
      await this.#loadAll();
    }
  }

  /** ログアウトする。sendo に届かなくても、この端末のデータは消える */
  async signOut(): Promise<void> {
    this.signOutPending = !(await this.client.signOut());
    this.signedIn = false;
    this.user = null;
    this.loginError = null;
  }

  feedTitle(feedId: string): string {
    const feed = this.feeds.find((f) => f.id === feedId);
    return feed === undefined ? "（購読していないフィード）" : (feed.title ?? feed.url);
  }

  async #loadAll(): Promise<void> {
    await Promise.all([this.#loadFolders(), this.#loadFeeds(), this.#loadUnread()]);
  }

  async #loadFolders(): Promise<void> {
    this.folders = await this.client.listFolders();
  }

  async #loadFeeds(): Promise<void> {
    this.feeds = await this.client.listFeeds();
  }

  async #loadUnread(): Promise<void> {
    this.unread = await this.client.countUnread();
  }
}
