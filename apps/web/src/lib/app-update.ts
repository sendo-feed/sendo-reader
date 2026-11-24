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
 * - 前に出ている間は読み込み直さないので、新しい版に替わったことを画面に知らせ（onUpdateReady）、
 *   利用者がその場で切り替えられるようにする
 */

import { AUTHORIZE_PATH } from "./authorize";

/** 開いたままのときに、新しい版を確かめる間隔 */
export const UPDATE_CHECK_INTERVAL_MS = 60 * 60 * 1000;

interface Listenable {
  addEventListener(type: string, listener: () => void): void;
}

interface InstallingWorker extends Listenable {
  readonly state: ServiceWorkerState;
  removeEventListener(type: string, listener: () => void): void;
}

interface Registration extends Listenable {
  readonly installing: InstallingWorker | null;
  readonly waiting: InstallingWorker | null;
  removeEventListener(type: string, listener: () => void): void;
  update(): Promise<unknown>;
}

export interface AppVersion {
  readonly commit: string;
  readonly builtAt: string;
}

export type AppUpdateNotice = "ready" | "failed";

/** 使うものだけを、形で受ける（テストでは、にせものを渡す） */
export interface AppUpdateEnvironment {
  serviceWorker:
    | (Listenable & {
        readonly controller: unknown;
        register: () => Promise<Registration>;
      })
    | null;
  version: AppVersion;
  fetch: (path: string, init: RequestInit) => Promise<Response>;
  document: Listenable & { readonly visibilityState: string };
  reload: () => void;
  /** 読み込み直すと消えるものを出している間は false */
  canReload: () => boolean;
  setInterval: (fn: () => void, ms: number) => unknown;
  onNotice: (notice: AppUpdateNotice | null) => void;
}

/**
 * 読み込み直すと消えるものを出している画面のパス。設定（発行したトークン）、購読の管理（入力中の
 * フォーム・取り込み結果）、ブックマークレットからの追加、OAuth の許可
 */
const KEEP_PATHS: readonly string[] = ["/settings", "/manage", "/add", AUTHORIZE_PATH];

/**
 * いまの画面を読み込み直してよいか。読み込み直すと消えるものを出している画面（上のパス）と、出している
 * 間（held。lib/reload-guard.svelte.ts の印。開いている Save a URL の窓など）は false。自動の読み込み
 * 直し（main.ts の canReload）と、新しい版の知らせ（App.svelte）の両方が、これで決める。パスはここに、
 * パスで分からないものは reloadGuard の印で足す
 */
export function canReloadPage(pathname: string, held: boolean): boolean {
  return !KEEP_PATHS.includes(pathname) && !held;
}

/**
 * 新しい版の知らせの文。ホーム画面のアプリには読み込み直す操作がないので、開き直すよう伝える
 * （docs/decisions/ui.md の 5）
 */
export function updateReadyMessage(standalone: boolean): string {
  return standalone
    ? "新しい版があります。Reload を押すか、アプリを開き直すと切り替わります。"
    : "新しい版があります。Reload を押すか、ページを読み込み直すと切り替わります。";
}

function sameVersion(a: AppVersion, b: AppVersion): boolean {
  return a.commit === b.commit && a.builtAt === b.builtAt;
}

async function serverVersion(env: AppUpdateEnvironment): Promise<AppVersion | null> {
  try {
    const response = await env.fetch("/version.json", { cache: "no-store" });
    if (!response.ok) return null;
    const version: unknown = await response.json();
    if (
      typeof version === "object" &&
      version !== null &&
      "commit" in version &&
      typeof version.commit === "string" &&
      version.commit.trim() !== "" &&
      "builtAt" in version &&
      typeof version.builtAt === "string" &&
      Number.isFinite(Date.parse(version.builtAt)) &&
      new Date(version.builtAt).toISOString() === version.builtAt
    ) {
      return { commit: version.commit, builtAt: version.builtAt };
    }
  } catch {
    // オフラインや、版のファイルを持たないサーバーの index.html など
  }
  return null;
}

/** update() は取り込みの完了を待たないので、見つけた worker の状態も確かめる */
async function installUpdate(
  registration: Registration,
): Promise<"unchanged" | "installed" | "failed" | "unavailable"> {
  let installing = registration.installing ?? registration.waiting;
  const found = () => {
    installing = registration.installing ?? installing;
  };
  registration.addEventListener("updatefound", found);
  try {
    await registration.update();
    installing = registration.installing ?? registration.waiting ?? installing;
  } catch {
    if (installing === null) return "unavailable";
  } finally {
    registration.removeEventListener("updatefound", found);
  }

  const worker = installing;
  if (worker === null) return "unchanged";
  return new Promise((resolve) => {
    const onState = () => {
      if (worker.state === "installing" || worker.state === "parsed") return;
      worker.removeEventListener("statechange", onState);
      resolve(worker.state === "redundant" ? "failed" : "installed");
    };
    worker.addEventListener("statechange", onState);
    onState();
  });
}

type Update =
  | { kind: "ready"; version: AppVersion | null }
  | { kind: "failed"; version: AppVersion };

export function watchAppUpdate(env: AppUpdateEnvironment): void {
  const controller = () => env.serviceWorker?.controller ?? null;
  let previousController = controller();
  let update: Update | null = null;
  let reloading = false;
  let checkId = 0;

  const setUpdate = (next: Update | null) => {
    update = next;
    env.onNotice(next?.kind ?? null);
  };
  const reloadIfAllowed = () => {
    if (reloading || !env.canReload()) return;
    reloading = true;
    env.reload();
  };
  const workerReady = () => {
    setUpdate({ kind: "ready", version: null });
    if (env.document.visibilityState === "hidden") reloadIfAllowed();
  };

  env.serviceWorker?.addEventListener("controllerchange", () => {
    const before = previousController;
    const current = controller();
    previousController = current;
    if (reloading || current === null || current === before) return;
    if (before !== null) {
      workerReady();
      return;
    }

    // 初めての受け持ちや強制再読み込みのあと、画面が最新なら知らせない
    void serverVersion(env).then((version) => {
      if (reloading || controller() !== current || version === null) return;
      if (!sameVersion(env.version, version)) workerReady();
      else if (update !== null) setUpdate(null);
    });
  });

  const registration = Promise.resolve()
    .then(() => env.serviceWorker?.register() ?? null)
    .catch(() => null);

  const check = async (reason: "startup" | "interval" | "visibility"): Promise<void> => {
    if (reloading) return;
    const id = ++checkId;
    const current = controller();
    const isCurrent = () => id === checkId && !reloading && current === controller();
    const version = await serverVersion(env);
    if (!isCurrent()) return;

    // Service Worker の切り替えを知ったあとは、その次の切り替えも controllerchange で知る。
    // /version.json が変わらないコンテナ設定の変更もあるため、SW 自身の確認は続ける
    const waitingForWorkerReload = update?.kind === "ready" && update.version === null;
    if (waitingForWorkerReload || version === null || sameVersion(env.version, version)) {
      if (!waitingForWorkerReload && version !== null && update !== null) setUpdate(null);
      if (reason !== "startup" && current !== null) {
        const worker = await registration;
        if (isCurrent()) void worker?.update().catch(() => {});
      }
      return;
    }

    if (current === null) {
      const pendingVersion = update?.kind === "ready" ? update.version : null;
      const samePending = pendingVersion !== null && sameVersion(pendingVersion, version);
      const hidden = env.document.visibilityState === "hidden";
      if (!samePending) setUpdate({ kind: "ready", version });

      if (reason === "visibility" && (samePending || (hidden && pendingVersion !== null))) {
        reloadIfAllowed();
      } else if (pendingVersion === null && hidden && env.canReload()) {
        // 裏で初めて新版を見つけたときも、再取得してから自動で読み込み直す
        await check("visibility");
      }
      return;
    }

    const worker = await registration;
    if (worker === null || !isCurrent()) return;
    const result = await installUpdate(worker);
    if (!isCurrent() || (update?.kind === "ready" && update.version === null)) return;
    if (result === "unchanged") workerReady();
    if (
      result === "failed" &&
      !(update?.kind === "failed" && sameVersion(update.version, version))
    ) {
      setUpdate({ kind: "failed", version });
    }
  };

  env.document.addEventListener("visibilitychange", () => {
    if (update?.kind === "ready" && update.version === null) reloadIfAllowed();
    else if (update?.kind === "ready" || env.document.visibilityState === "visible") {
      void check("visibility");
    }
  });
  env.setInterval(() => void check("interval"), UPDATE_CHECK_INTERVAL_MS);
  void check("startup");
}
