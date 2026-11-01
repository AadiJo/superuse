// End-to-end checks of scripts/install.sh and scripts/doctor.sh, run against fresh clones in
// isolated client configuration. Nothing here touches the user's Claude, Codex or superuse settings.
//
//   node bench/setup-check.ts [--build] [--browser] [--clients]
//
// Writes bench/out/setup-<time>/: report.json (every case), one folder per case with the setup
// JSON reports and command logs, versions.json (tool versions, driver hashes), and transcripts
// for --clients. Exits 1 on any failure; cases that can't run here are reported as blocked.
//
// How setup can fail, and the case that guards against it:
//   fresh        a machine without Node 24 or Rust: Node and the driver must download, nothing builds,
//                both clients register, the server starts with PATH=/usr/bin:/bin from a path with spaces
//   clients      a registration that points somewhere else, or a launcher that only works from a shell
//   rerun        a second run that re-downloads, re-registers or rewrites anything
//   checksum     a corrupt or substituted download that gets installed; a failure that sticks
//   auth         a private release without gh login that silently builds or breaks the old install
//   upgrade      an older recorded plugin version or driver that stays in use after an update
//   moved        a checkout moved elsewhere that clients keep pointing at
//   preserve     unrelated Codex servers, skills, policy settings or a hand-built driver that get replaced
//   malformed    a broken policy file that gets overwritten with defaults
//   no-release   changed driver sources that fall back to an unrelated binary
//   temporary    a git worktree that gets registered and later vanishes
//   app          a server that installs fine but can't drive a real app (doctor --verify, TestPad)
//   --build      a build from the changed sources that isn't recorded as theirs (slow: compiles Rust)
//   --browser    browser attach reported ready without driving a tab (uses the user's real policy, read-only)
//   --clients    a client that registers superuse but can't call it (runs Claude and Codex with the user's login)
//
// Prompt handling (unsupported, accepted, declined) is covered by bench/server-check.ts.

import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { parseArgs } from "node:util";
import { McpClient, textOf } from "./mcp-client.ts";
import { timestamp } from "./win.ts";

const REPO = path.dirname(import.meta.dirname);
const RUN = path.join(REPO, "bench", "out", `setup-${timestamp()}`);
const { values: flags } = parseArgs({ options: { build: { type: "boolean" }, browser: { type: "boolean" }, clients: { type: "boolean" } } });

type Status = "ok" | "restart" | "action" | "fail" | "skip";
type Check = { id: string; status: Status; code: string; summary: string };
type Report = { outcome: string; checks: Check[]; commands: string[] };
type Result = { case: string; ok: boolean | "blocked"; detail: string };
const results: Result[] = [];

function check(name: string, ok: boolean, detail: string) {
  results.push({ case: name, ok, detail: detail.slice(0, 600) });
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}: ${detail.slice(0, 200)}`);
}

function blocked(name: string, why: string) {
  results.push({ case: name, ok: "blocked", detail: why });
  console.log(`BLOCKED  ${name}: ${why}`);
}

const sh = (cmd: string, args: string[], opts: Parameters<typeof spawnSync>[2] = {}) => {
  const r = spawnSync(cmd, args, { encoding: "utf8", ...opts });
  return { code: r.status ?? 1, stdout: String(r.stdout ?? ""), stderr: String(r.stderr ?? "") };
};
const sha = (file: string) => { try { return createHash("sha256").update(fs.readFileSync(file)).digest("hex"); } catch { return null; } };

// --- isolation ---------------------------------------------------------------------------------

const realNode = process.execPath;
const realClaude = fs.realpathSync(sh("bash", ["-lc", "command -v claude"]).stdout.trim());
const codexJs = fs.realpathSync(sh("bash", ["-lc", "command -v codex"]).stdout.trim());
const realGhConfig = process.env.GH_CONFIG_DIR ?? path.join(os.homedir(), ".config", "gh");

/** A bin folder with claude and codex, but no node: codex runs through a wrapper with its own node. */
const SHIMS = path.join(RUN, "shims");
fs.mkdirSync(SHIMS, { recursive: true });
fs.symlinkSync(realClaude, path.join(SHIMS, "claude"));
fs.writeFileSync(path.join(SHIMS, "codex"), `#!/bin/sh\nexec ${JSON.stringify(realNode)} ${JSON.stringify(codexJs)} "$@"\n`, { mode: 0o755 });

/** Environment for one isolated user: their own HOME, Claude config, Codex home and policy. No
 *  node, cargo or inherited superuse/Claude/Codex variables. gh uses the real login unless `noAuth`. */
function userEnv(home: string, opts: { noAuth?: boolean; extra?: Record<string, string> } = {}): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {};
  for (const [k, v] of Object.entries(process.env)) if (!/^(SUPERUSE_|CLAUDE|CODEX_|GH_|NODE_|npm_)/.test(k)) env[k] = v;
  const noGh = path.join(RUN, "no-gh");
  fs.mkdirSync(noGh, { recursive: true });
  return {
    ...env, HOME: home, CLAUDE_CONFIG_DIR: path.join(home, ".claude"), CODEX_HOME: path.join(home, ".codex"),
    GH_CONFIG_DIR: opts.noAuth ? noGh : realGhConfig, PATH: `${SHIMS}:/usr/bin:/bin`, ...opts.extra,
  };
}

function newHome(name: string): string {
  const home = path.join(RUN, "homes", name);
  fs.mkdirSync(path.join(home, ".codex"), { recursive: true });
  return home;
}

function clone(name: string): string {
  const dir = path.join(RUN, name);
  const r = sh("git", ["clone", "-q", "--no-local", REPO, dir]);
  if (r.code !== 0) throw new Error(`clone failed: ${r.stderr}`);
  sh("git", ["-C", dir, "checkout", "-q", sh("git", ["-C", REPO, "rev-parse", "HEAD"]).stdout.trim()]);
  return dir;
}

let step = 0;
/** Run scripts/install.sh or doctor.sh with --json; keep its report, stderr and exit code. */
function setup(caseName: string, checkout: string, script: "install" | "doctor", env: NodeJS.ProcessEnv, args: string[] = []) {
  const r = sh(path.join(checkout, "scripts", `${script}.sh`), ["--json", ...args], { env, cwd: checkout, maxBuffer: 64 << 20 });
  const dir = path.join(RUN, caseName);
  fs.mkdirSync(dir, { recursive: true });
  const base = path.join(dir, `${String(++step).padStart(2, "0")}-${script}`);
  fs.writeFileSync(`${base}.json`, r.stdout);
  fs.writeFileSync(`${base}.stderr.txt`, r.stderr);
  let report: Report = { outcome: "unparseable", checks: [], commands: [] };
  try { report = JSON.parse(r.stdout) as Report; } catch { /* kept as unparseable */ }
  const codes = report.checks.map((c) => c.code);
  return { code: r.code, report, codes, has: (code: string) => codes.includes(code), ran: (re: RegExp) => report.commands.some((c) => re.test(c)), summary: `exit ${r.code} ${report.outcome} [${codes.join(" ")}]` };
}

/** Hashes of every file a rerun must leave alone. */
function snapshot(home: string, checkout: string): Record<string, string | null> {
  const files = [".claude/settings.json", ".claude/plugins/installed_plugins.json", ".claude/plugins/known_marketplaces.json", ".codex/config.toml", ".config/superuse/policy.json", ".config/superuse/node-path"].map((f) => path.join(home, f));
  files.push(path.join(checkout, "plugin/driver/superuse-driver.exe"), path.join(checkout, "plugin/driver/superuse-driver.json"));
  return Object.fromEntries(files.map((f) => [f, sha(f)]));
}

const claudeJson = <T>(env: NodeJS.ProcessEnv, args: string[]) => JSON.parse(sh("claude", args, { env }).stdout) as T;
const codexJson = <T>(env: NodeJS.ProcessEnv, args: string[]) => JSON.parse(sh("codex", args, { env }).stdout) as T;

const manifest = JSON.parse(fs.readFileSync(path.join(REPO, "driver", "release.json"), "utf8")) as { sha256: string; tag: string; fingerprint: string };

// --- cases --------------------------------------------------------------------------------------

const homeA = newHome("a");
const envA = userEnv(homeA);
const cloneA = clone("clone A");

{
  const r = setup("fresh", cloneA, "install", envA);
  check("fresh: outcome restart_required, exit 0", r.code === 0 && r.report.outcome === "restart_required", r.summary);
  const node = fs.readFileSync(path.join(homeA, ".config/superuse/node-path"), "utf8").trim();
  check("fresh: Node downloaded into superuse's own folder and recorded", node.startsWith(path.join(homeA, ".local/share/superuse/node/")), node);
  check("fresh: driver downloaded, nothing built", r.has("DRIVER_DOWNLOADED") && !r.ran(/build\.sh/) && sha(path.join(cloneA, "plugin/driver/superuse-driver.exe")) === manifest.sha256, r.summary);
  check("fresh: both clients registered", r.has("CLAUDE_RESTART") && r.has("CODEX_RESTART"), r.summary);
  check("fresh: server verified through the launcher", r.has("SERVER_VERIFIED"), r.summary);
}

{
  const plugin = claudeJson<Array<{ id: string; version: string; readFromFolder?: string; mcpServers?: Record<string, { command: string }> }>>(envA, ["plugin", "list", "--json"]).find((p) => p.id === "superuse@superuse");
  check("clients: Claude loads this checkout's plugin", plugin?.readFromFolder === path.join(cloneA, "plugin") && plugin.version === manifestVersion(cloneA), JSON.stringify(plugin ?? null).slice(0, 300));
  const codex = codexJson<{ transport: { command: string } }>(envA, ["mcp", "get", "superuse", "--json"]);
  const launcher = path.join(cloneA, "plugin/server/run.sh");
  check("clients: Codex runs this checkout's launcher", codex.transport.command === launcher, codex.transport.command);
  check("clients: Codex skill linked", fs.readlinkSync(path.join(homeA, ".agents/skills/computer-use")) === path.join(cloneA, "plugin/skills/computer-use"), "");
  // Start each client's registered command the way the client would: no shell, minimal PATH.
  const claudeCmd = plugin?.mcpServers?.computer?.command.replace("${CLAUDE_PLUGIN_ROOT}", plugin.readFromFolder ?? "") ?? "";
  for (const [client, cmd] of [["Claude", claudeCmd], ["Codex", codex.transport.command]] as const) {
    try {
      // Overrides from this shell would hide a broken recorded Node or installed driver.
      const clean = { SUPERUSE_NODE: undefined, SUPERUSE_DRIVER: undefined, SUPERUSE_APPS: undefined, SUPERUSE_POLICY: undefined };
      await using c = await McpClient.start([cmd], { env: { ...clean, HOME: homeA, PATH: "/usr/bin:/bin", SUPERUSE_AUDIT: "off" }, elicit: "unsupported" });
      const { result } = await c.call("js", { code: "return (await desktop.windows()).length" }, 30_000);
      check(`clients: ${client}'s registered command answers with PATH=/usr/bin:/bin`, /^\d+$/.test(textOf(result)), textOf(result));
    } catch (e) {
      check(`clients: ${client}'s registered command answers with PATH=/usr/bin:/bin`, false, String(e));
    }
  }
}

function manifestVersion(checkout: string): string {
  return (JSON.parse(fs.readFileSync(path.join(checkout, "plugin/.claude-plugin/plugin.json"), "utf8")) as { version: string }).version;
}

{
  const before = snapshot(homeA, cloneA);
  const r = setup("rerun", cloneA, "install", envA);
  const after = snapshot(homeA, cloneA);
  const changed = Object.keys(before).filter((k) => before[k] !== after[k]);
  check("rerun: server_verified, exit 0", r.code === 0 && r.report.outcome === "server_verified", r.summary);
  check("rerun: no download, registration or file change", !r.ran(/release download|curl|marketplace add|plugin (install|update)|mcp (add|remove)|npm/) && !changed.length, `changed: ${changed.join(", ") || "none"}; ${r.summary}`);
  const d = setup("rerun", cloneA, "doctor", envA);
  check("rerun: doctor agrees", d.code === 0 && d.report.outcome === "server_verified", d.summary);
}

const exeA = path.join(cloneA, "plugin/driver/superuse-driver.exe");
const recordA = path.join(cloneA, "plugin/driver/superuse-driver.json");

{
  fs.rmSync(exeA);
  fs.rmSync(recordA);
  const bad = path.join(RUN, "bad-release.json");
  fs.writeFileSync(bad, JSON.stringify({ ...manifest, sha256: "0".repeat(64) }));
  const r = setup("checksum", cloneA, "install", { ...envA, SUPERUSE_RELEASE_MANIFEST: bad });
  const leftovers = fs.readdirSync(path.dirname(exeA)).filter((f) => f.startsWith("."));
  check("checksum: mismatch fails and installs nothing", r.code === 1 && r.has("DRIVER_CHECKSUM") && !fs.existsSync(exeA) && !leftovers.length, `${r.summary}; leftovers ${leftovers.join(",") || "none"}`);
  const again = setup("checksum", cloneA, "install", envA);
  check("checksum: rerun recovers", again.has("DRIVER_DOWNLOADED") && sha(exeA) === manifest.sha256, again.summary);
}

{
  // An older managed driver: its record matches its bytes but names other sources.
  const old = Buffer.from("an older driver build");
  fs.writeFileSync(exeA, old);
  fs.writeFileSync(recordA, JSON.stringify({ source: "release", fingerprint: "0".repeat(64), sha256: createHash("sha256").update(old).digest("hex"), tag: "driver-old" }));
  const r = setup("auth", cloneA, "install", userEnv(homeA, { noAuth: true }));
  const authCheck = r.report.checks.find((c) => c.code === "DRIVER_AUTH");
  check("auth: private release without login asks for gh auth login", r.code === 2 && !!authCheck && authCheck.summary.includes("gh isn't signed in"), r.summary);
  check("auth: no build, old driver kept", !r.ran(/build\.sh/) && !fs.existsSync(path.join(cloneA, "tools")) && fs.readFileSync(exeA).equals(old), r.summary);
  const up = setup("upgrade", cloneA, "install", envA);
  check("upgrade: an outdated managed driver is replaced", up.has("DRIVER_DOWNLOADED") && sha(exeA) === manifest.sha256, up.summary);
}

{
  // Claude recorded an older version of the plugin: install must update the record.
  const pj = path.join(cloneA, "plugin/.claude-plugin/plugin.json");
  const real = fs.readFileSync(pj, "utf8");
  fs.writeFileSync(pj, real.replace(/"version": "[^"]+"/, '"version": "0.0.1"'));
  sh("claude", ["plugin", "update", "superuse@superuse", "--scope", "user"], { env: envA });
  fs.writeFileSync(pj, real);
  const r = setup("upgrade", cloneA, "install", envA);
  const plugin = claudeJson<Array<{ id: string; version: string }>>(envA, ["plugin", "list", "--json"]).find((p) => p.id === "superuse@superuse");
  check("upgrade: Claude's recorded plugin version is updated", r.ran(/plugin update/) && r.has("CLAUDE_RESTART") && plugin?.version === manifestVersion(cloneA), `${r.summary}; claude has ${plugin?.version}`);
}

{
  const cloneB = clone("clone B");
  const r = setup("moved", cloneB, "install", envA);
  const market = claudeJson<Array<{ name: string; path?: string }>>(envA, ["plugin", "marketplace", "list", "--json"]).find((m) => m.name === "superuse");
  const codex = codexJson<{ transport: { command: string } }>(envA, ["mcp", "get", "superuse", "--json"]);
  const skill = fs.readlinkSync(path.join(homeA, ".agents/skills/computer-use"));
  check("moved: every registration follows the new checkout", market?.path === cloneB && codex.transport.command === path.join(cloneB, "plugin/server/run.sh") && skill === path.join(cloneB, "plugin/skills/computer-use"), `${r.summary}; claude ${market?.path}; codex ${codex.transport.command}; skill ${skill}`);
  const back = setup("moved", cloneA, "doctor", envA);
  check("moved: the old checkout's doctor says clients point elsewhere", back.has("CLAUDE_OTHER_CHECKOUT") && back.has("CODEX_STALE"), back.summary);
}

const homeC = newHome("c");
fs.mkdirSync(path.join(homeC, ".config/superuse"), { recursive: true });
fs.copyFileSync(path.join(homeA, ".config/superuse/node-path"), path.join(homeC, ".config/superuse/node-path")); // reuse A's downloaded Node
const envC = userEnv(homeC);
const cloneC = clone("clone C");

{
  const policy = path.join(homeC, ".config/superuse/policy.json");
  const policyText = `{"allow": ["testpad"], "deny": ["slack"], "note": "mine"}\n`;
  fs.writeFileSync(policy, policyText);
  fs.writeFileSync(path.join(homeC, ".codex/config.toml"), `[mcp_servers.other]\ncommand = "/bin/true"\n`);
  const skill = path.join(homeC, ".agents/skills/computer-use");
  fs.mkdirSync(skill, { recursive: true });
  fs.writeFileSync(path.join(skill, "SKILL.md"), "someone else's skill\n");
  const custom = Buffer.from("a hand-built driver");
  fs.mkdirSync(path.join(cloneC, "plugin/driver"), { recursive: true });
  fs.writeFileSync(path.join(cloneC, "plugin/driver/superuse-driver.exe"), custom);
  const r = setup("preserve", cloneC, "install", envC);
  check("preserve: unknown driver kept and reported; clients wait", r.code === 2 && r.has("DRIVER_UNKNOWN") && r.has("CLIENT_SKIPPED") && fs.readFileSync(path.join(cloneC, "plugin/driver/superuse-driver.exe")).equals(custom), r.summary);
  fs.rmSync(path.join(cloneC, "plugin/driver/superuse-driver.exe")); // the user moves their driver away
  const r2 = setup("preserve", cloneC, "install", envC);
  check("preserve: policy file untouched", fs.readFileSync(policy, "utf8") === policyText, r2.summary);
  check("preserve: other Codex server kept, skill conflict reported", fs.readFileSync(path.join(homeC, ".codex/config.toml"), "utf8").includes("[mcp_servers.other]") && r2.has("CODEX_SKILL_CONFLICT") && r2.has("DRIVER_DOWNLOADED"), r2.summary);
  check("preserve: someone else's skill folder kept", fs.readFileSync(path.join(skill, "SKILL.md"), "utf8") === "someone else's skill\n", "");
  const allow = setup("preserve", cloneC, "install", envC, ["--allow-apps=Calculator", "--foreground=ask"]);
  const merged = JSON.parse(fs.readFileSync(policy, "utf8")) as { allow: string[]; deny: string[]; note: string; foreground: string };
  check("preserve: approved choices merge into the policy", merged.allow.join() === "calculator,testpad" && merged.deny.join() === "slack" && merged.note === "mine" && merged.foreground === "ask", `${allow.summary}; ${JSON.stringify(merged)}`);

  const broken = `{"allow": ["testpad",]}`;
  fs.writeFileSync(policy, broken);
  const m = setup("malformed", cloneC, "install", envC, ["--allow-apps=Paint"]);
  check("malformed: reported, never overwritten", m.code === 1 && m.has("POLICY_MALFORMED") && fs.readFileSync(policy, "utf8") === broken, m.summary);
  fs.rmSync(policy);
}

{
  fs.rmSync(path.join(cloneC, "plugin/driver/superuse-driver.exe"));
  fs.rmSync(path.join(cloneC, "plugin/driver/superuse-driver.json"));
  fs.appendFileSync(path.join(cloneC, "driver/VERSION"), "\n");
  const r = setup("no-release", cloneC, "install", envC);
  check("no-release: changed driver sources need a build or release", r.code === 1 && r.has("DRIVER_NO_RELEASE") && !fs.existsSync(path.join(cloneC, "plugin/driver/superuse-driver.exe")), r.summary);
  check("no-release: no download, no build, clients left alone", !r.ran(/release download|curl|build-driver\.sh|marketplace add|mcp add/) && r.has("CLIENT_SKIPPED"), r.summary);
  if (flags.build) {
    const b = setup("build", cloneC, "install", { ...envC, PATH: `${path.join(os.homedir(), ".cargo/bin")}:${envC.PATH}` }, ["--build"]);
    const record = JSON.parse(fs.readFileSync(path.join(cloneC, "plugin/driver/superuse-driver.json"), "utf8")) as { source: string; sha256: string };
    check("build: built from the changed sources and recorded as a build", b.has("DRIVER_BUILT") && record.source === "build" && record.sha256 === sha(path.join(cloneC, "plugin/driver/superuse-driver.exe")), b.summary);
  }
}

{
  const wt = path.join(RUN, "worktree");
  sh("git", ["-C", cloneA, "worktree", "add", "-q", "--detach", wt]);
  const homeT = newHome("t");
  const r = setup("temporary", wt, "install", userEnv(homeT, { extra: { SUPERUSE_NODE: fs.readFileSync(path.join(homeA, ".config/superuse/node-path"), "utf8").trim() } }));
  check("temporary: a git worktree isn't registered", r.code === 2 && r.has("CHECKOUT_TEMPORARY") && !r.ran(/^claude|^codex|npm/) && !fs.existsSync(path.join(homeT, ".config/superuse/node-path")), r.summary);
}

{
  const r = setup("app", cloneA, "doctor", envA, ["--verify"]);
  check("app: doctor --verify drives TestPad and saves the exact text", r.has("VERIFY_APP"), r.summary);
}

if (flags.browser) {
  const policy = path.join(os.homedir(), ".config/superuse/policy.json"); // read-only: the user's own grants
  const r = setup("browser", cloneA, "doctor", { ...envA, SUPERUSE_POLICY: policy }, ["--verify"]);
  check("browser: doctor --verify drives an own tab", r.has("BROWSER_VERIFIED"), r.summary);
}

if (flags.clients) await clientRuns();

/** Each real client edits TestPad through the server command its isolated registration holds,
 *  with HOME set to that user's, so Node comes from what install recorded. The clients sign in
 *  with the user's own login, which lives beside their real registrations, so the command is
 *  passed per run (--mcp-config, -c) rather than loaded from the isolated config. */
async function clientRuns() {
  const { verifyClientRun } = await import("./setup-clients.ts");
  const plugin = claudeJson<Array<{ id: string; readFromFolder?: string; mcpServers?: Record<string, { command: string }> }>>(envA, ["plugin", "list", "--json"]).find((p) => p.id === "superuse@superuse");
  const commands = {
    claude: plugin?.mcpServers?.computer?.command.replace("${CLAUDE_PLUGIN_ROOT}", plugin.readFromFolder ?? "") ?? "",
    codex: codexJson<{ transport: { command: string } }>(envA, ["mcp", "get", "superuse", "--json"]).transport.command,
  };
  for (const client of ["claude", "codex"] as const) {
    const r = await verifyClientRun(client, commands[client], homeA, path.join(RUN, `client-${client}`));
    if (r.blocked) blocked(`client: ${client} edits TestPad through superuse`, r.detail);
    else check(`client: ${client} edits TestPad through superuse`, r.ok, r.detail);
  }
}

blocked("agent: Claude and Codex each configure a fresh clone from \"configure this for me\"",
  "needs scoped credentials for an isolated client config (CLAUDE_CODE_OAUTH_TOKEN, OPENAI_API_KEY); copying the user's own login could rotate it. --clients covers the call path with the user's login instead");

fs.writeFileSync(path.join(RUN, "versions.json"), JSON.stringify({
  node: sh(fs.readFileSync(path.join(homeA, ".config/superuse/node-path"), "utf8").trim(), ["-v"]).stdout.trim(),
  claude: sh("claude", ["--version"], { env: envA }).stdout.trim(), codex: sh("codex", ["--version"], { env: envA }).stdout.trim(),
  plugin: manifestVersion(REPO), release: manifest, commit: sh("git", ["-C", REPO, "rev-parse", "HEAD"]).stdout.trim(),
}, null, 2));
fs.writeFileSync(path.join(RUN, "report.json"), JSON.stringify(results, null, 2));
sh("git", ["-C", cloneA, "worktree", "remove", "--force", path.join(RUN, "worktree")]);
const failed = results.filter((r) => r.ok === false);
console.log(`${results.filter((r) => r.ok === true).length} passed, ${failed.length} failed, ${results.filter((r) => r.ok === "blocked").length} blocked; ${RUN}`);
process.exitCode = failed.length ? 1 : 0;
