import { ApiError, type PushRegistration, type PushStatus } from "@sendo-reader/core";
import { AccountChangedError } from "./account";

/**
 * この端末で通知を受ける（Web Push の登録。docs/decisions/notifications.md の 1〜4）。
 *
 * 受けているかは、ブラウザーの登録（pushManager.getSubscription()）があり、許可が granted かで決める。
 * 手元の DB にも sendo にも、受けるかの印を持たない。登録を作る、送り直す、外すは、タブどうしで同じ
 * ロックを取って 1 つずつにし、ロックの中で登録を読み直してから決める。許可を求めるのはロックの外。
 *
 * 使うものだけを、形で受ける（テストでは、にせものを渡す。本物は push-device.ts）。
 */

/**
 * この端末とブラウザーで受けられるか。
 * - ios-home-screen：iPhone と iPad の Safari で、ホーム画面のアプリとして開いていない
 * - unsupported：通知、Service Worker、PushManager のどれかがない
 */
export type BrowserSupport = "ios-home-screen" | "unsupported" | "supported";

/**
 * iPhone と iPad の Safari は、ホーム画面のアプリでないと Notification も PushManager もない。
 * navigator.standalone が false で、かつ PushManager がない（2 つがそろう）ときだけ、ホーム画面に
 * 追加すれば受けられると見分ける。使えないブラウザーより先に見分ける
 */
export function browserSupport(globals: {
  standalone: boolean | undefined;
  notification: boolean;
  serviceWorker: boolean;
  pushManager: boolean;
}): BrowserSupport {
  if (globals.standalone === false && !globals.pushManager) return "ios-home-screen";
  if (!globals.notification || !globals.serviceWorker || !globals.pushManager) return "unsupported";
  return "supported";
}

export interface PushSubscriptionLike {
  readonly options: { readonly applicationServerKey: ArrayBuffer | null };
  toJSON(): PushSubscriptionJSON;
  unsubscribe(): Promise<boolean>;
}

export interface ServiceWorkerRegistrationLike {
  readonly pushManager: {
    getSubscription(): Promise<PushSubscriptionLike | null>;
    subscribe(options: {
      userVisibleOnly: boolean;
      applicationServerKey: Uint8Array<ArrayBuffer>;
    }): Promise<PushSubscriptionLike>;
  };
  getNotifications(): Promise<{ close(): void }[]>;
}

/** Service Worker が動いているか。timeout は上限（10 秒）までに分からなかった */
export type ServiceWorkerReadiness = "ready" | "timeout" | "unsupported";

/** Service Worker の ready を待つ上限（docs/decisions/notifications.md の 1） */
const READY_TIMEOUT_MS = 10_000;

/** Service Worker の登録のうち、取り込みが redundant で終わったかを見るところ */
export interface ServiceWorkerInstallLike {
  readonly active: object | null;
  readonly installing: ServiceWorkerStateLike | null;
  readonly waiting: ServiceWorkerStateLike | null;
}

export interface ServiceWorkerStateLike {
  readonly state: ServiceWorkerState;
  addEventListener(type: "statechange", listener: () => void): void;
}

/**
 * Service Worker が動くのを待つ。ready は navigator.serviceWorker.ready、registering は登録の結果
 * （登録を始めていない手元の dev サーバーでは null）。取り込みが終わらない（redundant で終わった、
 * 手元の dev サーバー）と ready が返らないので、10 秒の上限を置く。登録できなかったか、動いている版が
 * ないまま取り込みが redundant で終わったと分かれば、上限を待たずに unsupported を返す
 */
export function waitForServiceWorker(
  ready: Promise<unknown>,
  registering: Promise<ServiceWorkerInstallLike> | null,
): Promise<ServiceWorkerReadiness> {
  return new Promise((resolve) => {
    const timer = setTimeout(() => resolve("timeout"), READY_TIMEOUT_MS);
    const settle = (readiness: ServiceWorkerReadiness) => {
      clearTimeout(timer);
      resolve(readiness);
    };
    void ready.then(() => settle("ready"));
    registering?.then(
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

export interface PushEnvironment {
  readonly support: BrowserSupport;
  permission(): NotificationPermission;
  requestPermission(): Promise<NotificationPermission>;
  /** Service Worker が動くのを待つ。登録できなかった、取り込みが redundant で終わったら unsupported */
  ready(): Promise<ServiceWorkerReadiness>;
  /** 今の Service Worker の登録（待たない）。なければ null */
  registration(): Promise<ServiceWorkerRegistrationLike | null>;
  /** タブどうしで 1 つずつにする（navigator.locks） */
  lock<T>(task: () => Promise<T>): Promise<T>;
  sendo: {
    getPush(): Promise<PushStatus>;
    putRegistration(registration: PushRegistration): Promise<void>;
    deleteRegistration(): Promise<void>;
    /** セッションのユーザーが手元のユーザーと同じかを確かめる。違えば AccountChangedError */
    confirmUser(): Promise<void>;
  };
  /** アプリのバッジを、手元の DB の未読の数で書き直す（docs/decisions/notifications.md の 11） */
  refreshBadge(): void;
  /** 覚えた通知の tag を消す（docs/decisions/notifications.md の 8） */
  clearShownTags(): Promise<void>;
}

/**
 * Settings に出す、この端末の様子（docs/decisions/notifications.md の 2）。
 * - unavailable：Web Push を使えない Sendo。subscribed なら、外す操作を出す
 * - unreachable：Sendo に届かないか、Service Worker の ready が上限までに返らない（Retry を出す）
 * - unauthorized：セッションが切れた（ログインし直すよう促す）
 * - denied：拒まれた。端末やサイトの設定で許可すれば、publicKey で登録を作れる
 * - off：受けていない。publicKey で登録を作れる
 */
export type DeviceState =
  | { kind: "ios-home-screen" }
  | { kind: "unsupported" }
  | { kind: "unavailable"; subscribed: boolean }
  | { kind: "unreachable" }
  | { kind: "unauthorized"; error: ApiError }
  | { kind: "denied"; publicKey: string }
  | { kind: "off"; publicKey: string }
  | { kind: "on" };

type ServiceState =
  | { kind: "available"; publicKey: string }
  | { kind: "unavailable" }
  | { kind: "unreachable" }
  | { kind: "unauthorized"; error: ApiError };

/**
 * GET /api/v1/push の結果で分ける（docs/decisions/notifications.md の 1）。available が false と 404 は
 * 使えない Sendo、401 はログインし直す、そのほか（届かない、時間切れ、5xx、形の読めない応答）は
 * 使えるかが分からない
 */
async function checkService(env: PushEnvironment): Promise<ServiceState> {
  try {
    const status = await env.sendo.getPush();
    return status.available
      ? { kind: "available", publicKey: status.publicKey }
      : { kind: "unavailable" };
  } catch (error) {
    return error instanceof ApiError && error.kind === "unauthorized"
      ? { kind: "unauthorized", error }
      : { kind: "unreachable" };
  }
}

async function currentSubscription(env: PushEnvironment): Promise<PushSubscriptionLike | null> {
  const registration = await env.registration().catch(() => null);
  return (await registration?.pushManager.getSubscription().catch(() => null)) ?? null;
}

/** この端末を確かめる（Settings を開いたとき、前に出たとき、ベルを付けたとき） */
export async function checkDevice(env: PushEnvironment): Promise<DeviceState> {
  const started = Date.now();
  if (env.support === "ios-home-screen") {
    // ホーム画面に追加する案内も、Web Push を使える Sendo でだけ出す
    const service = await checkService(env);
    if (service.kind === "available") return { kind: "ios-home-screen" };
    return service.kind === "unavailable" ? { kind: "unavailable", subscribed: false } : service;
  }
  if (env.support === "unsupported") return { kind: "unsupported" };
  const [service, readiness] = await Promise.all([checkService(env), env.ready()]);
  if (readiness === "unsupported") return { kind: "unsupported" };
  if (service.kind === "unauthorized" || service.kind === "unreachable") return service;
  if (service.kind === "available" && readiness === "timeout") return { kind: "unreachable" };
  // 登録はロックの中で読む（ほかのタブが作り直している途中の、外したところを見ない）。ほかのタブが
  // ロックを持ったままのこともある（Safari は bfcache に入ったページのロックを残すことがある）ので、
  // ready と合わせた上限までに読めなければ、確かめられないとする
  let subscribed = false;
  if (env.permission() === "granted") {
    const read = await beforeDeadline(
      env.lock(() => currentSubscription(env)),
      READY_TIMEOUT_MS - (Date.now() - started),
    );
    if (read === "timeout") return { kind: "unreachable" };
    subscribed = read !== null;
  }
  if (service.kind === "unavailable") return { kind: "unavailable", subscribed };
  if (env.permission() === "denied") return { kind: "denied", publicKey: service.publicKey };
  return subscribed ? { kind: "on" } : { kind: "off", publicKey: service.publicKey };
}

/** task が ms までに終わらなければ timeout を返す（task は止めない） */
function beforeDeadline<T>(task: Promise<T>, ms: number): Promise<T | "timeout"> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => resolve("timeout"), Math.max(ms, 0));
    task.then(
      (value) => {
        clearTimeout(timer);
        resolve(value);
      },
      (error: unknown) => {
        clearTimeout(timer);
        reject(error);
      },
    );
  });
}

/** iPhone と iPad の Safari で、ホーム画面に追加していないときの案内（docs/decisions/notifications.md の 2） */
export const IOS_HOME_SCREEN_GUIDE =
  "通知は、ホーム画面に追加したアプリでだけ受けられます。共有のボタンから「ホーム画面に追加」を選び、追加したアプリで開いてから Turn on notifications を押してください。";

/** ベルを付けたときの勧め（docs/decisions/notifications.md の 1）。勧めないなら null */
export type Suggestion = { kind: "turn-on"; publicKey: string } | { kind: "ios-home-screen" };

export function suggestionFor(state: DeviceState): Suggestion | null {
  if (state.kind === "off") return { kind: "turn-on", publicKey: state.publicKey };
  if (state.kind === "ios-home-screen") return state;
  return null;
}

/**
 * Turn on notifications を押した結果。dismissed は許可の窓を決めずに閉じた（何も出さずに戻す）、
 * subscribe-failed はブラウザーが登録を断った、send-failed は sendo に送れなかった（作った登録は外した）
 */
export type TurnOnResult =
  | { kind: "on" }
  | { kind: "dismissed" }
  | { kind: "denied" }
  | { kind: "subscribe-failed" }
  | { kind: "send-failed"; error: unknown };

/**
 * Turn on notifications を押したときに呼ぶ。利用者の操作のすぐあとでないと許可の窓を出さない
 * ブラウザーがあるので、待ちを挟まずに許可を求める（ロックの外。許可してあれば窓は出ない）。
 * 許可を求めるのに失敗したら、受けられなかったと返す。許可されたら、ロックの中で登録を読み直して
 * から、作って送る
 */
export async function turnOn(env: PushEnvironment, publicKey: string): Promise<TurnOnResult> {
  let permission: NotificationPermission;
  try {
    permission = await env.requestPermission();
  } catch {
    return { kind: "subscribe-failed" };
  }
  if (permission === "default") return { kind: "dismissed" };
  if (permission === "denied") return { kind: "denied" };
  // 許可したら、手元の数が変わっていなくても書き直す（iOS では、許可の前に書けなかった）
  env.refreshBadge();
  return env.lock(async (): Promise<TurnOnResult> => {
    const registration = await env.registration().catch(() => null);
    if (registration === null) return { kind: "subscribe-failed" };
    const { pushManager } = registration;
    let subscription = await pushManager.getSubscription().catch(() => null);
    if (subscription !== null && !usesKey(subscription, publicKey)) {
      await subscription.unsubscribe().catch(() => false);
      subscription = null;
    }
    if (subscription === null) {
      try {
        subscription = await pushManager.subscribe({
          userVisibleOnly: true,
          applicationServerKey: decodeBase64Url(publicKey),
        });
      } catch {
        return { kind: "subscribe-failed" };
      }
    }
    try {
      await env.sendo.confirmUser();
      await env.sendo.putRegistration(toRegistration(subscription));
    } catch (error) {
      // 送れなかった登録は外す（Settings では受けているように見えるのに届かない、を作らない）
      await subscription.unsubscribe().catch(() => false);
      return { kind: "send-failed", error };
    }
    return { kind: "on" };
  });
}

/**
 * Turn off notifications（docs/decisions/notifications.md の 4）。sendo の登録を外し、sendo に届かなくても
 * ブラウザーの登録は外す
 */
export async function turnOff(env: PushEnvironment): Promise<void> {
  await env.lock(async () => {
    const subscription = await currentSubscription(env);
    try {
      await env.sendo.confirmUser();
      await env.sendo.deleteRegistration();
    } catch {
      // 外した登録に送ると、プッシュサービスが 404 か 410 を返し、sendo が消す
    }
    await subscription?.unsubscribe().catch(() => false);
  });
}

/**
 * 画面が起動したとき（タブごと）に、登録があれば送り直す（docs/decisions/notifications.md の 3）。
 * 許可が granted でなければ外す（GET /api/v1/push の結果によらない）。使える Sendo なら送り直し、
 * 公開鍵が登録の鍵と違えば作り直してから送る。失敗は画面に出さず、次の起動でまた送る
 */
export async function resendOnStartup(env: PushEnvironment): Promise<void> {
  if (env.support !== "supported") return;
  await env.lock(async () => {
    const registration = await env.registration().catch(() => null);
    let subscription =
      (await registration?.pushManager.getSubscription().catch(() => null)) ?? null;
    if (registration === null || subscription === null) return;
    if (env.permission() !== "granted") {
      await subscription.unsubscribe().catch(() => false);
      return;
    }
    let status: PushStatus;
    try {
      status = await env.sendo.getPush();
    } catch {
      return;
    }
    if (!status.available) return;
    if (!usesKey(subscription, status.publicKey)) {
      await subscription.unsubscribe().catch(() => false);
      try {
        subscription = await registration.pushManager.subscribe({
          userVisibleOnly: true,
          applicationServerKey: decodeBase64Url(status.publicKey),
        });
      } catch {
        // 利用者の操作のあとではないので、断られることがある。先に外したので、受けない状態になる
        return;
      }
    }
    try {
      await env.sendo.confirmUser();
    } catch (error) {
      // セッションが別のユーザーなら送らず、ユーザーが替わったときと同じく外す
      if (error instanceof AccountChangedError) await forgetLocked(env);
      return;
    }
    try {
      await env.sendo.putRegistration(toRegistration(subscription));
    } catch {
      // 次に起動したときにまた送る
    }
  });
}

/**
 * ログアウトとユーザーの切り替えで、この端末の登録を外す（docs/decisions/notifications.md の 4）。
 * unsubscribe() が終わってから、出ている通知を閉じ、覚えた tag を消し、バッジを書き直す。手元の DB を
 * 消したあとなので、ログアウトなら 0 件で消える。ユーザーの切り替えで次の人の記事がもう届いていれば、
 * その数を出す（消すと、次に記事の表が変わるまで、次の人の数が出ない）。unsubscribe() が投げても、
 * 閉じて消す。sendo の登録はセッションと一緒に消えるので、DELETE は送らない
 */
export async function forgetDevice(env: PushEnvironment): Promise<void> {
  await env.lock(() => forgetLocked(env));
}

async function forgetLocked(env: PushEnvironment): Promise<void> {
  const registration = await env.registration().catch(() => null);
  try {
    await (await registration?.pushManager.getSubscription())?.unsubscribe();
  } catch {
    // 外せなくても、通知と tag は消し、バッジは書き直す
  }
  try {
    for (const notification of (await registration?.getNotifications()) ?? []) {
      notification.close();
    }
  } catch {
    // 閉じられなくても続ける
  }
  await env.clearShownTags().catch(() => {});
  env.refreshBadge();
}

/** 登録が、この公開鍵で作ったものか（鍵が分からなければ、違うとみなす） */
function usesKey(subscription: PushSubscriptionLike, publicKey: string): boolean {
  const current = subscription.options.applicationServerKey;
  if (current === null) return false;
  let expected: Uint8Array;
  try {
    expected = decodeBase64Url(publicKey);
  } catch {
    return false;
  }
  const bytes = new Uint8Array(current);
  return bytes.length === expected.length && bytes.every((byte, i) => byte === expected[i]);
}

/** base64url（パディングなし）を、バイト列にする。読めなければ投げる */
export function decodeBase64Url(text: string): Uint8Array<ArrayBuffer> {
  const base64 = text.replace(/-/g, "+").replace(/_/g, "/");
  const binary = atob(base64.padEnd(base64.length + ((4 - (base64.length % 4)) % 4), "="));
  return Uint8Array.from(binary, (char) => char.charCodeAt(0));
}

/** 登録を、sendo に送る形（PushSubscription.toJSON() の形）にする。鍵がそろわなければ投げる */
function toRegistration(subscription: PushSubscriptionLike): PushRegistration {
  const { endpoint, keys } = subscription.toJSON();
  const p256dh = keys?.p256dh;
  const auth = keys?.auth;
  if (typeof endpoint !== "string" || typeof p256dh !== "string" || typeof auth !== "string") {
    throw new TypeError("ブラウザーの登録に、エンドポイントか鍵がない");
  }
  return { endpoint, keys: { p256dh, auth } };
}
