// superuse setup and diagnosis. Run through scripts/install.sh and scripts/doctor.sh, which find Node
// first; `node scripts/setup.ts --help` lists the options.
//
// install: platform -> checkout -> Node -> server dependencies -> driver -> access choices ->
//   clients -> server check. Runtime pieces come before client registration, so a client never
//   points at a half-installed server. Rerunning repairs what's stale and changes nothing else.
// doctor: the same checks without changes; --verify also drives a test app (and the browser).
//
// The report's outcome, and the exit status:
//   server_verified   0  installed, and the server works through its launcher
//   restart_required  0  same, but a client must start a new session to load the change
//   needs_action      2  something needs the user (a permission, a login, a conflict)
//   failed            1  something is broken
// A client counts as verified only once it calls the tool itself; the report says how.

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { parseArgs } from "node:util";
import { applyChoices, checkBrowser, checkPolicy, browsersEnabled, type AccessChoices } from "./setup/access.ts";
import { CLIENTS, checkClient, installClient, installed, type Client } from "./setup/clients.ts";
import { checkDriver, ensureDriver } from "./setup/driver.ts";
import { commandLog, LAUNCHER, NODE_RECORD, PLUGIN, REPO, VERSION, run, sha256File, timed, writeAtomic, type Check, type Status } from "./setup/lib.ts";
import { checkServer, verifyApp, verifyBrowser } from "./setup/verify.ts";

const HELP = `usage: scripts/install.sh [options]     set up or update superuse from this checkout
       scripts/doctor.sh [--json] [--verify] [--clients=...]

  --clients=claude,codex   clients to set up or check (default: the ones installed; "none" for neither)
  --build                  build the driver from source (needs Rust) instead of downloading it
  --allow-temporary-checkout
                           register a git worktree or temp directory anyway (it may disappear)
  --json                   print one JSON report on stdout
  --verify                 doctor only: drive a test app, and the browser if it's enabled

Access choices (install only). Pass only what the user approved; nothing else changes:
  --allow-apps=a,b         apps superuse may control without asking (e.g. TestPad,Calculator; "*" for all)
  --foreground=ask|allow|deny
                           whether superuse may briefly take the real mouse and focus
  --browsers=attach|off    whether w.page() may use the user's running, logged-in browser`;

const { values: opts, positionals } = parseArgs({
  allowPositionals: true,
  options: {
    clients: { type: "string" },
    build: { type: "boolean", default: false },
    "allow-temporary-checkout": { type: "boolean", default: false },
    json: { type: "boolean", default: false },
    verify: { type: "boolean", default: false },
    "allow-apps": { type: "string" },
    foreground: { type: "string" },
    browsers: { type: "string" },
    help: { type: "boolean", default: false },
  },
});

const command = positionals[0];
if (opts.help || (command !== "install" && command !== "doctor")) {
  console.log(HELP);
  process.exit(opts.help ? 0 : 1);
}
const installing = command === "install";

function usage(message: string): never {
  console.error(`${message}\n\n${HELP}`);
  process.exit(1);
}

function oneOf<const T extends string>(value: string | undefined, allowed: readonly T[], flag: string): T | undefined {
  if (value === undefined) return undefined;
  if ((allowed as readonly string[]).includes(value)) return value as T;
  return usage(`--${flag} must be one of ${allowed.join(", ")}`);
}

const choices: AccessChoices = {
  allowApps: (opts["allow-apps"] ?? "").split(",").map((s) => s.trim()).filter(Boolean),
  foreground: oneOf(opts.foreground, ["ask", "allow", "deny"], "foreground"),
  browsers: oneOf(opts.browsers, ["attach", "off"], "browsers"),
};
if (!installing && (choices.allowApps.length || choices.foreground || choices.browsers || opts.build)) usage("doctor doesn't change anything; pass access choices and --build to install");
if (installing && opts.verify) usage("--verify is a doctor option: run scripts/doctor.sh --verify");

/** Requested clients, or the installed ones. `explicit` says whether the user named them. */
function selectClients(): { clients: Client[]; explicit: boolean } {
  if (opts.clients === undefined) return { clients: CLIENTS.filter(installed), explicit: false };
  if (opts.clients === "none") return { clients: [], explicit: true };
  const names = opts.clients.split(",").map((s) => s.trim());
  for (const n of names) oneOf(n, CLIENTS, "clients");
  return { clients: [...new Set(names)] as Client[], explicit: true };
}

// --- checks owned by this file --------------------------------------------------------------

function checkPlatform(): Check {
  const id = "platform";
  const wsl = fs.existsSync("/proc/sys/fs/binfmt_misc/WSLInterop") || /microsoft/i.test(os.release());
  if (!wsl || process.arch !== "x64") return { id, status: "fail", code: "PLATFORM_UNSUPPORTED", summary: `superuse needs WSL2 on Windows 11, x64 (this is ${os.platform()} ${process.arch})` };
  const r = run("/mnt/c/Windows/System32/cmd.exe", ["/d", "/c", "ver"], { cwd: "/mnt/c" });
  if (r.code !== 0) return { id, status: "fail", code: "INTEROP_BROKEN", summary: "WSL can't run Windows programs (interop is off)", evidence: [r.stderr.trim()], next: "Enable [interop] in /etc/wsl.conf, then run wsl --shutdown from Windows." };
  return { id, status: "ok", code: "PLATFORM_OK", summary: `WSL2 x64, ${r.stdout.trim()}` };
}

/** A git worktree or a temp directory can vanish, taking every registration with it. */
function checkCheckout(): Check {
  const id = "checkout";
  const git = run("git", ["-C", REPO, "rev-parse", "--path-format=absolute", "--git-dir", "--git-common-dir"]);
  const [gitDir, commonDir] = git.stdout.trim().split("\n");
  const worktree = git.code === 0 && gitDir !== commonDir;
  const temp = [os.tmpdir(), "/tmp"].some((t) => REPO.startsWith(`${fs.realpathSync(t)}/`));
  if ((worktree || temp) && !opts["allow-temporary-checkout"]) {
    return {
      id, status: "action", code: "CHECKOUT_TEMPORARY", summary: `${REPO} is ${worktree ? "a git worktree" : "in a temp directory"}; clients would break when it's removed`,
      next: "Clone the repo to a permanent place (by default ~/.local/share/superuse/source) and run scripts/install.sh there, or pass --allow-temporary-checkout.",
    };
  }
  return { id, status: "ok", code: "CHECKOUT_OK", summary: REPO };
}

function nodeVersion(node: string): string | null {
  const r = run(node, ["-p", "process.versions.node"]);
  return r.code === 0 ? r.stdout.trim() : null;
}

function checkNode(): Check {
  const id = "node";
  let recorded = "";
  try { recorded = fs.readFileSync(NODE_RECORD, "utf8").trim(); } catch { /* none yet */ }
  const node = process.env.SUPERUSE_NODE || recorded;
  if (!node) return { id, status: "action", code: "NODE_NOT_RECORDED", summary: `no Node recorded in ${NODE_RECORD}; clients without Node 24 on PATH can't start superuse`, next: "Run scripts/install.sh." };
  const version = nodeVersion(node);
  if (!version || Number(version.split(".")[0]) < 24) return { id, status: "fail", code: "NODE_BROKEN", summary: `the recorded Node (${node}) ${version ? `is ${version}, not 24+` : "doesn't run"}`, next: "Run scripts/install.sh to record a working Node 24+." };
  return { id, status: "ok", code: "NODE_OK", summary: `Node ${version} at ${node}${process.env.SUPERUSE_NODE ? " (SUPERUSE_NODE)" : ""}` };
}

/** Record the Node running setup (install.sh validated it) for the launcher. */
function recordNode(): Check {
  let recorded = "";
  try { recorded = fs.readFileSync(NODE_RECORD, "utf8").trim(); } catch { /* none yet */ }
  if (recorded !== process.execPath) writeAtomic(NODE_RECORD, `${process.execPath}\n`);
  return checkNode();
}

const SERVER_DIR = path.join(PLUGIN, "server");
const LOCK_MARK = path.join(SERVER_DIR, "node_modules", ".superuse-lock-sha256");

/** Dependencies are current when they were installed from today's lockfile and still load. */
function depsCurrent(): { ok: boolean; why: string } {
  const lock = sha256File(path.join(SERVER_DIR, "package-lock.json"));
  let mark = "";
  try { mark = fs.readFileSync(LOCK_MARK, "utf8").trim(); } catch { /* never installed */ }
  if (mark !== lock) return { ok: false, why: mark ? "package-lock.json changed since the last install" : "not installed by setup yet" };
  const probe = run(process.execPath, ["--input-type=module", "-e", "await import('quickjs-emscripten')"], { cwd: SERVER_DIR });
  return probe.code === 0 ? { ok: true, why: "" } : { ok: false, why: `quickjs-emscripten doesn't load: ${probe.stderr.trim().split("\n")[0]}` };
}

function checkDeps(): Check {
  const d = depsCurrent();
  return d.ok
    ? { id: "deps", status: "ok", code: "DEPS_CURRENT", summary: "server dependencies match package-lock.json" }
    : { id: "deps", status: "action", code: "DEPS_STALE", summary: `server dependencies: ${d.why}`, next: "Run scripts/install.sh." };
}

/** npm ci with the npm that ships with this Node, so an older npm on PATH can't pick another Node. */
function installDeps(): Check {
  if (depsCurrent().ok) return checkDeps();
  const bin = path.dirname(fs.realpathSync(process.execPath));
  const cli = path.join(bin, "..", "lib", "node_modules", "npm", "bin", "npm-cli.js");
  const npm = fs.existsSync(cli) ? [process.execPath, cli] : ["npm"];
  const r = run(npm[0], [...npm.slice(1), "ci", "--omit=dev", "--no-audit", "--no-fund"], {
    cwd: SERVER_DIR, env: { ...process.env, PATH: `${bin}:${process.env.PATH ?? ""}` },
  });
  if (r.code !== 0) return { id: "deps", status: "fail", code: "DEPS_INSTALL_FAILED", summary: "npm ci failed in plugin/server", evidence: [r.stderr.trim().split("\n").slice(-5).join("\n")], next: "Fix the npm error above and rerun scripts/install.sh." };
  writeAtomic(LOCK_MARK, `${sha256File(path.join(SERVER_DIR, "package-lock.json"))}\n`);
  return checkDeps();
}

// --- the run ----------------------------------------------------------------------------------

type Outcome = "server_verified" | "restart_required" | "needs_action" | "failed";

const checks: Check[] = [];
const blocked = () => checks.some((c) => c.status === "fail" || c.status === "action");
async function step(c: () => Check | Promise<Check>) { checks.push(await timed(c)); }

await step(checkPlatform);
await step(checkCheckout);
// Install stops here on a bad platform or a temporary checkout: nothing should be registered.
const stopEarly = installing && blocked();
if (!stopEarly) {
  await step(installing ? recordNode : checkNode);
  await step(installing ? installDeps : checkDeps);
  await step(() => (installing ? ensureDriver(opts.build) : checkDriver()));
  if (installing) {
    const applied = applyChoices(choices);
    checks.push(applied ?? checkPolicy());
  } else {
    checks.push(checkPolicy());
  }
  // Clients are registered, and the server tried, only once Node, dependencies and driver all work.
  const runtimeReady = checks.filter((c) => ["node", "deps", "driver"].includes(c.id)).every((c) => c.status === "ok");
  const { clients, explicit } = selectClients();
  for (const client of clients) {
    if (!installed(client)) {
      checks.push({ id: `client:${client}`, status: "fail", code: "CLIENT_NOT_FOUND", summary: `${client} was requested but isn't on PATH` });
    } else if (installing && !runtimeReady) {
      checks.push({ id: `client:${client}`, status: "skip", code: "CLIENT_SKIPPED", summary: "not registered: Node, dependencies or driver above aren't ready" });
    } else {
      await step(() => (installing ? installClient(client) : checkClient(client)));
    }
  }
  if (!clients.length && !explicit) {
    checks.push({ id: "clients", status: "action", code: "NO_CLIENTS", summary: "neither Claude Code nor Codex is installed", next: "Register superuse in your MCP client by hand (see below), or install one and rerun." });
  }
  if (runtimeReady) await step(checkServer);
  if (!installing && opts.verify && runtimeReady) await step(verifyApp);
  await step(!installing && opts.verify && runtimeReady && browsersEnabled() ? verifyBrowser : checkBrowser);
}

const outcome: Outcome = checks.some((c) => c.status === "fail") ? "failed"
  : checks.some((c) => c.status === "action") ? "needs_action"
  : checks.some((c) => c.status === "restart") ? "restart_required"
  : "server_verified";

const manual = { command: LAUNCHER, args: [] as string[], skill: path.join(PLUGIN, "skills", "computer-use") };
const report = { superuse: VERSION, command, checkout: REPO, outcome, checks, manual, commands: commandLog };

const MARK: Record<Status, string> = { ok: "ok", restart: "restart", action: "ACTION", fail: "FAIL", skip: "skip" };
if (opts.json) {
  console.log(JSON.stringify(report, null, 2));
} else {
  const lines = [`superuse ${VERSION} ${command}: ${outcome}`, ""];
  for (const c of checks) {
    lines.push(`  ${MARK[c.status].padEnd(8)}${c.id.padEnd(15)}${c.summary}`);
    for (const e of c.evidence ?? []) lines.push(`${" ".repeat(25)}${e}`);
    if (c.next && c.status !== "ok") lines.push(`${" ".repeat(25)}next: ${c.next}`);
  }
  if (outcome === "server_verified" || outcome === "restart_required") {
    lines.push("", "A client counts as verified once it calls superuse's js tool itself, e.g. `return (await desktop.windows()).length`.");
  }
  lines.push("", `Other MCP clients: stdio command ${JSON.stringify(manual.command)} with no arguments; skill folder ${manual.skill}.`);
  console.log(lines.join("\n"));
}
process.exitCode = outcome === "failed" ? 1 : outcome === "needs_action" ? 2 : 0;
