// bcu-mcp v2: prototype "code mode" computer-use MCP server for Claude.
// ARCHIVED v2: the version measured in bench/out/v2.3. The current one is plugin/server/.
//
// Exposes two tools, `js` and `js_reset`. `js` runs model-written JavaScript in
// a persistent context whose only capability is a small `cua` API, backed by a
// long-lived Cua Driver process (our local fork; background UIA input on Windows).
// research/08-experiments.md explains why each piece exists. Changes since v1:
//   - reads wait for the UI to settle (tree polling) instead of fixed or model-written sleeps
//   - select() for combo boxes, drag(), and an explicit, policy-gated {foreground: true}
//   - model code only sees frozen facades; the driver handle is unreachable from it
//   - optional app scoping (BCU_APPS) so window lists don't expose unrelated windows
//
// PROTOTYPE: node:vm is not a security boundary (constructor-chain escapes still work).
// The facades stop casual reach-through, which Claude did in v1; a real build needs a
// capability sandbox (QuickJS or isolated-vm).
//
// Run: node proto/v2/bcu-mcp.ts          (Node 24+, TypeScript via type stripping)
// Env: BCU_CUA_DRIVER  path to cua-driver.exe (default tools/cua-driver-fork/v2)
//      BCU_APPS        comma list; windows whose "app title" text contains none of them are hidden
//      BCU_FOREGROUND  "allow" (default) or "deny" for {foreground: true}
//      BCU_CURSOR      "fast" (default: visible agent cursor, short glide), "animated", or "off"

import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { createInterface } from "node:readline";
import { fileURLToPath } from "node:url";
import path from "node:path";
import vm from "node:vm";

const here = path.dirname(fileURLToPath(import.meta.url));
const DRIVER = process.env.BCU_CUA_DRIVER ?? path.join(here, "../tools/cua-driver-fork/v2/cua-driver.exe");
const APPS = (process.env.BCU_APPS ?? "").split(",").map((s) => s.trim().toLowerCase()).filter(Boolean);
const FOREGROUND_ALLOWED = (process.env.BCU_FOREGROUND ?? "allow") !== "deny";
// The driver's agent cursor glides to every click target before acting: about 430 ms per click
// with the default animation, 65 ms with an 80 ms fixed glide, 7 ms hidden (measured on Calculator).
const CURSOR = process.env.BCU_CURSOR ?? "fast"; // "fast" | "animated" | "off"
const SESSION = "bcu"; // one driver session label, so cursor settings apply to every action
const SHOT_MAX = 1200; // long edge; stays inside Claude's no-rescale box for common window shapes
const CALL_TIMEOUT_MS = 90_000;
const TEXT_LIMIT = 20_000;
const DRIVER_TIMEOUT_MS = 20_000;
const SETTLE_AFTER_ACTION_MS = 2_000; // reads this soon after any action wait for the tree to stop changing
const SETTLE_CAP_MS = 1_500;
const SETTLE_POLL_MS = 100;
const SLEEP_CAP_MS = 300;

type Json = null | boolean | number | string | Json[] | { [k: string]: Json };
type Image = { data: string; mimeType: string };
type DriverResult = { text: string; data: Record<string, any> | null; images: Image[]; isError: boolean };
type DriverWindow = { pid: number; window_id: number; title?: string; app_name?: string };
type WindowQuery = string | { pid?: number; id?: number; title?: string; app?: string };
type InputOpts = { foreground?: boolean };

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

// --- Cua Driver client: newline-delimited JSON-RPC over the driver's stdio MCP ---

class Driver {
  private proc: ChildProcessWithoutNullStreams;
  private nextId = 1;
  private pending = new Map<number, { resolve: (v: any) => void; reject: (e: Error) => void }>();
  private sessionTools = new Set<string>(); // tools whose schema takes a `session` label
  private tail: Promise<unknown> = Promise.resolve(); // last queued tool call
  ready: Promise<void>;

  constructor(exe: string) {
    const wslenv = ["DO_NOT_TRACK", process.env.WSLENV].filter(Boolean).join(":");
    this.proc = spawn(exe, ["mcp"], { env: { ...process.env, DO_NOT_TRACK: "1", WSLENV: wslenv } });
    createInterface({ input: this.proc.stdout }).on("line", (line) => this.onLine(line));
    this.proc.stderr.on("data", () => {}); // driver logs; ignored
    this.ready = this.request("initialize", {
      protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "bcu", version: "0.0.2" },
    }).then(async () => {
      this.send({ jsonrpc: "2.0", method: "notifications/initialized" });
      const { tools } = await this.request("tools/list", {});
      for (const t of tools ?? []) if (t.inputSchema?.properties?.session) this.sessionTools.add(t.name);
      if (CURSOR === "off") await this.request("tools/call", { name: "set_agent_cursor_enabled", arguments: { session: SESSION, enabled: false } });
      else if (CURSOR === "fast") await this.request("tools/call", { name: "set_agent_cursor_motion", arguments: { session: SESSION, timing: "fixed", glide_duration_ms: 80, dwell_after_click_ms: 0 } });
    });
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

  /** Call a driver tool. Calls run one at a time in the order they were issued, so model code that
   *  forgets `await` (`w.setValue(...); await w.menu(...)`) still acts in the order it was written. */
  call(name: string, args: Record<string, Json | undefined>): Promise<DriverResult> {
    const run = this.tail.then(() => this.callNow(name, args));
    this.tail = run.catch(() => {});
    return run;
  }

  /** Parses the JSON text block when there is one. Gives up after DRIVER_TIMEOUT_MS so a hung
   *  app costs one short error instead of the whole js call. */
  private async callNow(name: string, args: Record<string, Json | undefined>): Promise<DriverResult> {
    await this.ready;
    const clean = Object.fromEntries(Object.entries(args).filter(([, v]) => v !== undefined));
    if (this.sessionTools.has(name)) clean.session = SESSION;
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

// --- Shared session state for one js call and across calls ---

/** What one `js` call shows the model: logs, notes, images. */
class Output {
  logs: string[] = [];
  images: Image[] = [];
  notes = new Set<string>();
  pendingLogs: Promise<void>[] = [];
  pending: Promise<void>[] = []; // every API call started during this js call
  errors: string[] = []; // failures of API calls, reported even when the model didn't await them
}

class Session {
  lastActionAt = 0;
  allowedPids = new Set<number>(); // apps launched through cua.open are always in scope
  out = new Output();
  readonly driver: Driver;
  constructor(driver: Driver) { this.driver = driver; }
  note(text: string) { this.out.notes.add(text); }
  private apiTail: Promise<unknown> = Promise.resolve();
  /** Run one model-facing API call after every API call issued before it. The queue is entered
   *  synchronously at call time, so `w.setValue(...); await w.menu(...)` without an await on the
   *  first call still runs in written order. Implementations never enqueue, so nesting can't deadlock. */
  enqueue<T>(f: () => Promise<T>): Promise<T> {
    const run = this.apiTail.then(f);
    this.apiTail = run.catch(() => {});
    return this.track(run);
  }
  /** Register an API promise: the js call waits for it before returning, and its failure is
   *  reported instead of becoming an unhandled rejection that would kill this server. */
  track<T>(p: Promise<T>): Promise<T> {
    const out = this.out;
    out.pending.push(p.then(() => {}, (e) => { out.errors.push(e instanceof Error ? e.message : String(e)); }));
    return p;
  }
  markAction() { this.lastActionAt = Date.now(); }
  get recentlyActed() { return Date.now() - this.lastActionAt < SETTLE_AFTER_ACTION_MS; }
  inScope(w: DriverWindow) {
    if (/cua-driver/i.test(w.app_name ?? "")) return false; // the driver's own cursor overlay
    if (!APPS.length || this.allowedPids.has(w.pid)) return true;
    const text = `${w.app_name ?? ""} ${w.title ?? ""}`.toLowerCase();
    return APPS.some((a) => text.includes(a));
  }
}

function fail(r: DriverResult, what: string): never {
  let msg = r.text.slice(0, 600);
  if (/background_unavailable|delivery_mode:"foreground"/.test(msg)) {
    msg += '\nHint: setValue()/select() work in the background for text boxes and combo boxes. Otherwise retry with {foreground: true}, which briefly takes focus and the real cursor.';
  }
  throw new Error(`${what} failed: ${msg}`);
}

const KEY_ALIASES: Record<string, string> = { enter: "return", esc: "escape", del: "delete", ctl: "ctrl", control: "ctrl", win: "cmd" };
const rowIndex = (line: string) => Number(line.match(/\[(\d+)\]/)?.[1] ?? NaN);

// --- One bound window. Internal: model code gets a frozen facade from windowApi(). ---

class Window {
  private snapshot: string | null = null;
  private lastTree = "";
  private hasFrame = false; // did the latest read of this window include a screenshot?
  private s: Session;
  readonly pid: number;
  readonly id: number;
  readonly app: string;
  readonly title: string;

  constructor(s: Session, pid: number, id: number, app: string, title: string) {
    this.s = s; this.pid = pid; this.id = id; this.app = app; this.title = title;
  }

  private async read(opts: { query?: string; max?: number; diff?: boolean; screenshot?: boolean }) {
    const r = await this.s.driver.call("get_window_state", {
      pid: this.pid, window_id: this.id, query: opts.query, max_elements: opts.max ?? 250,
      since: opts.diff && this.snapshot ? this.snapshot : undefined,
      include_screenshot: !!opts.screenshot, max_image_dimension: opts.screenshot ? SHOT_MAX : undefined,
    });
    if (r.isError) fail(r, "state");
    this.snapshot = r.data?.snapshot_id ?? this.snapshot;
    this.hasFrame = !!opts.screenshot;
    const d = r.data ?? {};
    const tree: string = d.tree_markdown ?? d.diff_markdown ?? r.text;
    return { r, d, tree };
  }

  /** Accessibility tree as compact text; rows tagged [N] are actionable. Right after an action it
   *  re-reads until two reads match (UI settled), so callers never need to sleep. */
  async state(opts: { query?: string; max?: number; diff?: boolean; screenshot?: boolean } = {}): Promise<string> {
    // "a|b" means any of several substrings: read the tree and filter rows here.
    const multi = opts.query?.includes("|")
      ? new RegExp(opts.query.split("|").map((q) => q.trim().replace(/[.*+?^${}()[\]\\]/g, "\\$&")).join("|"), "i") : null;
    const readOpts = { ...opts, query: multi ? undefined : opts.query };
    let cur = await this.read(readOpts);
    if (this.s.recentlyActed && !opts.diff) {
      const end = Date.now() + SETTLE_CAP_MS;
      while (Date.now() < end) {
        await sleep(SETTLE_POLL_MS);
        const next = await this.read({ ...readOpts, screenshot: false });
        const stable = next.tree === cur.tree;
        cur = opts.screenshot ? { ...next, r: cur.r } : next; // keep the screenshot from the first read
        if (stable) break;
      }
      if (opts.screenshot) cur = await this.read(readOpts); // fresh frame bound to the final snapshot
    }
    this.s.out.images.push(...cur.r.images);
    this.lastTree = cur.tree;
    const d = cur.d;
    const head = `window ${this.id} "${d.window_title ?? this.title}" (${d.returned_element_count ?? "?"}/${d.total_element_count ?? "?"} rows${d.truncated ? ", truncated: pass max or query" : ""})`;
    const tree = multi ? cur.tree.split("\n").filter((l) => multi.test(l)).join("\n") : cur.tree;
    return `${head}\n${tree}`;
  }

  /** Element number of the best row for `text` (and `role`, if given), from a fresh read.
   *  Ranks by the element's name: exact, then prefix, then substring, then anywhere in the row
   *  (ids, values). A plain substring match picked `Memory add [id=MemPlus]` for "Plus". */
  async find(text: string, role?: string): Promise<number | null> {
    const want = text.toLowerCase();
    // The driver's query output keeps ancestor rows (e.g. the window's Close button) for context.
    const rows = (await this.state({ query: text })).split("\n").slice(1).filter((l) => /\[\d+\]/.test(l));
    const rank = (l: string) => {
      const m = l.match(/\[\d+\]\s+(\S+)(?:\s+"([^"]*)")?/);
      if (!m || (role && m[1].toLowerCase() !== role.toLowerCase())) return 0;
      const name = (m[2] ?? "").toLowerCase();
      return name === want ? 4 : name.startsWith(want) ? 3 : name.includes(want) ? 2 : l.toLowerCase().includes(want) ? 1 : 0;
    };
    let best: string | undefined, bestRank = 0;
    for (const l of rows) { const r = rank(l); if (r > bestRank) { best = l; bestRank = r; } }
    return best ? rowIndex(best) : null;
  }

  private token(i: number): string {
    if (!this.snapshot) throw new Error("call state() on this window before using element numbers");
    return `${this.snapshot}:${i}`;
  }

  private delivery(opts: InputOpts) {
    if (!opts.foreground) return undefined;
    if (!FOREGROUND_ALLOWED) throw new Error("foreground input is disabled by policy (BCU_FOREGROUND=deny)");
    this.s.note("used foreground input: it briefly took focus and the real cursor");
    return "foreground";
  }

  private async act(tool: string, args: Record<string, Json | undefined>) {
    const r = await this.s.driver.call(tool, args);
    this.s.markAction();
    if (r.isError) fail(r, tool);
    // Surface "a dialog probably opened" information from the driver so the model looks for it.
    const summary: string = r.data?.summary ?? r.text;
    if (/did not return|dispatched|new window|dialog/i.test(summary)) this.s.note(`${tool}: ${summary.slice(0, 300)}`);
    return r;
  }

  private async ensureFrame() {
    // The driver maps pixels through the latest read's screenshot; refresh it silently if that read had none.
    if (!this.hasFrame) await this.frame(false);
  }

  /** Labels from the top-level menu down to row `i`, when `i` is a MenuItem nested under another
   *  MenuItem (a drop-down item). Read from the indentation of the last tree shown. */
  private menuPath(i: number): string[] | null {
    const lines = this.lastTree.split("\n");
    const at = lines.findIndex((l) => rowIndex(l) === i);
    if (at < 0 || !/\]\s+MenuItem\s+"/.test(lines[at])) return null;
    const path = [lines[at].match(/MenuItem\s+"([^"]*)"/)![1]];
    let indent = lines[at].search(/\S/);
    for (let j = at - 1; j >= 0; j--) {
      const d = lines[j].search(/\S/);
      if (d >= indent) continue;
      const m = lines[j].match(/MenuItem\s+"([^"]*)"/);
      if (!m) break;
      path.unshift(m[1]); indent = d;
    }
    return path.length > 1 ? path : null;
  }

  async click(target: number | [number, number], opts: { double?: boolean; right?: boolean } & InputOpts = {}) {
    const button = opts.right ? "right" : undefined, count = opts.double ? 2 : undefined, delivery_mode = this.delivery(opts);
    // A closed drop-down's items sit off screen; clicking one directly makes the driver fall back to
    // a blocking UIA Invoke (a modal dialog then freezes the app's tree). Walk the menu instead.
    const path = typeof target === "number" && !opts.right && !opts.double && !opts.foreground ? this.menuPath(target) : null;
    if (path) return this.menu(path);
    if (typeof target === "number") return void await this.act("click", { element_token: this.token(target), button, count, delivery_mode });
    await this.ensureFrame();
    await this.act("click", { pid: this.pid, window_id: this.id, x: target[0], y: target[1], button, count, delivery_mode });
  }

  async setValue(i: number, value: string) { await this.act("set_value", { element_token: this.token(i), pid: this.pid, value }); }

  /** Choose `option` in combo box N and verify it took. */
  async select(i: number, option: string) {
    const label = this.lastTree.split("\n").find((l) => rowIndex(l) === i)?.match(/"([^"]*)"/)?.[1];
    await this.setValue(i, option);
    const check = async () => {
      const rows = (await this.state(label ? { query: label } : {})).split("\n");
      const row = rows.find((l) => (label ? l.includes(`"${label}"`) : rowIndex(l) === i) && /ComboBox|List/.test(l));
      return { ok: !!row && row.toLowerCase().includes(`value="${option.toLowerCase()}"`), row };
    };
    let res = await check();
    if (res.ok) return;
    // Fallback: open the list and select the option element directly.
    if (res.row) await this.act("click", { element_token: this.token(rowIndex(res.row)), action: "expand" });
    const opt = (await this.state({ query: option })).split("\n").find((l) => /\[\d+\]/.test(l) && /ListItem|MenuItem|Option/.test(l) && l.includes(`"${option}"`));
    if (!opt) throw new Error(`select: no option "${option}" found after expanding the list`);
    await this.act("click", { element_token: this.token(rowIndex(opt)), action: "select" });
    res = await check();
    if (!res.ok) throw new Error(`select: "${option}" did not take; the row now reads: ${res.row?.trim() ?? "(not found)"}`);
  }

  async type(text: string, into?: number, opts: InputOpts = {}) {
    const delivery_mode = this.delivery(opts);
    await this.act("type_text", into === undefined ? { pid: this.pid, window_id: this.id, text, delivery_mode } : { element_token: this.token(into), text, delivery_mode });
  }

  async key(combo: string, opts: InputOpts = {}) {
    const parts = combo.toLowerCase().split("+").map((k) => KEY_ALIASES[k.trim()] ?? k.trim());
    const key = parts.pop()!, delivery_mode = this.delivery(opts);
    if (parts.length) await this.act("hotkey", { pid: this.pid, window_id: this.id, keys: [...parts, key], delivery_mode });
    else await this.act("press_key", { pid: this.pid, window_id: this.id, key, delivery_mode });
  }

  async drag(from: [number, number], to: [number, number], opts: InputOpts = {}) {
    await this.ensureFrame();
    await this.act("drag", { pid: this.pid, window_id: this.id, from_x: from[0], from_y: from[1], to_x: to[0], to_y: to[1], delivery_mode: this.delivery(opts) });
  }

  async menu(menuPath: string | string[]) {
    const p = Array.isArray(menuPath) ? menuPath : menuPath.split(">").map((s) => s.trim());
    try {
      await this.act("invoke_menu", { pid: this.pid, window_id: this.id, path: p });
    } catch (e) {
      // Labels like "Replace..." are often written without the ellipsis; retry once with it.
      const seg = Number(String(e).match(/segment (\d+) was not found/)?.[1]); // 0-based
      if (Number.isNaN(seg) || seg >= p.length || p[seg].endsWith("...")) throw e;
      await this.act("invoke_menu", { pid: this.pid, window_id: this.id, path: p.map((x, k) => (k === seg ? `${x}...` : x)) });
    }
  }

  async screenshot() { await this.frame(true); }

  private async frame(show: boolean) {
    if (this.s.recentlyActed) await sleep(250);
    const r = await this.s.driver.call("get_window_state", { pid: this.pid, window_id: this.id, include_accessibility_tree: false, include_screenshot: true, max_image_dimension: SHOT_MAX });
    if (r.isError) fail(r, "screenshot");
    this.hasFrame = true;
    if (show) this.s.out.images.push(...r.images);
  }

  /** Poll until `text` appears in this window's tree (case-insensitive). Returns the matching rows. */
  async waitFor(text: string, timeoutMs = 5000): Promise<string> {
    const end = Date.now() + timeoutMs;
    for (;;) {
      const { d, tree } = await this.read({ query: text });
      if (tree.toLowerCase().includes(text.toLowerCase())) {
        this.lastTree = tree;
        return `window ${this.id} "${d.window_title ?? this.title}"\n${tree}`;
      }
      if (Date.now() > end) throw new Error(`waitFor("${text}") timed out after ${timeoutMs} ms`);
      await sleep(150);
    }
  }
}

type Elem = number | null | PromiseLike<number | null>;

/** Element numbers may arrive as an un-awaited find() result; resolve them and fail clearly on null. */
async function elem(e: Elem, what: string): Promise<number> {
  const n = await e;
  if (n === null || n === undefined || Number.isNaN(n)) throw new Error(`${what}: no element (find() returned null; check the text, or read state() to pick a row)`);
  return n;
}

/** Unqueued implementations behind each facade, for lazyWindow. Not reachable from model code. */
const RAW = new WeakMap<object, ReturnType<typeof windowImpl>>();

function windowImpl(w: Window) {
  return {
    state: (o?: Parameters<Window["state"]>[0]) => w.state(o),
    find: (text: string, role?: string) => w.find(text, role),
    click: async (x: Elem | [number, number], o?: Parameters<Window["click"]>[1]) => w.click(Array.isArray(x) ? x : await elem(x, "click"), o),
    setValue: async (i: Elem, v: string) => w.setValue(await elem(i, "setValue"), v),
    select: async (i: Elem, option: string) => w.select(await elem(i, "select"), option),
    type: async (text: string, into?: Elem, o?: InputOpts) => w.type(text, into === undefined ? undefined : await elem(into, "type"), o),
    key: (combo: string, o?: InputOpts) => w.key(combo, o),
    drag: (from: [number, number], to: [number, number], o?: InputOpts) => w.drag(from, to, o),
    menu: (p: string | string[]) => w.menu(p),
    screenshot: () => w.screenshot(),
    waitFor: (text: string, ms?: number) => w.waitFor(text, ms),
  };
}

type Impl = ReturnType<typeof windowImpl>;
const METHODS = ["state", "find", "click", "setValue", "select", "type", "key", "drag", "menu", "screenshot", "waitFor"] as const;

/** The only view of a window that model code gets: data plus queued methods, frozen. */
function windowApi(w: Window, s: Session) {
  const impl = windowImpl(w);
  const queued = Object.fromEntries(METHODS.map((n) => [n, (...a: unknown[]) => s.enqueue(() => (impl[n] as (...x: unknown[]) => Promise<unknown>)(...a))])) as unknown as Impl;
  const api = Object.freeze({ pid: w.pid, id: w.id, app: w.app, title: w.title, ...queued,
    toJSON: () => ({ pid: w.pid, id: w.id, app: w.app, title: w.title }) });
  RAW.set(api, impl);
  return api;
}

type WindowApi = ReturnType<typeof windowApi>;

/** Lets `cua.window(...)` work with or without `await`: each method queues behind the binding.
 *  Models often forget the await; without this the first call fails with "w.state is not a function". */
function lazyWindow(binding: Promise<WindowApi>, s: Session) {
  const methods = Object.fromEntries(METHODS.map((n) => [n, (...a: unknown[]) =>
    s.enqueue(async () => (RAW.get(await binding)![n] as (...x: unknown[]) => Promise<unknown>)(...a))])) as unknown as Impl;
  return Object.freeze({
    ...methods,
    then: (ok: (w: WindowApi) => unknown, err?: (e: unknown) => unknown) => binding.then(ok, err),
  });
}

/** Resolve promises the model returned without awaiting (e.g. `return [cua.windows(), w.state()]`).
 *  Checks for thenables, not `instanceof Promise`: promises made inside the vm are another realm's. */
const isThenable = (x: unknown): x is PromiseLike<unknown> => !!x && typeof (x as { then?: unknown }).then === "function";
async function settleValue(v: unknown): Promise<unknown> {
  if (isThenable(v)) v = await v;
  if (Array.isArray(v)) return Promise.all(v);
  if (v && typeof v === "object" && !isThenable(v) && Object.values(v).some(isThenable)) {
    return Object.fromEntries(await Promise.all(Object.entries(v).map(async ([k, x]) => [k, await x] as const)));
  }
  return v;
}

function makeCua(s: Session) {
  async function listWindows(): Promise<DriverWindow[]> {
    const r = await s.driver.call("list_windows", { on_screen_only: true });
    if (r.isError) fail(r, "windows");
    return (r.data?.windows ?? []).filter((w: DriverWindow) => s.inScope(w));
  }
  const matches = (w: DriverWindow, q: WindowQuery) => typeof q === "string"
    ? `${w.app_name} ${w.title}`.toLowerCase().includes(q.toLowerCase())
    : (!q.pid || w.pid === q.pid) && (!q.id || w.window_id === q.id)
      && (!q.title || (w.title ?? "").toLowerCase().includes(q.title.toLowerCase()))
      && (!q.app || (w.app_name ?? "").toLowerCase().includes(q.app.toLowerCase()));
  const bind = (w: DriverWindow) => windowApi(new Window(s, w.pid, w.window_id, w.app_name ?? "", w.title ?? ""), s);

  return Object.freeze({
    windows(filter?: WindowQuery) {
      return s.enqueue(() => listWindows().then((all) => all.filter((w) => !filter || matches(w, filter))
        .map((w) => ({ id: w.window_id, pid: w.pid, app: w.app_name, title: w.title }))));
    },
    window(q: WindowQuery) {
      return lazyWindow(s.enqueue(async () => {
        const all = await listWindows();
        const hit = all.find((w) => matches(w, q));
        if (!hit) throw new Error(`no window matches ${JSON.stringify(q)}. Visible: ${all.map((w) => `${w.app_name} "${w.title}"`).join("; ")}`);
        return bind(hit);
      }), s);
    },
    open(name: string, opts: { args?: string[] } = {}) { return lazyWindow(s.enqueue(() => openApp(name, opts)), s); },
    /** Capped: reads already wait for the UI to settle. */
    sleep(ms: number) { return s.enqueue(() => capped(ms)); },
  });

  async function capped(ms: number) {
      if (ms > SLEEP_CAP_MS) s.note(`cua.sleep is capped at ${SLEEP_CAP_MS} ms: state(), find() and waitFor() already wait for the UI to settle`);
      await sleep(Math.min(ms, SLEEP_CAP_MS));
  }

  async function openApp(name: string, opts: { args?: string[] }) {
      const isPath = /[\\/]/.test(name);
      const r = await s.driver.call("launch_app", { name: isPath ? undefined : name, path: isPath ? name : undefined, additional_arguments: opts.args });
      if (r.isError) fail(r, "open");
      const pid: number | undefined = r.data?.pid;
      if (pid) s.allowedPids.add(pid);
      let wins: DriverWindow[] = r.data?.windows ?? [];
      for (let i = 0; i < 20 && wins.length === 0; i++) { await sleep(250); wins = (await listWindows()).filter((w) => w.pid === pid); }
      if (!wins.length) throw new Error(`launched ${name} (pid ${pid}) but no window appeared yet; try cua.window("${name}")`);
      s.allowedPids.add(wins[0].pid);
      s.markAction();
      return bind({ ...wins[0], pid: wins[0].pid ?? pid });
  }
}

// --- js runtime: one persistent vm context per server, reset by js_reset ---

class Runtime {
  private ctx!: vm.Context;
  private s: Session;
  constructor(s: Session) { this.s = s; this.reset(); }

  reset() {
    const s = this.s;
    // log() may be handed un-awaited promises (e.g. log(cua.windows())); resolve them before printing.
    const log = (...a: unknown[]) => {
      const slot = s.out.logs.push("") - 1;
      s.out.pendingLogs.push(Promise.all(a.map(settleValue)).then(
        (vals) => { s.out.logs[slot] = vals.map((x) => typeof x === "string" ? x : safeJson(x)).join(" "); },
        (err) => { s.out.logs[slot] = `log() argument failed: ${err instanceof Error ? err.message : String(err)}`; }));
    };
    const cappedTimeout = (fn: () => void, ms = 0) => {
      if (ms > SLEEP_CAP_MS) s.note(`setTimeout delays are capped at ${SLEEP_CAP_MS} ms: reads already wait for the UI to settle`);
      return setTimeout(fn, Math.min(ms, SLEEP_CAP_MS));
    };
    this.ctx = vm.createContext({ cua: makeCua(s), log, console: Object.freeze({ log, error: log, warn: log }), setTimeout: cappedTimeout });
  }

  async run(code: string): Promise<{ text: string; images: Image[]; isError: boolean }> {
    const out = (this.s.out = new Output());
    const body = hoistTopLevel(code); // top-level let/const persist across calls, like a REPL
    let value: unknown, error: string | null = null;
    try {
      const promise = vm.runInContext(`(async () => {\n${body}\n})()`, this.ctx, { filename: "js" }) as Promise<unknown>;
      value = await Promise.race([promise.then(settleValue), sleep(CALL_TIMEOUT_MS).then(() => { throw new Error(`timed out after ${CALL_TIMEOUT_MS / 1000}s`); })]);
    } catch (e) {
      error = e instanceof Error ? e.message : String(e);
    }
    await Promise.race([Promise.all(out.pending), sleep(DRIVER_TIMEOUT_MS)]); // un-awaited actions finish first
    await Promise.all(out.pendingLogs);
    const parts = [...out.logs];
    if (value !== undefined) parts.push(typeof value === "string" ? value : safeJson(value));
    if (error) parts.push(`Error: ${error}`);
    const unseen = [...new Set(out.errors)].filter((e) => !error?.includes(e));
    parts.push(...unseen.map((e) => `Error (in a call that wasn't awaited): ${e}`));
    if (unseen.length) error = error ?? unseen[0];
    parts.push(...[...out.notes].map((n) => `note: ${n}`));
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
cua.window("TestPad" | {pid,id,title,app}) -> Window  (bind an existing window)
cua.open("Calculator" | "C:\\\\path\\\\app.exe", {args?}) -> Window  (launch in background)

w.state({query?, diff?, max?, screenshot?}) -> string  accessibility tree; rows tagged [N] are actionable; query "a|b" matches either
w.find("Save", role?)                        -> N | null  best match by element name (exact first); role like "Button"
w.click(N | [x, y], {double?, right?})       element N from the latest state(), or pixels in the latest screenshot
w.setValue(N, "text")                        set a text box value directly (fastest way to enter text)
w.select(N, "Pro")                           choose an option in combo box N (verified)
w.type("text", N?)                           type at the focus, or into element N
w.key("enter" | "ctrl+s" | "alt+f4")         keys go to this window
w.drag([x1, y1], [x2, y2])                   pixels in the latest screenshot
w.menu("File > Save As...")                  invoke a menu item by its labels
w.waitFor("text", ms?)                       wait until text shows up in the tree; returns matching rows
w.screenshot()                               attach an image of the window

Input goes to the target window in the background: the user's mouse and focus are not touched.
If an action is refused in the background, click/type/key/drag accept {foreground: true}, which briefly takes focus and the real cursor. Use it only when setValue/select can't do the job.
Don't sleep: state(), find() and waitFor() already wait for the UI to settle after actions.
Element numbers come from the most recent state() of that window; call state() again after the UI changes.
If an action opens a dialog, the result notes the new window; bind it with cua.window({pid: w.pid, title: "..."}).

Work in few calls: batch several actions and the verifying read into one call. Example:
  const w = await cua.window("TestPad");
  const ed = await w.find("Text editor");
  await w.setValue(ed, "alpha\\r\\nbeta"); await w.key("ctrl+s");
  return await w.waitFor("TestPad");               // the title loses its * once saved`;

const TOOLS = [
  { name: "js", description: API, inputSchema: { type: "object", properties: { code: { type: "string", description: "JavaScript to run" } }, required: ["code"] } },
  { name: "js_reset", description: "Reset the JavaScript context (clears variables).", inputSchema: { type: "object", properties: {} } },
];

const session = new Session(new Driver(DRIVER));
process.on("unhandledRejection", (e) => { session.out.errors.push(`unhandled: ${e instanceof Error ? e.message : String(e)}`); });
const runtime = new Runtime(session);
const send = (msg: object) => process.stdout.write(JSON.stringify(msg) + "\n");

createInterface({ input: process.stdin }).on("line", async (line) => {
  let msg: any;
  try { msg = JSON.parse(line); } catch { return; }
  if (msg.id === undefined) return; // notifications
  const reply = (result: object) => send({ jsonrpc: "2.0", id: msg.id, result });
  switch (msg.method) {
    case "initialize":
      return reply({ protocolVersion: msg.params?.protocolVersion ?? "2025-06-18", capabilities: { tools: {} },
        serverInfo: { name: "bcu", version: "0.0.2" },
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
