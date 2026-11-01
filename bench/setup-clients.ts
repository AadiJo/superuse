// Real clients calling an installed superuse launcher, for bench/setup-check.ts --clients.
//
// Each client edits a TestPad built for the run, through the server command an isolated install
// registered, and the file on disk is the verdict. The client runs with that install's HOME, so
// the launcher finds Node the way it would for that user. Sign-in comes from the user's own
// client config, so the server is passed for this run only (Claude: --strict-mcp-config
// --mcp-config; Codex: -c overrides) and no client config changes.
// A client that can't sign in is "blocked", not a pass or a failure of superuse.

import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { withTestPad } from "../scripts/setup/verify.ts";

export type ClientRun = { ok: boolean; blocked: boolean; detail: string };

/** Signs that a client never reached the model: the run says nothing about superuse. */
const AUTH_FAILURE = /401 Unauthorized|invalid_refresh_token|Missing environment variable|Not logged in|Please run \/login|sign in again/i;

function runClient(cmd: string, args: string[], home: string, transcript: string, timeoutMs = 300_000): Promise<string> {
  return new Promise((resolve) => {
    // Sign-in stays in the real config dirs, named explicitly because HOME no longer points at them.
    const login = { CLAUDE_CONFIG_DIR: process.env.CLAUDE_CONFIG_DIR ?? path.join(os.homedir(), ".claude"), CODEX_HOME: process.env.CODEX_HOME ?? path.join(os.homedir(), ".codex") };
    // No superuse overrides from this shell: the server must run on what the install recorded.
    const env = Object.fromEntries(Object.entries(process.env).filter(([k]) => !k.startsWith("SUPERUSE_")));
    const proc = spawn(cmd, args, { stdio: ["ignore", "pipe", "pipe"], env: { ...env, ...login, HOME: home, MCP_TIMEOUT: "120000" } });
    let out = "";
    proc.stdout.on("data", (d: Buffer) => (out += d));
    proc.stderr.on("data", (d: Buffer) => (out += d));
    const timer = setTimeout(() => proc.kill("SIGKILL"), timeoutMs);
    proc.on("close", () => {
      clearTimeout(timer);
      fs.writeFileSync(transcript, out);
      resolve(out);
    });
  });
}

/** `command` is the server command the isolated registration holds; `home` is that user's HOME. */
export async function verifyClientRun(client: "claude" | "codex", command: string, home: string, dir: string): Promise<ClientRun> {
  if (!command) return { ok: false, blocked: false, detail: `the isolated ${client} registration has no superuse server command` };
  fs.mkdirSync(dir, { recursive: true });
  const expected = `superuse client check ${randomUUID().slice(0, 8)}`;
  const env = { SUPERUSE_APPS: "TestPad", SUPERUSE_AUDIT: "off" }; // headless runs can't show the approval prompt
  return withTestPad(async ({ pid, file }) => {
    const prompt = `A TestPad text editor window (process id ${pid}) is open with notes.txt. Using the superuse js tool, replace all of its text with exactly: ${expected}\nThen save with ctrl+s and check the title lost its "*". Reply DONE when saved.`;
    const transcript = path.join(dir, "transcript.jsonl");
    const out = client === "claude"
      ? await runClient("claude", ["-p", prompt, "--strict-mcp-config", "--mcp-config", JSON.stringify({ mcpServers: { superuse: { command, env } } }),
        "--allowedTools", "mcp__superuse__js", "--tools", "", "--output-format", "stream-json", "--verbose", "--no-session-persistence", "--setting-sources", "user"], home, transcript)
      : await runClient("codex", ["exec", "--skip-git-repo-check", "--ephemeral", "--json", "-s", "read-only",
        "-c", `mcp_servers.superuse.command=${JSON.stringify(command)}`,
        "-c", `mcp_servers.superuse.env={${Object.entries(env).map(([k, v]) => `${k}=${JSON.stringify(v)}`).join(",")}}`,
        "-c", `mcp_servers.superuse.default_tools_approval_mode="approve"`, prompt], home, transcript);
    const saved = fs.readFileSync(file, "utf8");
    if (saved === expected) return { ok: true, blocked: false, detail: `${client} saved the exact text; transcript ${transcript}` };
    if (AUTH_FAILURE.test(out)) return { ok: false, blocked: true, detail: `${client} couldn't sign in with this shell's login: ${out.match(AUTH_FAILURE)?.[0]}; transcript ${transcript}` };
    return { ok: false, blocked: false, detail: `file holds ${JSON.stringify(saved.slice(0, 80))}; transcript ${transcript}` };
  });
}
