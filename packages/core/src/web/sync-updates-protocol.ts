export const SYNC_UPDATES_PROTOCOL_PREFIX = "sendo-sync.";

/** Upgrade を中継する reader が、同期済みのユーザーと照合するための値。 */
export function syncUpdatesProtocol(userId: string): string {
  const bytes = new TextEncoder().encode(userId);
  const encoded = btoa(String.fromCharCode(...bytes))
    .replaceAll("+", "-")
    .replaceAll("/", "_")
    .replace(/=+$/, "");
  return `${SYNC_UPDATES_PROTOCOL_PREFIX}${encoded}`;
}
