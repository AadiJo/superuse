// Driver client. The driver is superuse-driver.exe, built from driver/ (our fork of Cua Driver); we speak its stdio MCP server as
// newline-delimited JSON-RPC. One long-lived process serves every call, and calls run one at a
// time in the order they were issued. If the driver exits, the next call starts a fresh one; if it
// ends our session after the idle timeout, the next call starts the session again.
//
// A Driver either owns its runtime, or reaches one that every Superuse server on this desktop
// shares (browserService below).

import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { createHash, randomBytes } from "node:crypto";
import fs from "node:fs";
import { createInterface } from "node:readline";
import { VERSION } from "./version.ts";

const TRACE = process.env.SUPERUSE_TRACE;

/** SUPERUSE_TRACE=<file>: append one JSON line per driver and API call with its timing, for the
 *  benchmark. Off by default. Entries carry tool and method names only, never arguments. */
export function trace(entry: Record<string, unknown>) {
  if (!TRACE) return;
  try { fs.appendFileSync(TRACE, JSON.stringify({ t: Date.now(), ...entry }) + "\n"); } catch { /* tracing must never break a call */ }
}

export type Image = { data: string; mimeType: string };
export type DriverWindow = {
  pid: number; window_id: number; title?: string; app_name?: string; z_index?: number; is_on_screen?: boolean; minimized?: boolean;
};

/** Fields the driver returns in structuredContent (or as JSON text). Each tool fills a subset. */
export type DriverData = Partial<{
  snapshot_id: string;
  tree_markdown: string;
  diff_markdown: string;
  window_title: string;
  returned_element_count: number;
  total_element_count: number;
  truncated: boolean;
  summary: string;
  // Input tools: how the driver delivered the action ("accessibility", "synthetic_events",
  // "global_input", ...), and what it saw of the effect ("confirmed", "unverifiable", "suspected_noop", ...).
  route: string;
  effect: string;
  // With effect "refused": why. Browser actions (browser_click, browser_type, ...) report refusals here.
  error: { code?: string; hint?: string };
  pid: number;
  screenshot_width: number;
  screenshot_height: number;
  windows: DriverWindow[];
  // Browser reads and binding (get_browser_state, ...): a refusal comes back as status "refused".
  // Browser actions come back in the action envelope instead: effect "refused" with `error`.
  status: string;
  refusal: { code?: string; message?: string };
  target_id: string;
  tab_id: string;
  tabs: BrowserTab[];
  mutation_allowed: boolean;
  page: { url?: string; title?: string };
  outline: string;
  refs: Array<{ ref: string; role?: string; name?: string | null; actions?: string[] }>;
  snapshot: { id?: string; complete?: boolean; continuation?: string | null };
}>;

export type BrowserTab = { tab_id: string; title?: string; url?: string; active?: boolean | null };

export type DriverResult = { text: string; data: DriverData; images: Image[]; isError: boolean };
export type Args = Record<string, unknown>;

type ToolResult = {
  content?: Array<{ type: string; text?: string; data?: string; mimeType?: string }>;
  structuredContent?: DriverData;
  isError?: boolean;
};
type Pending = { resolve: (v: unknown) => void; reject: (e: Error) => void };

const TIMEOUT_MS = 20_000;

/** A driver runtime shared by every Driver that names the same pipe. The driver process is then a
 *  thin client of it; the first client starts the service, and the service exits by itself once no
 *  client has been connected for `exitUnusedSecs` (SUPERUSE_DRIVER_EXIT_UNUSED_SECS replaces it).
 *
 *  The service keeps a session label for the connection that first used it, even after that client
 *  has exited, and our labels ("Claude Code 1") pass from one server to the next. So a client's
 *  label there is its usual one plus a short tail that is new for every connection. The badge under
 *  the cursor the service draws for page actions shows it, e.g. "Claude Code 1 4f2a9". */
export type SharedService = { pipe: string; grants: string[]; exitUnusedSecs: number };

/** The service that holds this desktop's DevTools connections to the user's browsers. A browser
 *  asks its user "Allow remote debugging?" for every new connection, so one process keeps a single
 *  connection per browser and every agent session's page calls go through it: the browser asks
 *  once, not once per session. It closes its connections when it exits, ten minutes after the last
 *  session that used it has gone. The name is per driver build, so a rebuilt or updated driver
 *  gets its own service instead of one still running the old code. */
export function browserService(exe: string): SharedService {
  const build = createHash("sha256").update(`${exe}\n${fs.statSync(exe, { throwIfNoEntry: false })?.mtimeMs ?? 0}`).digest("hex").slice(0, 12);
  return { pipe: String.raw`\\.\pipe\superuse-browser-${build}`, grants: ["existing-profile"], exitUnusedSecs: 600 };
}

export const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

export type CursorMode = "fast" | "animated" | "off";

function withTimeout<T>(p: Promise<T>, what: string, hint = ""): Promise<T> {
  return Promise.race([p, sleep(TIMEOUT_MS).then((): never => {
    throw new Error(`${what} got no reply in ${TIMEOUT_MS / 1000}s${hint ? `; ${hint}` : ""}`);
  })]);
}

export class Driver {
  private proc: ChildProcessWithoutNullStreams | null = null;
  private ready: Promise<void> = Promise.resolve();
  private nextId = 1;
  private pending = new Map<number, Pending>();
  private sessionTools = new Set<string>(); // tools whose schema takes a `session` label
  private toolNames = new Set<string>();
  private tail: Promise<unknown> = Promise.resolve();
  private readonly exe: string;
  private readonly cursor: CursorMode;
  private readonly sessionLabel: () => Promise<string>;
  private readonly shared: SharedService | undefined;
  // Every call carries one session label, so cursor settings apply to every action. The driver
  // draws it in the badge under the agent cursor; it's fixed for the life of the driver process.
  private session = "superuse";

  /** `sessionLabel` is read each time the driver process starts (a label that names the MCP
   *  client). The driver starts on the first call, so a session that never uses the desktop never
   *  asks for a label. With `shared`, the process is a client of that service, not its own runtime. */
  constructor(exe: string, cursor: CursorMode, sessionLabel: () => Promise<string> = async () => "superuse", shared?: SharedService) {
    this.exe = exe;
    this.cursor = cursor;
    this.sessionLabel = sessionLabel;
    this.shared = shared;
  }

  /** Whether the running driver offers a tool. Valid once a call has completed the handshake. */
  has(tool: string) { return this.toolNames.has(tool); }

  /** The driver's environment. WSLENV names the variables that cross into the Windows process. */
  private env(extra: Record<string, string> = {}) {
    const wslenv = ["DO_NOT_TRACK", ...Object.keys(extra), process.env.WSLENV].filter(Boolean).join(":");
    return { ...process.env, DO_NOT_TRACK: "1", ...extra, WSLENV: wslenv };
  }

  private start() {
    this.ready = withTimeout(this.connect(), "starting the driver");
  }

  /** Start the driver process and shake hands. A client of a shared service exits at once when no
   *  service is listening: start the service then, and try again until it answers. Detached, so
   *  the service outlives this server; two servers starting one at the same moment is fine, because
   *  the second service finds the pipe taken and exits. */
  private async connect() {
    const giveUp = Date.now() + TIMEOUT_MS / 2;
    for (let startedService = false; ;) {
      this.launch();
      try {
        return await this.handshake();
      } catch (e) {
        // A process that is still running failed for some other reason.
        if (!this.shared || this.proc || Date.now() > giveUp) throw e;
        if (!startedService) {
          const { pipe, grants, exitUnusedSecs } = this.shared;
          spawn(this.exe, ["serve", "--socket", pipe, ...grants.flatMap((g) => ["--grant", g])],
            { detached: true, stdio: "ignore", env: this.env({ SUPERUSE_DRIVER_EXIT_UNUSED_SECS: process.env.SUPERUSE_DRIVER_EXIT_UNUSED_SECS ?? String(exitUnusedSecs) }) }).unref();
          startedService = true;
        }
        await sleep(250);
      }
    }
  }

  private launch() {
    const proc = spawn(this.exe, this.shared ? ["mcp", "--socket", this.shared.pipe] : ["mcp"], { env: this.env() });
    this.proc = proc;
    createInterface({ input: proc.stdout }).on("line", (line) => this.onLine(line));
    proc.stderr.on("data", () => {}); // driver logs; ignored
    // A spawn failure (missing exe) emits "error" and may never emit "exit": handle both the same way.
    const gone = (why: string) => {
      if (this.proc !== proc) return;
      this.proc = null;
      for (const p of this.pending.values()) p.reject(new Error(why));
      this.pending.clear();
    };
    proc.on("exit", () => gone("the driver process exited; the next call restarts it"));
    proc.on("error", (e) => gone(`couldn't run the driver at ${this.exe}: ${e.message}`));
  }

  private async handshake() {
    const label = await this.sessionLabel();
    this.session = this.shared ? `${label} ${randomBytes(3).toString("hex").slice(0, 5)}` : label;
    await this.request("initialize", { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "superuse", version: VERSION } });
    this.send({ jsonrpc: "2.0", method: "notifications/initialized" });
    const list = (await this.request("tools/list", {})) as { tools?: Array<{ name: string; inputSchema?: { properties?: Record<string, unknown> } }> };
    for (const t of list.tools ?? []) {
      this.toolNames.add(t.name);
      if (t.inputSchema?.properties?.session) this.sessionTools.add(t.name);
    }
    await this.configureCursor();
  }

  /** Cursor settings are per session, so they're applied again whenever the session restarts. */
  private async configureCursor() {
    // The agent cursor glides to every click target before acting: about 430 ms per click when
    // animated, 65 ms with an 80 ms fixed glide, 7 ms hidden (measured on Calculator).
    if (this.cursor === "off") await this.timedCall("set_agent_cursor_enabled", { session: this.session, enabled: false });
    else if (this.cursor === "fast") await this.timedCall("set_agent_cursor_motion", { session: this.session, timing: "fixed", glide_duration_ms: 80, dwell_after_click_ms: 0 });
  }

  private send(msg: object) {
    this.proc?.stdin.write(JSON.stringify(msg) + "\n");
  }

  private onLine(line: string) {
    let msg: { id?: number; method?: string; result?: unknown; error?: { message?: string } };
    try { msg = JSON.parse(line); } catch { return; }
    if (msg.method && msg.id !== undefined) { // driver -> us request: decline anything interactive
      this.send({ jsonrpc: "2.0", id: msg.id, result: msg.method === "elicitation/create" ? { action: "decline" } : {} });
      return;
    }
    const p = msg.id === undefined ? undefined : this.pending.get(msg.id);
    if (!p || msg.id === undefined) return;
    this.pending.delete(msg.id);
    if (msg.error) p.reject(new Error(msg.error.message ?? JSON.stringify(msg.error)));
    else p.resolve(msg.result);
  }

  private request(method: string, params: object): Promise<unknown> {
    const id = this.nextId++;
    this.send({ jsonrpc: "2.0", id, method, params });
    return new Promise((resolve, reject) => this.pending.set(id, { resolve, reject }));
  }

  /** Call a driver tool after every call issued before it. */
  call(name: string, args: Args): Promise<DriverResult> {
    const run = this.tail.then(() => this.callNow(name, args));
    this.tail = run.catch(() => {});
    return run;
  }

  /** A hung app costs one short error instead of the whole js call. */
  private async callNow(name: string, args: Args): Promise<DriverResult> {
    if (!this.proc) this.start();
    try {
      await this.ready;
    } catch (e) {
      this.proc?.kill(); // the next call starts over instead of waiting on a broken handshake
      this.proc = null;
      throw e;
    }
    const clean: Args = Object.fromEntries(Object.entries(args).filter(([, v]) => v !== undefined && v !== null));
    if (this.sessionTools.has(name)) clean.session = this.session;
    let res = await this.timedCall(name, clean);
    // The driver ends a session after 5 idle minutes and then refuses every call on it, before
    // dispatch, so nothing was sent. Start the session again and retry once.
    if (res.isError && res.structuredContent?.refusal?.code === "session_ended") {
      await this.timedCall("start_session", { session: this.session });
      await this.configureCursor();
      res = await this.timedCall(name, clean);
    }
    const content = res.content ?? [];
    const text = content.filter((c) => c.type === "text").map((c) => c.text ?? "").join("\n");
    const images = content.filter((c) => c.type === "image" && c.data).map((c) => ({ data: c.data!, mimeType: c.mimeType ?? "image/png" }));
    let data: DriverData = res.structuredContent ?? {};
    if (!res.structuredContent && text.trimStart().startsWith("{")) {
      try { data = JSON.parse(text) as DriverData; } catch { /* plain text */ }
    }
    return { text, data, images, isError: !!res.isError };
  }

  private async timedCall(name: string, args: Args): Promise<ToolResult> {
    const started = performance.now();
    let ok = false;
    try {
      const res = (await withTimeout(this.request("tools/call", { name, arguments: args }), name,
        "the app is probably blocked by a modal dialog. Check desktop.windows() for a new window.")) as ToolResult;
      ok = !res.isError;
      return res;
    } finally {
      trace({ driver: name, ms: Math.round(performance.now() - started), ok }); // timeouts too: they're the slow calls
    }
  }
}
