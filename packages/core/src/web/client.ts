import type { Table } from "../models";
import type { ReaderCore } from "../reader";
import { LOCAL_ID_PREFIX } from "../sync/ops";
import type { SyncStatus } from "../sync/scheduler";
import {
  deserializeError,
  type Method,
  READER_METHODS,
  type ReaderMethod,
  type TabMessage,
  type WorkerMessage,
} from "./protocol";

type Remote<T> = {
  [K in keyof T]: T[K] extends (...args: infer A) => infer R
    ? (...args: A) => Promise<Awaited<R>>
    : never;
};

/**
 * 画面から使う、sendo-reader の中核の窓口。中身は自分のタブのワーカーにあり、すべて Promise で返す。
 * 読み出しは手元の DB だけを読むので、ネットワークを待たない。
 */
export type ReaderClient = Remote<Pick<ReaderCore, ReaderMethod>> & {
  /** 今すぐ同期し、終わったときの様子を返す */
  syncNow(): Promise<SyncStatus>;
  /** 今の同期の様子 */
  status(): Promise<SyncStatus>;
  /** 手元の表が変わったら呼ぶ（どのタブで変えても届く）。やめるときは返した関数を呼ぶ */
  onChange(listener: (tables: ReadonlySet<Table>) => void): () => void;
  /** 同期の様子が変わったら呼ぶ */
  onStatus(listener: (status: SyncStatus) => void): () => void;
  /** タブが前に出たことを知らせる（しばらく同期していなければ同期する） */
  notifyVisible(): void;
};

/** 自分のタブのワーカー（runReaderWorker を動かすもの）につなぐ */
export function connectReader(worker: Worker): ReaderClient {
  let nextId = 1;
  const pending = new Map<
    number,
    { resolve: (value: unknown) => void; reject: (e: Error) => void }
  >();
  const changeListeners = new Set<(tables: ReadonlySet<Table>) => void>();
  const statusListeners = new Set<(status: SyncStatus) => void>();

  const post = (message: TabMessage) => worker.postMessage(message);

  worker.addEventListener("message", (event: MessageEvent<WorkerMessage>) => {
    const message = event.data;
    if (message.type === "result") {
      const waiter = pending.get(message.id);
      if (waiter === undefined) return;
      pending.delete(message.id);
      if (message.result.ok) waiter.resolve(message.result.value);
      else waiter.reject(deserializeError(message.result.error));
    } else if (message.type === "changed") {
      const tables = new Set(message.tables);
      for (const listener of changeListeners) listener(tables);
    } else if (message.type === "status") {
      for (const listener of statusListeners) listener(message.status);
    }
  });

  function call(method: Method, args: unknown[]): Promise<unknown> {
    const id = nextId++;
    return new Promise((resolve, reject) => {
      pending.set(id, { resolve, reject });
      post({ type: "call", id, method, args });
    });
  }

  const client: Record<string, unknown> = {};
  for (const method of READER_METHODS) {
    client[method] = (...args: unknown[]) => call(method, args);
  }
  // 代表が入れ替わると呼び出しを送り直すので、二重に作らないよう、仮の ID はこちらで決める
  client.createFolder = (name: string) =>
    call("createFolder", [name, `${LOCAL_ID_PREFIX}${crypto.randomUUID()}`]);
  client.syncNow = () => call("syncNow", []);
  client.status = () => call("status", []);
  client.onChange = (listener: (tables: ReadonlySet<Table>) => void) => {
    changeListeners.add(listener);
    return () => changeListeners.delete(listener);
  };
  client.onStatus = (listener: (status: SyncStatus) => void) => {
    statusListeners.add(listener);
    return () => statusListeners.delete(listener);
  };
  client.notifyVisible = () => post({ type: "visible" });
  return client as ReaderClient;
}
