import { ApiError, type SyncStatus } from "@sendo-reader/core";
import { AccountChangedError } from "./account";

/** 失敗を、画面に出す文にする */
export function describeError(error: unknown): string {
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

export function describeSavedPageError(error: SyncStatus["savedPageError"] | undefined): string {
  if (error === "limit")
    return "Sendo の保存上限に達しました。ページの保存を解除してからやり直してください。";
  if (error === "unsupported") return "接続先の Sendo はページの保存に対応していません。";
  return "保存ページの変更を同期できませんでした。";
}
