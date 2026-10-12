// Benchmark copy of ~/.local/bin/codex-cu-mcp with browser backends disabled. The claude-codexcu
// arm in run.ts registers it as the "cu" MCP server; latency.ts drives it directly.
//
//   node bench/codex-cu-bridge.ts      (stdio MCP server; CODEX_CU_AUTO_APPROVE=1 for headless runs)
//
// Exposes Windows Codex's Computer Use MCP server (cua_repl + @oai/sky) to WSL. Each start re-reads
// the newest `unified-computer-use/<version>/.mcp.json` written by the Windows Codex app, so Codex
// updates that move the bundled runtime keep working. The app ships cua_repl with only the
// "browser" surface; this turns on "computer" (Windows desktop control via @oai/sky) and runs it
// without the Codex app: sky spawns its own codex-computer-use.exe helper.
//
// It also proxies stdio to fix app approvals. Sky asks "Allow Codex to use <app>?" through an MCP
// elicitation on every helper request, relying on the Codex client to remember "allow for this
// session". This proxy plays that role: the first request per app goes to the MCP client, and an
// accept is remembered for the life of the server (one Claude session). CODEX_CU_AUTO_APPROVE=1
// approves every app without asking, for headless runs (`claude -p`) that can't show a dialog.

import { execFileSync, spawn } from "node:child_process";
import { readdirSync, readFileSync, statSync } from "node:fs";
import path from "node:path";
import { createInterface } from "node:readline";

type CuaRepl = { command: string; args?: string[]; env?: Record<string, string> };
type RpcId = number | string;
type Rpc = {
  jsonrpc?: string;
  id?: RpcId;
  method?: string;
  params?: { message?: string; _meta?: { connector_id?: string; tool_params?: { app?: unknown } } };
  result?: { action?: string };
};

/** Run a command and return its trimmed stdout. stdin must be closed: WSL interop relays our stdin
 * into Windows children, which would swallow the MCP client's initialize request. */
const run = (command: string, args: string[], cwd?: string) =>
  execFileSync(command, args, { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();

const wslpath = (windowsPath: string) => run("wslpath", ["-u", windowsPath]);
const isFile = (p: string) => statSync(p, { throwIfNoEntry: false })?.isFile() ?? false;

/** %USERPROFILE% of the Windows user that owns this WSL session. */
function windowsProfile(): string {
  return process.env.CODEX_CU_WINDOWS_PROFILE
    ?? wslpath(run("/mnt/c/Windows/System32/cmd.exe", ["/d", "/c", "echo %USERPROFILE%"], "/mnt/c"));
}

/** Versions look like 26.930.31730; compare them numerically, part by part. */
function compareVersions(a: string, b: string): number {
  const key = (v: string) => v.split(".").map((x) => (/^\d+$/.test(x) ? Number(x) : -1));
  const [ka, kb] = [key(a), key(b)];
  for (let i = 0; i < Math.min(ka.length, kb.length); i++) if (ka[i] !== kb[i]) return ka[i] - kb[i];
  return ka.length - kb.length;
}

function newestMcpJson(profile: string): string {
  const root = path.join(profile, ".codex/plugins/cache/openai-bundled/unified-computer-use");
  const versions = statSync(root, { throwIfNoEntry: false })?.isDirectory()
    ? readdirSync(root).filter((v) => isFile(path.join(root, v, ".mcp.json")))
    : [];
  if (!versions.length) {
    console.error(`codex-cu-mcp: no unified-computer-use plugin under ${root}. Install or open the Codex Windows app first.`);
    process.exit(1);
  }
  const newest = versions.reduce((best, v) => (compareVersions(v, best) > 0 ? v : best));
  return path.join(root, newest, ".mcp.json");
}

/** The Codex app's cua_repl env, adjusted to run desktop control standalone. */
function serverEnv(server: CuaRepl): NodeJS.ProcessEnv {
  const env = { ...server.env };
  env.CUA_REPL_ENABLED_SURFACES = process.env.CODEX_CU_SURFACES ?? "computer";
  // Let cua-repl derive trusted services from the surfaces (adds @oai/sky/service).
  delete env.NODE_REPL_TRUSTED_SERVICES;
  // The native pipe belongs to a running Codex app; without it sky spawns its own helper.
  delete env.SKY_CUA_NATIVE_PIPE;
  delete env.SKY_CUA_NATIVE_PIPE_DIRECTORY;
  // With CODEX_CLI_PATH set, node_repl starts its JS kernel inside Codex's Windows sandbox, which
  // fails outside the app (CreateProcessWithLogonW 1056). Claude's own shell is already
  // unsandboxed, so run the kernel directly.
  delete env.CODEX_CLI_PATH;
  // Benchmark copy: browser tab records are redacted on the way out (redactTabs). Clearing
  // BROWSER_USE_AVAILABLE_BACKENDS / BROWSER_USE_TINYSKY_ENABLED instead broke
  // computer.launch_app ("accessibility window-opened handler did not become ready").
  // WSL only forwards variables named in WSLENV to Windows processes.
  const forwarded = [...(process.env.WSLENV ?? "").split(":").filter(Boolean), ...Object.keys(env)];
  return { ...process.env, ...env, WSLENV: forwarded.join(":") };
}

// Benchmark guard: browser tab records (they carry "lastOpened" or "providerTabId" values) never
// leave this bridge with their titles or URLs, even if a browser backend is reachable.
const TAB_RECORD = /\{[^{}]*(?:lastOpened|providerTabId)\\?"\s*:\s*\\?"[^{}]*\}/g;
const TAB_FIELD = /(\\?"(?:url|title)\\?"\s*:\s*\\?")(?:[^"\\]|\\(?!"))*(\\?")/g;

const redactTabs = (line: string) => line.replace(TAB_RECORD, (record) => record.replace(TAB_FIELD, "$1<redacted>$2"));

function parse(line: string): Rpc | null {
  try {
    const msg: unknown = JSON.parse(line);
    // Only JSON-RPC objects are inspected; anything else passes through untouched.
    return typeof msg === "object" && msg !== null && !Array.isArray(msg) ? msg : null;
  } catch {
    return null;
  }
}

/** App id when msg is sky's "Allow Codex to use <app>?" elicitation. */
function approvalApp(msg: Rpc): string | null {
  if (msg.method !== "elicitation/create" || msg.id === undefined) return null;
  const meta = msg.params?._meta;
  const app = meta?.tool_params?.app;
  return meta?.connector_id === "computer-use" && typeof app === "string" ? app : null;
}

const profile = windowsProfile();
const { mcpServers: { cua_repl: server } }: { mcpServers: { cua_repl: CuaRepl } } = JSON.parse(readFileSync(newestMcpJson(profile), "utf8"));
const child = spawn(wslpath(server.command), server.args ?? [], {
  env: serverEnv(server),
  cwd: profile, // A Windows cwd avoids \\wsl.localhost UNC working directories.
  stdio: ["pipe", "pipe", "inherit"],
});
child.on("error", (e) => {
  console.error(`codex-cu-mcp: couldn't start cua_repl: ${e.message}`);
  process.exit(1);
});
child.stdin.on("error", () => {}); // the child exiting first ends this process below
child.on("close", (code) => process.exit(code ?? 1));

// Relay newline-delimited JSON-RPC between the MCP client and cua_repl, answering repeat Computer
// Use app approvals from a per-session memory.
const autoApprove = process.env.CODEX_CU_AUTO_APPROVE === "1";
const approvedApps = new Set<string>();
const pending = new Map<RpcId, string>(); // forwarded elicitation id -> app id
const toChild = (line: string) => child.stdin.write(line + "\n");
const toClient = (line: string) => process.stdout.write(line + "\n");

createInterface({ input: process.stdin })
  .on("line", (line) => {
    const msg = parse(line);
    const app = msg && msg.method === undefined && msg.id !== undefined ? pending.get(msg.id) : undefined;
    if (msg?.id !== undefined && app !== undefined) {
      pending.delete(msg.id);
      if (msg.result?.action === "accept") approvedApps.add(app);
    }
    toChild(line);
  })
  .on("close", () => child.stdin.end());

createInterface({ input: child.stdout }).on("line", (line) => {
  const msg = parse(line);
  const app = msg && approvalApp(msg);
  if (!msg || msg.id === undefined || app === null) {
    toClient(redactTabs(line));
  } else if (autoApprove || approvedApps.has(app)) {
    toChild(JSON.stringify({ jsonrpc: "2.0", id: msg.id, result: { action: "accept", content: {} } }));
  } else {
    pending.set(msg.id, app);
    if (msg.params && typeof msg.params.message === "string") {
      msg.params.message = msg.params.message.replaceAll("Allow Codex to use", "Allow Claude to use") + " (Windows Computer Use, remembered for this session)";
    }
    toClient(JSON.stringify(msg));
  }
});
