// bcu-mcp: prototype "code mode" computer-use MCP server for Claude.
// ARCHIVED v1: the version measured in bench/out/final (plus the find() fix). The current one is plugin/server/.
//
// Exposes two tools, `js` and `js_reset`. `js` runs model-written JavaScript in
// a persistent context whose only capability is a small `cua` API, backed by a
// long-lived Cua Driver process (MIT, background UIA input on Windows). The
// point is to test the design from research/00-synthesis.md: Codex-style
// batching in one call, a ~1.5k-token tool surface instead of Cua Driver's
// ~52k tokens of tool definitions, and an API named the way Claude expects.
//
// PROTOTYPE: node:vm is not a security boundary. A real build needs a
// capability sandbox (isolated-vm or QuickJS) before untrusted use.
//
// Run: node proto/v1/bcu-mcp.ts            (Node 24+, TypeScript via type stripping)
// Env: BCU_CUA_DRIVER=<path to cua-driver.exe>  (defaults to tools/cua-driver-main)

import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { createInterface } from "node:readline";
import { fileURLToPath } from "node:url";
import path from "node:path";
import vm from "node:vm";

const here = path.dirname(fileURLToPath(import.meta.url));
const DRIVER = process.env.BCU_CUA_DRIVER ?? path.join(here, "../../tools/cua-driver-main/cua-driver.exe");
const SHOT_MAX = 1200; // long edge; stays inside Claude's no-rescale box for common window shapes
const CALL_TIMEOUT_MS = 90_000;
const TEXT_LIMIT = 20_000;
const DRIVER_TIMEOUT_MS = 20_000;

type Json = null | boolean | number | string | Json[] | { [k: string]: Json };
type Image = { data: string; mimeType: string };
type DriverResult = { text: string; data: Record<string, any> | null; images: Image[]; isError: boolean };

// --- Cua Driver client: newline-delimited JSON-RPC over the driver's stdio MCP ---

class Driver {
  private proc: ChildProcessWithoutNullStreams;
  private nextId = 1;
  private pending = new Map<number, { resolve: (v: any) => void; reject: (e: Error) => void }>();
  ready: Promise<void>;

  constructor(exe: string) {
    const wslenv = ["DO_NOT_TRACK", process.env.WSLENV].filter(Boolean).join(":");
    this.proc = spawn(exe, ["mcp"], { env: { ...process.env, DO_NOT_TRACK: "1", WSLENV: wslenv } });
    createInterface({ input: this.proc.stdout }).on("line", (line) => this.onLine(line));
    this.proc.stderr.on("data", () => {}); // driver logs; ignored
    this.ready = this.request("initialize", {
      protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "bcu", version: "0.0.1" },
    }).then(() => this.send({ jsonrpc: "2.0", method: "notifications/initialized" }));
  }

  private send(msg: object) { this.proc.stdin.write(JSON.stringify(msg) + "\n"); }

  private onLine(line: string) {
    let msg: any;
    try { msg = JSON.parse(line); } catch { return; }
    if (msg.method && msg.id !== undefined) { // server -> client request; decline anything interactive
      this.send({ jsonrpc: "2.0", id: msg.id, result: msg.method === "elicitation/create" ? { action: "decline" } : {} });
      return;
    }
    const p = this.pending.get(msg.id);
    if (!p) return;
    this.pending.delete(msg.id);
    msg.error ? p.reject(new Error(msg.error.message ?? JSON.stringify(msg.error))) : p.resolve(msg.result);
  }

  private request(method: string, params: object): Promise<any> {
    const id = this.nextId++;
    this.send({ jsonrpc: "2.0", id, method, params });
    return new Promise((resolve, reject) => this.pending.set(id, { resolve, reject }));
  }

  /** Call a driver tool; parses the JSON text block when there is one. Gives up after
   *  DRIVER_TIMEOUT_MS so a hung app (typically a modal dialog opened by a synchronous
   *  UIA Invoke) costs the model one short error instead of the whole js call. */
  async call(name: string, args: Record<string, Json | undefined>): Promise<DriverResult> {
    await this.ready;
    const clean = Object.fromEntries(Object.entries(args).filter(([, v]) => v !== undefined));
    const res = await Promise.race([
      this.request("tools/call", { name, arguments: clean }),
      sleep(DRIVER_TIMEOUT_MS).then(() => {
        throw new Error(`${name} got no reply in ${DRIVER_TIMEOUT_MS / 1000}s; the app is probably blocked by a modal dialog. Check cua.windows() for a new window.`);
      }),
    ]);
    const text = (res.content ?? []).filter((c: any) => c.type === "text").map((c: any) => c.text).join("\n");
    const images = (res.content ?? []).filter((c: any) => c.type === "image").map((c: any) => ({ data: c.data, mimeType: c.mimeType }));
    let data: Record<string, any> | null = res.structuredContent ?? null;
    if (!data && text.trimStart().startsWith("{")) { try { data = JSON.parse(text); } catch { /* plain text */ } }
    return { text, data, images, isError: !!res.isError };
  }
}

// --- The `cua` API exposed to model code ---

/** Collects what one `js` call shows the model: logs, images. */
class Output {
  logs: string[] = [];
  images: Image[] = [];
}

function fail(r: DriverResult, what: string): never {
  throw new Error(`${what} failed: ${r.text.slice(0, 600)}`);
}

const KEY_ALIASES: Record<string, string> = { enter: "return", esc: "escape", del: "delete", ctl: "ctrl", control: "ctrl", win: "cmd" };

class Window {
  pid: number;
  id: number;
  title: string;
  app: string;
  private snapshot: string | null = null;
  private hasFrame = false; // did the latest read of this window include a screenshot?
  private dirty = false;
  private driver: Driver;
  private out: () => Output;

  constructor(driver: Driver, out: () => Output, w: { pid: number; window_id: number; title?: string; app_name?: string }) {
    this.driver = driver; this.out = out;
    this.pid = w.pid; this.id = w.window_id; this.title = w.title ?? ""; this.app = w.app_name ?? "";
  }

  toJSON() { return { pid: this.pid, id: this.id, app: this.app, title: this.title }; }

  /** Accessibility tree as compact text. Rows tagged [N] are actionable; pass N to click/setValue/type.
   *  opts.query filters rows; opts.diff returns only changes since the last read; opts.screenshot adds an image. */
  async state(opts: { query?: string; max?: number; diff?: boolean; screenshot?: boolean } = {}): Promise<string> {
    if (this.dirty) { await sleep(200); this.dirty = false; } // let the UI settle after actions
    // "a|b" means any of several substrings: read the tree and filter rows here.
    const multi = opts.query?.includes("|") ? new RegExp(opts.query.split("|").map((q) => q.trim().replace(/[.*+?^${}()[\]\\]/g, "\\$&")).join("|"), "i") : null;
    const r = await this.driver.call("get_window_state", {
      pid: this.pid, window_id: this.id, query: multi ? undefined : opts.query, max_elements: opts.max ?? 250,
      since: opts.diff && this.snapshot ? this.snapshot : undefined,
      include_screenshot: !!opts.screenshot, max_image_dimension: opts.screenshot ? SHOT_MAX : undefined,
    });
    if (r.isError) fail(r, "state");
    this.snapshot = r.data?.snapshot_id ?? this.snapshot;
    this.hasFrame = !!opts.screenshot;
    this.out().images.push(...r.images);
    const d = r.data ?? {};
    const head = `window ${this.id} "${d.window_title ?? this.title}" (${d.returned_element_count ?? "?"}/${d.total_element_count ?? "?"} rows${d.truncated ? ", truncated: pass max or query" : ""})`;
    let tree: string = d.tree_markdown ?? d.diff_markdown ?? r.text;
    if (multi) tree = tree.split("\n").filter((l) => multi.test(l)).join("\n");
    return `${head}\n${tree}`;
  }

  /** Element number of the first row whose text contains `text` (and `role`, if given), from a fresh read. */
  async find(text: string, role?: string): Promise<number | null> {
    // The driver's query output keeps ancestor rows (e.g. the window's Close button) for
    // context, so only accept rows that contain the text themselves.
    const rows = (await this.state({ query: text })).split("\n").slice(1);
    const row = rows.find((l) => /\[\d+\]/.test(l) && l.toLowerCase().includes(text.toLowerCase())
      && (!role || l.toLowerCase().includes(role.toLowerCase())));
    return row ? Number(row.match(/\[(\d+)\]/)![1]) : null;
  }

  private token(i: number): string {
    if (!this.snapshot) throw new Error("call state() on this window before using element numbers");
    return `${this.snapshot}:${i}`;
  }

  private async act(tool: string, args: Record<string, Json | undefined>) {
    const r = await this.driver.call(tool, args);
    this.dirty = true;
    if (r.isError) fail(r, tool);
    // Surface "dispatched but no reply" notes (a modal dialog probably opened) so the model looks for it.
    const summary: string = r.data?.summary ?? r.text;
    if (/did not return|dispatched/i.test(summary)) {
      const dialogs = (await this.driver.call("list_windows", { pid: this.pid, on_screen_only: true })).data?.windows ?? [];
      this.out().logs.push(`note: ${tool} ${summary.split(".")[0].toLowerCase()}; windows for this app now: ${dialogs.map((w: any) => `${w.window_id} "${w.title}"`).join(", ")}`);
    }
    return r;
  }

  /** Click element N from the last state(), or window pixels [x, y] from the last screenshot. */
  async click(target: number | [number, number], opts: { double?: boolean; right?: boolean } = {}) {
    const button = opts.right ? "right" : undefined, count = opts.double ? 2 : undefined;
    if (typeof target === "number") await this.act("click", { element_token: this.token(target), button, count });
    else {
      // The driver maps pixels through the latest read's screenshot; refresh it silently if that read had none.
      if (!this.hasFrame) await this.frame(false);
      await this.act("click", { pid: this.pid, window_id: this.id, x: target[0], y: target[1], button, count });
    }
  }

  /** Replace the value of an editable element N (text box, combo box) without typing. */
  async setValue(i: number, value: string) { await this.act("set_value", { element_token: this.token(i), pid: this.pid, value }); }

  /** Type text at the focused element, or into element N when `into` is given. */
  async type(text: string, into?: number) {
    await this.act("type_text", into === undefined ? { pid: this.pid, window_id: this.id, text } : { element_token: this.token(into), text });
  }

  /** Press a key or combination: "enter", "tab", "ctrl+s", "ctrl+shift+s", "alt+f4". */
  async key(combo: string) {
    const parts = combo.toLowerCase().split("+").map((k) => KEY_ALIASES[k.trim()] ?? k.trim());
    const key = parts.pop()!;
    if (parts.length) await this.act("hotkey", { pid: this.pid, window_id: this.id, keys: [...parts, key] });
    else await this.act("press_key", { pid: this.pid, window_id: this.id, key });
  }

  /** Invoke a menu item by path: "File > Save As..." */
  async menu(menuPath: string | string[]) {
    const p = Array.isArray(menuPath) ? menuPath : menuPath.split(">").map((s) => s.trim());
    await this.act("invoke_menu", { pid: this.pid, window_id: this.id, path: p });
  }

  /** Attach a screenshot of this window to the result (pixel coordinates for click([x, y]) refer to it). */
  async screenshot() { await this.frame(true); }

  private async frame(show: boolean) {
    if (this.dirty) { await sleep(200); this.dirty = false; }
    const r = await this.driver.call("get_window_state", { pid: this.pid, window_id: this.id, include_accessibility_tree: false, include_screenshot: true, max_image_dimension: SHOT_MAX });
    if (r.isError) fail(r, "screenshot");
    this.hasFrame = true;
    if (show) this.out().images.push(...r.images);
  }

  /** Poll until `text` appears in this window's tree (case-insensitive). Returns the matching rows, or throws on timeout. */
  async waitFor(text: string, timeoutMs = 5000): Promise<string> {
    const end = Date.now() + timeoutMs;
    for (;;) {
      const s = await this.state({ query: text });
      if (s.toLowerCase().includes(text.toLowerCase()) && /\[\d+\]|"/.test(s.split("\n").slice(1).join("\n"))) return s;
      if (Date.now() > end) throw new Error(`waitFor("${text}") timed out after ${timeoutMs} ms`);
      await sleep(250);
    }
  }
}

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

function makeCua(driver: Driver, out: () => Output) {
  const wrap = (w: any) => new Window(driver, out, w);
  async function listWindows(filter?: string | { pid?: number; app?: string; title?: string }) {
    const r = await driver.call("list_windows", { app: undefined, on_screen_only: true });
    if (r.isError) fail(r, "windows");
    // Hide the driver's own overlay windows (agent cursor) from the model.
    const all: any[] = (r.data?.windows ?? []).filter((w: any) => !/cua-driver/i.test(w.app_name ?? ""));
    if (filter && typeof filter === "object") {
      return all.filter((w) => (!filter.pid || w.pid === filter.pid)
        && (!filter.app || (w.app_name ?? "").toLowerCase().includes(filter.app.toLowerCase()))
        && (!filter.title || (w.title ?? "").toLowerCase().includes(filter.title.toLowerCase())));
    }
    const f = filter?.toLowerCase();
    return all.filter((w) => !f || `${w.app_name} ${w.title}`.toLowerCase().includes(f));
  }
  return {
    /** Visible top-level windows, optionally filtered by app name or title text. */
    async windows(filter?: string | { pid?: number; app?: string; title?: string }) {
      return (await listWindows(filter)).map((w) => ({ id: w.window_id, pid: w.pid, app: w.app_name, title: w.title }));
    },
    /** Bind one window by title/app text or {pid, id}. Throws with the candidates when ambiguous or missing. */
    async window(q: string | { pid?: number; id?: number; title?: string; app?: string }) {
      const all = await listWindows();
      const match = all.filter((w) => typeof q === "string"
        ? `${w.app_name} ${w.title}`.toLowerCase().includes(q.toLowerCase())
        : (!q.pid || w.pid === q.pid) && (!q.id || w.window_id === q.id)
          && (!q.title || (w.title ?? "").toLowerCase().includes(q.title.toLowerCase()))
          && (!q.app || (w.app_name ?? "").toLowerCase().includes(q.app.toLowerCase())));
      if (match.length === 0) throw new Error(`no window matches ${JSON.stringify(q)}. Visible: ${all.map((w) => `${w.app_name} "${w.title}"`).join("; ")}`);
      return wrap(match[0]);
    },
    /** Launch an app by name ("Calculator", "notepad") or full .exe path, in the background. Returns its window. */
    async open(name: string, opts: { args?: string[] } = {}) {
      const isPath = /[\\/]/.test(name);
      const r = await driver.call("launch_app", { name: isPath ? undefined : name, path: isPath ? name : undefined, additional_arguments: opts.args });
      if (r.isError) fail(r, "open");
      let wins: any[] = r.data?.windows ?? [];
      for (let i = 0; i < 20 && wins.length === 0; i++) { await sleep(250); wins = (await listWindows()).filter((w) => w.pid === r.data?.pid); }
      if (!wins.length) throw new Error(`launched ${name} (pid ${r.data?.pid}) but no window appeared yet; try cua.window("${name}")`);
      return wrap({ ...wins[0], pid: wins[0].pid ?? r.data?.pid });
    },
    sleep,
  };
}

// --- js runtime: one persistent vm context per server, reset by js_reset ---

class Runtime {
  private ctx!: vm.Context;
  private current = new Output();
  private driver: Driver;

  constructor(driver: Driver) { this.driver = driver; this.reset(); }

  reset() {
    const log = (...a: unknown[]) => { this.current.logs.push(a.map((x) => typeof x === "string" ? x : safeJson(x)).join(" ")); };
    this.ctx = vm.createContext({ cua: makeCua(this.driver, () => this.current), log, console: { log, error: log, warn: log }, sleep, setTimeout });
  }

  async run(code: string): Promise<{ text: string; images: Image[]; isError: boolean }> {
    this.current = new Output();
    const out = this.current;
    // Persist top-level `let/const/var x = ...` across calls by turning them into context globals.
    const body = hoistTopLevel(code);
    let value: unknown, error: string | null = null;
    try {
      const promise = vm.runInContext(`(async () => {\n${body}\n})()`, this.ctx, { filename: "js" }) as Promise<unknown>;
      value = await Promise.race([promise, sleep(CALL_TIMEOUT_MS).then(() => { throw new Error(`timed out after ${CALL_TIMEOUT_MS / 1000}s`); })]);
    } catch (e) {
      error = e instanceof Error ? e.message : String(e);
    }
    const parts = [...out.logs];
    if (value !== undefined) parts.push(typeof value === "string" ? value : safeJson(value));
    if (error) parts.push(`Error: ${error}`);
    let text = parts.join("\n") || (out.images.length ? `(${out.images.length} image attached)` : "(no output: return a value or call log())");
    if (text.length > TEXT_LIMIT) text = text.slice(0, TEXT_LIMIT) + `\n[truncated ${text.length - TEXT_LIMIT} chars; use state({query}) to narrow]`;
    return { text, images: out.images, isError: !!error };
  }
}

/** Rewrite `let|const|var name =` at brace depth 0 into `name =`, so the binding lands on the
 *  context's global object and survives into the next js call (like a REPL). Skips strings,
 *  template literals and comments; destructuring declarations are left alone. */
function hoistTopLevel(code: string): string {
  let out = "", depth = 0, i = 0;
  while (i < code.length) {
    const c = code[i], two = code.slice(i, i + 2);
    if (two === "//" || two === "/*") {
      const end = two === "//" ? code.indexOf("\n", i) : code.indexOf("*/", i + 2) + 2;
      const stop = end <= 0 || end === 1 ? code.length : end;
      out += code.slice(i, stop); i = stop; continue;
    }
    if (c === "'" || c === '"' || c === "`") {
      let j = i + 1;
      while (j < code.length && code[j] !== c) j += code[j] === "\\" ? 2 : 1;
      out += code.slice(i, j + 1); i = j + 1; continue;
    }
    if ("([{".includes(c)) depth++;
    else if (")]}".includes(c)) depth--;
    if (depth === 0 && /[A-Za-z_$]/.test(c) && !/[\w$.]/.test(code[i - 1] ?? "")) {
      const m = /^(let|const|var)\s+([A-Za-z_$][\w$]*)\s*=(?!=)/.exec(code.slice(i));
      if (m) { out += `${m[2]} =`; i += m[0].length; continue; }
    }
    out += c; i++;
  }
  return out;
}

function safeJson(v: unknown): string {
  try { return JSON.stringify(v); } catch { return String(v); }
}

// --- MCP server over stdio ---

const API = `Control Windows apps with JavaScript. The code runs in an async function with a persistent \`cua\` object; top-level let/const persist between calls. Return a value or call log(...) to see output.

cua.windows(filter?)            -> [{id, pid, app, title}] visible windows; filter is text or {pid, app, title}
cua.window("Notepad" | {pid,id,title,app}) -> Window  (bind an existing window)
cua.open("Calculator" | "C:\\\\path\\\\app.exe", {args?}) -> Window  (launch in background)
cua.sleep(ms)

w.state({query?, diff?, max?, screenshot?}) -> string  accessibility tree; rows tagged [N] are actionable; query "a|b" matches either
w.find("Save", role?)                        -> N | null  element number of the first matching row
w.click(N | [x, y], {double?, right?})       element N from the latest state(), or pixels in the latest screenshot
w.setValue(N, "text")                        set an edit/combo box value directly (fastest way to enter text)
w.type("text", N?)                           type at the focus, or into element N
w.key("enter" | "ctrl+s" | "alt+f4")         keys go to this window
w.menu("File > Save As...")                  invoke a menu item by its labels
w.waitFor("text", ms?)                       wait until text shows up in the tree; returns matching rows
w.screenshot()                               attach an image of the window
A control that opens a modal dialog may not return until the dialog closes; if an action reports no reply, look for the dialog with cua.windows({pid: w.pid}).

Input goes to the target window in the background: the user's mouse and focus are not touched.
Element numbers come from the most recent state() of that window; call state() again after the UI changes.

Work in few calls: batch several actions and the verifying read into one call. Example:
  const w = await cua.window("TestPad");
  log(await w.state({query: "Text editor"}));      // find the editor row, e.g. [3]
  await w.setValue(3, "alpha\\r\\nbeta"); await w.key("ctrl+s");
  return await w.waitFor("TestPad");               // confirm the title lost its * (saved)`;

const TOOLS = [
  { name: "js", description: API, inputSchema: { type: "object", properties: { code: { type: "string", description: "JavaScript to run" } }, required: ["code"] } },
  { name: "js_reset", description: "Reset the JavaScript context (clears variables).", inputSchema: { type: "object", properties: {} } },
];

const driver = new Driver(DRIVER);
const runtime = new Runtime(driver);
const send = (msg: object) => process.stdout.write(JSON.stringify(msg) + "\n");

createInterface({ input: process.stdin }).on("line", async (line) => {
  let msg: any;
  try { msg = JSON.parse(line); } catch { return; }
  if (msg.id === undefined) return; // notifications
  const reply = (result: object) => send({ jsonrpc: "2.0", id: msg.id, result });
  switch (msg.method) {
    case "initialize":
      return reply({ protocolVersion: msg.params?.protocolVersion ?? "2025-06-18", capabilities: { tools: {} },
        serverInfo: { name: "bcu", version: "0.0.1" },
        instructions: "Windows computer use through one `js` tool. Batch actions and checks into few calls; input runs in the background." });
    case "tools/list":
      return reply({ tools: TOOLS });
    case "tools/call": {
      if (msg.params?.name === "js_reset") { runtime.reset(); return reply({ content: [{ type: "text", text: "context reset" }] }); }
      const r = await runtime.run(String(msg.params?.arguments?.code ?? ""));
      return reply({ content: [{ type: "text", text: r.text }, ...r.images.map((i) => ({ type: "image", data: i.data, mimeType: i.mimeType }))], isError: r.isError });
    }
    case "ping":
      return reply({});
    default:
      send({ jsonrpc: "2.0", id: msg.id, error: { code: -32601, message: `unknown method ${msg.method}` } });
  }
});
