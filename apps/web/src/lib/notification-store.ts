/**
 * Service Worker が出した通知の tag を覚える場所（IndexedDB。docs/decisions/notifications.md の 8・10）。
 *
 * iPhone と iPad のホーム画面のアプリでは、裏で動いているときに押された通知が届かないので、画面が
 * 前に出たときに、覚えた tag のうち通知センターから消えたものを見分ける。Cache Storage は、Service
 * Worker の書き込みが画面から見えなかった（試作）ので、IndexedDB に置く。
 *
 * 覚えるのは tag（ベルと記事の ID）と覚えた時刻だけ。通知の中身（タイトルと本文）は入れない。
 * Service Worker（sw/sw.ts）と画面の両方が開くので、どの接続も versionchange を受けたら閉じる。
 * ブラウザーでも Service Worker でも動く（画面だけの API を使わない）。
 */

const DB_NAME = "sendo-reader-notifications";
const DB_VERSION = 1;
const STORE = "tags";

/** 覚えた tag と、覚えた時刻（ミリ秒） */
export interface ShownTag {
  tag: string;
  at: number;
}

function open(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open(DB_NAME, DB_VERSION);
    request.onupgradeneeded = () => {
      request.result.createObjectStore(STORE, { keyPath: "tag" });
    };
    request.onsuccess = () => {
      const db = request.result;
      db.onversionchange = () => db.close();
      resolve(db);
    };
    request.onerror = () => reject(request.error);
  });
}

/** 1 つのトランザクションで読み書きし、終わったら閉じる */
async function run<T>(
  mode: IDBTransactionMode,
  work: (store: IDBObjectStore) => IDBRequest<T> | undefined,
): Promise<T | undefined> {
  const db = await open();
  try {
    return await new Promise((resolve, reject) => {
      const transaction = db.transaction(STORE, mode);
      const request = work(transaction.objectStore(STORE));
      transaction.oncomplete = () => resolve(request?.result);
      transaction.onerror = () => reject(transaction.error);
      transaction.onabort = () => reject(transaction.error);
    });
  } finally {
    db.close();
  }
}

/** 出し終えた通知の tag を覚える */
export async function rememberTag(tag: string, at: number): Promise<void> {
  await run("readwrite", (store) => {
    store.put({ tag, at } satisfies ShownTag);
    return undefined;
  });
}

/** tag を覚えから外す（押した、利用者が消した、通知センターから消えた） */
export async function forgetTag(tag: string): Promise<void> {
  await run("readwrite", (store) => {
    store.delete(tag);
    return undefined;
  });
}

/** 覚えた tag をすべて読む（形の合わないものは捨てる） */
export async function listTags(): Promise<ShownTag[]> {
  const rows: unknown[] = (await run("readonly", (store) => store.getAll())) ?? [];
  return rows.filter(
    (row): row is ShownTag =>
      typeof row === "object" &&
      row !== null &&
      typeof (row as ShownTag).tag === "string" &&
      typeof (row as ShownTag).at === "number",
  );
}

/** 覚えた tag をすべて消す（ログアウトとユーザーの切り替え） */
export async function clearTags(): Promise<void> {
  await run("readwrite", (store) => {
    store.clear();
    return undefined;
  });
}
