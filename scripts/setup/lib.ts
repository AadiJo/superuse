// Shared pieces of scripts/setup.ts: the report's check type, command running with a log, and
// small file helpers. Every module returns Check values; setup.ts renders them.

import { spawnSync, type SpawnSyncOptions } from "node:child_process";
import { createHash } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

/** ok: works. restart: works once the client starts a new session. action: the user (or their
 *  agent) must do something. fail: broken. skip: not requested or not reached. */
export type Status = "ok" | "restart" | "action" | "fail" | "skip";

/** One line of the report. `code` is stable for scripts; `summary` is for people. */
export type Check = {
  id: string;
  status: Status;
  code: string;
  summary: string;
  evidence?: string[];
  next?: string;
  ms?: number;
};

export const REPO = path.resolve(import.meta.dirname, "..", "..");
export const PLUGIN = path.join(REPO, "plugin");
export const LAUNCHER = path.join(PLUGIN, "server", "run.sh");
export const CONFIG_DIR = path.join(os.homedir(), ".config", "superuse");
export const NODE_RECORD = path.join(CONFIG_DIR, "node-path");

export const VERSION: string = readJson<{ version: string }>(path.join(PLUGIN, ".claude-plugin", "plugin.json")).version;

/** Every external command setup ran, in order. The JSON report includes it, so a test can prove
 *  what a run did (no download, no registration) without parsing human text. */
export const commandLog: string[] = [];

export type Run = { code: number; stdout: string; stderr: string };

/** Run a command to completion. A missing executable is code 127, like a shell. The log keeps the
 *  names of `--env KEY=VALUE` arguments but not their values, which can be secrets. */
export function run(cmd: string, args: string[], opts: SpawnSyncOptions = {}): Run {
  const shown = args.map((a, i) => (args[i - 1] === "--env" ? `${a.split("=")[0]}=<value>` : a));
  commandLog.push([cmd, ...shown].map((a) => (/^[\w./:=,@+<>-]+$/.test(a) ? a : JSON.stringify(a))).join(" "));
  const r = spawnSync(cmd, args, { encoding: "utf8", maxBuffer: 64 << 20, ...opts });
  if (r.error) return { code: 127, stdout: "", stderr: r.error.message };
  return { code: r.status ?? 1, stdout: String(r.stdout ?? ""), stderr: String(r.stderr ?? "") };
}

export function readJson<T>(file: string): T {
  return JSON.parse(fs.readFileSync(file, "utf8")) as T;
}

export function sha256(data: Buffer | string): string {
  return createHash("sha256").update(data).digest("hex");
}

export function sha256File(file: string): string | null {
  try { return sha256(fs.readFileSync(file)); } catch { return null; }
}

/** Write through a temporary file and rename, so readers never see half a file. */
export function writeAtomic(file: string, data: string | Buffer, mode?: number) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, data, mode === undefined ? undefined : { mode });
  fs.renameSync(tmp, file);
}

/** Time a check. */
export async function timed(check: () => Check | Promise<Check>): Promise<Check> {
  const started = performance.now();
  const c = await check();
  return { ...c, ms: Math.round(performance.now() - started) };
}

const CMD = "/mnt/c/Windows/System32/cmd.exe";

/** A Windows environment variable through WSL interop ("TEMP", "LOCALAPPDATA"), as a WSL path.
 *  cmd.exe can't start in a WSL directory, so it runs from C:\. */
export function windowsDir(name: string): string | null {
  const r = run(CMD, ["/d", "/c", `echo %${name}%`], { cwd: "/mnt/c" });
  const win = r.stdout.trim();
  if (r.code !== 0 || !win || win.includes("%")) return null;
  const wsl = run("wslpath", ["-u", win]);
  return wsl.code === 0 ? wsl.stdout.trim() : null;
}
