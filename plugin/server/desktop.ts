// Host side of the `cua` API. Model code runs in the QuickJS sandbox (sandbox.ts); every API call
// there reaches Desktop.dispatch as a method name plus JSON arguments. Nothing in here is reachable
// from model code except through dispatch, which validates every argument.
//
// Calls arrive one at a time in the order the model wrote them (the sandbox queues them), so
// implementations here may call each other freely without re-queueing.

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { sleep, type Args, type Driver, type DriverResult, type DriverWindow, type Image } from "./driver.ts";
import { appOf, type App, type Policy } from "./policy.ts";

const SHOT_MAX = 1200; // long edge; inside Claude's no-rescale box for common window shapes
const SETTLE_AFTER_ACTION_MS = 2_000; // reads this soon after an action wait for the tree to stop changing
const SETTLE_CAP_MS = 1_500;
const SETTLE_POLL_MS = 100;
const SLEEP_CAP_MS = 300;
const AUDIT = process.env.BCU_AUDIT ?? path.join(os.homedir(), ".local", "state", "bcu", "actions.jsonl");

type StateOpts = { query?: string; max?: number; diff?: boolean; screenshot?: boolean };
type InputOpts = { foreground?: boolean };
type ClickOpts = InputOpts & { double?: boolean; right?: boolean };
type WindowQuery = string | { pid?: number; id?: number; title?: string; app?: string };
type WindowInfo = { pid: number; id: number; app: string; title: string };

/** What one `js` call shows the model besides its logs and return value. */
export type RunOutput = { images: Image[]; notes: Set<string> };

// --- Argument checks: everything below arrives from model code as JSON ---

const isObj = (x: unknown): x is Record<string, unknown> => typeof x === "object" && x !== null && !Array.isArray(x);

function str(x: unknown, what: string): string {
  if (typeof x !== "string") throw new Error(`${what}: expected a string, got ${JSON.stringify(x)}`);
  return x;
}
const optStr = (x: unknown, what: string) => (x == null ? undefined : str(x, what));
function optNum(x: unknown, what: string): number | undefined {
  if (x == null) return undefined;
  if (typeof x !== "number" || !Number.isFinite(x)) throw new Error(`${what}: expected a number, got ${JSON.stringify(x)}`);
  return x;
}
const flag = (o: Record<string, unknown>, k: string) => o[k] === true;

/** An element number from state()/find(). null usually means an un-awaited find() found nothing. */
function elem(x: unknown, what: string): number {
  if (typeof x === "number" && Number.isInteger(x) && x >= 0) return x;
  if (x == null) throw new Error(`${what}: no element (find() returned null; check the text, or read state() to pick a row)`);
  throw new Error(`${what}: expected an element number from state() or find(), got ${JSON.stringify(x)}`);
}

function point(x: unknown, what: string): [number, number] {
  if (Array.isArray(x) && x.length === 2 && x.every((n) => typeof n === "number" && Number.isFinite(n))) return [x[0], x[1]];
  throw new Error(`${what}: expected [x, y] pixels in the latest screenshot, got ${JSON.stringify(x)}`);
}

function stateOpts(x: unknown): StateOpts {
  if (x == null) return {};
  if (!isObj(x)) throw new Error("state: options must be an object like {query: \"Save\"}");
  return { query: optStr(x.query, "state query"), max: optNum(x.max, "state max"), diff: flag(x, "diff"), screenshot: flag(x, "screenshot") };
}

const inputOpts = (x: unknown): InputOpts => (isObj(x) ? { foreground: flag(x, "foreground") } : {});
const clickOpts = (x: unknown): ClickOpts => (isObj(x) ? { foreground: flag(x, "foreground"), double: flag(x, "double"), right: flag(x, "right") } : {});

function windowQuery(x: unknown): WindowQuery {
  if (typeof x === "string") return x;
  if (isObj(x)) return { pid: optNum(x.pid, "pid"), id: optNum(x.id, "id"), title: optStr(x.title, "title"), app: optStr(x.app, "app") };
  throw new Error(`expected a window name or {pid, id, title, app}, got ${JSON.stringify(x)}`);
}

function fail(r: DriverResult, what: string): never {
  let msg = r.text.slice(0, 600);
  if (/background_unavailable|delivery_mode:"foreground"/.test(msg)) {
    msg += "\nHint: setValue()/select() work in the background for text boxes and combo boxes. Otherwise retry with {foreground: true}, which briefly takes focus and the real cursor (the user may be asked first).";
  }
  throw new Error(`${what} failed: ${msg}`);
}

function audit(entry: Record<string, unknown>) {
  if (AUDIT === "off") return;
  try {
    fs.mkdirSync(path.dirname(AUDIT), { recursive: true });
    fs.appendFileSync(AUDIT, JSON.stringify({ t: new Date().toISOString(), ...entry }) + "\n");
  } catch { /* auditing must never break an action */ }
}

const KEY_ALIASES: Record<string, string> = { enter: "return", esc: "escape", del: "delete", ctl: "ctrl", control: "ctrl", win: "cmd" };
const rowIndex = (line: string) => Number(line.match(/\[(\d+)\]/)?.[1] ?? NaN);

// --- Desktop: windows, binding, dispatch ---

export class Desktop {
  out: RunOutput = { images: [], notes: new Set() };
  private lastActionAt = 0;
  private readonly bindings = new Map<number, Promise<Win>>();
  readonly driver: Driver;
  readonly policy: Policy;

  constructor(driver: Driver, policy: Policy) {
    this.driver = driver;
    this.policy = policy;
  }

  beginRun() { this.out = { images: [], notes: new Set() }; }
  note(text: string) { this.out.notes.add(text); }
  markAction() { this.lastActionAt = Date.now(); }
  get recentlyActed() { return Date.now() - this.lastActionAt < SETTLE_AFTER_ACTION_MS; }

  /** Entry point for every sandbox call: `cua.*` and `w.*` methods with JSON arguments. */
  async dispatch(method: string, args: unknown[]): Promise<unknown> {
    switch (method) {
      case "cua.windows": return this.windows(args[0] == null ? undefined : windowQuery(args[0]));
      case "cua.window": return this.bind(args[0], () => this.findWindow(windowQuery(args[1])));
      case "cua.open": return this.bind(args[0], () => this.open(str(args[1], "open"), args[2]));
      case "cua.sleep": return this.cappedSleep(optNum(args[0], "sleep") ?? 0);
    }
    if (!method.startsWith("w.")) throw new Error(`unknown API method ${method}`);
    const w = await this.boundWindow(args[0]);
    const [a, b, c] = args.slice(1);
    switch (method.slice(2)) {
      case "state": return w.state(stateOpts(a));
      case "find": return w.find(str(a, "find"), optStr(b, "find role"));
      case "click": return w.click(Array.isArray(a) ? point(a, "click") : elem(a, "click"), clickOpts(b));
      case "setValue": return w.setValue(elem(a, "setValue"), str(b, "setValue value"));
      case "select": return w.select(elem(a, "select"), str(b, "select option"));
      case "type": return w.type(str(a, "type"), b == null ? undefined : elem(b, "type"), inputOpts(c));
      case "key": return w.key(str(a, "key"), inputOpts(b));
      case "drag": return w.drag(point(a, "drag from"), point(b, "drag to"), inputOpts(c));
      case "menu": return w.menu(Array.isArray(a) ? a.map((s) => str(s, "menu")) : str(a, "menu"));
      case "screenshot": return w.screenshot();
      case "waitFor": return w.waitFor(str(a, "waitFor"), optNum(b, "waitFor timeout") ?? 5000);
    }
    throw new Error(`unknown window method ${method.slice(2)}`);
  }

  private async bind(hid: unknown, make: () => Promise<Win>): Promise<WindowInfo> {
    if (typeof hid !== "number") throw new Error("internal: bad window handle");
    const p = make();
    this.bindings.set(hid, p);
    return (await p).info();
  }

  private async boundWindow(hid: unknown): Promise<Win> {
    const p = typeof hid === "number" ? this.bindings.get(hid) : undefined;
    if (!p) throw new Error("internal: unknown window handle");
    try { return await p; } catch (e) {
      throw new Error(`this window was never bound: ${e instanceof Error ? e.message : String(e)}`);
    }
  }

  /** Visible top-level windows, minus the driver's cursor overlay and policy-denied apps. */
  private async listWindows(): Promise<DriverWindow[]> {
    const r = await this.driver.call("list_windows", { on_screen_only: true });
    if (r.isError) fail(r, "windows");
    return (r.data.windows ?? []).filter((w) => this.policy.status(appOf(w)) !== "denied");
  }

  private approved(w: DriverWindow) { return this.policy.windowApproved(appOf(w), w.pid); }

  /** Approved windows in full. Other apps appear once each, by name only: their titles stay hidden
   *  until the user approves them, because titles carry document names, tabs and messages. */
  private async windows(filter?: WindowQuery) {
    const all = await this.listWindows();
    const rows: Array<WindowInfo | { app: string; approved: false }> = [];
    const seen = new Set<string>();
    for (const w of all) {
      const app = appOf(w);
      if (this.approved(w)) {
        if (!filter || matches(w, filter)) rows.push({ id: w.window_id, pid: w.pid, app: app.label, title: w.title ?? "" });
      } else if (!seen.has(app.key) && (!filter || matchesApp(w, filter))) {
        seen.add(app.key);
        rows.push({ app: app.label, approved: false });
      }
    }
    return rows;
  }

  private async findWindow(q: WindowQuery): Promise<Win> {
    const all = await this.listWindows();
    const hit = all.find((w) => this.approved(w) && matches(w, q));
    if (hit) return this.makeWindow(hit);
    // Unapproved apps match on identity only, never on titles, then ask the user.
    const cand = all.find((w) => !this.approved(w) && matchesApp(w, q));
    if (cand) {
      await this.policy.requireApp(appOf(cand), cand.title);
      return this.makeWindow(cand);
    }
    const ok = all.filter((w) => this.approved(w)).map((w) => `${appOf(w).label} "${w.title ?? ""}"`);
    const others = [...new Set(all.filter((w) => !this.approved(w)).map((w) => appOf(w).label))];
    throw new Error(`no window matches ${JSON.stringify(q)}. Approved windows: ${ok.join("; ") || "none"}. Other apps (bind one by app name to ask the user): ${others.join(", ") || "none"}.`);
  }

  private makeWindow(w: DriverWindow) { return new Win(this, w.pid, w.window_id, appOf(w), w.title ?? ""); }

  private async open(name: string, rawOpts: unknown): Promise<Win> {
    const args = isObj(rawOpts) && Array.isArray(rawOpts.args) ? rawOpts.args.map((a) => str(a, "open args")) : undefined;
    const { remember } = await this.policy.requireLaunch(name);
    const isPath = /[\\/]/.test(name);
    const r = await this.driver.call("launch_app", { name: isPath ? undefined : name, path: isPath ? name : undefined, additional_arguments: args });
    if (r.isError) fail(r, "open");
    const pid = r.data.pid;
    let wins = r.data.windows ?? [];
    for (let i = 0; i < 20 && wins.length === 0; i++) {
      await sleep(250);
      wins = (await this.listWindows()).filter((w) => w.pid === pid);
    }
    if (!wins.length || pid === undefined) throw new Error(`launched ${name} (pid ${pid}) but no window appeared yet; try cua.window("${name}")`);
    const first = wins[0];
    this.policy.launched(first.pid ?? pid, appOf(first), remember);
    audit({ tool: "launch_app", app: appOf(first).key, window: first.window_id });
    this.markAction();
    return this.makeWindow({ ...first, pid: first.pid ?? pid });
  }

  private async cappedSleep(ms: number) {
    if (ms > SLEEP_CAP_MS) this.note(`cua.sleep is capped at ${SLEEP_CAP_MS} ms: state(), find() and waitFor() already wait for the UI to settle`);
    await sleep(Math.min(Math.max(ms, 0), SLEEP_CAP_MS));
  }
}

function matches(w: DriverWindow, q: WindowQuery): boolean {
  const app = appOf(w);
  if (typeof q === "string") {
    const s = q.toLowerCase();
    return `${w.app_name ?? ""} ${app.label} ${w.title ?? ""}`.toLowerCase().includes(s);
  }
  return (!q.pid || w.pid === q.pid) && (!q.id || w.window_id === q.id)
    && (!q.title || (w.title ?? "").toLowerCase().includes(q.title.toLowerCase()))
    && (!q.app || `${w.app_name ?? ""} ${app.label}`.toLowerCase().includes(q.app.toLowerCase()));
}

/** Like matches(), without looking at the title. */
function matchesApp(w: DriverWindow, q: WindowQuery): boolean {
  const ident = `${w.app_name ?? ""} ${appOf(w).label}`.toLowerCase();
  if (typeof q === "string") return ident.includes(q.toLowerCase());
  if (q.title && !q.app && !q.pid) return false;
  return (!q.pid || w.pid === q.pid) && (!q.id || w.window_id === q.id) && (!q.app || ident.includes(q.app.toLowerCase()));
}

// --- One bound window ---

class Win {
  private snapshot: string | null = null;
  private lastTree = "";
  private hasFrame = false; // did the latest read include a screenshot? Pixel actions map through it.
  private readonly d: Desktop;
  readonly pid: number;
  readonly id: number;
  readonly app: App;
  readonly title: string;

  constructor(d: Desktop, pid: number, id: number, app: App, title: string) {
    this.d = d; this.pid = pid; this.id = id; this.app = app; this.title = title;
  }

  info(): WindowInfo { return { pid: this.pid, id: this.id, app: this.app.label, title: this.title }; }

  private async read(opts: StateOpts) {
    const r = await this.d.driver.call("get_window_state", {
      pid: this.pid, window_id: this.id, query: opts.query, max_elements: opts.max ?? 250,
      since: opts.diff && this.snapshot ? this.snapshot : undefined,
      include_screenshot: !!opts.screenshot, max_image_dimension: opts.screenshot ? SHOT_MAX : undefined,
    });
    if (r.isError) fail(r, "state");
    this.snapshot = r.data.snapshot_id ?? this.snapshot;
    this.hasFrame = !!opts.screenshot;
    return { r, tree: r.data.tree_markdown ?? r.data.diff_markdown ?? r.text };
  }

  /** Accessibility tree as compact text; rows tagged [N] are actionable. Right after an action it
   *  re-reads until two reads match (UI settled), so model code never needs to sleep. */
  async state(opts: StateOpts = {}): Promise<string> {
    // "a|b" means any of several substrings: read the whole tree and filter rows here.
    const multi = opts.query?.includes("|")
      ? new RegExp(opts.query.split("|").map((q) => q.trim().replace(/[.*+?^${}()[\]\\]/g, "\\$&")).join("|"), "i") : null;
    const readOpts = { ...opts, query: multi ? undefined : opts.query };
    let cur = await this.read(readOpts);
    if (this.d.recentlyActed && !opts.diff) {
      const end = Date.now() + SETTLE_CAP_MS;
      while (Date.now() < end) {
        await sleep(SETTLE_POLL_MS);
        const next = await this.read({ ...readOpts, screenshot: false });
        const stable = next.tree === cur.tree;
        cur = opts.screenshot ? { ...next, r: cur.r } : next;
        if (stable) break;
      }
      if (opts.screenshot) cur = await this.read(readOpts); // fresh frame bound to the final snapshot
    }
    this.d.out.images.push(...cur.r.images);
    this.lastTree = cur.tree;
    const d = cur.r.data;
    const head = `window ${this.id} "${d.window_title ?? this.title}" (${d.returned_element_count ?? "?"}/${d.total_element_count ?? "?"} rows${d.truncated ? ", truncated: pass max or query" : ""})`;
    const tree = multi ? cur.tree.split("\n").filter((l) => multi.test(l)).join("\n") : cur.tree;
    return `${head}\n${tree}`;
  }

  /** Element number of the best row for `text` (and `role`), from a fresh read. Ranks by the
   *  element's name: exact, prefix, substring, then anywhere in the row. A plain substring match
   *  picked `Memory add [id=MemPlus]` for "Plus". */
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

  private async delivery(opts: InputOpts): Promise<"foreground" | undefined> {
    if (!opts.foreground) return undefined;
    await this.d.policy.requireForeground(this.app);
    this.d.note("used foreground input: it briefly took focus and the real cursor");
    return "foreground";
  }

  private async act(tool: string, args: Args) {
    const r = await this.d.driver.call(tool, args);
    this.d.markAction();
    audit({ tool, app: this.app.key, window: this.id, delivery: args.delivery_mode ?? "background", ok: !r.isError });
    if (r.isError) fail(r, tool);
    // Surface "a dialog probably opened" from the driver so the model looks for it.
    const summary = r.data.summary ?? r.text;
    if (/did not return|dispatched|new window|dialog/i.test(summary)) this.d.note(`${tool}: ${summary.slice(0, 300)}`);
    return r;
  }

  /** The driver maps pixels through the latest read's screenshot; refresh it silently if needed. */
  private async ensureFrame() { if (!this.hasFrame) await this.frame(false); }

  /** Role of row `i` in the last tree shown, e.g. "ListItem". */
  private roleOf(i: number): string | undefined {
    return this.lastTree.split("\n").find((l) => rowIndex(l) === i)?.match(/\[\d+\]\s+(\S+)/)?.[1];
  }

  async click(target: number | [number, number], opts: ClickOpts = {}) {
    const button = opts.right ? "right" : undefined, count = opts.double ? 2 : undefined;
    const delivery_mode = await this.delivery(opts);
    if (typeof target === "number") {
      // A single click on a list or tree item selects it, as a mouse click would. Without this the
      // driver's default action is Invoke, which opens a file in Explorer. {double: true} opens.
      const select = !opts.double && !opts.right && /^(ListItem|TreeItem|DataItem)$/.test(this.roleOf(target) ?? "");
      return void await this.act("click", { element_token: this.token(target), button, count, delivery_mode, action: select ? "select" : undefined });
    }
    await this.ensureFrame();
    await this.act("click", { pid: this.pid, window_id: this.id, x: target[0], y: target[1], button, count, delivery_mode });
  }

  async setValue(i: number, value: string) {
    await this.act("set_value", { element_token: this.token(i), pid: this.pid, value });
  }

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
    const opt = (await this.state({ query: option })).split("\n")
      .find((l) => /\[\d+\]/.test(l) && /ListItem|MenuItem|Option/.test(l) && l.includes(`"${option}"`));
    if (!opt) throw new Error(`select: no option "${option}" found after expanding the list`);
    await this.act("click", { element_token: this.token(rowIndex(opt)), action: "select" });
    res = await check();
    if (!res.ok) throw new Error(`select: "${option}" did not take; the row now reads: ${res.row?.trim() ?? "(not found)"}`);
  }

  async type(text: string, into?: number, opts: InputOpts = {}) {
    const delivery_mode = await this.delivery(opts);
    await this.act("type_text", into === undefined
      ? { pid: this.pid, window_id: this.id, text, delivery_mode }
      : { element_token: this.token(into), text, delivery_mode });
  }

  async key(combo: string, opts: InputOpts = {}) {
    const parts = combo.toLowerCase().split("+").map((k) => KEY_ALIASES[k.trim()] ?? k.trim());
    const key = parts.pop()!;
    const delivery_mode = await this.delivery(opts);
    if (parts.length) await this.act("hotkey", { pid: this.pid, window_id: this.id, keys: [...parts, key], delivery_mode });
    else await this.act("press_key", { pid: this.pid, window_id: this.id, key, delivery_mode });
  }

  async drag(from: [number, number], to: [number, number], opts: InputOpts = {}) {
    const delivery_mode = await this.delivery(opts);
    await this.ensureFrame();
    await this.act("drag", { pid: this.pid, window_id: this.id, from_x: from[0], from_y: from[1], to_x: to[0], to_y: to[1], delivery_mode });
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
    if (this.d.recentlyActed) await sleep(250);
    const r = await this.d.driver.call("get_window_state", { pid: this.pid, window_id: this.id, include_accessibility_tree: false, include_screenshot: true, max_image_dimension: SHOT_MAX });
    if (r.isError) fail(r, "screenshot");
    this.hasFrame = true;
    if (show) this.d.out.images.push(...r.images);
  }

  /** Poll until `text` appears in this window's tree (case-insensitive). Returns the matching rows. */
  async waitFor(text: string, timeoutMs: number): Promise<string> {
    const end = Date.now() + timeoutMs;
    for (;;) {
      const { r, tree } = await this.read({ query: text });
      if (tree.toLowerCase().includes(text.toLowerCase())) {
        this.lastTree = tree;
        return `window ${this.id} "${r.data.window_title ?? this.title}"\n${tree}`;
      }
      if (Date.now() > end) throw new Error(`waitFor("${text}") timed out after ${timeoutMs} ms`);
      await sleep(150);
    }
  }
}
