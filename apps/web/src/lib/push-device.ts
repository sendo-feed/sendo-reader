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
  type TurnOffResult,
  type TurnOnResult,
  turnOff,
  turnOn,
  waitForServiceWorker,
} from "./push";
import { serviceWorkerRegistering } from "./service-worker";

/** 登録を作る、送り直す、外すを、タブどうしで 1 つずつにするロック（docs/decisions/notifications.md の 3） */
const PUSH_LOCK = "sendo-reader:push";

/**
 * この端末で通知を受ける操作の、ブラウザーの本物（lib/push.ts の PushEnvironment）。main.ts が
 * connect で、手元のユーザーと、セッションのユーザーが違ったときの扱いと、バッジの書き直し方と、
 * 解除待ちの印の読み書きを渡す
 */
class PushDevice {
  #user: () => User | null = () => null;
  #onAccountChanged: () => void = () => {};
  #refreshBadge: () => void = () => {};
  // つなぐ前は、印を読めないとする（送り直さず、登録も作らない）
  #unsubscribePending: () => Promise<boolean> = () => Promise.reject(new Error("つないでいない"));
  #clearUnsubscribePending: () => Promise<void> = () => Promise.reject(new Error("つないでいない"));

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
    unsubscribePending: () => this.#unsubscribePending(),
    clearUnsubscribePending: () => this.#clearUnsubscribePending(),
  };

  connect(options: {
    /** 手元のユーザー */
    user: () => User | null;
    /** sendo のセッションが、手元のユーザーと違った（同期を頼んで、切り替えを任せる） */
    onAccountChanged: () => void;
    /** アプリのバッジを、手元の DB の未読の数で書き直す（lib/app-badge.ts） */
    refreshBadge: () => void;
    /** 解除待ちの印があるか（手元の DB。docs/decisions/notifications.md の 4） */
    unsubscribePending: () => Promise<boolean>;
    /** 解除待ちの印を消す */
    clearUnsubscribePending: () => Promise<void>;
  }): void {
    this.#user = options.user;
    this.#onAccountChanged = options.onAccountChanged;
    this.#refreshBadge = options.refreshBadge;
    this.#unsubscribePending = options.unsubscribePending;
    this.#clearUnsubscribePending = options.clearUnsubscribePending;
  }

  check(): Promise<DeviceState> {
    return checkDevice(this.#env);
  }

  /** Turn on notifications を押したときに、待ちを挟まずに呼ぶ */
  turnOn(publicKey: string): Promise<TurnOnResult> {
    return turnOn(this.#env, publicKey);
  }

  turnOff(): Promise<TurnOffResult> {
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

/** Service Worker が動くのを待つ（lib/push.ts の waitForServiceWorker） */
function serviceWorkerReady(): Promise<ServiceWorkerReadiness> {
  const container = navigator.serviceWorker;
  if (container === undefined) return Promise.resolve("unsupported");
  return waitForServiceWorker(container.ready, serviceWorkerRegistering());
}
