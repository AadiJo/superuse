// Cua Driver client. The driver is our fork's cua-driver.exe; we speak its stdio MCP server as
// newline-delimited JSON-RPC. One long-lived process serves every call, and calls run one at a
// time in the order they were issued. If the driver exits, the next call starts a fresh one.

import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import fs from "node:fs";
import { createInterface } from "node:readline";
import { VERSION } from "./version.ts";

const TRACE = process.env.BCU_TRACE;

/** BCU_TRACE=<file>: append one JSON line per driver and API call with its timing, for the
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
  pid: number;
  screenshot_width: number;
  screenshot_height: number;
  windows: DriverWindow[];
  // Browser route (get_browser_state, browser_*): every refusal comes back as status "refused".
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

const SESSION = "bcu"; // one driver session label, so cursor settings apply to every action
const TIMEOUT_MS = 20_000;

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
  private readonly launchArgs: () => string[];

  /** `launchArgs` is read each time the driver process starts (e.g. the existing-profile grant). */
  constructor(exe: string, cursor: CursorMode, launchArgs: () => string[] = () => []) {
    this.exe = exe;
    this.cursor = cursor;
    this.launchArgs = launchArgs;
  }

  /** Whether the running driver offers a tool. Valid once a call has completed the handshake. */
  has(tool: string) { return this.toolNames.has(tool); }

  private start() {
    const wslenv = ["DO_NOT_TRACK", process.env.WSLENV].filter(Boolean).join(":");
    const proc = spawn(this.exe, ["mcp", ...this.launchArgs()], { env: { ...process.env, DO_NOT_TRACK: "1", WSLENV: wslenv } });
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
    this.ready = withTimeout(this.handshake(), "starting the driver");
  }

  private async handshake() {
    await this.request("initialize", { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "bcu", version: VERSION } });
    this.send({ jsonrpc: "2.0", method: "notifications/initialized" });
    const list = (await this.request("tools/list", {})) as { tools?: Array<{ name: string; inputSchema?: { properties?: Record<string, unknown> } }> };
    for (const t of list.tools ?? []) {
      this.toolNames.add(t.name);
      if (t.inputSchema?.properties?.session) this.sessionTools.add(t.name);
    }
    // The agent cursor glides to every click target before acting: about 430 ms per click when
    // animated, 65 ms with an 80 ms fixed glide, 7 ms hidden (measured on Calculator).
    if (this.cursor === "off") await this.request("tools/call", { name: "set_agent_cursor_enabled", arguments: { session: SESSION, enabled: false } });
    else if (this.cursor === "fast") await this.request("tools/call", { name: "set_agent_cursor_motion", arguments: { session: SESSION, timing: "fixed", glide_duration_ms: 80, dwell_after_click_ms: 0 } });
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
    if (this.sessionTools.has(name)) clean.session = SESSION;
    const started = performance.now();
    let ok = false;
    let res: ToolResult;
    try {
      res = (await withTimeout(this.request("tools/call", { name, arguments: clean }), name,
        "the app is probably blocked by a modal dialog. Check cua.windows() for a new window.")) as ToolResult;
      ok = !res.isError;
    } finally {
      trace({ driver: name, ms: Math.round(performance.now() - started), ok }); // timeouts too: they're the slow calls
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
}
