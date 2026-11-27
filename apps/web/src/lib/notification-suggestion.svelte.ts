import { describePushSendError } from "./errors";
import { type Suggestion, suggestionFor } from "./push";
import { pushDevice } from "./push-device";

/**
 * ベルを付けたときに出す、この端末で通知を受ける勧め（docs/decisions/notifications.md の 1）。
 *
 * この端末で受けておらず、許可が拒否でなければ出す（iPhone と iPad の Safari でホーム画面に追加して
 * いなければ、追加の案内を出す）。使えるかを確かめ終えて、使えると分かってから出す。Dismiss で閉じたら、
 * 読み込み直すまで出さない（閉じた印は画面のメモリーにだけ持つ）
 */
class NotificationSuggestion {
  current = $state<Suggestion | null>(null);
  busy = $state(false);
  failure = $state<string | null>(null);
  #dismissed = false;
  #offers = 0;

  /** ベルを付けたときに呼ぶ（ベルを付ける操作そのものは待たせない） */
  async offer(): Promise<void> {
    if (this.#dismissed) return;
    const offer = ++this.#offers;
    const suggestion = suggestionFor(await pushDevice.check());
    if (this.#dismissed || offer !== this.#offers || this.busy) return;
    this.current = suggestion;
    this.failure = null;
  }

  /** Turn on notifications を押したときに、待ちを挟まずに呼ぶ */
  turnOn(publicKey: string): void {
    if (this.busy) return;
    const result = pushDevice.turnOn(publicKey);
    this.busy = true;
    this.failure = null;
    void result
      .then((outcome) => {
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
            // ほかのタブがロックを持ったまま、上限までに始められなかった。もう一度押せる
            this.failure = "通知を受ける準備ができませんでした。もう一度押してください。";
            break;
          case "dismissed":
            // 許可の窓を決めずに閉じたら、押す前に戻す
            break;
        }
      })
      .finally(() => {
        this.busy = false;
      });
  }

  dismiss(): void {
    this.#dismissed = true;
    this.current = null;
    this.failure = null;
  }
}

export const notificationSuggestion = new NotificationSuggestion();
