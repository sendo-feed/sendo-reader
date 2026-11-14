import type { Feed, Folder, SyncStatus, UnreadCounts } from "@sendo-reader/core";
import type { ReaderClient } from "@sendo-reader/core/web";

/**
 * 画面の状態。手元の DB を読み、変わったら読み直す（ネットワークは待たない）。
 * 記事の一覧は画面ごとに読むので、ここでは「記事が変わった」ことだけを数える。
 */
export class ReaderState {
  /** null はまだ分からない（起動したばかり） */
  signedIn = $state<boolean | null>(null);
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
      if (this.signedIn !== status.signedIn) {
        this.signedIn = status.signedIn;
        if (status.signedIn) void this.#loadAll();
      }
    });
  }

  async init(): Promise<void> {
    this.signedIn = await this.client.isSignedIn();
    if (this.signedIn) await this.#loadAll();
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
