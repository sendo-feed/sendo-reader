/**
 * core が SQLite に触れる窓口（docs/decisions/local-first.md）。
 *
 * Web は Wasm の SQLite（sqlite-wasm.ts）、ネイティブは Capacitor で包むときに別の実装を差し込む。
 * ネイティブの SQLite はたいてい非同期なので、窓口は Promise で返す。
 */

/** 列の値。整数の時刻はミリ秒の数で持つ */
export type SqlValue = string | number | null;

export type Row = Record<string, SqlValue>;

/** 1 つの文を実行する */
export interface Executor {
  /** 行を返さない文を実行する。1 回に 1 つの文だけを渡す */
  run(sql: string, params?: readonly SqlValue[]): Promise<void>;
  /** 行を返す文を実行する */
  all<T extends Row>(sql: string, params?: readonly SqlValue[]): Promise<T[]>;
}

export interface Database extends Executor {
  /**
   * 渡した関数を 1 つのトランザクションで実行する。関数が投げたら巻き戻す。
   *
   * トランザクションの間は、ほかの読み書きを待たせる。中で通信を待たないこと
   * （そのあいだ画面の読み出しも止まる）。中では Database ではなく、渡された tx を使う。
   */
  transaction<T>(fn: (tx: Executor) => Promise<T>): Promise<T>;
}
