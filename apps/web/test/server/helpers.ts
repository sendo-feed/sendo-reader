import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import path from "node:path";
import { serve } from "@hono/node-server";
import { createReaderServer } from "../../server/app";
import { loadAssets } from "../../server/assets";
import type { Assets } from "../../server/static";

/** 画面のビルドに見立てたファイルを置き、読み込む */
export async function fixtureAssets(files: Record<string, string | Uint8Array>): Promise<Assets> {
  const directory = await mkdtemp(path.join(tmpdir(), "sendo-reader-dist-"));
  try {
    for (const [name, content] of Object.entries(files)) {
      const file = path.join(directory, name);
      await mkdir(path.dirname(file), { recursive: true });
      await writeFile(file, content);
    }
    return await loadAssets(directory);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}

/** 偽の sendo が受けたリクエスト */
export type ReceivedRequest = {
  method: string;
  url: string;
  headers: IncomingMessage["headers"];
  rawHeaders: string[];
  body: Buffer;
};

export type FakeSendo = {
  origin: string;
  received: ReceivedRequest[];
  close: () => Promise<void>;
};

/** 本物の HTTP で答える偽の sendo。答え方は handler で決める */
export async function startFakeSendo(
  handler: (request: ReceivedRequest, response: ServerResponse) => void | Promise<void>,
): Promise<FakeSendo> {
  const received: ReceivedRequest[] = [];
  const server = createServer(async (req, res) => {
    const chunks: Buffer[] = [];
    for await (const chunk of req) chunks.push(chunk as Buffer);
    const request: ReceivedRequest = {
      method: req.method ?? "",
      url: req.url ?? "",
      headers: req.headers,
      rawHeaders: req.rawHeaders,
      body: Buffer.concat(chunks),
    };
    received.push(request);
    await handler(request, res);
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address() as AddressInfo;
  return {
    origin: `http://127.0.0.1:${port}`,
    received,
    close: () =>
      new Promise((resolve) => {
        server.closeAllConnections();
        server.close(() => resolve());
      }),
  };
}

export type RunningReader = { origin: string; close: () => Promise<void> };

/** reader のサーバーを、本番と同じく @hono/node-server で動かす */
export async function startReader(assets: Assets, sendoOrigin: string): Promise<RunningReader> {
  const app = createReaderServer({ assets, sendoOrigin });
  const { server, port } = await new Promise<{ server: ReturnType<typeof serve>; port: number }>(
    (resolve) => {
      const started = serve({ fetch: app.fetch, port: 0, hostname: "127.0.0.1" }, (info) =>
        resolve({ server: started, port: info.port }),
      );
    },
  );
  return {
    origin: `http://127.0.0.1:${port}`,
    close: () =>
      new Promise((resolve) => {
        if ("closeAllConnections" in server) server.closeAllConnections();
        server.close(() => resolve());
      }),
  };
}

export const INDEX_HTML = "<!doctype html><title>Sendo</title>";
