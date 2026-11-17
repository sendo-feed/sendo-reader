/** トークンと OAuth の許可の、管理一覧に必要な情報。秘密は含めない */
export interface ConnectionRow {
  id: string;
  name: string;
  detail?: string | null;
  note?: string | undefined;
  access: string;
  createdAt: number;
  lastUsedAt: number | null;
}
