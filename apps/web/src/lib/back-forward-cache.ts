/** ページの出入り（pagehide ／ pageshow）を聞ける相手。本番は window */
export interface PageTransitionTarget {
  addEventListener(
    type: "pagehide" | "pageshow",
    listener: (event: { readonly persisted: boolean }) => void,
  ): void;
}

/** ロックを誰が持っているかを確かめる相手。本番は navigator.locks */
export interface LockProbe {
  query(): Promise<{ held?: { name?: string; clientId?: string }[] }>;
}

export interface BackForwardCacheEnvironment {
  window: PageTransitionTarget;
  locks: LockProbe;
  /** 代表を決めるロックの名前 */
  leaderLock: string;
  /** DB のワーカーを止め、代表のロックと DB（OPFS）を離す */
  release: () => void;
  /** ページを読み込み直す */
  reload: () => void;
  /** ページごと移る */
  assign: (url: string) => void;
  /** 代表のロックが空くのを待つ上限（ミリ秒）。既定は 1 秒 */
  releaseTimeout?: number;
  /** 何ミリ秒か待つ（テストで差し替える） */
  sleep?: (ms: number) => Promise<void>;
  /** 今の時刻（ミリ秒。テストで差し替える） */
  now?: () => number;
}

export interface PageLeaver {
  /**
   * reader の外へページごと移る（Google のログイン、Discord の連携）。先にワーカーを止め、代表の
   * ロックが空いたのを確かめてから移る。ほかのタブが代表のときは空かないので、上限まで待って移る
   * （生きている代表がいるので、次に開いたページは止まらない）
   */
  leave(url: string): Promise<void>;
}

/**
 * Safari は、ロックを持つページも、ワーカーごと bfcache（戻る・進むのためのページのキャッシュ）に
 * 止めて残す。止まったワーカーは代表のロックを持ったまま答えないので、次に開いたページのワーカーが
 * ロックを待ち続ける（Loading… で止まる）。
 *
 * - reader が自分で始める移動では、移る前にワーカーを止め、ロックが空くのを待つ（leave）。
 *   Safari は bfcache に入れたページをすぐ止めるので、pagehide の中で始めた処理は終わりきらないことが
 *   ある。ワーカーを止めておけば、代表のタブを閉じたときと同じく、待っているタブが代表を引き継ぐ
 *   （docs/decisions/local-first.md の 5）
 * - それ以外の移動（リンクを開くなど）に備えて、bfcache に入るとき（persisted の pagehide）にも止める
 * - 止めたあとに bfcache から戻ったら、ワーカーがいないので、読み込み直す
 *
 * ロックを持つページを bfcache に入れないブラウザ（Chromium）では、pagehide ／ pageshow の
 * persisted が true にならないので、leave で止める以外は何もしない。
 */
export function watchBackForwardCache(env: BackForwardCacheEnvironment): PageLeaver {
  const sleep = env.sleep ?? ((ms) => new Promise<void>((resolve) => setTimeout(resolve, ms)));
  const now = env.now ?? (() => Date.now());
  const timeout = env.releaseTimeout ?? 1000;
  let released = false;

  const release = () => {
    if (released) return;
    released = true;
    env.release();
  };

  /** 代表のロックを持っているクライアント。誰も持っていなければ null */
  async function leaderHolder(): Promise<string | null> {
    const { held = [] } = await env.locks.query();
    const lock = held.find((l) => l.name === env.leaderLock);
    return lock === undefined ? null : (lock.clientId ?? "");
  }

  /**
   * 止める前に代表のロックを持っていたクライアント（before）が、離すまで待つ。待っていたほかの
   * タブに渡ったときも、離したとみなす。上限を過ぎたら諦める（ほかのタブが代表なら、離さない）
   */
  async function waitForRelease(before: string | null): Promise<void> {
    if (before === null) return;
    const deadline = now() + timeout;
    while ((await leaderHolder()) === before && now() < deadline) await sleep(20);
  }

  env.window.addEventListener("pagehide", (event) => {
    if (event.persisted) release();
  });
  env.window.addEventListener("pageshow", (event) => {
    if (event.persisted && released) env.reload();
  });

  return {
    async leave(url) {
      try {
        const before = await leaderHolder();
        release();
        await waitForRelease(before);
      } finally {
        // 確かめられなくても（ロックを調べるのに失敗しても）、止めて移る
        release();
        env.assign(url);
      }
    },
  };
}
