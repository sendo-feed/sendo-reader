import { ApiError } from "@sendo-reader/core";

/** 失敗を、画面に出す文にする */
export function describeError(error: unknown): string {
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
        return "トークンが使えなくなりました。ログインし直してください。";
      case "server":
        return "sendo でうまくいきませんでした。少し待ってからやり直してください。";
      default:
        return error.message;
    }
  }
  if (error instanceof RangeError) return "名前を入れてください。";
  return "うまくいきませんでした。";
}
