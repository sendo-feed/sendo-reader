import { createSendoApi, errorFromBody, type SendoApiOptions } from "./api/client";
import type { User } from "./models";

/**
 * アカウントの画面（設定の画面、OAuth の許可の画面）が使う sendo の API（docs/decisions/account.md）。
 *
 * sendo にしかないもの（アクセストークン、OAuth の許可）を扱うので、ネットワークが要り、結果は
 * 手元の DB に置かない。sendo のセッション（ブラウザのクッキー）でだけ使える。同期と同じ API の
 * 窓口（api/client.ts）を通し、タイムアウト、中断、失敗の分け方を揃える。
 */

export type TokenPurpose = "reader" | "mcp";
export type Scope = "read" | "write";

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

    /** OAuth で出した許可を取り消す。そのクライアントのトークンは、すぐに使えなくなる */
    async revokeGrant(id: string, signal?: AbortSignal): Promise<void> {
      const { error, response } = await api.client(signal).DELETE("/oauth/grants/{id}", {
        params: { path: { id } },
      });
      if (!response.ok) throw errorFromBody(response.status, error);
    },
  };
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
