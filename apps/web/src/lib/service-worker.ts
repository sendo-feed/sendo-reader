import { trustedScriptUrl } from "./trusted";

let registering: Promise<ServiceWorkerRegistration> | null = null;

/**
 * Service Worker（sw.js）を登録する。何度呼んでも、登録は 1 度だけ。Trusted Types のポリシーを通す
 * （lib/trusted.ts）。手元の dev サーバーでは呼ばない（main.ts）
 */
export function registerServiceWorker(
  container: ServiceWorkerContainer,
): Promise<ServiceWorkerRegistration> {
  registering ??= container.register(trustedScriptUrl("/sw.js"), { scope: "/" });
  return registering;
}

/** 登録を始めていれば、その結果。始めていなければ（手元の dev サーバー）null */
export function serviceWorkerRegistering(): Promise<ServiceWorkerRegistration> | null {
  return registering;
}
