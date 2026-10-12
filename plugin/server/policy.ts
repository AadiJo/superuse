// Which apps Claude may see and control, and when it may take the real mouse and focus.
//
// The engine owns this decision, not the MCP client: approvals are remembered here for the
// session, "always" approvals persist in the policy file, and a client that can't show a prompt
// gets a clear refusal that says how to approve instead of a hang.
//
// Policy file (BCU_POLICY, default ~/.config/bcu/policy.json):
//   { "allow": ["testpad", "uwp:calculator"],   apps allowed without asking
//     "deny": ["slack"],                          apps never shown or controlled
//     "foreground": "ask" }                       "ask" | "allow" | "deny" for {foreground: true}
// Env: BCU_APPS        comma list of apps pre-approved for this process (benchmarks, headless runs)
//      BCU_FOREGROUND  overrides the file's "foreground"

import fs from "node:fs";
import os from "node:os";
import path from "node:path";

/** Asks the user. "unsupported" means the client can't show a prompt (no elicitation). */
export type Ask = (message: string, rememberLabel: string) => Promise<"once" | "always" | "no" | "unsupported">;

export type App = { key: string; label: string };
type ForegroundMode = "ask" | "allow" | "deny";
type PolicyFile = { allow?: string[]; deny?: string[]; foreground?: ForegroundMode };

// Hidden and refused unless the policy file's "allow" names them: shells (a terminal window is
// shell access), password managers, credential and security prompts, and agents (including us).
const BUILTIN_DENY = new Set([
  "windowsterminal", "wt", "cmd", "powershell", "pwsh", "powershell_ise", "wsl", "wslhost", "conhost",
  "openconsole", "mintty", "wezterm-gui", "alacritty", "1password", "bitwarden", "keepass", "keepassxc",
  "dashlane", "credentialuibroker", "consent", "lockapp", "logonui", "sechealthui", "cua-driver",
  "claude", "codex", "textinputhost",
]);

const LABELS: Record<string, string> = {
  msedge: "Microsoft Edge", chrome: "Google Chrome", firefox: "Firefox", explorer: "File Explorer",
  systemsettings: "Settings", winword: "Word", excel: "Excel", powerpnt: "PowerPoint", outlook: "Outlook",
};

/** App identity of a window: the exe name. UWP apps all run in ApplicationFrameHost.exe, so they're
 *  keyed by the app name, which Windows puts last in the frame's title ("img.jpg - Photos"). */
export function appOf(w: { app_name?: string; title?: string }): App {
  const exe = (w.app_name ?? "").replace(/\.exe$/i, "");
  const lower = exe.toLowerCase();
  if (lower === "applicationframehost") {
    const name = (w.title ?? "").split(" - ").pop()?.trim() || "Windows app";
    return { key: `uwp:${name.toLowerCase()}`, label: name };
  }
  return { key: lower, label: LABELS[lower] ?? exe };
}

/** Lenient match used for BCU_APPS and the file's allow/deny lists: "calculator" matches the key
 *  "uwp:calculator", "File Explorer" matches explorer's label. */
function listed(list: readonly string[], app: App): boolean {
  const label = app.label.toLowerCase();
  return list.some((e) => e === app.key || app.key.endsWith(`:${e}`) || label === e || (e.length > 3 && (app.key.includes(e) || label.includes(e))));
}

export class Policy {
  readonly file: string;
  private conf: PolicyFile;
  private readonly preapproved: string[];
  private readonly approved = new Set<string>(); // app keys approved this session
  private readonly declined = new Set<string>(); // asked this session and refused: don't nag
  private readonly launchedPids = new Set<number>(); // apps Claude opened through cua.open
  private readonly foregroundOk = new Set<string>();
  private readonly ask: Ask;

  constructor(ask: Ask) {
    this.ask = ask;
    this.file = process.env.BCU_POLICY ?? path.join(os.homedir(), ".config", "bcu", "policy.json");
    this.conf = this.load();
    this.preapproved = (process.env.BCU_APPS ?? "").split(",").map((s) => s.trim().toLowerCase()).filter(Boolean);
  }

  private load(): PolicyFile {
    try { return JSON.parse(fs.readFileSync(this.file, "utf8")) as PolicyFile; } catch { return {}; }
  }

  private lower(list?: string[]) { return (list ?? []).map((s) => s.toLowerCase()); }

  status(app: App): "denied" | "approved" | "unapproved" {
    const allow = this.lower(this.conf.allow), deny = this.lower(this.conf.deny);
    if (listed(deny, app)) return "denied";
    if (BUILTIN_DENY.has(app.key) && !allow.includes(app.key)) return "denied";
    if (this.approved.has(app.key) || listed(allow, app) || listed(this.preapproved, app)) return "approved";
    return "unapproved";
  }

  /** Windows of processes Claude launched are in scope too (dialogs, windows whose title changed).
   *  Not for UWP apps: they all share ApplicationFrameHost's pid, so a launched Calculator would
   *  otherwise bring Settings into scope. */
  windowApproved(app: App, pid: number) {
    const s = this.status(app);
    return s === "approved" || (s !== "denied" && !app.key.startsWith("uwp:") && this.launchedPids.has(pid));
  }

  /** Throws unless the user allows Claude to control `app` (asking once per session if needed). */
  async requireApp(app: App, windowTitle?: string): Promise<void> {
    const s = this.status(app);
    if (s === "approved") return;
    if (s === "denied") throw new Error(`${app.label} is blocked by policy (${this.denyReason(app)}).`);
    if (this.declined.has(app.key)) throw new Error(`the user declined access to ${app.label} earlier in this session.`);
    const where = windowTitle ? ` (window "${windowTitle}")` : "";
    const answer = await this.ask(
      `Allow Claude to control ${app.label}${where}? It will read this app's windows and send clicks and keys to them in the background.`,
      `Always allow ${app.label}`);
    this.settle(app, answer);
  }

  /** Check before launching by name or path; the launched process's windows are then in scope.
   *  The name is judged by its last path segment, so it must be exactly what Windows will run:
   *  a NUL or other control character would make ShellExecute stop early and run something else
   *  ("cmd.exe\0C:\\testpad.exe" reads as testpad here and runs cmd.exe). */
  async requireLaunch(name: string): Promise<{ remember: boolean }> {
    if (/[\u0000-\u001f"<>|*?]/.test(name) || !name.trim()) throw new Error(`can't open ${JSON.stringify(name)}: not a plain app name or path`);
    const guess = { key: path.basename(name.replace(/\\/g, "/")).replace(/\.exe$/i, "").toLowerCase(), label: name };
    const s = this.status(guess);
    if (s === "denied") throw new Error(`${name} is blocked by policy (${this.denyReason(guess)}).`);
    if (s === "approved") return { remember: false };
    if (this.declined.has(guess.key)) throw new Error(`the user declined to let Claude open ${name} earlier in this session.`);
    const answer = await this.ask(`Allow Claude to open ${name} and control its windows?`, `Always allow ${name}`);
    this.settle(guess, answer);
    return { remember: answer === "always" };
  }

  /** After a launch: scope the new process, and persist its real key if the user said "always". */
  launched(pid: number, app: App | null, remember: boolean) {
    this.launchedPids.add(pid);
    if (app) this.approved.add(app.key);
    if (app && remember) this.persistAllow(app.key);
  }

  /** Throws unless foreground input (real cursor and focus) is allowed for this app. */
  async requireForeground(app: App): Promise<void> {
    const mode = (process.env.BCU_FOREGROUND as ForegroundMode | undefined) ?? this.conf.foreground ?? "ask";
    if (mode === "allow" || this.foregroundOk.has(app.key)) return;
    if (mode === "deny") throw new Error("foreground input is disabled by policy. Use setValue/select, or ask the user to do this step.");
    const answer = await this.ask(
      `Claude wants to briefly take the mouse and keyboard focus to act in ${app.label}, because background input was refused. Allow?`,
      `Allow for the rest of this session`);
    if (answer === "unsupported") throw new Error(`foreground input needs approval and this client can't show prompts. Set "foreground": "allow" in ${this.file} or BCU_FOREGROUND=allow.`);
    if (answer === "no") throw new Error("the user declined foreground input. Use setValue/select, or ask the user to do this step.");
    if (answer === "always") this.foregroundOk.add(app.key);
  }

  private settle(app: App, answer: Awaited<ReturnType<Ask>>) {
    if (answer === "unsupported") {
      throw new Error(`${app.label} isn't approved and this client can't show an approval prompt. Add "${app.key}" to "allow" in ${this.file}, or set BCU_APPS.`);
    }
    if (answer === "no") {
      this.declined.add(app.key);
      throw new Error(`the user declined access to ${app.label}.`);
    }
    this.approved.add(app.key);
    if (answer === "always") this.persistAllow(app.key);
  }

  private denyReason(app: App) {
    return listed(this.lower(this.conf.deny), app) ? `listed under "deny" in ${this.file}` : "shells, password managers, security prompts and agents are blocked by default";
  }

  private persistAllow(key: string) {
    this.conf = this.load(); // another session may have written since we started
    const allow = new Set(this.conf.allow ?? []);
    allow.add(key);
    this.conf.allow = [...allow].sort();
    fs.mkdirSync(path.dirname(this.file), { recursive: true });
    const tmp = `${this.file}.${process.pid}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify(this.conf, null, 2) + "\n");
    fs.renameSync(tmp, this.file);
  }
}
