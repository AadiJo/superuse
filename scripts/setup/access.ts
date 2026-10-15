// Access choices: the policy file the server reads (plugin/server/policy.ts documents it). Setup
// never widens access on its own. It writes only the choices passed as flags, which the user
// approved, and keeps every other setting. A file that doesn't parse is reported, never replaced.

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { windowsDir, writeAtomic, type Check } from "./lib.ts";

export const POLICY = process.env.BCU_POLICY ?? path.join(os.homedir(), ".config", "bcu", "policy.json");

type Foreground = "ask" | "allow" | "deny";
type Browsers = "attach" | "off";
type PolicyFile = { allow?: string[]; deny?: string[]; foreground?: Foreground; browsers?: Browsers; [other: string]: unknown };

/** Choices the user approved, from install's flags. */
export type AccessChoices = { allowApps: string[]; foreground?: Foreground; browsers?: Browsers };

type Read = { kind: "missing" } | { kind: "ok"; policy: PolicyFile } | { kind: "malformed"; error: string };

function readPolicy(): Read {
  let text: string;
  try { text = fs.readFileSync(POLICY, "utf8"); } catch { return { kind: "missing" }; }
  try {
    const policy = JSON.parse(text) as unknown;
    if (typeof policy !== "object" || policy === null || Array.isArray(policy)) return { kind: "malformed", error: "not a JSON object" };
    return { kind: "ok", policy: policy as PolicyFile };
  } catch (e) {
    return { kind: "malformed", error: e instanceof Error ? e.message : String(e) };
  }
}

/** Whether the policy file turns browser attach on. BCU_BROWSERS in this shell doesn't count:
 *  clients don't see it, and verification removes it. */
export function browsersEnabled(): boolean {
  const r = readPolicy();
  return r.kind === "ok" && r.policy.browsers === "attach";
}

export function checkPolicy(): Check {
  const id = "policy";
  const r = readPolicy();
  const env = ["BCU_APPS", "BCU_FOREGROUND", "BCU_BROWSERS", "BCU_POLICY"].filter((k) => process.env[k]).map((k) => `${k}=${process.env[k]} is set in this shell; clients only see it if their server environment sets it too`);
  if (r.kind === "malformed") {
    return { id, status: "fail", code: "POLICY_MALFORMED", summary: `${POLICY} isn't valid JSON: ${r.error}`, evidence: env, next: "Fix the file by hand. bcu treats it as empty until then and won't overwrite it." };
  }
  const p = r.kind === "ok" ? r.policy : {};
  const allow = p.allow?.length ? p.allow.join(", ") : "none";
  return {
    id, status: "ok", code: r.kind === "ok" ? "POLICY_READ" : "POLICY_DEFAULT",
    summary: `${r.kind === "ok" ? POLICY : "no policy file (defaults)"}: allow ${allow}; foreground ${p.foreground ?? "ask"}; browsers ${p.browsers ?? "off"}`,
    evidence: [...(p.deny?.length ? [`deny ${p.deny.join(", ")}`] : []), ...env],
  };
}

/** Merge the approved choices into the policy file. Nothing to apply leaves the file untouched. */
export function applyChoices(c: AccessChoices): Check | null {
  if (!c.allowApps.length && !c.foreground && !c.browsers) return null;
  const id = "policy";
  const r = readPolicy();
  if (r.kind === "malformed") return { id, status: "fail", code: "POLICY_MALFORMED", summary: `${POLICY} isn't valid JSON (${r.error}); no access choices were written`, next: "Fix the file by hand, then rerun with the same flags." };
  const p: PolicyFile = r.kind === "ok" ? { ...r.policy } : {};
  const before = JSON.stringify(p);
  if (c.allowApps.length) p.allow = [...new Set([...(p.allow ?? []), ...c.allowApps.map((a) => a.toLowerCase())])].sort();
  if (c.foreground) p.foreground = c.foreground;
  if (c.browsers) p.browsers = c.browsers;
  if (JSON.stringify(p) !== before) writeAtomic(POLICY, JSON.stringify(p, null, 2) + "\n");
  return checkPolicy();
}

/** Chromium browsers bcu can attach to, by their user-data folder under %LOCALAPPDATA%. */
const BROWSERS: Array<[name: string, dir: string]> = [
  ["Google Chrome", "Google/Chrome/User Data"],
  ["Microsoft Edge", "Microsoft/Edge/User Data"],
  ["Helium", "imput/Helium/User Data"],
  ["Chromium", "Chromium/User Data"],
  ["Brave", "BraveSoftware/Brave-Browser/User Data"],
];

/** Browser attach, before verification. A DevToolsActivePort file means remote debugging was on
 *  at some point; only scripts/doctor.sh --verify proves a connection. */
export function checkBrowser(): Check {
  const id = "browser";
  if (!browsersEnabled()) return { id, status: "ok", code: "BROWSER_DISABLED", summary: "off (w.page() can't reach the user's logged-in browser)", next: "If the user wants that, rerun install with --browsers=attach." };
  const local = windowsDir("LOCALAPPDATA");
  const found = local ? BROWSERS.filter(([, dir]) => fs.existsSync(path.join(local, dir))) : [];
  const evidence = found.map(([name, dir]) => `${name}: ${fs.existsSync(path.join(local!, dir, "DevToolsActivePort")) ? "remote debugging has been on (a hint, not a connection)" : "no sign of remote debugging"}`);
  if (!found.length) return { id, status: "action", code: "BROWSER_NOT_FOUND", summary: "browsers: attach, but no Chrome, Edge, Helium, Chromium or Brave profile was found", next: "Install a Chromium browser, or set browsers back to off." };
  return {
    id, status: "action", code: "BROWSER_UNVERIFIED", summary: "browsers: attach, not verified yet", evidence,
    next: "Open the browser, turn on chrome://inspect/#remote-debugging, approve the browser app, restart the MCP server if it was running, then run scripts/doctor.sh --verify.",
  };
}
