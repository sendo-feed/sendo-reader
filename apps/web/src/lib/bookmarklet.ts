import { normalizeSavedUrl } from "@sendo-reader/core";

export const CAPTURE_PATH = "/add";
const CAPTURE_STORAGE_KEY = "sendo.bookmarkletCapture";
const CAPTURE_PARAM = "capture";

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
  if (url.pathname !== CAPTURE_PATH) return null;
  const captured = urlInFragment(url);
  if (captured === null) return null;
  const marker = crypto.randomUUID();
  sessionStorage.setItem(CAPTURE_STORAGE_KEY, `${marker}\n${captured}`);
  return `${CAPTURE_PATH}?${new URLSearchParams({ [CAPTURE_PARAM]: marker })}`;
}

export function capturedPageUrl(url: URL): string | null {
  const fromFragment = urlInFragment(url);
  if (fromFragment !== null) return fromFragment;
  const marker = url.searchParams.get(CAPTURE_PARAM);
  if (marker === null) return null;
  const stored = sessionStorage.getItem(CAPTURE_STORAGE_KEY);
  return stored?.startsWith(`${marker}\n`) === true
    ? normalizeSavedUrl(stored.slice(marker.length + 1))
    : null;
}

export function clearCapturedPage(): void {
  sessionStorage.removeItem(CAPTURE_STORAGE_KEY);
}
