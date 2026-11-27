import type { User } from "@sendo-reader/core";
import { account, confirmAccount } from "./account";
import { clearTags } from "./notification-store";
import {
  browserSupport,
  checkDevice,
  type DeviceState,
  forgetDevice,
  type PushEnvironment,
  resendOnStartup,
  type ServiceWorkerReadiness,
  type TurnOnResult,
  turnOff,
  turnOn,
} from "./push";
import { serviceWorkerRegistering } from "./service-worker";

/** 登録を作る、送り直す、外すを、タブどうしで 1 つずつにするロック（docs/decisions/notifications.md の 3） */
const PUSH_LOCK = "sendo-reader:push";

/** Service Worker の ready を待つ上限（docs/decisions/notifications.md の 1） */
const READY_TIMEOUT_MS = 10_000;

/**
 * この端末で通知を受ける操作の、ブラウザーの本物（lib/push.ts の PushEnvironment）。main.ts が
 * connect で、手元のユーザーと、セッションのユーザーが違ったときの扱いと、バッジの書き直し方を渡す
 */
class PushDevice {
  #user: () => User | null = () => null;
  #onAccountChanged: () => void = () => {};
  #refreshBadge: () => void = () => {};

  readonly #env: PushEnvironment = {
    support: browserSupport({
      standalone: (navigator as Navigator & { standalone?: boolean }).standalone,
      notification: typeof Notification !== "undefined",
      serviceWorker: "serviceWorker" in navigator,
      pushManager: typeof PushManager !== "undefined",
    }),
    permission: () => Notification.permission,
    requestPermission: () => Notification.requestPermission(),
    ready: serviceWorkerReady,
    registration: async () => (await navigator.serviceWorker?.getRegistration("/")) ?? null,
    lock: (task) => navigator.locks.request(PUSH_LOCK, task),
    sendo: {
      getPush: () => account.getPush(),
      putRegistration: (registration) => account.putPushRegistration(registration),
      deleteRegistration: () => account.deletePushRegistration(),
      confirmUser: () => confirmAccount(this.#user(), this.#onAccountChanged),
    },
    refreshBadge: () => this.#refreshBadge(),
    clearShownTags: clearTags,
  };

  connect(options: {
    /** 手元のユーザー */
    user: () => User | null;
    /** sendo のセッションが、手元のユーザーと違った（同期を頼んで、切り替えを任せる） */
    onAccountChanged: () => void;
    /** アプリのバッジを、手元の DB の未読の数で書き直す（lib/app-badge.ts） */
    refreshBadge: () => void;
  }): void {
    this.#user = options.user;
    this.#onAccountChanged = options.onAccountChanged;
    this.#refreshBadge = options.refreshBadge;
  }

  check(): Promise<DeviceState> {
    return checkDevice(this.#env);
  }

  /** Turn on notifications を押したときに、待ちを挟まずに呼ぶ */
  turnOn(publicKey: string): Promise<TurnOnResult> {
    return turnOn(this.#env, publicKey);
  }

  turnOff(): Promise<void> {
    return turnOff(this.#env);
  }

  /** 画面が起動したときに呼ぶ（ログインしているとき） */
  resend(): Promise<void> {
    return resendOnStartup(this.#env);
  }

  /** ログアウトとユーザーの切り替えで呼ぶ */
  forget(): Promise<void> {
    return forgetDevice(this.#env);
  }
}

export const pushDevice = new PushDevice();

/**
 * Service Worker が動くのを待つ（navigator.serviceWorker.ready）。取り込みが終わらない（redundant で
 * 終わった、手元の dev サーバー）と返らないので、10 秒の上限を置く。登録できなかったか、取り込みが
 * redundant で終わったと分かれば、上限を待たずに unsupported を返す
 */
function serviceWorkerReady(): Promise<ServiceWorkerReadiness> {
  const container = navigator.serviceWorker;
  if (container === undefined) return Promise.resolve("unsupported");
  return new Promise((resolve) => {
    const timer = setTimeout(() => resolve("timeout"), READY_TIMEOUT_MS);
    const settle = (readiness: ServiceWorkerReadiness) => {
      clearTimeout(timer);
      resolve(readiness);
    };
    void container.ready.then(() => settle("ready"));
    serviceWorkerRegistering()?.then(
      (registration) => {
        if (registration.active !== null) return;
        const worker = registration.installing ?? registration.waiting;
        if (worker === null) return;
        const check = () => {
          if (worker.state === "redundant" && registration.active === null) settle("unsupported");
        };
        worker.addEventListener("statechange", check);
        check();
      },
      () => settle("unsupported"),
    );
  });
}
