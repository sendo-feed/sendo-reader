import { ApiError } from "../api/errors";
import type { Database } from "../db/database";
import { TABLES, type Table } from "../models";
import { DEFAULT_PREFETCH_CONTENTS, ReaderCore } from "../reader";
import { SyncScheduler, type SyncStatus } from "../sync/scheduler";
import { SyncUpdates, syncUpdatesUrl, type WebSocketLike } from "../sync/updates";
import { openWebDatabase } from "./database";
import { clearImageCache } from "./image-cache";
import {
  DEFAULT_NAMESPACE,
  isMethod,
  leaderLockName,
  type Method,
  type PeerMessage,
  PROTOCOL_VERSION,
  ProtocolMismatchError,
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
  /**
   * sendo の通知（WebSocket）につなぐ。既定はブラウザの WebSocket。null なら通知を使わず、
   * 定期同期だけで動く（テストで使う）
   */
  webSocket?: ((url: string) => WebSocketLike) | null;
  /** ワーカーどうしのやり取りの版の番号。既定は PROTOCOL_VERSION（テストで、版の違うタブを作る） */
  protocolVersion?: number;
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
 *
 * 版の違うタブが混ざることがあるので、ワーカーどうしのやり取りには版の番号を付ける
 * （docs/decisions/local-first.md の 5）。代表の番号を知るまで頼まず、合わなければ頼まずに
 * ProtocolMismatchError で返す。代表も、番号の合わない頼みは処理せずに同じ失敗を返す。
 */
export function runReaderWorker(options: ReaderWorkerOptions = {}): void {
  const namespace = options.namespace ?? DEFAULT_NAMESPACE;
  // DedicatedWorkerGlobalScope の型は、画面（DOM）の型で調べると見えないので、使う形だけを書く
  const scope = globalThis as unknown as {
    postMessage(message: WorkerMessage): void;
    addEventListener(type: "message", listener: (event: MessageEvent<TabMessage>) => void): void;
    addEventListener(type: "online", listener: () => void): void;
  };
  const workerId = crypto.randomUUID();
  const version = options.protocolVersion ?? PROTOCOL_VERSION;
  const peers = new BroadcastChannel(`${namespace}:peers`);

  let leader: { core: ReaderCore; scheduler: SyncScheduler; updates: SyncUpdates | null } | null =
    null;
  /** 代表になるロックを頼んでいる（待っている、DB を開いている、または代表である） */
  let seeking = false;
  /** 開いた（開いている途中の）DB */
  let opened: Promise<Database> | null = null;
  /**
   * 今の代表（自分が代表でないとき）と、その番号（名乗らなければ null）。分かるまでは null で、
   * 自分のタブからの呼び出しを送らずに待たせる
   */
  let currentLeader: { id: string; version: number | null } | null = null;
  /**
   * 番号の合わない代表を知ってから、まだ番号の合う代表に替わっていない。その間の知らせは画面に
   * 渡さず、失敗を返した頼みも前の代表が書き込んでいたかもしれないので、番号の合う代表に替わったら
   * （自分が代表になったときも）、すべての表を読み直させる。番号の合う代表どうしの交代では、頼みを
   * 送り直すだけにする（読み込み直すたびに、すべての表を読み直させない）
   */
  let afterMismatch = false;
  /**
   * 代表のロックを取った（DB を開いている途中か、代表である）。ほかの代表はいないので、
   * 名乗りは受けず、自分のタブからの呼び出しは、代表になるまで溜める
   */
  let locked = false;
  /** 代表に渡して（番号を知るまでは、渡すのを待って）、まだ答えの来ていない呼び出し */
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
        if (!locked && currentLeader !== null && currentLeader.version !== version) {
          // 番号の合わない代表には頼まない（処理されると、形の違う頼みで誤って動きうる）
          toTab({ type: "result", id: message.id, result: mismatch(currentLeader.version) });
        } else {
          forwarded.set(message.id, message);
          // 代表の番号を知るまでは送らない（名乗ったときに送る）。ロックを取ったあとは、
          // 代表になったときに受ける
          if (!locked && currentLeader !== null) forward(message);
        }
        // 前に代表になれなかったら、もう一度なろうとする（ほかのタブが代表なら、その代表が
        // 答え、こちらはロックを待つだけ）
        seekLeadership();
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
        if (leader === null) return;
        // 番号の違う頼みと、番号のない頼み（この決まりより前の版のタブ）は処理しない。
        // 相手から見た相手（代表）の番号を返す
        if (message.version !== version) {
          toPeers({ type: "result", to: message.from, id: message.id, result: mismatch(version) });
          return;
        }
        if (!isMethod(message.method)) {
          const error = { name: "Error", message: "unknown method" };
          toPeers({
            type: "result",
            to: message.from,
            id: message.id,
            result: { ok: false, error },
          });
          return;
        }
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
      // 番号の合わない代表の知らせは、画面に渡さない（形や意味が違いうる）
      case "changed":
        if (leader === null && message.version === version) {
          toTab({ type: "changed", tables: message.tables });
        }
        return;
      case "status":
        if (leader === null && message.version === version) {
          toTab({ type: "status", status: message.status });
        }
        return;
      case "leader":
        // 代表が替わったときだけ動く（同じ代表が名乗り直しただけなら、すでに受けているので
        // 送り直さない）
        if (!locked && message.leaderId !== currentLeader?.id) {
          onLeader({ id: message.leaderId, version: message.version ?? null });
        }
        return;
      case "hello":
        if (leader !== null) announce(leader);
        return;
      case "visible":
        if (leader !== null) onVisible(leader);
        return;
    }
  });

  // オンラインに戻ったら、すぐ同期する
  scope.addEventListener("online", () => {
    leader?.scheduler.requestNow();
    leader?.updates?.online();
  });

  toPeers({ type: "hello", from: workerId });
  seekLeadership();

  function mismatch(peerVersion: number | null): Result {
    return { ok: false, error: serializeError(new ProtocolMismatchError(peerVersion, version)) };
  }

  function forward(call: Extract<TabMessage, { type: "call" }>): void {
    toPeers({ ...call, version, from: workerId });
  }

  /** 名乗る。今の同期の様子も送る（あとから開いたタブ、代表が替わったタブのため） */
  function announce(current: { scheduler: SyncScheduler }): void {
    toPeers({ type: "leader", version, leaderId: workerId });
    toPeers({ type: "status", version, status: current.scheduler.status });
  }

  /** ほかのタブが代表になった（または、代表を知った） */
  function onLeader(next: { id: string; version: number | null }): void {
    currentLeader = next;
    if (next.version !== version) {
      afterMismatch = true;
      // 番号が合わない。答えの来ていない呼び出しも、待たせずに失敗で返す
      const result = mismatch(next.version);
      for (const call of forwarded.values()) toTab({ type: "result", id: call.id, result });
      forwarded.clear();
      return;
    }
    // 同期の様子は、新しい代表が名乗るときに送る
    readAgainAfterMismatch();
    for (const call of forwarded.values()) forward(call);
  }

  function readAgainAfterMismatch(): void {
    if (!afterMismatch) return;
    afterMismatch = false;
    toTab({ type: "changed", tables: [...TABLES] });
  }

  /**
   * 代表になれるまで待つ。なったら、ワーカーが終わるまでロックを持ち続ける。
   *
   * DB を開けなかったら、自分のタブから待っている呼び出しに失敗を返し、ロックを放す（ほかの
   * タブが代表になれるように）。次に自分のタブから呼ばれたら、もう一度なろうとする。間隔を
   * 決めて試し続けないのは、開けない理由が続くことが多く、そのたびに wasm を読み直すため。
   */
  function seekLeadership(): void {
    if (seeking) return;
    seeking = true;
    void navigator.locks.request(leaderLockName(namespace), async () => {
      // 前の代表はもういない（番号の合わない代表でも、もう頼みを断らない）
      locked = true;
      currentLeader = null;
      try {
        leader = await becomeLeader();
      } catch (error) {
        console.error("代表になれなかった（DB を開けない）", error);
        seeking = false;
        locked = false;
        const result: Result = { ok: false, error: serializeError(error) };
        for (const call of forwarded.values()) toTab({ type: "result", id: call.id, result });
        forwarded.clear();
        return;
      }
      await new Promise(() => {});
    });
  }

  async function becomeLeader() {
    // 開けた DB は、ReaderCore の準備で失敗しても開き直さずに使う（OPFS の取っ手を二重に取らない）
    opened ??= (options.openDatabase ?? openWebDatabase)(namespace);
    const db = await opened.catch((error: unknown) => {
      opened = null;
      throw error;
    });
    const core = await ReaderCore.open({
      db,
      baseUrl: options.baseUrl ?? "/api/v1",
      ...(options.fetch === undefined ? {} : { fetch: options.fetch }),
      // 手元の DB を消すとき（ログアウト、ユーザーの切り替え）に、画像のキャッシュも消す
      onDataCleared: clearImageCache,
      // 同期のあとに、未読の記事の全文を取っておく（開いたときに待たず、オフラインでも読めるように）
      prefetchContents: DEFAULT_PREFETCH_CONTENTS,
    });
    let updates: SyncUpdates | null = null;
    const scheduler = new SyncScheduler(core, {
      onStatus: (status: SyncStatus) => {
        toTab({ type: "status", status });
        toPeers({ type: "status", version, status });
        updates?.update(status);
      },
    });
    // 通知につなぐのは代表だけ（ブラウザごとに 1 本。docs/decisions/local-first.md の 3）
    const openWebSocket =
      options.webSocket === undefined
        ? // 受け取り手の引数の型だけが違う（使うのは data と code だけ）
          (url: string) => new WebSocket(url) as unknown as WebSocketLike
        : options.webSocket;
    if (openWebSocket !== null) {
      const url = syncUpdatesUrl(options.baseUrl ?? "/api/v1", self.location.href);
      updates = new SyncUpdates({
        connect: () => openWebSocket(url),
        requestSync: () => scheduler.requestNotified(),
        checkSession: () => scheduler.requestNow(),
      });
    }
    core.onChange((tables) => {
      const changed: Table[] = [...tables];
      toTab({ type: "changed", tables: changed });
      toPeers({ type: "changed", version, tables: changed });
    });
    const current = { core, scheduler, updates };

    // 代表を待っている間に自分のタブから頼まれた呼び出しは、ここで受ける
    for (const call of forwarded.values()) {
      void dispatch(current, call.method, call.args).then((result) =>
        toTab({ type: "result", id: call.id, result }),
      );
    }
    forwarded.clear();
    announce(current);
    readAgainAfterMismatch();
    toTab({ type: "status", status: scheduler.status });
    scheduler.requestNow();
    updates?.update(scheduler.status);
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
      if (WRITE_METHODS.has(method)) {
        leader.scheduler.requestSoon(
          method === "savePage" || method === "unsavePage",
          method === "createWorkspace" ||
            method === "renameWorkspace" ||
            method === "setDefaultWorkspace" ||
            method === "deleteWorkspace" ||
            method === "moveFeedToWorkspace",
        );
      }
      if (SYNC_NOW_METHODS.has(method)) leader.scheduler.requestNow();
    }
    return { ok: true, value };
  } catch (error) {
    // 訳し直しを断られたのは、手元の状態が古い（もう訳し直した、訳文がない）ため。同期して直す
    // （docs/decisions/translation.md の 6）
    if (
      method === "requestTranslation" &&
      error instanceof ApiError &&
      error.code === "retranslation_not_allowed"
    ) {
      leader.scheduler.requestNow();
    }
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
