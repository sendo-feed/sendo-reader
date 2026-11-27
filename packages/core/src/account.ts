import {
  ApiError,
  createSendoApi,
  errorFromBody,
  type SendoApi,
  type SendoApiOptions,
} from "./api/client";
import type { components } from "./api/schema.gen";
import type { User } from "./models";

/**
 * アカウントの画面（設定の画面、OAuth の許可の画面）が使う sendo の API（docs/decisions/account.md）。
 *
 * sendo にしかないもの（アクセストークン、OAuth の許可、Discord 連携）を扱うので、ネットワークが要り、結果は
 * 手元の DB に置かない。sendo のセッション（ブラウザのクッキー）でだけ使える。同期と同じ API の
 * 窓口（api/client.ts）を通し、タイムアウト、中断、失敗の分け方を揃える。
 */

export type TokenPurpose = "reader" | "mcp";
export type Scope = "read" | "write";
export type DiscordIntegration = components["schemas"]["DiscordIntegration"];
export type DiscordSubscription = DiscordIntegration["subscriptions"][number];

/**
 * この Sendo で Web Push を使えるか（GET /push。sendo の web-push.md の 3）。使えるなら、
 * PushManager.subscribe の applicationServerKey に渡す VAPID の公開鍵（base64url）
 */
export type PushStatus = { available: true; publicKey: string } | { available: false };

/** この端末の Web Push の登録（PushSubscription.toJSON() の形。sendo の web-push.md の 4） */
export type PushRegistration = components["schemas"]["PushRegistration"];

/** アクセストークン（中身は含まない。中身は発行したときにしか受け取れない） */
export interface AccessToken {
  id: string;
  name: string;
  /** reader はリーダーアプリと REST API 用、mcp は MCP サーバー（/mcp）用 */
  purpose: TokenPurpose;
  /** MCP 用の範囲。リーダーアプリ用は空 */
  scopes: Scope[];
  createdAt: number;
  /** 最後に使った時刻（sendo は 1 時間ごとにしか書き直さない）。使っていなければ null */
  lastUsedAt: number | null;
}

export interface NewAccessToken {
  name: string;
  purpose: TokenPurpose;
  /** MCP 用の範囲。既定は read だけ。リーダーアプリ用には付けない */
  scopes?: Scope[];
}

export interface IssuedAccessToken {
  accessToken: AccessToken;
  /**
   * トークンの中身（sendo_ で始まる）。この応答でしか受け取れない。画面に一度だけ出し、
   * どこにも保存しない（docs/decisions/account.md の 4）
   */
  secret: string;
}

/** OAuth で出した許可 */
export interface OAuthGrant {
  id: string;
  clientId: string;
  /** 許可したときのクライアントの名前。registered なら、クライアントが名乗っただけ */
  clientName: string | null;
  clientKind: "metadata_document" | "registered";
  scopes: Scope[];
  createdAt: number;
  /** 最後にトークンを出した時刻。まだなら null */
  lastUsedAt: number | null;
}

/** OAuth の許可の画面に出す、認可のリクエスト（sendo が確かめたもの） */
export interface AuthorizationRequest {
  client: {
    id: string;
    /** registered なら、クライアントが名乗っただけで確かめていない */
    name: string | null;
    kind: "metadata_document" | "registered";
    /** クライアントの ID の URL のホスト（metadata_document のとき） */
    host: string | null;
  };
  redirectUri: string;
  /** 戻る先のホスト。画面に必ず出す */
  redirectHost: string;
  /** 戻る先が手元（localhost など）。ほかのアプリでも受けられる */
  loopbackRedirect: boolean;
  scopes: Scope[];
}

/**
 * 認可のリクエストが正しくない（sendo の 400）。redirectTo があれば、誤りをクライアントに返す
 * ために、そこへ移る。なければ画面に誤りを出し、どこへも移らない
 */
export class AuthorizationError extends Error {
  constructor(
    readonly code: string,
    message: string,
    readonly redirectTo: string | null,
  ) {
    super(message);
    this.name = "AuthorizationError";
  }
}

/** トークンの名前の長さの上限（sendo と同じ。前後の空白を除いて数える） */
export const MAX_TOKEN_NAME_LENGTH = 100;

export type AccountApi = ReturnType<typeof createAccountApi>;

export function createAccountApi(options: SendoApiOptions) {
  const api = createSendoApi(options);

  return {
    /** セッションのユーザー。ログインしていなければ ApiError（unauthorized） */
    me(signal?: AbortSignal): Promise<User> {
      return api.me(signal);
    },

    getDiscord(signal?: AbortSignal): Promise<DiscordIntegration> {
      return getDiscord(api, signal);
    },

    async connectDiscord(returnTo: string, signal?: AbortSignal): Promise<string> {
      const { data, error, response } = await api
        .client(signal)
        .POST("/integrations/discord/connect", { body: { returnTo } });
      if (data === undefined) throw errorFromBody(response.status, error);
      return data.authorizationUrl;
    },

    async subscribeDiscord(url: string, signal?: AbortSignal): Promise<DiscordSubscription> {
      const { data, error, response } = await api
        .client(signal)
        .POST("/integrations/discord/subscriptions", { body: { url } });
      if (data === undefined) throw errorFromBody(response.status, error);
      return data;
    },

    /**
     * Web Push を使えるか（docs/decisions/notifications.md の 1）。404（Web Push に対応する前の
     * Sendo）は使えないとする。応答の形が読めなければ ApiError（server）。届かない、401 などは
     * ApiError のまま投げる
     */
    async getPush(signal?: AbortSignal): Promise<PushStatus> {
      const { data, error, response } = await api.client(signal).GET("/push");
      if (response.status === 404) return { available: false };
      if (data === undefined) throw errorFromBody(response.status, error);
      const body = data as { available?: unknown; publicKey?: unknown } | null;
      if (body?.available === false) return { available: false };
      if (body?.available === true && typeof body.publicKey === "string" && body.publicKey !== "") {
        return { available: true, publicKey: body.publicKey };
      }
      throw new ApiError("server", "sendo の Web Push の応答の形が違う");
    },

    /**
     * この端末の登録を、今のセッションに結んで置く（何度送ってもよい）。登録は秘密として扱い、
     * 失敗の文にも入れない。使えない設定なら ApiError（status 501）
     */
    async putPushRegistration(registration: PushRegistration, signal?: AbortSignal): Promise<void> {
      const { error, response } = await api
        .client(signal)
        .PUT("/push/registration", { body: registration });
      if (!response.ok) throw errorFromBody(response.status, error);
    },

    /** 今のセッションの登録を外す（なくても成功する） */
    async deletePushRegistration(signal?: AbortSignal): Promise<void> {
      const { error, response } = await api.client(signal).DELETE("/push/registration");
      if (!response.ok) throw errorFromBody(response.status, error);
    },

    /** アクセストークンの一覧（新しい順） */
    async listTokens(signal?: AbortSignal): Promise<AccessToken[]> {
      const { data, error, response } = await api.client(signal).GET("/tokens");
      if (data === undefined) throw errorFromBody(response.status, error);
      return data.items.map(toAccessToken);
    },

    /** アクセストークンを発行する。中身は、返した secret でしか受け取れない */
    async createToken(input: NewAccessToken, signal?: AbortSignal): Promise<IssuedAccessToken> {
      const body =
        input.purpose === "mcp"
          ? { name: input.name, purpose: "mcp" as const, scopes: input.scopes ?? ["read"] }
          : { name: input.name, purpose: "reader" as const };
      const { data, error, response } = await api.client(signal).POST("/tokens", { body });
      if (data === undefined) throw errorFromBody(response.status, error);
      return { accessToken: toAccessToken(data.accessToken), secret: data.token };
    },

    /** アクセストークンを取り消す。すぐに使えなくなる */
    async revokeToken(id: string, signal?: AbortSignal): Promise<void> {
      const { error, response } = await api.client(signal).DELETE("/tokens/{id}", {
        params: { path: { id } },
      });
      if (!response.ok) throw errorFromBody(response.status, error);
    },

    /** OAuth で出した許可の一覧 */
    async listGrants(signal?: AbortSignal): Promise<OAuthGrant[]> {
      const { data, error, response } = await api.client(signal).GET("/oauth/grants");
      if (data === undefined) throw errorFromBody(response.status, error);
      return data.items.map((grant) => ({
        id: grant.id,
        clientId: grant.clientId,
        clientName: grant.clientName,
        clientKind: grant.clientKind,
        scopes: [...grant.scopes],
        createdAt: Date.parse(grant.createdAt),
        lastUsedAt: grant.lastUsedAt === null ? null : Date.parse(grant.lastUsedAt),
      }));
    },

    /**
     * OAuth の許可の画面を出す前に、認可のリクエスト（location.search をそのまま）を確かめる。
     * 正しくなければ AuthorizationError、ログインしていなければ ApiError（unauthorized）、
     * sendo で OAuth を使う設定がなければ ApiError（not_found、code が oauth_disabled）
     */
    async checkAuthorization(query: string, signal?: AbortSignal): Promise<AuthorizationRequest> {
      const { data, error, response } = await api
        .client(signal)
        .POST("/oauth/authorize/check", { body: { query } });
      if (data === undefined) throw toAuthorizationError(response.status, error);
      return {
        client: { ...data.client },
        redirectUri: data.redirectUri,
        redirectHost: data.redirectHost,
        loopbackRedirect: data.loopbackRedirect,
        scopes: [...data.scopes],
      };
    },

    /**
     * 利用者が選んだ結果（許可なら true）を送り、ブラウザを移す先を返す（許可なら認可コード、
     * 拒否なら access_denied を付けた、クライアントの戻る先）。失敗は checkAuthorization と同じ
     */
    async decideAuthorization(
      query: string,
      approved: boolean,
      signal?: AbortSignal,
    ): Promise<string> {
      const { data, error, response } = await api
        .client(signal)
        .POST("/oauth/authorize/decide", { body: { query, approved } });
      if (data === undefined) throw toAuthorizationError(response.status, error);
      return toRedirect(data.redirectTo);
    },

    /** OAuth で出した許可を取り消す。そのクライアントのトークンは、すぐに使えなくなる */
    async revokeGrant(id: string, signal?: AbortSignal): Promise<void> {
      const { error, response } = await api.client(signal).DELETE("/oauth/grants/{id}", {
        params: { path: { id } },
      });
      if (!response.ok) throw errorFromBody(response.status, error);
    },
  };
}

export async function getDiscord(api: SendoApi, signal?: AbortSignal): Promise<DiscordIntegration> {
  const { data, error, response } = await api.client(signal).GET("/integrations/discord");
  if (data === undefined) throw errorFromBody(response.status, error);
  return data;
}

export async function unsubscribeDiscord(
  api: SendoApi,
  id: string,
  signal: AbortSignal,
): Promise<void> {
  const { error, response } = await api.client(signal).DELETE("/feeds/{id}", {
    params: { path: { id } },
  });
  // 別の端末ですでに購読を解除していても目的は達成している。
  if (!response.ok && response.status !== 404) throw errorFromBody(response.status, error);
}

export async function disconnectDiscord(api: SendoApi, signal: AbortSignal): Promise<void> {
  const { error, response } = await api.client(signal).DELETE("/integrations/discord");
  if (!response.ok) throw errorFromBody(response.status, error);
}

function toAccessToken(token: {
  id: string;
  name: string;
  purpose: TokenPurpose;
  scopes: Scope[];
  createdAt: string;
  lastUsedAt: string | null;
}): AccessToken {
  return {
    id: token.id,
    name: token.name,
    purpose: token.purpose,
    scopes: [...token.scopes],
    createdAt: Date.parse(token.createdAt),
    lastUsedAt: token.lastUsedAt === null ? null : Date.parse(token.lastUsedAt),
  };
}

/** 400 なら AuthorizationError、そのほかは ApiError にする */
function toAuthorizationError(status: number, body: unknown): Error {
  if (status !== 400) return errorFromBody(status, body);
  const parsed = body as { error?: { code?: unknown; message?: unknown }; redirectTo?: unknown };
  const code = typeof parsed?.error?.code === "string" ? parsed.error.code : "invalid_request";
  const message = typeof parsed?.error?.message === "string" ? parsed.error.message : "HTTP 400";
  const redirectTo =
    typeof parsed?.redirectTo === "string" ? safeRedirect(parsed.redirectTo) : null;
  return new AuthorizationError(code, message, redirectTo);
}

/** 移る先は http ／ https の URL だけにする（sendo の決まりでも、戻る先はこの 2 つだけ） */
function safeRedirect(value: string): string | null {
  try {
    const url = new URL(value);
    return url.protocol === "https:" || url.protocol === "http:" ? url.href : null;
  } catch {
    return null;
  }
}

function toRedirect(value: string): string {
  const url = safeRedirect(value);
  if (url === null) throw new ApiError("server", "sendo が返した戻る先が http ／ https でない");
  return url;
}
