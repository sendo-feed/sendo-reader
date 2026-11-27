import { describePushSendError } from "./errors";
import { type DeviceState, type Suggestion, suggestionFor, type TurnOnResult } from "./push";
import { pushDevice } from "./push-device";

/** 勧めが使う、この端末の操作（本物は push-device.ts。テストでは、にせものを渡す） */
export interface SuggestionDevice {
  check(): Promise<DeviceState>;
  turnOn(publicKey: string): Promise<TurnOnResult>;
}

/**
 * ベルを付けたときに出す、この端末で通知を受ける勧め（docs/decisions/notifications.md の 1）。
 *
 * この端末で受けておらず、許可が拒否でなければ出す（iPhone と iPad の Safari でホーム画面に追加して
 * いなければ、追加の案内を出す）。使えるかを確かめ終えて、使えると分かってから出す。Dismiss で閉じたら、
 * 読み込み直すまで出さない（閉じた印は画面のメモリーにだけ持つ）。ログアウトとユーザーの切り替えで
 * 手元を消したら、前の人の勧めと閉じた印を残さない
 */
export class NotificationSuggestion {
  current = $state<Suggestion | null>(null);
  busy = $state(false);
  failure = $state<string | null>(null);
  readonly #device: SuggestionDevice;
  #dismissed = false;
  #offers = 0;
  /** 手元を消すたびに増やす。前の人のために押した Turn on の結果を、次の人に出さない */
  #generation = 0;

  constructor(device: SuggestionDevice) {
    this.#device = device;
  }

  /**
   * ベルを付けたときに呼ぶ（ベルを付ける操作そのものは待たせない）。wanted は、確かめ終えたときに
   * まだ勧めるか（付けたベルが、まだ付いているか）
   */
  async offer(wanted: () => boolean): Promise<void> {
    if (this.#dismissed) return;
    const offer = ++this.#offers;
    const suggestion = suggestionFor(await this.#device.check());
    if (this.#dismissed || offer !== this.#offers || this.busy || !wanted()) return;
    this.current = suggestion;
    this.failure = null;
  }

  /** Turn on notifications を押したときに、待ちを挟まずに呼ぶ */
  turnOn(publicKey: string): void {
    if (this.busy) return;
    const result = this.#device.turnOn(publicKey);
    const generation = this.#generation;
    this.busy = true;
    this.failure = null;
    void result
      .then((outcome) => {
        if (generation !== this.#generation) return;
        switch (outcome.kind) {
          case "on":
          case "denied":
            // 受け始めたか、拒んだ（拒んだあとの案内は Settings に出す）
            this.current = null;
            break;
          case "subscribe-failed":
            this.failure = "この端末では通知を受けられませんでした。";
            break;
          case "send-failed":
            this.failure = describePushSendError(outcome.error);
            break;
          case "unreachable":
            // ロックを上限までに取れなかったか、前の人の登録を外し終えられなかった。もう一度押せる
            this.failure = "通知を受ける準備ができませんでした。もう一度押してください。";
            break;
          case "dismissed":
            // 許可の窓を決めずに閉じたら、押す前に戻す
            break;
        }
      })
      .finally(() => {
        if (generation === this.#generation) this.busy = false;
      });
  }

  dismiss(): void {
    this.#dismissed = true;
    this.current = null;
    this.failure = null;
  }

  /**
   * ログアウトとユーザーの切り替えで、手元を消したときに呼ぶ（別のタブで起きても届く）。出している
   * 勧め、閉じた印、確かめている途中の勧め、押している途中の Turn on の結果を、次の人に残さない
   */
  reset(): void {
    this.#generation += 1;
    this.#offers += 1;
    this.#dismissed = false;
    this.current = null;
    this.failure = null;
    this.busy = false;
  }
}

export const notificationSuggestion = new NotificationSuggestion(pushDevice);
