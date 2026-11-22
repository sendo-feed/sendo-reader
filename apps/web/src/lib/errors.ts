import { ApiError, type SyncStatus } from "@sendo-reader/core";
import { ProtocolMismatchError } from "@sendo-reader/core/web";
import { AccountChangedError } from "./account";

export const DISCORD_UNAVAILABLE =
  "Sendo サーバーに Discord 連携の設定がないため、利用できません。";

export function describeDiscordError(error: unknown): string {
  if (error instanceof ApiError) {
    switch (error.code) {
      case "feature_unavailable":
        return DISCORD_UNAVAILABLE;
      case "invalid_channel_url":
        return "Discord のチャンネル URL（https://discord.com/channels/…）を入力してください。";
      case "channel_not_found":
        return "チャンネルを読めません。チャンネルが存在し、接続したアカウントと Bot の両方にチャンネルの閲覧とメッセージ履歴の読み取りが許可されているか確認してください。購読できるのは年齢制限のないテキスト・アナウンスチャンネルです。";
      case "discord_not_connected":
        return "Discord との接続がありません。Discord を接続してからやり直してください。";
      case "discord_unavailable":
        return "Discord が応答しませんでした。少し待ってからやり直してください。";
    }
  }
  return describeError(error);
}

/**
 * 版の違うタブと、やり取りの版の番号が合わない（docs/decisions/local-first.md の 5）。自分のほうが
 * 古ければ、自分を読み込み直せば直る。相手が番号を名乗らなければ（この決まりより前の版）、相手が古い
 */
export function isOlderThanPeer(error: ProtocolMismatchError): boolean {
  return error.peerVersion !== null && error.peerVersion > error.version;
}

/** 版の違うタブが開いているときの文。どちらのタブを読み込み直せばよいかを分けて書く */
export function describeVersionMismatch(error: ProtocolMismatchError): string {
  return isOlderThanPeer(error)
    ? "新しい版の画面が、ほかのタブで開いています。このタブを読み込み直してください。"
    : "古い版の画面が、ほかのタブで開いています。そのタブを読み込み直すか閉じると、このタブを使えます。";
}

/** 失敗を、画面に出す文にする */
export function describeError(error: unknown): string {
  if (error instanceof ProtocolMismatchError) return describeVersionMismatch(error);
  if (error instanceof AccountChangedError) {
    return "別のアカウントでログインしていたので、送りませんでした。そのアカウントに切り替えます。";
  }
  if (error instanceof ApiError) {
    switch (error.code) {
      case "url_not_allowed":
        return "この URL は使えません（http ／ https の、公開されている URL を入れてください）。";
      case "fetch_failed":
        return "その URL を取得できませんでした。";
      case "feed_not_found":
        return "フィードが見つかりませんでした。";
      case "invalid_opml":
        return "OPML として読めませんでした。";
      case "too_large":
        return "ファイルが大きすぎます。";
      case "folder_not_found":
        return "そのフォルダはもうありません。";
    }
    switch (error.kind) {
      case "network":
        return "sendo に届きません。通信を確かめてください。";
      case "unauthorized":
        return "ログインが切れました。ログインし直してください。";
      case "server":
        return "sendo でうまくいきませんでした。少し待ってからやり直してください。";
      default:
        return error.message;
    }
  }
  if (error instanceof RangeError) return "名前を入れてください。";
  return "うまくいきませんでした。";
}

/** その場の翻訳が sendo で訳せずに戻ったときの文（docs/decisions/translation.md の 6） */
export const TRANSLATION_FAILED = "訳せませんでした。Translate でもう一度頼めます。";

/** 訳し直しが sendo で訳せずに戻ったときの文（docs/decisions/translation.md の 6） */
export const RETRANSLATION_FAILED =
  "訳し直せませんでした。もとの訳文のままです。More actions の Retranslate with Opus でもう一度頼めます。";

/** その場の翻訳と訳し直しを頼めなかったときの文（docs/decisions/translation.md の 6） */
export function describeTranslationError(error: unknown): string {
  if (error instanceof ApiError) {
    switch (error.code) {
      case "translation_unavailable":
        return "この Sendo では翻訳を使えません（API キーが設定されていません）。";
      case "translation_not_supported":
        return "この記事は訳せません。";
      case "retranslation_not_allowed":
        return "この記事は、もう訳し直したか、訳し直しの最中か、訳し直せる訳文がありません。";
      case "translation_exists":
        // 訳し直しの指定に対応する前の sendo は、本文を読まずにその場の翻訳として断る
        return "この Sendo では訳し直しを使えません。Sendo を新しくすると使えます。";
      case "not_found":
        return "この記事は Sendo にもうありません。";
    }
  }
  return describeError(error);
}

export function describeSavedPageError(error: SyncStatus["savedPageError"] | undefined): string {
  if (error === "limit")
    return "Sendo の保存上限に達しました。ページの保存を解除してからやり直してください。";
  if (error === "unsupported") return "接続先の Sendo はページの保存に対応していません。";
  return "保存ページの変更を同期できませんでした。";
}
