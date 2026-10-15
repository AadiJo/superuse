// Client registration, through each client's own CLI. Setup only touches bcu's own entries: the
// Claude marketplace "better-computer-use" with plugin bcu, Codex's MCP server "bcu", and the
// skill link ~/.agents/skills/computer-use. If replacing one fails, the previous one is restored.
//
// Claude Code loads a directory marketplace's plugins in place (`claude plugin list --json`
// reports readFromFolder), so the checkout is what runs. Its cache keeps a copy for bookkeeping
// only; setup never edits or links it.

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { EXE } from "./driver.ts";
import { LAUNCHER, PLUGIN, REPO, VERSION, run, sha256File, type Check } from "./lib.ts";

export const CLIENTS = ["claude", "codex"] as const;
export type Client = (typeof CLIENTS)[number];

const MARKETPLACE = "better-computer-use";
const PLUGIN_ID = `bcu@${MARKETPLACE}`;
const SKILL_SOURCE = path.join(PLUGIN, "skills", "computer-use");
const SKILL_LINK = path.join(os.homedir(), ".agents", "skills", "computer-use");

export function installed(client: Client): boolean {
  return run(client, ["--version"]).code === 0;
}

/** Parse a CLI's --json output; null when the command failed or printed something else. */
function json<T>(client: Client, args: string[]): T | null {
  const r = run(client, args);
  if (r.code !== 0) return null;
  try { return JSON.parse(r.stdout) as T; } catch { return null; }
}

// --- Claude Code ---------------------------------------------------------------------------

type ClaudeMarketplace = { name: string; source?: string; path?: string };
type ClaudePlugin = { id: string; version?: string; scope?: string; enabled?: boolean; installPath?: string; readFromFolder?: string };

function claudeState() {
  const market = json<ClaudeMarketplace[]>("claude", ["plugin", "marketplace", "list", "--json"])?.find((m) => m.name === MARKETPLACE);
  const plugins = json<ClaudePlugin[]>("claude", ["plugin", "list", "--json"]) ?? [];
  return { market, plugin: plugins.find((p) => p.id === PLUGIN_ID && p.scope === "user"), others: plugins.filter((p) => p.id.startsWith("bcu@") && p.id !== PLUGIN_ID) };
}

/** What Claude would run, checked as a package: version, launcher, dependencies and driver. */
function checkPackage(dir: string): string[] {
  const problems: string[] = [];
  let version = "";
  try { version = (JSON.parse(fs.readFileSync(path.join(dir, ".claude-plugin", "plugin.json"), "utf8")) as { version: string }).version; } catch { /* reported below */ }
  if (version !== VERSION) problems.push(`version ${version || "unreadable"}, expected ${VERSION}`);
  try { fs.accessSync(path.join(dir, "server", "run.sh"), fs.constants.X_OK); } catch { problems.push("server/run.sh is missing or not executable"); }
  if (!fs.existsSync(path.join(dir, "server", "node_modules", "quickjs-emscripten"))) problems.push("server dependencies are missing");
  if (!process.env.BCU_CUA_DRIVER && sha256File(path.join(dir, "driver", "cua-driver.exe")) !== sha256File(EXE)) problems.push("its driver differs from this checkout's");
  return problems;
}

export function checkClaude(changed = false): Check {
  const id = "client:claude";
  const { market, plugin, others } = claudeState();
  const evidence = others.map((p) => `another bcu plugin is installed: ${p.id}`);
  if (!market || !plugin) return { id, status: "action", code: "CLAUDE_NOT_REGISTERED", summary: "bcu isn't installed in Claude Code", evidence, next: "Run scripts/install.sh --clients=claude." };
  if (path.resolve(market.path ?? "") !== REPO) return { id, status: "action", code: "CLAUDE_OTHER_CHECKOUT", summary: `Claude's marketplace points at ${market.path ?? market.source}`, evidence, next: "Run scripts/install.sh --clients=claude from this checkout to point it here." };
  if (plugin.enabled === false) return { id, status: "action", code: "CLAUDE_DISABLED", summary: "the bcu plugin is disabled", evidence, next: `Run claude plugin enable ${PLUGIN_ID}.` };
  const dir = plugin.readFromFolder ?? plugin.installPath ?? "";
  if (plugin.version !== VERSION) evidence.push(`Claude recorded version ${plugin.version}, checkout is ${VERSION}`);
  const problems = checkPackage(dir);
  if (problems.length || plugin.version !== VERSION) {
    return { id, status: "action", code: "CLAUDE_STALE", summary: `the plugin Claude loads (${dir}) isn't current`, evidence: [...evidence, ...problems], next: "Run scripts/install.sh --clients=claude." };
  }
  evidence.push(`loads ${dir}`);
  return changed
    ? { id, status: "restart", code: "CLAUDE_RESTART", summary: `plugin ${VERSION} registered`, evidence, next: "Start a new Claude Code session (or run /reload-plugins) to load it." }
    : { id, status: "ok", code: "CLAUDE_CURRENT", summary: `plugin ${VERSION} installed`, evidence };
}

export function installClaude(): Check {
  const id = "client:claude";
  const before = claudeState();
  let changed = false;
  const fail = (what: string, r: { stderr: string; stdout: string }): Check => {
    // Point the marketplace back where it was, so a half-finished move doesn't strand the plugin.
    if (before.market?.path && path.resolve(before.market.path) !== REPO) run("claude", ["plugin", "marketplace", "add", before.market.path]);
    return { id, status: "fail", code: "CLAUDE_INSTALL_FAILED", summary: `${what} failed`, evidence: [(r.stderr || r.stdout).trim()], next: "Fix the error above and rerun scripts/install.sh." };
  };
  if (path.resolve(before.market?.path ?? "") !== REPO) {
    const r = run("claude", ["plugin", "marketplace", "add", REPO]); // also repoints a moved checkout
    if (r.code !== 0) return fail("claude plugin marketplace add", r);
    changed = true;
  }
  if (!before.plugin) {
    const r = run("claude", ["plugin", "install", PLUGIN_ID, "--scope", "user"]);
    if (r.code !== 0) return fail("claude plugin install", r);
    changed = true;
  } else if (before.plugin.version !== VERSION) {
    let r = run("claude", ["plugin", "marketplace", "update", MARKETPLACE]);
    if (r.code === 0) r = run("claude", ["plugin", "update", PLUGIN_ID, "--scope", "user"]);
    if (r.code !== 0) return fail("claude plugin update", r);
    changed = true;
  }
  return checkClaude(changed);
}

// --- Codex -----------------------------------------------------------------------------------

type CodexServer = { name: string; transport?: { type?: string; command?: string; args?: string[]; env?: Record<string, string> | null } };

function codexServer(): CodexServer | null {
  return json<CodexServer>("codex", ["mcp", "get", "bcu", "--json"]);
}

/** Other Codex servers that run a bcu launcher or server: leftovers from older installs. */
function codexDuplicates(): string[] {
  const all = json<CodexServer[]>("codex", ["mcp", "list", "--json"]) ?? [];
  return all
    .filter((s) => s.name !== "bcu" && [s.transport?.command, ...(s.transport?.args ?? [])].some((a) => /plugin\/server\/(run\.sh|main\.ts)$/.test(a ?? "")))
    .map((s) => `Codex server "${s.name}" also runs bcu (${s.transport?.command}); remove it with codex mcp remove ${s.name}`);
}

type SkillLink = "current" | "missing" | "stale" | "conflict";

/** ~/.agents/skills/computer-use: ours if it's a link to some checkout's plugin skill. */
function skillLink(): SkillLink {
  let target: string;
  try { target = fs.readlinkSync(SKILL_LINK); } catch (e) {
    return (e as NodeJS.ErrnoException).code === "ENOENT" ? "missing" : "conflict";
  }
  if (path.resolve(path.dirname(SKILL_LINK), target) === SKILL_SOURCE) return "current";
  return target.endsWith(path.join("plugin", "skills", "computer-use")) ? "stale" : "conflict";
}

export function checkCodex(changed = false): Check {
  const id = "client:codex";
  const server = codexServer();
  const evidence = codexDuplicates();
  const link = skillLink();
  if (!server) return { id, status: "action", code: "CODEX_NOT_REGISTERED", summary: "bcu isn't registered in Codex", evidence, next: "Run scripts/install.sh --clients=codex." };
  if (server.transport?.command !== LAUNCHER || (server.transport.args ?? []).length) {
    return { id, status: "action", code: "CODEX_STALE", summary: `Codex's bcu server runs ${server.transport?.command}`, evidence, next: "Run scripts/install.sh --clients=codex." };
  }
  if (link === "missing" || link === "stale") return { id, status: "action", code: "CODEX_SKILL_MISSING", summary: "the computer-use skill isn't linked for Codex", evidence, next: "Run scripts/install.sh --clients=codex." };
  if (link === "conflict") return { id, status: "action", code: "CODEX_SKILL_CONFLICT", summary: `${SKILL_LINK} holds something else, so Codex won't load bcu's skill; bcu left it alone`, evidence, next: `Move it away if it isn't needed, then rerun scripts/install.sh --clients=codex. The MCP server works without the skill.` };
  evidence.push(`runs ${LAUNCHER}`, `skill ${SKILL_LINK}`);
  return changed
    ? { id, status: "restart", code: "CODEX_RESTART", summary: "MCP server bcu registered", evidence, next: "Start a new Codex session to load it." }
    : { id, status: "ok", code: "CODEX_CURRENT", summary: "MCP server bcu registered", evidence };
}

export function installCodex(): Check {
  const id = "client:codex";
  const before = codexServer();
  let changed = false;
  if (before?.transport?.command !== LAUNCHER || (before.transport.args ?? []).length) {
    if (before) run("codex", ["mcp", "remove", "bcu"]);
    const r = run("codex", ["mcp", "add", "bcu", "--", LAUNCHER]);
    if (r.code !== 0) {
      const t = before?.transport;
      if (t?.command) run("codex", ["mcp", "add", "bcu", ...Object.entries(t.env ?? {}).flatMap(([k, v]) => ["--env", `${k}=${v}`]), "--", t.command, ...(t.args ?? [])]);
      return { id, status: "fail", code: "CODEX_INSTALL_FAILED", summary: "codex mcp add failed; the previous entry was restored", evidence: [(r.stderr || r.stdout).trim()], next: "Fix the error above and rerun scripts/install.sh." };
    }
    changed = true;
  }
  const link = skillLink();
  if (link === "missing" || link === "stale") {
    fs.mkdirSync(path.dirname(SKILL_LINK), { recursive: true });
    if (link === "stale") fs.unlinkSync(SKILL_LINK);
    fs.symlinkSync(SKILL_SOURCE, SKILL_LINK);
    changed = true;
  }
  return checkCodex(changed);
}

export const checkClient = (c: Client) => (c === "claude" ? checkClaude() : checkCodex());
export const installClient = (c: Client) => (c === "claude" ? installClaude() : installCodex());
