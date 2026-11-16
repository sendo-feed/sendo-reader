/**
 * アプリの新しい版への切り替え（docs/decisions/ui.md の 5）。
 *
 * Service Worker は、新しい版を見つけると、裏で取り込んですぐ使い始める（autoUpdate）。ただ、
 * 開いている画面は、読み込んだときの古い版のまま動き続ける。ホーム画面に置いた PWA は、
 * 読み込み直す操作がなく、ほかのアプリから戻っても読み込み直さないので、そのままでは、いつまでも
 * 新しい版にならない。そこで、
 *
 * - 画面が前に出たときと、一定の間隔で、新しい版があるかを確かめる
 * - 新しい版に替わったら、画面が裏にある間か、次に前に出たときに、読み込み直す。
 *   読んでいる最中には、読み込み直さない
 */

/** 開いたままのときに、新しい版を確かめる間隔 */
export const UPDATE_CHECK_INTERVAL_MS = 60 * 60 * 1000;

interface Listenable {
  addEventListener(type: string, listener: () => void): void;
}

interface Registration {
  update(): Promise<unknown>;
}

/** 使うものだけを、形で受ける（テストでは、にせものを渡す） */
export interface AppUpdateEnvironment {
  /** navigator.serviceWorker */
  container: Listenable & { readonly controller: unknown };
  /** Service Worker を登録する */
  register: () => Promise<Registration>;
  document: Listenable & { readonly visibilityState: string };
  /** 画面を読み込み直す */
  reload: () => void;
  /**
   * 今は読み込み直してよいか。読み込み直すと消えるもの（発行したばかりのアクセストークンの表示
   * など）を出している画面では、false を返す。次に画面が前に出た ／ 裏に回ったときに、もう一度聞く
   */
  canReload: () => boolean;
  setInterval: (fn: () => void, ms: number) => unknown;
}

export function watchAppUpdate(env: AppUpdateEnvironment): void {
  // 初めて入れたときも、Service Worker が画面を受け持ち始めて controllerchange が起きる。
  // それは版の切り替えではないので、読み込み直さない
  let controlled = env.container.controller !== null;
  /** 新しい版に替わったが、まだ読み込み直していない */
  let pending = false;
  let registration: Registration | null = null;

  const check = () => {
    // 届かない、などで確かめられなくても、次の機会にまた確かめる
    registration?.update().catch(() => {});
  };
  const reloadIfReady = () => {
    if (!pending || !env.canReload()) return;
    pending = false;
    env.reload();
  };

  env.container.addEventListener("controllerchange", () => {
    if (!controlled) {
      controlled = true;
      return;
    }
    pending = true;
    // 裏にあるなら、すぐ読み込み直す。前に出ているなら、裏に回るか、次に前に出るまで待つ
    if (env.document.visibilityState === "hidden") reloadIfReady();
  });
  env.document.addEventListener("visibilitychange", () => {
    if (pending) reloadIfReady();
    else if (env.document.visibilityState === "visible") check();
  });
  env.setInterval(check, UPDATE_CHECK_INTERVAL_MS);

  void env.register().then(
    (result) => {
      registration = result;
    },
    () => {},
  );
}
