import type { Database } from "../db/database";
import type { Table } from "../models";
import { ReaderCore } from "../reader";
import { SyncScheduler, type SyncStatus } from "../sync/scheduler";
import { openWebDatabase } from "./database";
import {
  isMethod,
  type Method,
  type PeerMessage,
  READER_METHODS,
  type ReaderMethod,
  type Result,
  SYNC_NOW_METHODS,
  serializeError,
  type TabMessage,
  type WorkerMessage,
  WRITE_METHODS,
} from "./protocol";

export interface ReaderWorkerOptions {
  /** DB の名前、代表を決めるロックの名前、タブの間のチャンネルの名前の元。既定は "sendo-reader" */
  namespace?: string;
  /** sendo の API の入口。既定は同じオリジンの "/api/v1" */
  baseUrl?: string;
  fetch?: typeof fetch;
  /** DB を開く（テストで差し替える） */
  openDatabase?: (name: string) => Promise<Database>;
}

/** 代表として受けた呼び出しを覚えておく数 */
const MAX_HANDLED = 1000;

/** タブがしばらく前に出ていなかったら、前に出たときに同期する（ミリ秒） */
const VISIBLE_SYNC_AFTER_MS = 30_000;

/**
 * タブごとの Dedicated Worker の中で動かす（docs/decisions/local-first.md）。
 *
 * Web Locks で代表を 1 つ決め、代表のワーカーだけが DB を開いて同期を回す。ほかのワーカーは、
 * タブからの呼び出しを BroadcastChannel で代表に渡す。代表のタブが閉じたら、待っていたワーカー
 * が代表を引き継ぎ、渡したまま答えの来ていない呼び出しを、新しい代表に送り直す（呼び出しは
 * どれも冪等にしてある）。
 */
export function runReaderWorker(options: ReaderWorkerOptions = {}): void {
  const namespace = options.namespace ?? "sendo-reader";
  const scope = globalThis as unknown as DedicatedWorkerGlobalScope;
  const workerId = crypto.randomUUID();
  const peers = new BroadcastChannel(`${namespace}:peers`);

  let leader: { core: ReaderCore; scheduler: SyncScheduler } | null = null;
  /** 今の代表（自分が代表でないとき） */
  let currentLeader: string | null = null;
  /** 代表に渡して、まだ答えの来ていない呼び出し */
  const forwarded = new Map<number, Extract<TabMessage, { type: "call" }>>();
  /**
   * 代表として受けた呼び出し（同じ呼び出しを二重に動かさない）。タブは代表が替わったと思うと
   * 送り直すので、答えたあとにも同じ呼び出しが届きうる。古いものから捨てる
   */
  const handled = new Set<string>();

  const toTab = (message: WorkerMessage) => scope.postMessage(message);
  const toPeers = (message: PeerMessage) => peers.postMessage(message);

  scope.addEventListener("message", (event: MessageEvent<TabMessage>) => {
    const message = event.data;
    if (message.type === "call") {
      if (!isMethod(message.method)) {
        toTab({
          type: "result",
          id: message.id,
          result: { ok: false, error: { name: "Error", message: "unknown method" } },
        });
        return;
      }
      if (leader !== null) {
        void dispatch(leader, message.method, message.args).then((result) =>
          toTab({ type: "result", id: message.id, result }),
        );
      } else {
        forwarded.set(message.id, message);
        toPeers({ ...message, from: workerId });
      }
    } else if (message.type === "visible") {
      if (leader !== null) onVisible(leader);
      else toPeers({ type: "visible" });
    }
  });

  peers.addEventListener("message", (event: MessageEvent<PeerMessage>) => {
    const message = event.data;
    switch (message.type) {
      case "call": {
        if (leader === null || !isMethod(message.method)) return;
        const key = `${message.from}:${message.id}`;
        if (handled.has(key)) return;
        handled.add(key);
        if (handled.size > MAX_HANDLED) {
          const oldest = handled.values().next().value;
          if (oldest !== undefined) handled.delete(oldest);
        }
        void dispatch(leader, message.method, message.args).then((result) =>
          toPeers({ type: "result", to: message.from, id: message.id, result }),
        );
        return;
      }
      case "result":
        if (message.to !== workerId || !forwarded.delete(message.id)) return;
        toTab({ type: "result", id: message.id, result: message.result });
        return;
      case "changed":
        if (leader === null) toTab(message);
        return;
      case "status":
        if (leader === null) toTab(message);
        return;
      case "leader":
        // 代表が替わったときだけ、答えの来ていない呼び出しを新しい代表に送り直す
        // （同じ代表が名乗り直しただけなら、すでに受けているので送らない）
        if (leader === null && message.leaderId !== currentLeader) {
          currentLeader = message.leaderId;
          for (const call of forwarded.values()) toPeers({ ...call, from: workerId });
        }
        return;
      case "hello":
        if (leader !== null) {
          toPeers({ type: "leader", leaderId: workerId });
          toPeers({ type: "status", status: leader.scheduler.status });
        }
        return;
      case "visible":
        if (leader !== null) onVisible(leader);
        return;
    }
  });

  // オンラインに戻ったら、すぐ同期する
  scope.addEventListener("online", () => leader?.scheduler.requestNow());

  toPeers({ type: "hello", from: workerId });

  // 代表になれるまで待つ。なったら、ワーカーが終わるまでロックを持ち続ける
  void navigator.locks.request(`${namespace}:leader`, async () => {
    leader = await becomeLeader();
    await new Promise(() => {});
  });

  async function becomeLeader() {
    const db = await (options.openDatabase ?? openWebDatabase)(namespace);
    const core = await ReaderCore.open({
      db,
      baseUrl: options.baseUrl ?? "/api/v1",
      ...(options.fetch === undefined ? {} : { fetch: options.fetch }),
    });
    const scheduler = new SyncScheduler(core, {
      onStatus: (status: SyncStatus) => {
        toTab({ type: "status", status });
        toPeers({ type: "status", status });
      },
    });
    core.onChange((tables) => {
      const changed: Table[] = [...tables];
      toTab({ type: "changed", tables: changed });
      toPeers({ type: "changed", tables: changed });
    });
    const current = { core, scheduler };

    // 代表を待っている間に自分のタブから頼まれた呼び出しは、ここで受ける
    for (const call of forwarded.values()) {
      void dispatch(current, call.method, call.args).then((result) =>
        toTab({ type: "result", id: call.id, result }),
      );
    }
    forwarded.clear();
    toPeers({ type: "leader", leaderId: workerId });
    toTab({ type: "status", status: scheduler.status });
    scheduler.requestNow();
    return current;
  }
}

function onVisible(leader: { scheduler: SyncScheduler }): void {
  const { lastSyncedAt } = leader.scheduler.status;
  if (lastSyncedAt === null || Date.now() - lastSyncedAt > VISIBLE_SYNC_AFTER_MS) {
    leader.scheduler.requestNow();
  }
}

async function dispatch(
  leader: { core: ReaderCore; scheduler: SyncScheduler },
  method: Method,
  args: unknown[],
): Promise<Result> {
  try {
    let value: unknown;
    if (method === "syncNow") {
      await leader.scheduler.syncNow();
      value = leader.scheduler.status;
    } else if (method === "status") {
      value = leader.scheduler.status;
    } else {
      value = await callCore(leader.core, method, args);
      if (WRITE_METHODS.has(method)) leader.scheduler.requestSoon();
      if (SYNC_NOW_METHODS.has(method)) leader.scheduler.requestNow();
    }
    return { ok: true, value };
  } catch (error) {
    return { ok: false, error: serializeError(error) };
  }
}

function callCore(core: ReaderCore, method: ReaderMethod, args: unknown[]): Promise<unknown> {
  if (!(READER_METHODS as readonly string[]).includes(method)) {
    return Promise.reject(new Error(`呼べないメソッド：${method}`));
  }
  const fn = core[method] as (...args: unknown[]) => unknown;
  return Promise.resolve(fn.apply(core, args));
}
