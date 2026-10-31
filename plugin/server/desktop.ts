// Host side of the `cua` API. Model code runs in the QuickJS sandbox (sandbox.ts); every API call
// there reaches Desktop.dispatch as a method name plus JSON arguments. Nothing in here is reachable
// from model code except through dispatch, which validates every argument.
//
// Calls arrive one at a time in the order the model wrote them (the sandbox queues them), so
// implementations here may call each other freely without re-queueing.

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { sleep, trace, type Args, type BrowserTab, type Driver, type DriverResult, type DriverWindow, type Image } from "./driver.ts";
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
type WindowInfo = { pid: number; id: number; app: string; title: string; minimized?: true };
type PageInfo = { title: string; url: string };

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

/** A page element ref from p.read(), like "p3:12". */
function ref(x: unknown, what: string): string {
  if (typeof x === "string" && /^p\d+:\d+$/.test(x)) return x;
  throw new Error(`${what}: expected an element ref from p.read() like "p3:12", got ${JSON.stringify(x)}`);
}

function webUrl(x: unknown, what: string): string {
  const u = str(x, what);
  if (!/^(https?:\/\/|about:)/i.test(u)) throw new Error(`${what}: only http, https and about URLs, got ${JSON.stringify(u)}`);
  return u;
}

function pageReadOpts(x: unknown): { query?: string; screenshot?: boolean } {
  if (x == null) return {};
  if (!isObj(x)) throw new Error("read: options must be an object like {query: \"Sign in\"}");
  return { query: optStr(x.query, "read query"), screenshot: flag(x, "screenshot") };
}

const inputOpts = (x: unknown): InputOpts => (isObj(x) ? { foreground: flag(x, "foreground") } : {});
const clickOpts = (x: unknown): ClickOpts => (isObj(x) ? { foreground: flag(x, "foreground"), double: flag(x, "double"), right: flag(x, "right") } : {});

function windowQuery(x: unknown): WindowQuery {
  if (typeof x === "string") return x;
  if (isObj(x)) return { pid: optNum(x.pid, "pid"), id: optNum(x.id, "id"), title: optStr(x.title, "title"), app: optStr(x.app, "app") };
  throw new Error(`expected a window name or {pid, id, title, app}, got ${JSON.stringify(x)}`);
}

/** Driver refusals the model can recover from, and what to do next. Nothing was sent in any of them. */
const HINTS: Array<[RegExp, string]> = [
  [/window_target_mismatch|window_target_not_found/, "This window closed or changed. Bind it again with cua.window(...) and read state() before acting."],
  [/target_not_at_point/, "Another window covers that point, so nothing was sent. Act by element number instead, or ask the user to uncover the window."],
  [/background_unavailable[\s\S]*Chrome_WidgetWin|Chrome_WidgetWin[\s\S]*background_unavailable|Background delivery is not available for target window class 'Chrome_WidgetWin/, "This is a browser window. For the web page, use `const p = await w.page()`: p.type() and p.key() work in the background. setValue()/select() also work on page fields."],
  [/background_unavailable|delivery_mode:"foreground"/, "setValue()/select() work in the background for text boxes and combo boxes. Otherwise retry this one action with {foreground: true}, which briefly takes focus and the real cursor (the user may be asked first)."],
];

function fail(r: DriverResult, what: string): never {
  let msg = r.text.slice(0, 600);
  const hint = HINTS.find(([re]) => re.test(r.text));
  if (hint) msg += `\nHint: ${hint[1]}`;
  throw new Error(`${what} failed: ${msg}`);
}

/** Browser-route refusals carry {status: "refused", refusal: {code, message}}. */
function browserFail(r: DriverResult, what: string): never {
  const code = r.data.refusal?.code ?? "";
  let msg = r.data.refusal?.message ?? r.text.slice(0, 400);
  if (/stale/.test(code)) msg += "\nHint: refs belong to the latest p.read() of this tab; read again and use the new refs.";
  if (code === "browser_consent_required") msg += "\nHint: the browser didn't grant DevTools access; ask the user to allow it in the browser.";
  throw new Error(`${what} failed (${code || "error"}): ${msg}`);
}

function audit(entry: Record<string, unknown>) {
  if (AUDIT === "off") return;
  try {
    fs.mkdirSync(path.dirname(AUDIT), { recursive: true });
    fs.appendFileSync(AUDIT, JSON.stringify({ t: new Date().toISOString(), ...entry }) + "\n");
  } catch { /* auditing must never break an action */ }
}

/** How the driver delivered a pixel click, from its result's `route`. */
const PIXEL_ROUTES: Record<string, string> = {
  accessibility: "a UI Automation action on the control at that point",
  synthetic_events: "mouse messages sent to the window",
  global_input: "real mouse input",
};

const KEY_ALIASES: Record<string, string> = { enter: "return", esc: "escape", del: "delete", ctl: "ctrl", control: "ctrl", win: "cmd" };
const rowIndex = (line: string) => Number(line.match(/\[(\d+)\]/)?.[1] ?? NaN);

// --- Desktop: windows, binding, dispatch ---

export class Desktop {
  out: RunOutput = { images: [], notes: new Set() };
  private lastActionAt = 0;
  private readonly readWindows = new Set<number>(); // windows whose tree this session has read
  private readonly bindings = new Map<number, Promise<Win>>();
  private readonly pages = new Map<number, Promise<Page>>();
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

  /** True the first time a window's tree is read this session. Chromium (browsers, Electron apps)
   *  builds a page's tree only once a UIA client connects: the first read of a cold Edge window
   *  returned its own chrome, 20 rows, and the next read 0.1 s later all 141. */
  firstRead(windowId: number) {
    if (this.readWindows.has(windowId)) return false;
    this.readWindows.add(windowId);
    return true;
  }

  /** Entry point for every sandbox call: `cua.*` and `w.*` methods with JSON arguments. */
  async dispatch(method: string, args: unknown[]): Promise<unknown> {
    const started = performance.now();
    try {
      return await this.route(method, args);
    } finally {
      trace({ api: method, ms: Math.round(performance.now() - started) });
    }
  }

  private async route(method: string, args: unknown[]): Promise<unknown> {
    switch (method) {
      case "cua.windows": return this.windows(args[0] == null ? undefined : windowQuery(args[0]));
      case "cua.window": return this.bind(args[0], () => this.findWindow(windowQuery(args[1])));
      case "cua.open": return this.bind(args[0], () => this.open(str(args[1], "open")));
      case "cua.sleep": return this.cappedSleep(optNum(args[0], "sleep") ?? 0);
    }
    if (method.startsWith("p.")) return this.dispatchPage(method.slice(2), args);
    if (!method.startsWith("w.")) throw new Error(`unknown API method ${method}`);
    const w = await this.boundWindow(args[0]);
    const [a, b, c] = args.slice(1);
    switch (method.slice(2)) {
      case "page": return this.bindPage(a, () => this.openPage(w, optStr(b, "page")));
      case "state": return w.state(stateOpts(a));
      case "find": return w.find(str(a, "find"), optStr(b, "find role"));
      case "click": return w.click(Array.isArray(a) ? point(a, "click") : elem(a, "click"), clickOpts(b));
      case "setValue": return w.setValue(elem(a, "setValue"), str(b, "setValue value"));
      case "select": return w.select(elem(a, "select"), str(b, "select option"));
      case "type": return w.type(str(a, "type"), b == null ? undefined : elem(b, "type"), inputOpts(c));
      case "key": return w.key(str(a, "key"), inputOpts(b));
      case "drag": return w.drag(point(a, "drag from"), point(b, "drag to"), inputOpts(c));
      case "menu": return w.menu(Array.isArray(a) ? a.map((s) => str(s, "menu")) : str(a, "menu"), inputOpts(b));
      case "screenshot": return w.screenshot();
      case "waitFor": return w.waitFor(str(a, "waitFor"), optNum(b, "waitFor timeout") ?? 5000);
    }
    throw new Error(`unknown window method ${method.slice(2)}`);
  }

  private async dispatchPage(name: string, args: unknown[]): Promise<unknown> {
    const p = await this.boundPage(args[0]);
    const [a, b, c] = args.slice(1);
    switch (name) {
      case "read": return p.read(pageReadOpts(a));
      case "click": return p.click(Array.isArray(a) ? point(a, "click") : ref(a, "click"));
      case "type": {
        // Documented as p.type(ref, text) like p.click(ref) and p.select(ref, option); w.type(text, N)
        // habits put the text first, so accept that order too.
        const [at, text] = typeof a === "string" && /^p\d+:\d+$/.test(a) ? [a, b] : [b, a];
        return p.type(ref(at, "type"), str(text, "type"), isObj(c) ? { replace: flag(c, "replace") } : {});
      }
      case "key": return p.key(str(a, "key"));
      case "select": return p.select(ref(a, "select"), str(b, "select option"));
      case "go": return p.go(webUrl(a, "go"));
      case "newTab": return this.bindPage(a, () => p.newTab(webUrl(b, "newTab")));
      case "close": return p.close();
      case "tabs": return p.tabs();
      case "waitFor": return p.waitFor(str(a, "waitFor"), optNum(b, "waitFor timeout") ?? 5000);
      case "screenshot": return p.screenshot();
    }
    throw new Error(`unknown page method ${name}`);
  }

  private async bindPage(hid: unknown, make: () => Promise<Page>): Promise<PageInfo> {
    if (typeof hid !== "number") throw new Error("internal: bad page handle");
    const p = make();
    this.pages.set(hid, p);
    return (await p).info();
  }

  private async boundPage(hid: unknown): Promise<Page> {
    const p = typeof hid === "number" ? this.pages.get(hid) : undefined;
    if (!p) throw new Error("internal: unknown page handle");
    try { return await p; } catch (e) {
      throw new Error(`this page was never bound: ${e instanceof Error ? e.message : String(e)}`);
    }
  }

  /** Bind the browser behind window `w` over DevTools. The first bind in a session attaches to the
   *  browser's existing profile, and the driver answers the browser's "Allow remote debugging?"
   *  prompt. Chromium shows that prompt in the browser window the user activated last, and the
   *  driver only answers it inside the window it prepares, so attaching goes through that window.
   *  If the attach doesn't cover `w` itself, the page binds through that front window instead. */
  async browserBind(w: Win): Promise<{ target: string; tabs: BrowserTab[]; win: Win }> {
    if (!this.policy.browserAttach) {
      throw new Error(`web pages are reached over the browser's DevTools, which is off. Set "browsers": "attach" in ${this.policy.file} and start a new session, or use this window's accessibility tree (w.state, w.setValue, w.click).`);
    }
    const bind = (x: { pid: number; id: number }) => this.driver.call("get_browser_state", { pid: x.pid, window_id: x.id });
    let via = w;
    let r = await bind(w);
    if (r.data.refusal?.code === "browser_consent_required") {
      const front = await this.frontWindowOf(w);
      const prep = await this.driver.call("browser_prepare", { pid: front.pid, window_id: front.id, strategy: { kind: "existing_profile" } });
      if (prep.data.status !== "ok") browserFail(prep, "attaching to the browser");
      r = await bind(w);
      if (r.data.refusal?.code === "browser_consent_required" && front.id !== w.id) {
        via = front;
        r = await bind(front);
      }
    }
    if (r.data.status !== "ok" || !r.data.target_id) browserFail(r, "binding the browser");
    if (r.data.mutation_allowed === false) throw new Error("the browser window is bound read-only (its tab couldn't be matched exactly); bind the window again");
    if (via !== w) this.note(`bound the browser through its most recently used window, "${via.title}"`);
    return { target: r.data.target_id, tabs: r.data.tabs ?? [], win: via };
  }

  /** The front-most normal window of `w`'s process: the window the user activated last. */
  private async frontWindowOf(w: Win): Promise<Win> {
    const mine = (await this.listAllWindows()).filter((x) => x.pid === w.pid && x.title && !/remote debugging/i.test(x.title));
    const front = mine.reduce<DriverWindow | undefined>((a, b) => ((b.z_index ?? -1) > (a?.z_index ?? -1) ? b : a), undefined);
    return front && front.window_id !== w.id ? this.makeWindow(front) : w;
  }

  /** The selected tab of browser window `w`, or the tab whose title or URL contains `query`. */
  private async openPage(w: Win, query?: string): Promise<Page> {
    const { target, tabs, win } = await this.browserBind(w);
    const q = query?.toLowerCase();
    const tab = q
      ? tabs.find((t) => `${t.title ?? ""} ${t.url ?? ""}`.toLowerCase().includes(q))
      : tabs.find((t) => t.active === true) ?? (tabs.length === 1 ? tabs[0] : undefined);
    if (!tab) {
      throw new Error(q
        ? `no tab matches "${query}". Tabs: ${tabs.map((t) => `"${t.title ?? ""}"`).join(", ")}`
        : "couldn't tell which tab is selected; pass part of its title: w.page(\"Inbox\")");
    }
    return new Page(this, win, target, tab, false);
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

  /** Visible and minimized top-level windows, minus policy-denied apps (which includes the driver's cursor overlay). */
  private async listWindows(): Promise<DriverWindow[]> {
    return (await this.listAllWindows()).filter((w) => this.policy.status(appOf(w)) !== "denied");
  }

  /** On-screen windows plus minimized ones: a minimized browser or editor is still the user's open
   *  app, and its tree and pages stay reachable. Hidden and cloaked windows (other virtual desktops,
   *  background helpers) stay out. */
  private async listAllWindows(): Promise<DriverWindow[]> {
    const r = await this.driver.call("list_windows", { on_screen_only: false });
    if (r.isError) fail(r, "windows");
    return (r.data.windows ?? []).filter((w) => w.is_on_screen !== false || w.minimized === true);
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
        if (!filter || matches(w, filter)) rows.push({ id: w.window_id, pid: w.pid, app: app.label, title: w.title ?? "", ...(w.minimized ? { minimized: true } : {}) });
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

  /** Launch by name or path. No command-line arguments: an approved app plus arguments can run
   *  anything (Edge's --renderer-cmd-prefix, `explorer.exe C:\\...\\cmd.exe`). Open files through
   *  the app's own File > Open instead. */
  private async open(name: string): Promise<Win> {
    const { remember } = await this.policy.requireLaunch(name);
    const isPath = /[\\/]/.test(name);
    const r = await this.driver.call("launch_app", { name: isPath ? undefined : name, path: isPath ? name : undefined });
    if (r.isError) fail(r, "open");
    // launch_app's window records carry no app_name, so identify the window from the window list,
    // which does: the policy decides by that identity, not by the name the model asked for.
    const ids = new Set((r.data.windows ?? []).map((w) => w.window_id));
    const pid = r.data.pid;
    let win: DriverWindow | undefined;
    for (let i = 0; i < 20 && !win; i++) {
      if (i) await sleep(250);
      const all = await this.listAllWindows();
      win = all.find((w) => ids.has(w.window_id)) ?? all.find((w) => w.pid === pid);
    }
    if (!win) throw new Error(`launched ${name} (pid ${pid}) but no window appeared yet; try cua.window("${name}")`);
    const app = appOf(win);
    if (this.policy.status(app) === "denied") throw new Error(`${name} opened ${app.label}, which is blocked by policy.`);
    this.policy.launched(win.pid, app, remember);
    audit({ tool: "launch_app", app: app.key, window: win.window_id });
    this.markAction();
    return this.makeWindow(win);
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
  private frameSize: { w: number; h: number } | null = null; // pixel size of that screenshot
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
    if (opts.screenshot) this.noteFrame(r);
    return { r, tree: r.data.tree_markdown ?? r.data.diff_markdown ?? r.text };
  }

  /** Accessibility tree as compact text; rows tagged [N] are actionable. Right after an action, and
   *  on a window's first read, it re-reads until two reads match (UI settled), so model code never
   *  needs to sleep. */
  async state(opts: StateOpts = {}): Promise<string> {
    // "a|b" means any of several substrings: read the whole tree and filter rows here.
    const multi = opts.query?.includes("|")
      ? new RegExp(opts.query.split("|").map((q) => q.trim().replace(/[.*+?^${}()[\]\\]/g, "\\$&")).join("|"), "i") : null;
    const readOpts = { ...opts, query: multi ? undefined : opts.query };
    const first = this.d.firstRead(this.id);
    let cur = await this.read(readOpts);
    if ((first || this.d.recentlyActed) && !opts.diff) {
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
    audit({ tool, app: this.app.key, window: this.id, delivery: args.delivery_mode ?? "background", route: r.data.route, effect: r.data.effect, ok: !r.isError });
    if (r.isError) fail(r, tool);
    // Surface "a dialog probably opened" from the driver so the model looks for it.
    const summary = r.data.summary ?? r.text;
    if (/did not return|dispatched|new window|dialog/i.test(summary)) this.d.note(`${tool}: ${summary.slice(0, 300)}`);
    return r;
  }

  private noteFrame(r: DriverResult) {
    const { screenshot_width: w, screenshot_height: h } = r.data;
    this.frameSize = w && h ? { w, h } : null;
  }

  /** The driver maps pixels through the latest read's screenshot, so refresh it silently if needed,
   *  and keep every pixel inside it: a point outside this window would land on whatever is there. */
  private async pixelTarget(...points: Array<[number, number]>) {
    if (!this.hasFrame) await this.frame(false);
    const f = this.frameSize;
    for (const [x, y] of points) {
      if (f && (x < 0 || y < 0 || x >= f.w || y >= f.h)) {
        throw new Error(`[${x}, ${y}] is outside this window's screenshot (${f.w}x${f.h}); pixels are relative to the latest w.screenshot() of this window`);
      }
    }
  }

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
    await this.pixelTarget(target);
    const r = await this.act("click", { pid: this.pid, window_id: this.id, x: target[0], y: target[1], button, count, delivery_mode });
    // A pixel click reports success once it's sent. Say how, so a click that changed nothing can
    // be told apart from one that never reached the app.
    const { route = "", effect } = r.data;
    if (effect === "unverifiable" || effect === "suspected_noop") {
      const how = PIXEL_ROUTES[route] ?? (route.replaceAll("_", " ") || "an unreported route");
      const seen = effect === "suspected_noop" ? "the driver suspects it did nothing" : "nothing confirmed its effect";
      this.d.note(`click [${target.join(", ")}] went out as ${how}; ${seen}, so check the window before relying on it`);
    }
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
    await this.pixelTarget(from, to);
    await this.act("drag", { pid: this.pid, window_id: this.id, from_x: from[0], from_y: from[1], to_x: to[0], to_y: to[1], delivery_mode });
  }

  /** Walk a menu by labels. Classic menus run in the background; a host that needs the window
   *  activated for its menu refuses with background_unavailable unless {foreground: true} passed
   *  the policy gate. */
  async menu(menuPath: string | string[], opts: InputOpts = {}) {
    const p = Array.isArray(menuPath) ? menuPath : menuPath.split(">").map((s) => s.trim());
    const delivery_mode = await this.delivery(opts);
    try {
      await this.act("invoke_menu", { pid: this.pid, window_id: this.id, path: p, delivery_mode });
    } catch (e) {
      // Labels like "Replace..." are often written without the ellipsis; retry once with it.
      const seg = Number(String(e).match(/segment (\d+) was not found/)?.[1]); // 0-based
      if (Number.isNaN(seg) || seg >= p.length || p[seg].endsWith("...")) throw e;
      await this.act("invoke_menu", { pid: this.pid, window_id: this.id, path: p.map((x, k) => (k === seg ? `${x}...` : x)), delivery_mode });
    }
  }

  async screenshot() { await this.frame(true); }

  private async frame(show: boolean) {
    if (this.d.recentlyActed) await sleep(250);
    const r = await this.d.driver.call("get_window_state", { pid: this.pid, window_id: this.id, include_accessibility_tree: false, include_screenshot: true, max_image_dimension: SHOT_MAX });
    if (r.isError) fail(r, "screenshot");
    this.hasFrame = true;
    this.noteFrame(r);
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

// --- One browser tab, over DevTools (Cua Driver's browser route) ---

const MODIFIERS: Record<string, string> = { control: "ctrl", ctl: "ctrl", win: "meta", cmd: "meta", command: "meta", option: "alt" };

const KEY_NAMES: Record<string, string> = {
  enter: "Enter", return: "Enter", tab: "Tab", esc: "Escape", escape: "Escape", space: " ", backspace: "Backspace",
  delete: "Delete", del: "Delete", up: "ArrowUp", down: "ArrowDown", left: "ArrowLeft", right: "ArrowRight",
  home: "Home", end: "End", pageup: "PageUp", pagedown: "PageDown",
};

class Page {
  private refs = new Map<string, { role?: string; name?: string | null }>(); // from the latest read
  private readonly d: Desktop;
  private readonly win: Win;
  private readonly target: string;
  private readonly tab: string;
  private readonly openedHere: boolean;
  private title: string;
  private url: string;

  constructor(d: Desktop, win: Win, target: string, tab: BrowserTab, openedHere: boolean) {
    this.d = d; this.win = win; this.target = target; this.tab = tab.tab_id; this.openedHere = openedHere;
    this.title = tab.title ?? ""; this.url = tab.url ?? "";
  }

  info(): PageInfo { return { title: this.title, url: this.url }; }

  private async act(tool: string, args: Args, onTab = true) {
    const r = await this.d.driver.call(tool, { target_id: this.target, ...(onTab ? { tab_id: this.tab } : {}), ...args });
    this.d.markAction();
    audit({ tool, app: this.win.app.key, window: this.win.id, delivery: "devtools", ok: r.data.status !== "refused" && !r.isError });
    if (r.data.status === "refused" || r.isError) browserFail(r, tool);
    return r;
  }

  /** The page as an outline, then its actionable elements as refs like [p3:12]. */
  async read(opts: { query?: string; screenshot?: boolean } = {}): Promise<string> {
    const snap = () => this.d.driver.call("get_browser_state", {
      target_id: this.target, tab_id: this.tab, snapshot_format: "semantic_v2", query: opts.query, include_screenshot: opts.screenshot || undefined,
    });
    let r = await snap();
    // A read racing a re-render can lose its frame ("Frame with the given frameId is not found").
    if (r.data.status === "refused" && /frameId is not found/i.test(r.data.refusal?.message ?? "")) {
      await sleep(300);
      r = await snap();
    }
    if (r.data.status === "refused" || r.isError) browserFail(r, "read");
    this.d.out.images.push(...r.images);
    const { page = {}, outline = "", refs = [], snapshot = {} } = r.data;
    this.title = page.title ?? this.title;
    this.url = page.url ?? this.url;
    this.refs = new Map(refs.map((x) => [x.ref, { role: x.role, name: x.name }]));
    const actionable = refs.filter((x) => x.actions?.length);
    const more = snapshot.complete === false ? "; partial: pass {query} to narrow" : "";
    return [`page "${this.title}" ${this.url} (${actionable.length} actionable${more})`, outline,
      actionable.length ? "actions:" : "",
      ...actionable.map((x) => `[${x.ref}] ${x.role ?? ""}${x.name ? ` "${x.name}"` : ""} (${x.actions!.join(",")})`)].filter(Boolean).join("\n");
  }

  async click(target: string | [number, number]) {
    if (typeof target === "string") await this.act("browser_click", { ref: target });
    else await this.act("browser_click", { x: target[0], y: target[1] });
  }

  async type(at: string, text: string, opts: { replace?: boolean }) {
    await this.act("browser_type", { ref: at, text, replace: opts.replace || undefined });
  }

  /** "Enter", "Escape", "ctrl+a": sent to the page's focused element. */
  async key(combo: string) {
    if (!this.d.driver.has("browser_press_key")) throw new Error("page key presses need a newer driver; click the page's button instead");
    const parts = combo.split("+").map((k) => k.trim());
    const key = parts.pop()!;
    const modifiers = parts.map((m) => MODIFIERS[m.toLowerCase()] ?? m.toLowerCase());
    await this.act("browser_press_key", { key: KEY_NAMES[key.toLowerCase()] ?? key, modifiers: modifiers.length ? modifiers : undefined });
  }

  /** Choose an option of a <select>. Uses the driver's page route when it has one, otherwise the
   *  window's accessibility tree, which changes <select> values in the background. */
  async select(at: string, option: string) {
    if (this.d.driver.has("browser_select")) return void await this.act("browser_select", { ref: at, option });
    const name = this.refs.get(at)?.name;
    if (!name) throw new Error(`select: read() the page first; ${at} isn't in the latest read`);
    const n = await this.win.find(name, "ComboBox");
    if (n === null) throw new Error(`select: no list named "${name}" in the window's accessibility tree`);
    await this.win.select(n, option);
  }

  async go(url: string) { await this.act("browser_navigate", { url }); this.url = url; }

  /** Open a tab in the background, without touching the user's current tab. */
  async newTab(url: string): Promise<Page> {
    if (!this.d.driver.has("browser_open_tab")) throw new Error("opening tabs needs a newer driver; use p.go(url) on a tab you opened, or ask the user");
    const r = await this.act("browser_open_tab", { url }, false);
    const tabId = r.data.tab_id;
    if (!tabId) throw new Error("the browser didn't report the new tab");
    return new Page(this.d, this.win, this.target, { tab_id: tabId, url, title: "" }, true);
  }

  /** Close a tab opened with newTab(). The user's own tabs stay open. */
  async close() {
    if (!this.openedHere) throw new Error("only tabs opened with newTab() can be closed");
    await this.act("browser_close_tab", {});
  }

  async tabs() {
    const { tabs } = await this.d.browserBind(this.win);
    return tabs.map((t) => ({ title: t.title ?? "", url: t.url ?? "", selected: t.active === true }));
  }

  /** Attach an image of the tab's viewport. Chromium doesn't paint a tab that isn't showing, so a
   *  background tab (one opened with newTab) has no image to capture; the capture would hang. */
  async screenshot() {
    if (this.openedHere) throw new Error("a background tab isn't painted, so it has no screenshot. Use p.read() for its content; screenshots work on the tab the user has selected.");
    await this.read({ screenshot: true });
  }

  async waitFor(text: string, timeoutMs: number): Promise<string> {
    const end = Date.now() + timeoutMs;
    for (;;) {
      const out = await this.read({ query: text });
      if (out.toLowerCase().includes(text.toLowerCase())) return out;
      if (Date.now() > end) throw new Error(`waitFor("${text}") timed out after ${timeoutMs} ms`);
      await sleep(250);
    }
  }
}

