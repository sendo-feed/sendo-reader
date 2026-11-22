import { type ChildProcess, spawn } from "node:child_process";
import { request as httpRequest } from "node:http";
import { fileURLToPath } from "node:url";
import { expect } from "@playwright/test";

/**
 * 手元の Vite の preview を、X の投稿の隔離フレームのオリジン（X_EMBED_ORIGIN）付きで動かす
 * （docs/decisions/embeds.md の 3。開発用の http://127.0.0.1 を、reader の localhost と違うホスト名として使う）
 */

const APP = fileURLToPath(new URL("..", import.meta.url));
const VITE = fileURLToPath(new URL("../node_modules/vite/bin/vite.js", import.meta.url));

export type RunningPreview = { stop: () => Promise<void> };

function status(port: number): Promise<number> {
  return new Promise((resolve) => {
    const request = httpRequest(`http://localhost:${port}/`, (response) => {
      response.resume();
      resolve(response.statusCode ?? 0);
    });
    request.on("error", () => resolve(0));
    request.end();
  });
}

export async function startPreview(
  port: number,
  env: Record<string, string>,
): Promise<RunningPreview> {
  const child: ChildProcess = spawn(
    process.execPath,
    [VITE, "preview", "--port", String(port), "--strictPort"],
    { cwd: APP, env: { ...process.env, ...env }, stdio: ["ignore", "pipe", "pipe"] },
  );
  let output = "";
  const collect = (chunk: Buffer) => {
    output += chunk.toString();
  };
  child.stdout?.on("data", collect);
  child.stderr?.on("data", collect);
  const stop = async () => {
    if (child.exitCode !== null || child.signalCode !== null) return;
    const exited = new Promise((resolve) => child.once("exit", resolve));
    child.kill("SIGTERM");
    await exited;
  };
  try {
    await expect
      .poll(
        () => {
          // 起動に失敗したら（ポートが埋まっている、など）、待たずに落とす
          if (child.exitCode !== null) throw new Error(`preview exited:\n${output}`);
          return status(port);
        },
        { timeout: 30_000 },
      )
      .toBe(200);
  } catch (error) {
    await stop();
    throw error;
  }
  return { stop };
}
