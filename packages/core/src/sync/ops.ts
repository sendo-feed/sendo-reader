import { ApiError, errorFromBody, type SendoApi } from "../api/client";
import { toBell, toSavedPage } from "../api/sync-contract";
import type { BellTarget } from "../bells";
import type { Executor } from "../db/database";
import { getSetting, setSetting } from "../db/settings";
import { requestResync } from "../db/synced";
import { putSyncedSetting, removeSyncedSetting } from "../db/synced-settings";
import {
  effectiveWorkspaceDefault,
  putWorkspace,
  putWorkspaceDefault,
  setWorkspacesAvailable,
} from "../db/workspaces";
import type { Bell, DeviceType, JsonValue, SavedPage, SettingItem } from "../models";
import { MAX_SETTINGS_PER_REQUEST } from "../settings";

/**
 * 手元にすぐ反映して、あとで sendo に送る操作（docs/decisions/local-first.md、sendo の sync.md）。
 *
 * どの操作も、何度送っても同じ結果になる（冪等）ようにする。送ったかどうか分からないまま
 * やり直しても壊れない。
 */
export type Operation =
  | { kind: "setArticleState"; articleId: string; read?: boolean; starred?: boolean; at: number }
  | {
      kind: "markRead";
      scope: MarkReadScope;
      /**
       * 押したときに手元で未読だった記事。手元ではこれだけを既読にする（あとから届いた記事を
       * 巻き込まない。カーソルが古すぎて取り直したあとも、同じ記事を既読に重ね直せる）
       */
      articleIds: string[];
      /**
       * 押したときに、最後まで同期し終えていたカーソル（一度も終えていなければ null）。sendo には、
       * このカーソルまでに未読のまま届いた記事だけを既読にするよう頼む（sync.md の 6）
       */
      cursor: string | null;
      /**
       * articleIds のうち、カーソルの範囲に入らない記事（カーソルのあとに届いた、またはカーソルの
       * あとに手元で既読・未読を変えた）。sendo はカーソルではこれらを既読にしないので、ID で頼む
       */
      extraIds: string[];
      at: number;
    }
  | {
      kind: "markWorkspaceRead";
      /** 操作時に有効だった購読。所属や選択が変わっても入れ替えない。 */
      subscriptionIds: string[];
      articleIds: string[];
      /** さらに日時で絞った場合は null。選んだ記事 ID だけを送る。 */
      cursor: string | null;
      /** 送信済みで、同期の確定状態を待っている。 */
      acknowledged?: true;
      /** 送る前の差分で Sendo 側でも既読を確認した記事。 */
      serverReadArticleIds?: string[];
      at: number;
    }
  | { kind: "createFolder"; folderId: string; name: string; at: number }
  | { kind: "renameFolder"; folderId: string; name: string }
  | { kind: "deleteFolder"; folderId: string }
  | { kind: "moveFeed"; feedId: string; folderId: string | null }
  | { kind: "renameFeed"; feedId: string; displayName: string | null }
  | WorkspaceOperation
  | { kind: "unsubscribe"; feedId: string }
  | { kind: "setSavedPage"; id: string; page: SavedPage | null }
  /**
   * ベルを付ける ／ 外す（sendo の docs/decisions/notifications.md の 1〜7）。ベルは購読と言葉の組で、
   * 購読だけのベルは words が null、言葉だけのベルは feedId が null。付けるときの bellId は、この端末が
   * 決めた小文字の UUID（オフラインで付けて外しても、外す相手を指せる）。外すときは、押したときに
   * 手元に見えていたベルの ID と、そのベルの組。at は付けた時刻（送るまで手元に見せる作った時刻）
   */
  | ({ kind: "setBell"; bellId: string; on: boolean; at: number } & BellTarget)
  | { kind: "recordArticleOpens"; events: ArticleOpenEvent[] }
  /**
   * 設定を置く ／ 消す（docs/decisions/settings.md）。同じ名前は、put と remove のどちらか一方に
   * 1 度だけ入れる
   */
  | { kind: "setSettings"; deviceType: DeviceType; put: SettingItem[]; remove: string[] };

export type WorkspaceOperation =
  | { kind: "createWorkspace"; workspaceId: string; name: string; at: number }
  | { kind: "renameWorkspace"; workspaceId: string; name: string }
  | { kind: "setDefaultWorkspace"; workspaceId: string }
  | { kind: "deleteWorkspace"; workspaceId: string; requireDefaultSupport?: true }
  | {
      kind: "moveFeedToWorkspace";
      feedId: string;
      subscriptionId: string;
      workspaceId: string | null;
    };

export function isWorkspaceOperation(op: Operation): op is WorkspaceOperation {
  return (
    op.kind === "createWorkspace" ||
    op.kind === "renameWorkspace" ||
    op.kind === "setDefaultWorkspace" ||
    op.kind === "deleteWorkspace" ||
    op.kind === "moveFeedToWorkspace"
  );
}

interface ArticleOpenEvent {
  id: string;
  articleId: string;
  occurredAt: string;
}

const MAX_ARTICLE_OPEN_EVENTS = 50;

/** まとめて既読の範囲 */
export type MarkReadScope = { all: true } | { feedId: string } | { folderId: string };

/** まとめて既読で、1 回に ID で頼める記事の数（sendo の MarkReadRequest の ids の上限） */
export const MAX_MARK_READ_IDS = 90;

/**
 * フォルダの ID の形（小文字の UUID）。手元で作るフォルダの ID は reader が決め、そのまま sendo に
 * 送る（sendo の POST /folders は、クライアントが決めた ID を受ける）。オフラインで作っても、
 * sendo に届いたあとも、同じ ID で使える
 */
export const FOLDER_ID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

const FOLDER_ID_REMAPS_KEY = "local.folderIdRemaps";

/** 同期が Sendo の確定状態を受け取れるよう、送信を終えた操作の分だけ楽観表示を外す。 */
export async function dropWorkspaceReadOverlay(
  tx: Executor,
  op: Extract<Operation, { kind: "markWorkspaceRead" }>,
): Promise<boolean> {
  const rows = await tx.all<{ id: string }>(
    `update articles set read_at = null, read_synced = 1
     where read_at = ? and read_synced = 0 and id in (select value from json_each(?))
     returning id`,
    [op.at, JSON.stringify(op.articleIds)],
  );
  return rows.length > 0;
}

/**
 * 手元で作ったフォルダの ID から、まとめた先（sendo にあった、同じ名前のフォルダ）の ID への対応
 */
export async function getFolderIdRemaps(db: Executor): Promise<Record<string, string>> {
  const raw = await getSetting(db, FOLDER_ID_REMAPS_KEY);
  return raw === null ? {} : (JSON.parse(raw) as Record<string, string>);
}

/** 同じものへの操作をまとめるときの鍵 */
export function keyOf(op: Operation): string {
  switch (op.kind) {
    case "setArticleState":
      return op.articleId;
    case "markRead":
      return "all" in op.scope ? "all" : "feedId" in op.scope ? op.scope.feedId : op.scope.folderId;
    case "markWorkspaceRead":
      return "workspaces";
    case "createFolder":
    case "renameFolder":
    case "deleteFolder":
      return op.folderId;
    case "createWorkspace":
    case "renameWorkspace":
    case "setDefaultWorkspace":
    case "deleteWorkspace":
      return op.workspaceId;
    case "moveFeed":
    case "moveFeedToWorkspace":
    case "renameFeed":
    case "unsubscribe":
      return op.feedId;
    case "setBell":
      // 購読と言葉の組。購読だけの組はフィードの ID（前の版の setFeedBell と同じ鍵）
      return `${op.feedId ?? ""}${op.words === null ? "" : ` ${op.words.matchKey}`}`;
    case "setSavedPage":
      return op.id;
    case "recordArticleOpens":
      return "articleOpens";
    case "setSettings":
      return `settings:${op.deviceType}`;
  }
}

/**
 * 列の最後にある同じ鍵の操作に、新しい操作をまとめられるならまとめた操作を返す。
 * まとめるのは、上書きしても意味が変わらないもの（既読・スター、名前、フォルダの移動）だけ。
 */
export function merge(previous: Operation, next: Operation): Operation | null {
  if (previous.kind === "setArticleState" && next.kind === "setArticleState") {
    if (previous.articleId !== next.articleId) return null;
    const merged: Operation = { ...previous, at: next.at };
    if (next.read !== undefined) merged.read = next.read;
    if (next.starred !== undefined) merged.starred = next.starred;
    return merged;
  }
  if (previous.kind === "renameFolder" && next.kind === "renameFolder") {
    return previous.folderId === next.folderId ? next : null;
  }
  if (
    (previous.kind === "moveFeed" && next.kind === "moveFeed") ||
    (previous.kind === "renameFeed" && next.kind === "renameFeed")
  ) {
    return previous.feedId === next.feedId ? next : null;
  }
  if (previous.kind === "renameWorkspace" && next.kind === "renameWorkspace") {
    return previous.workspaceId === next.workspaceId ? next : null;
  }
  if (previous.kind === "moveFeedToWorkspace" && next.kind === "moveFeedToWorkspace") {
    return previous.subscriptionId === next.subscriptionId ? next : null;
  }
  // setBell はまとめない。付けてすぐ外したのを外すだけにすると、ほかの端末が同じ組に付けた、
  // まだ取り込んでいないベルが sendo に残る（付ければ sendo のベルの ID が返り、外す操作をそれに
  // 付け替えられる）
  if (previous.kind === "recordArticleOpens" && next.kind === "recordArticleOpens") {
    const events = [...previous.events];
    const ids = new Set(events.map(({ id }) => id));
    for (const event of next.events) {
      if (ids.has(event.id)) continue;
      if (events.length === MAX_ARTICLE_OPEN_EVENTS) return null;
      ids.add(event.id);
      events.push(event);
    }
    return { kind: "recordArticleOpens", events };
  }
  if (previous.kind === "setSettings" && next.kind === "setSettings") {
    if (previous.deviceType !== next.deviceType) return null;
    // 同じ名前は、最後の操作だけを残す
    const touched = new Set([...next.put.map((item) => item.name), ...next.remove]);
    return {
      kind: "setSettings",
      deviceType: next.deviceType,
      put: [...previous.put.filter((item) => !touched.has(item.name)), ...next.put],
      remove: [...previous.remove.filter((name) => !touched.has(name)), ...next.remove],
    };
  }
  return null;
}

/** 操作を手元の DB に当てる。同期で届いた行の上に、まだ送り終えていない操作を重ねるときにも使う */
export async function applyLocally(tx: Executor, op: Operation, pendingId?: number): Promise<void> {
  switch (op.kind) {
    case "setArticleState": {
      // sendo と同じく、すでにその状態なら時刻は変えない
      const read = op.read === undefined ? null : op.read ? 1 : 0;
      const starred = op.starred === undefined ? null : op.starred ? 1 : 0;
      // 既読・未読を変えたら、最後まで同期し終えたカーソルの範囲から外れる（db/schema.ts）
      await tx.run(
        `update articles set
           read_at = case ?1 when 1 then coalesce(read_at, ?3) when 0 then null else read_at end,
           starred_at = case ?2 when 1 then coalesce(starred_at, ?3) when 0 then null else starred_at end,
           read_synced = case when ?1 is null then read_synced else 0 end
         where id = ?4`,
        [read, starred, op.at, op.articleId],
      );
      return;
    }
    case "markRead":
      await tx.run(
        `update articles set read_at = ?, read_synced = 0
         where read_at is null and id in (select value from json_each(?))`,
        [op.at, JSON.stringify(op.articleIds)],
      );
      return;
    case "markWorkspaceRead":
      await tx.run(
        `update articles set read_at = ?1, read_synced = 0
           where read_at is null and id in (select value from json_each(?2))
             and (?3 is null or feed_id in (
               select id from feeds where subscription_id in (select value from json_each(?3))
             ))`,
        [
          op.at,
          JSON.stringify(op.articleIds),
          op.cursor === null ? null : JSON.stringify(op.subscriptionIds),
        ],
      );
      return;
    case "createFolder":
      await tx.run(
        "insert into folders (id, name, created_at) values (?, ?, ?) on conflict (id) do nothing",
        [op.folderId, op.name, op.at],
      );
      return;
    case "renameFolder":
      await tx.run("update folders set name = ? where id = ?", [op.name, op.folderId]);
      return;
    case "deleteFolder":
      await tx.run("delete from folders where id = ?", [op.folderId]);
      await tx.run("update feeds set folder_id = null where folder_id = ?", [op.folderId]);
      return;
    case "moveFeed":
      await tx.run("update feeds set folder_id = ? where id = ?", [op.folderId, op.feedId]);
      return;
    case "renameFeed":
      await tx.run("update feeds set display_name = ? where id = ?", [op.displayName, op.feedId]);
      return;
    case "createWorkspace":
      await tx.run(
        "insert into workspaces (id, name, created_at) values (?, ?, ?) on conflict (id) do nothing",
        [op.workspaceId, op.name, op.at],
      );
      return;
    case "renameWorkspace":
      await tx.run("update workspaces set name = ? where id = ?", [op.name, op.workspaceId]);
      return;
    case "setDefaultWorkspace":
      // 表示では確定した印の上に、キューに残っている最後の切り替えを重ねる。
      return;
    case "deleteWorkspace":
      if (op.workspaceId === (await effectiveWorkspaceDefault(tx, pendingId))) return;
      await tx.run(
        `update workspaces set deleted_locally = 1 where id = ?1
           and not exists (select 1 from feeds where workspace_id = ?1)`,
        [op.workspaceId],
      );
      return;
    case "moveFeedToWorkspace":
      await tx.run(
        `update feeds set workspace_id = ?1 where id = ?2 and subscription_id = ?3
           and (?1 is null or exists (select 1 from workspaces where id = ?1 and deleted_locally = 0))`,
        [op.workspaceId, op.feedId, op.subscriptionId],
      );
      return;
    case "unsubscribe":
      await tx.run("delete from feeds where id = ?", [op.feedId]);
      // sendo は、購読をやめたフィードの記事のうち、スターのないものを受信箱から消す。手元でも先に
      // 同じように消しておく（自分の操作の楽観的な反映。同期では、記事ごとの消した記録が届いた
      // ときにだけ消す。docs/decisions/local-first.md）
      await tx.run("delete from articles where feed_id = ? and starred_at is null", [op.feedId]);
      // sendo は、購読をやめると、その購読のベルを外す（言葉だけのベルは残る）。手元でも先に外す
      await tx.run("delete from bells where feed_id = ?", [op.feedId]);
      return;
    case "setSavedPage":
      // 操作キューの行を visible_saved_pages が読む。同期で届いた行は上書きしない。
      return;
    case "setBell":
      // 操作キューの行を、手元に見えるベル（db/bells.ts）が重ねて読む。届いた行は上書きしない
      return;
    case "recordArticleOpens":
      return;
    case "setSettings":
      for (const name of op.remove) await removeSyncedSetting(tx, op.deviceType, name);
      for (const item of op.put) await putSyncedSetting(tx, op.deviceType, item.name, item.value);
      return;
  }
}

/** まとめて既読の範囲を、articles の条件にする */
export function scopeCondition(scope: MarkReadScope): [string, string[]] {
  if ("feedId" in scope) return ["feed_id = ?", [scope.feedId]];
  if ("folderId" in scope) {
    return ["feed_id in (select id from feeds where folder_id = ?)", [scope.folderId]];
  }
  return ["1 = 1", []];
}

/** 送った結果。手元で作ったフォルダを、sendo にあった同じ名前のフォルダにまとめたら remap を返す */
export type SendResult = {
  remap?: { from: string; to: string };
  savedPage?: SavedPage;
  /** 付けたベル（sendo に同じ組のベルがもうあったら、その ID のベル） */
  bell?: Bell;
};

export async function readWorkspaceDefault(
  api: SendoApi,
  signal?: AbortSignal,
): Promise<string | null> {
  try {
    const { items } = check(await api.client(signal).GET("/workspaces"));
    return items.find((workspace) => workspace.isDefault === true)?.id ?? null;
  } catch (error) {
    if (error instanceof ApiError && error.kind === "not_found") return null;
    throw error;
  }
}

// キューに積んだあとで旧 Sendo に戻った場合も、デフォルトを前提にした書き込みは送らない。
async function requireWorkspaceDefault(api: SendoApi, signal: AbortSignal): Promise<void> {
  if ((await readWorkspaceDefault(api, signal)) === null) {
    throw new ApiError(
      "invalid",
      "デフォルトに対応した Sendo と同期してください",
      400,
      "workspace_default_unavailable",
    );
  }
}

/** 操作を sendo に送る。失敗したら ApiError を投げる。signal で中断する（ログアウトなど） */
export async function send(api: SendoApi, op: Operation, signal: AbortSignal): Promise<SendResult> {
  const client = api.client(signal);
  switch (op.kind) {
    case "setArticleState": {
      const body: { read?: boolean; starred?: boolean } = {};
      if (op.read !== undefined) body.read = op.read;
      if (op.starred !== undefined) body.starred = op.starred;
      check(
        await client.PATCH("/articles/{id}", {
          params: { path: { id: op.articleId } },
          body,
        }),
      );
      return {};
    }
    case "markRead": {
      let ids = op.extraIds;
      if (op.cursor !== null) {
        try {
          check(
            await client.POST("/articles/mark-read", { body: { ...op.scope, cursor: op.cursor } }),
          );
        } catch (error) {
          // カーソルを受け付けなかった（sendo の版が変わって読めない、など）。手元で既読にした
          // 記事をすべて ID で頼む（どちらで頼んでも、押したときに手元にあった記事だけになる）
          if (!(error instanceof ApiError && isCursorRejected(error))) throw error;
          ids = op.articleIds;
        }
      }
      // 何度送っても同じ結果になる。途中で届かなくなったら、次は最初から送り直す
      for (let i = 0; i < ids.length; i += MAX_MARK_READ_IDS) {
        check(
          await client.POST("/articles/mark-read", {
            body: { ids: ids.slice(i, i + MAX_MARK_READ_IDS) },
          }),
        );
      }
      return {};
    }
    case "markWorkspaceRead": {
      const cursor = op.cursor;
      const ids = cursor === null ? op.articleIds : op.subscriptionIds;
      for (let i = 0; i < ids.length; i += MAX_MARK_READ_IDS) {
        const batch = ids.slice(i, i + MAX_MARK_READ_IDS);
        check(
          await client.POST("/articles/mark-read", {
            body: cursor === null ? { ids: batch } : { subscriptionIds: batch, cursor },
          }),
        );
      }
      return {};
    }
    case "createFolder": {
      // 手元で決めた ID で作る。201 は作った、200 は同じ ID のフォルダがもうある（前に送って
      // 応答だけ失った）。どちらも手元の ID のまま使える（名前がほかの端末で変わっていれば、
      // その変更は同期で届く）
      const { error, response } = await client.POST("/folders", {
        body: { id: op.folderId, name: op.name },
      });
      if (response.ok) return {};
      const failure = errorFromBody(response.status, error);
      if (failure.code === "folder_exists") {
        // 同じ名前の別のフォルダがある（別の端末で作った）。それにまとめる
        const existing = await findFolderByName(api, op.name, signal);
        if (existing !== null) return { remap: { from: op.folderId, to: existing } };
      }
      // その ID は使えない（folder_id_taken：消したフォルダか、ほかの人のフォルダが使っている）
      // など。受け付けられなかった操作として、手元からも消す（undo）
      throw failure;
    }
    case "renameFolder":
      check(
        await client.PATCH("/folders/{id}", {
          params: { path: { id: op.folderId } },
          body: { name: op.name },
        }),
      );
      return {};
    case "deleteFolder":
      try {
        check(await client.DELETE("/folders/{id}", { params: { path: { id: op.folderId } } }));
      } catch (error) {
        // すでにない。消したかった状態になっている
        if (!(error instanceof ApiError && error.kind === "not_found")) throw error;
      }
      return {};
    case "moveFeed":
      check(
        await client.PATCH("/feeds/{id}", {
          params: { path: { id: op.feedId } },
          body: { folderId: op.folderId },
        }),
      );
      return {};
    case "renameFeed":
      check(
        await client.PATCH("/feeds/{id}", {
          params: { path: { id: op.feedId } },
          body: { displayName: op.displayName },
        }),
      );
      return {};
    case "createWorkspace":
      check(await client.POST("/workspaces", { body: { id: op.workspaceId, name: op.name } }));
      return {};
    case "renameWorkspace":
      check(
        await client.PATCH("/workspaces/{id}", {
          params: { path: { id: op.workspaceId } },
          body: { name: op.name },
        }),
      );
      return {};
    case "setDefaultWorkspace":
      await requireWorkspaceDefault(api, signal);
      check(
        await client.PATCH("/workspaces/{id}", {
          params: { path: { id: op.workspaceId } },
          body: { isDefault: true },
        }),
      );
      return {};
    case "deleteWorkspace":
      if (op.requireDefaultSupport) await requireWorkspaceDefault(api, signal);
      check(await client.DELETE("/workspaces/{id}", { params: { path: { id: op.workspaceId } } }));
      return {};
    case "moveFeedToWorkspace":
      check(
        await client.PATCH("/feeds/{id}", {
          params: { path: { id: op.feedId } },
          body: { workspaceId: op.workspaceId, subscriptionId: op.subscriptionId },
        }),
      );
      return {};
    case "unsubscribe":
      try {
        check(await client.DELETE("/feeds/{id}", { params: { path: { id: op.feedId } } }));
      } catch (error) {
        if (!(error instanceof ApiError && error.kind === "not_found")) throw error;
      }
      return {};
    case "recordArticleOpens":
      check(await client.POST("/activity", { body: { events: op.events } }));
      return {};
    case "setBell":
      if (op.on) {
        // 201 は付けた、200 は同じ組のベルがもうある（ほかの端末で付けた、前に送って応答だけ
        // 失った）。どちらも応答のベルを正とする
        const data = check(
          await client.POST("/bells", {
            body: {
              id: op.bellId,
              ...(op.feedId === null ? {} : { feedId: op.feedId }),
              ...(op.words === null ? {} : { words: op.words.words }),
            },
          }),
        );
        return { bell: toBell(data?.bell) };
      }
      try {
        check(await client.DELETE("/bells/{id}", { params: { path: { id: op.bellId } } }));
      } catch (error) {
        // 付ける前に外した（sendo にない ID）。外したかった状態になっている
        if (!(error instanceof ApiError && error.kind === "not_found")) throw error;
      }
      return {};
    case "setSavedPage": {
      if (op.page === null) {
        check(await client.DELETE("/saved/{id}", { params: { path: { id: op.id } } }));
        return {};
      }
      const body = {
        url: op.page.url,
        ...(op.page.title === null ? {} : { title: op.page.title }),
      };
      const savedPage = toSavedPage(check(await client.PUT("/saved", { body }))?.page);
      if (savedPage.id !== op.id || savedPage.url !== op.page.url) {
        throw new ApiError("server", "sendo が別の保存ページを返しました");
      }
      return { savedPage };
    }
    case "setSettings": {
      // 1 回に送れる数（100 項目）ごとに分ける。何度送っても同じ結果になるので、途中で届かなく
      // なったら、次は最初から送り直す
      const entries: ({ put: SettingItem } | { remove: string })[] = [
        ...op.remove.map((name) => ({ remove: name })),
        ...op.put.map((item) => ({ put: item })),
      ];
      for (let i = 0; i < entries.length; i += MAX_SETTINGS_PER_REQUEST) {
        const chunk = entries.slice(i, i + MAX_SETTINGS_PER_REQUEST);
        check(
          await client.PATCH("/settings/{deviceType}", {
            params: { path: { deviceType: op.deviceType } },
            body: {
              put: chunk.flatMap((entry) => ("put" in entry ? [entry.put] : [])),
              remove: chunk.flatMap((entry) => ("remove" in entry ? [entry.remove] : [])),
            },
          }),
        );
      }
      return {};
    }
  }
}

/**
 * sendo が受け付けなかった（やり直しても変わらない）操作の、手元への反映を戻す。
 * 戻す先は sendo の今の状態にする。通信が要るものは、ここで読み直す。
 *
 * 戻し方が決まっていないもの（sendo が状態を変えずに断ったので、次の差分にも載らないもの）は、
 * 次の同期で最初から取り直す（手元の行は、取り直し終えるまで残す）。
 */
export async function undo(
  api: SendoApi,
  op: Operation,
  error: ApiError,
  write: (fn: (tx: Executor) => Promise<void>) => Promise<void>,
  signal: AbortSignal,
): Promise<void> {
  switch (op.kind) {
    case "setArticleState":
      if (error.kind === "not_found") {
        // 記事が受信箱にない（購読をやめた、など）。手元からも消す
        await write((tx) => tx.run("delete from articles where id = ?", [op.articleId]));
        return;
      }
      break;
    case "createFolder":
      // sendo にはないフォルダ。手元からも消す
      await write(async (tx) => {
        await tx.run("delete from folders where id = ?", [op.folderId]);
        await tx.run("update feeds set folder_id = null where folder_id = ?", [op.folderId]);
      });
      return;
    case "renameFolder": {
      const folder = check(await api.client(signal).GET("/folders")).items.find(
        (item) => item.id === op.folderId,
      );
      await write(async (tx) => {
        if (folder === undefined) {
          // sendo でもう消えている。入っていたフィードもフォルダなしに戻す（sendo と同じ決まり）
          await tx.run("delete from folders where id = ?", [op.folderId]);
          await tx.run("update feeds set folder_id = null where folder_id = ?", [op.folderId]);
        } else {
          await tx.run("update folders set name = ? where id = ?", [folder.name, folder.id]);
        }
      });
      return;
    }
    case "moveFeed":
    case "renameFeed": {
      const feed = check(await api.client(signal).GET("/feeds")).items.find(
        (item) => item.id === op.feedId,
      );
      await write(async (tx) => {
        if (feed === undefined) {
          // sendo でもう購読をやめている。記事は消さない（受信箱から消えた記事は、記事ごとの
          // 消した記録が同期で届く。docs/decisions/local-first.md）
          await tx.run("delete from feeds where id = ?", [op.feedId]);
        } else if (op.kind === "moveFeed") {
          await tx.run("update feeds set folder_id = ? where id = ?", [feed.folderId, feed.id]);
        } else {
          await tx.run("update feeds set display_name = ? where id = ?", [
            feed.displayName ?? null,
            feed.id,
          ]);
        }
      });
      return;
    }
    case "createWorkspace":
    case "renameWorkspace":
    case "deleteWorkspace": {
      try {
        const { items } = check(await api.client(signal).GET("/workspaces"));
        const current = items.find((workspace) => workspace.id === op.workspaceId);
        await write(async (tx) => {
          if (current === undefined) {
            await tx.run("delete from workspaces where id = ?", [op.workspaceId]);
            // 失効した移動を取り除き、その後で有効な未送信操作を重ね直す。
            await tx.run(
              "update feeds set workspace_id = synced_workspace_id where workspace_id = ?",
              [op.workspaceId],
            );
          } else {
            await putWorkspace(tx, { ...current, createdAt: Date.parse(current.createdAt) });
          }
          await putWorkspaceDefault(tx, items.find((workspace) => workspace.isDefault)?.id ?? null);
        });
      } catch (failure) {
        if (!(failure instanceof ApiError && failure.kind === "not_found")) throw failure;
        // 対応前の Sendo に戻った場合、表示範囲を広げずに再同期する。
        await write(async (tx) => {
          await setWorkspacesAvailable(tx, false);
          await putWorkspaceDefault(tx, null);
          await requestResync(tx);
        });
      }
      return;
    }
    case "setDefaultWorkspace":
      return;
    case "moveFeedToWorkspace": {
      const current = check(await api.client(signal).GET("/feeds")).items.find(
        (feed) => feed.id === op.feedId,
      );
      await write(async (tx) => {
        if (current === undefined) {
          await tx.run("delete from feeds where id = ? and subscription_id = ?", [
            op.feedId,
            op.subscriptionId,
          ]);
        } else {
          await tx.run(
            "update feeds set workspace_id = ?1, synced_workspace_id = ?1, subscription_id = ?2 where id = ?3 and subscription_id = ?4",
            [
              current.workspaceId ?? null,
              current.subscriptionId ?? null,
              op.feedId,
              op.subscriptionId,
            ],
          );
        }
      });
      return;
    }
    case "setSettings": {
      // 手元には、置き換える前の値がない。sendo の今の値を読み、この操作が触った項目を置き直す
      // （名前の形や値の大きさで断られた、項目の数や合計の上限を超えた。settings.md の 7）
      let items: { name: string; value?: unknown }[];
      try {
        items = check(
          await api.client(signal).GET("/settings/{deviceType}", {
            params: { path: { deviceType: op.deviceType } },
          }),
        ).items;
      } catch (failure) {
        // 届かなかったら、戻さずに残す（次の同期でやり直す）。読むこと自体を断られたら
        // （設定を配る前の版の sendo）、戻す先が分からないので、手元はそのままにして捨てる
        if (failure instanceof ApiError && !isRetryable(failure)) return;
        throw failure;
      }
      const current = new Map(items.map((item) => [item.name, item.value]));
      await write(async (tx) => {
        for (const name of [...op.put.map((item) => item.name), ...op.remove]) {
          if (current.has(name)) {
            await putSyncedSetting(
              tx,
              op.deviceType,
              name,
              (current.get(name) ?? null) as JsonValue,
            );
          } else {
            await removeSyncedSetting(tx, op.deviceType, name);
          }
        }
      });
      return;
    }
    case "setSavedPage":
    case "setBell":
    case "recordArticleOpens":
      // 手元の行は書き換えていない。操作が消えれば、sendo の状態に戻る
      return;
    case "markWorkspaceRead":
      await write(async (tx) => {
        await dropWorkspaceReadOverlay(tx, op);
      });
      return;
    case "markRead":
    case "deleteFolder":
    case "unsubscribe":
      break;
  }
  await write(requestResync);
}

/**
 * 手元で作ったフォルダを、sendo にあった同じ名前のフォルダにまとめる（ID を付け替える）。
 * フォルダ、そこに入れたフィード、まだ送っていない操作のすべてを付け替える。
 */
export async function remapFolderId(tx: Executor, from: string, to: string): Promise<void> {
  if (from === to) return;
  // 画面がまとめる前の ID を持ったままでも使えるよう、付け替えを覚えておく（代表のタブが替わっても残る）
  const remaps = await getFolderIdRemaps(tx);
  remaps[from] = to;
  await setSetting(tx, FOLDER_ID_REMAPS_KEY, JSON.stringify(remaps));
  // 同期ですでに届いていれば、まとめる前のほうを消す
  await tx.run("delete from folders where id = ? and exists (select 1 from folders where id = ?)", [
    from,
    to,
  ]);
  await tx.run("update folders set id = ? where id = ?", [to, from]);
  await tx.run("update feeds set folder_id = ? where folder_id = ?", [to, from]);
  await tx.run(
    `update pending_ops set payload = json_set(payload, '$.folderId', ?1),
       key = case key when ?2 then ?1 else key end
     where json_extract(payload, '$.folderId') = ?2`,
    [to, from],
  );
  await tx.run(
    `update pending_ops set payload = json_set(payload, '$.scope.folderId', ?1),
       key = case key when ?2 then ?1 else key end
     where json_extract(payload, '$.scope.folderId') = ?2`,
    [to, from],
  );
}

/**
 * 付けたベルの ID が、sendo にあった同じ組のベルの ID と違った。まだ送っていない外す操作が、
 * sendo のベルを外すように付け替える（付けている間に外すと、外す操作は手元で決めた ID を持つ）
 */
export async function remapBellId(tx: Executor, from: string, to: string): Promise<void> {
  if (from === to) return;
  await tx.run(
    `update pending_ops set payload = json_set(payload, '$.bellId', ?1)
     where kind = 'setBell' and json_extract(payload, '$.bellId') = ?2`,
    [to, from],
  );
}

async function findFolderByName(
  api: SendoApi,
  name: string,
  signal: AbortSignal,
): Promise<string | null> {
  const { items } = check(await api.client(signal).GET("/folders"));
  return items.find((item) => item.name === name)?.id ?? null;
}

/** あとでやり直せば通るかもしれない失敗（届かない、サーバーの不具合、セッションが切れた） */
export function isRetryable(error: ApiError): boolean {
  return error.kind === "network" || error.kind === "server" || error.kind === "unauthorized";
}

/** まとめて既読のカーソルを sendo が受け付けなかった */
function isCursorRejected(error: ApiError): boolean {
  return error.kind === "cursor_invalid" || error.code === "sync_incomplete";
}

/** openapi-fetch の結果から、成功ならデータを返し、失敗なら ApiError を投げる */
function check<T>(result: { data?: T; error?: unknown; response: Response }): T {
  if (result.response.ok && result.data !== undefined) return result.data;
  if (result.response.ok) return undefined as T;
  throw errorFromBody(result.response.status, result.error);
}
