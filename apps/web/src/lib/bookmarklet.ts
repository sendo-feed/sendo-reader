import { normalizeSavedUrl } from "@sendo-reader/core";

export const CAPTURE_PATH = "/add";
const CAPTURE_STORAGE_KEY = "sendo.bookmarkletCapture";
const CAPTURE_PARAM = "capture";

function capturePath(marker: string): string {
  return `${CAPTURE_PATH}?${new URLSearchParams({ [CAPTURE_PARAM]: marker })}`;
}

function storedCapture(): { marker: string; url: string } | null {
  let value: string | null;
  try {
    value = sessionStorage.getItem(CAPTURE_STORAGE_KEY);
  } catch {
    return null;
  }
  if (value === null) return null;
  const split = value.indexOf("\n");
  if (split < 1) return null;
  const marker = value.slice(0, split);
  const url = normalizeSavedUrl(value.slice(split + 1));
  return url === null ? null : { marker, url };
}

export function bookmarkletFor(origin: string): string {
  const target = JSON.stringify(new URL(CAPTURE_PATH, origin).href);
  return `javascript:(()=>{location.assign(${target}+"#url="+encodeURIComponent(location.href))})()`;
}

function urlInFragment(url: URL): string | null {
  const value = new URLSearchParams(url.hash.slice(1)).get("url");
  return value === null ? null : normalizeSavedUrl(value);
}

/** ログインには短い印だけを渡し、長い URL やクエリは同じタブに残す。 */
export function bookmarkletReturnTo(url: URL): string | null {
  if (url.pathname !== CAPTURE_PATH) {
    clearCapturedPage();
    return null;
  }
  const captured = urlInFragment(url);
  if (captured === null) return null;
  const marker = crypto.randomUUID();
  sessionStorage.setItem(CAPTURE_STORAGE_KEY, `${marker}\n${captured}`);
  return capturePath(marker);
}

/** Google が失敗時に / に戻しても、同じタブで始めた追加に戻る。 */
export function bookmarkletLoginRetryPath(): string | null {
  const capture = storedCapture();
  return capture === null ? null : capturePath(capture.marker);
}

export function capturedPageUrl(url: URL): string | null {
  const fromFragment = urlInFragment(url);
  if (fromFragment !== null) return fromFragment;
  const marker = url.searchParams.get(CAPTURE_PARAM);
  if (marker === null) return null;
  const capture = storedCapture();
  return capture?.marker === marker ? capture.url : null;
}

export function clearCapturedPage(): void {
  try {
    sessionStorage.removeItem(CAPTURE_STORAGE_KEY);
  } catch {
    // セッションストレージを使えないブラウザーでも、開いている画面の操作は続ける。
  }
}
