// Cross-agent input locks (driver/NOTES.md, "Input locks across agents"): two drivers act at once.
//
//   node bench/input-locks.ts [fgclicks] [sametype] [samehotkey] [held] [abandoned]
//
// Agents A and B are each their own `superuse-driver mcp` process (SUPERUSE_DRIVER, default
// plugin/driver/superuse-driver.exe), the way the plugin runs one per session. A third driver only
// reads window state. Ordering comes from observation, not sleeps: B's call starts only once A's
// call is visibly under way (A's window took the foreground, or A's first characters are in the
// text box), so B always lands while A holds its locks.
//
// - fgclicks: A and B foreground-triple-click two windows. Both land, every foreground sample of A
//   comes before every sample of B, and the foreground ends where it started.
// - sametype: A and B type into one window. The text is A's, then B's, not interleaved.
// - samehotkey: A types, B presses Ctrl+Home in the same window. B's caret move waits, so A's text
//   arrives in order.
// - held: a PowerShell process holds the foreground lock, then one window's lock, past the
//   driver's 5 s wait. A foreground click and a background type are refused as `input_busy`, and
//   nothing lands.
// - abandoned: a process takes the foreground lock and exits without releasing it, as a crashed
//   driver would, while a foreground click waits. The click goes through once the holder dies.
//
// Windows are MenuPads (bench/apps/MenuPad.cs) built to %TEMP%\superuse\MenuPad-locks.exe, so the
// script never touches MenuPads other checks run. Writes bench/out/input-locks-runs/input-locks-<time>.json
// with every call, its time and the foreground samples.

import { spawn, type ChildProcess } from "node:child_process";
import { createHash } from "node:crypto";
import { copyFileSync, existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import path from "node:path";
import { createInterface } from "node:readline";
import { setTimeout as sleep } from "node:timers/promises";
import { McpClient, textOf, type Args, type ToolResult } from "./mcp-client.ts";
import { start } from "./tasks.ts";
import { listWindows, ps, Sampler, timestamp, WIN_TEMP, WIN_TYPES, WSL_TEMP, type Win } from "./win.ts";

const HERE = import.meta.dirname;
const EXE = process.env.SUPERUSE_DRIVER ?? path.join(HERE, "..", "plugin/driver/superuse-driver.exe");
const OUT = path.join(HERE, "out", "input-locks-runs");
const ENV = { DO_NOT_TRACK: "1", WSLENV: "DO_NOT_TRACK" };
const POWERSHELL = "/mnt/c/Windows/System32/WindowsPowerShell/v1.0/powershell.exe";
const PAD_EXE = "MenuPad-locks.exe";
// The driver's lock names and wait (driver/crates/platform-windows/src/input/lock.rs).
const FOREGROUND_LOCK = String.raw`Local\superuse-input-foreground`;
/** A window's lock is its UI thread's, so a window and its owned dialogs share one. */
async function windowLock(hwnd: number): Promise<string> {
  const thread = Number((await ps(`${WIN_TYPES}\n$p = [uint32]0; [SuperuseW]::GetWindowThreadProcessId([IntPtr]${hwnd}, [ref]$p)`)).trim());
  if (!thread) throw new Error(`window ${hwnd} has no UI thread`);
  return String.raw`Local\superuse-input-thread-` + thread;
}
const LOCK_WAIT_MS = 5000;
// WSL's clock ran about 10% slow against Windows' here (4540 ms for a 5040 ms Windows sleep), so a
// refusal after the driver's full wait can measure under 5000 ms on this side.
const MIN_WAITED_MS = LOCK_WAIT_MS * 0.8;
const ABANDON_AFTER_MS = 1500; // how long the abandoned check's holder owns the lock before exiting

type LogEntry = { agent: string; tool: string; args: Args; sent_ms: number; ms: number; error: boolean; code: string | null; text: string };
type Called = { result: ToolResult; ms: number; sentAt: number; doneAt: number; error: boolean; code: string | null; text: string };

const t0 = performance.now();
const now = () => Number((performance.now() - t0).toFixed(1));
const log: LogEntry[] = [];

/** One agent: a driver process and its calls, logged with when each was sent. */
class Agent {
  readonly name: string;
  readonly client: McpClient;

  constructor(name: string, client: McpClient) {
    this.name = name;
    this.client = client;
  }

  async call(tool: string, args: Args): Promise<Called> {
    const sentAt = now();
    const { result, ms } = await this.client.call(tool, args);
    const sc = result.structuredContent ?? {};
    const text = textOf(result);
    const called = { result, ms, sentAt, doneAt: now(), error: !!result.isError, code: sc.code ?? sc.refusal?.code ?? sc.error?.code ?? null, text };
    log.push({ agent: this.name, tool, args, sent_ms: sentAt, ms: Number(ms.toFixed(1)), error: called.error, code: called.code, text: text.slice(0, 300) });
    console.log(`  ${this.name} ${tool.padEnd(16)} sent ${String(sentAt).padStart(8)} ${ms.toFixed(1).padStart(7)} ms ${called.error ? `ERR ${called.code ?? ""} ` : ""}${JSON.stringify(text.slice(0, 160))}`);
    return called;
  }
}

const brief = (c: Called) => ({ sent_ms: c.sentAt, done_ms: c.doneAt, ms: Number(c.ms.toFixed(1)), error: c.error, code: c.code, text: c.text.slice(0, 300) });

type Agents = { a: Agent; b: Agent; observer: Agent; pads: Win[] };

/** Build MenuPad.cs into its own exe once (or when the source is newer) and open one with `flags`. */
async function openPad(title: string, x: number, y: number, flags: string[] = []): Promise<Win> {
  const src = path.join(HERE, "apps", "MenuPad.cs");
  const exe = path.join(WSL_TEMP, PAD_EXE);
  if (!existsSync(exe) || statSync(exe).mtimeMs < statSync(src).mtimeMs) {
    mkdirSync(WSL_TEMP, { recursive: true });
    copyFileSync(src, path.join(WSL_TEMP, "MenuPad-locks.cs"));
    await ps(`Remove-Item '${WIN_TEMP}\\${PAD_EXE}' -ErrorAction SilentlyContinue
Add-Type -TypeDefinition (Get-Content -Raw '${WIN_TEMP}\\MenuPad-locks.cs') -OutputAssembly '${WIN_TEMP}\\${PAD_EXE}' -OutputType WindowsApplication -ReferencedAssemblies System.Windows.Forms,System.Drawing`, 120_000);
  }
  await start(`${WIN_TEMP}\\${PAD_EXE}`, "--at", String(x), String(y), "--title", title, ...flags);
  const end = Date.now() + 10_000;
  while (Date.now() < end) {
    const found = (await listWindows(true)).find((w) => w.proc === "MenuPad-locks" && w.title === title);
    if (found) return found;
    await sleep(300);
  }
  throw new Error(`MenuPad window ${title} not found`);
}

/** The pad's text box value, read through the observer driver (get_window_state takes no lock). */
async function padText(observer: Agent, w: Win): Promise<string> {
  const { result } = await observer.client.call("get_window_state", { pid: w.pid, window_id: w.hwnd, include_screenshot: false });
  const row = (result.structuredContent?.tree_markdown ?? "").split("\n").find((l) => l.includes('Edit "Text editor"'));
  return /value="([^"]*)"/.exec(row ?? "")?.[1] ?? "";
}

/** A point in the pad's text box, in window-local screenshot pixels (needs a snapshot first). */
async function textBoxPoint(agent: Agent, w: Win): Promise<{ x: number; y: number }> {
  await agent.call("get_window_state", { pid: w.pid, window_id: w.hwnd, include_screenshot: true });
  const { result } = await agent.client.call("list_windows", { pid: w.pid });
  const win = result.structuredContent?.windows?.find((x) => x.window_id === w.hwnd);
  const b = win?.bounds ?? win;
  if (b?.width == null || b.height == null) throw new Error(`no bounds for ${w.title}`);
  return { x: Math.floor(b.width / 2), y: Math.floor(b.height * 0.6) };
}

async function until(pred: () => boolean | Promise<boolean>, timeoutMs: number, everyMs = 5): Promise<boolean> {
  const end = Date.now() + timeoutMs;
  while (Date.now() < end) {
    if (await pred()) return true;
    await sleep(everyMs);
  }
  return false;
}

/** Foreground windows in order, each with its first and last sample time (ms since script start). */
function foregroundRuns(sampler: Sampler, startedAt: number) {
  const runs: Array<{ fg: number; from_ms: number; to_ms: number }> = [];
  for (const s of sampler.samples) {
    const t = Number((s.t * 1000 - startedAt).toFixed(0));
    const last = runs.at(-1);
    if (last && last.fg === s.fg) last.to_ms = t;
    else runs.push({ fg: s.fg, from_ms: t, to_ms: t });
  }
  return runs;
}

/** A process that takes the named mutex, says "held", keeps it `holdMs`, then releases it, or exits
 * still owning it (`release: false`), which abandons it as a crashed driver would. */
async function holdMutex(name: string, holdMs: number, release: boolean): Promise<ChildProcess> {
  const script = `$m = New-Object System.Threading.Mutex($false, '${name}')
[void]$m.WaitOne()
[Console]::Out.WriteLine('held'); [Console]::Out.Flush()
Start-Sleep -Milliseconds ${holdMs}
${release ? "$m.ReleaseMutex()" : ""}`;
  const proc = spawn(POWERSHELL, ["-NoProfile", "-NonInteractive", "-EncodedCommand", Buffer.from(script, "utf16le").toString("base64")], { stdio: ["ignore", "pipe", "ignore"] });
  const held = Promise.withResolvers<void>();
  createInterface({ input: proc.stdout! }).on("line", (line) => line.trim() === "held" && held.resolve());
  proc.on("exit", () => held.reject(new Error(`mutex holder for ${name} exited before holding it`)));
  await held.promise;
  return proc;
}

const clicksIn = (text: string) => text.split("click").length - 1;

// --- a. Two foreground clicks at once ------------------------------------------------------

async function checkFgclicks({ a, b, observer, pads }: Agents) {
  const home = await openPad("Locks-Home", 40, 40);
  const padA = await openPad("Locks-A", 640, 40, ["--log-clicks"]);
  const padB = await openPad("Locks-B", 640, 460, ["--log-clicks"]);
  pads.push(home, padA, padB);
  const pointA = await textBoxPoint(a, padA);
  const pointB = await textBoxPoint(b, padB);
  await observer.call("bring_to_front", { pid: home.pid, window_id: home.hwnd });
  await sleep(300);

  const sampler = await Sampler.start(5);
  const startedAt = performance.timeOrigin + t0;
  const res = await (async () => {
    const first = sampler.samples[0]?.fg;
    // Triple clicks keep A's transaction (activate, click, restore) open for about 300 ms.
    const callA = a.call("click", { pid: padA.pid, window_id: padA.hwnd, ...pointA, count: 3, delivery_mode: "foreground" });
    const sawA = await until(() => sampler.samples.some((s) => s.fg === padA.hwnd), 3000, 2);
    const bSent = now();
    const callB = b.call("click", { pid: padB.pid, window_id: padB.hwnd, ...pointB, count: 3, delivery_mode: "foreground" });
    const [ra, rb] = await Promise.all([callA, callB]);
    await sleep(1500); // past the restore and the late-steal poller's first ticks
    return { first_fg: first, saw_a_active: sawA, b_sent_ms: bSent, a: brief(ra), b: brief(rb) };
  })().finally(() => sampler.stop());
  const runs = foregroundRuns(sampler, startedAt);
  const lastA = Math.max(...runs.filter((r) => r.fg === padA.hwnd).map((r) => r.to_ms));
  const firstB = Math.min(...runs.filter((r) => r.fg === padB.hwnd).map((r) => r.from_ms));
  const textA = await padText(observer, padA);
  const textB = await padText(observer, padB);
  const final = sampler.samples.at(-1)?.fg;
  return {
    ...res, home: home.hwnd, pad_a: padA.hwnd, pad_b: padB.hwnd, foreground_runs: runs,
    last_a_foreground_ms: lastA, first_b_foreground_ms: firstB, final_fg: final,
    clicks_in_a: clicksIn(textA), clicks_in_b: clicksIn(textB),
    passed: res.first_fg === home.hwnd && res.saw_a_active
      && res.b_sent_ms < res.a.done_ms // B really started while A's call ran
      && !res.a.error && !res.b.error
      && clicksIn(textA) === 3 && clicksIn(textB) === 3
      && lastA < firstB // no foreground handoff between A and B mid-action
      && final === home.hwnd,
  };
}

// --- b. Two agents typing into one window ---------------------------------------------------

/** A types `textA`; once its first characters show, B runs `actB` on the same window. */
async function sameWindow({ a, b, observer, pads }: Agents, title: string, textA: string, actB: { tool: string; args: Args }) {
  const pad = await openPad(title, 40, 460);
  pads.push(pad);
  const target = { pid: pad.pid, window_id: pad.hwnd };
  await padText(observer, pad);
  const callA = a.call("type_text", { ...target, text: textA });
  const started = await until(async () => (await padText(observer, pad)).length > 0, 3000, 1);
  const bSent = now();
  const callB = b.call(actB.tool, { ...target, ...actB.args });
  const [ra, rb] = await Promise.all([callA, callB]);
  await sleep(300);
  const text = await padText(observer, pad);
  return { a_started: started, b_sent_ms: bSent, a: brief(ra), b: brief(rb), text, overlapped: started && bSent < ra.doneAt };
}

async function checkSametype(agents: Agents) {
  const textA = "a".repeat(150), textB = "b".repeat(150);
  const res = await sameWindow(agents, "Locks-Type", textA, { tool: "type_text", args: { text: textB } });
  return { ...res, passed: res.overlapped && !res.a.error && !res.b.error && res.text === textA + textB };
}

async function checkSamehotkey(agents: Agents) {
  // No repeating period: a caret jump mid-text rotates the text, which must show.
  const textA = Array.from({ length: 38 }, (_, i) => String(i).padStart(3, "0")).join(" ");
  // Ctrl+Home on a WinForms box holds Ctrl in the window's keyboard state (the attached hold).
  const res = await sameWindow(agents, "Locks-Hotkey", textA, { tool: "hotkey", args: { keys: ["ctrl", "home"] } });
  return { ...res, passed: res.overlapped && !res.a.error && !res.b.error && res.text === textA };
}

// --- c. A lock held past the wait, and an abandoned one -------------------------------------

async function checkHeld({ a, observer, pads }: Agents) {
  const pad = await openPad("Locks-Held", 640, 40, ["--log-clicks"]);
  pads.push(pad);
  const point = await textBoxPoint(a, pad);
  const target = { pid: pad.pid, window_id: pad.hwnd };

  const foregroundHolder = await holdMutex(FOREGROUND_LOCK, LOCK_WAIT_MS + 3000, true);
  const sampler = await Sampler.start(20);
  const click = await a.call("click", { ...target, ...point, delivery_mode: "foreground" }).finally(() => {
    sampler.stop();
    foregroundHolder.kill();
  });
  const windowHolder = await holdMutex(await windowLock(pad.hwnd), LOCK_WAIT_MS + 3000, true);
  const typed = await a.call("type_text", { ...target, text: "held" }).finally(() => windowHolder.kill());
  const text = await padText(observer, pad);
  const s = sampler.summary();
  return {
    foreground_lock: brief(click), window_lock: brief(typed), sampler: s, text,
    passed: click.code === "input_busy" && click.ms >= MIN_WAITED_MS && /another agent/.test(click.text)
      && typed.code === "input_busy" && typed.ms >= MIN_WAITED_MS
      && s.foreground_changes === 0 && s.cursor_max_displacement_px === 0
      && text === "",
  };
}

async function checkAbandoned({ a, observer, pads }: Agents) {
  const pad = await openPad("Locks-Abandoned", 640, 40, ["--log-clicks"]);
  pads.push(pad);
  const point = await textBoxPoint(a, pad);
  // The click starts waiting while the holder still owns the lock, so its handle keeps the mutex
  // alive through the holder's exit and the wait ends in WAIT_ABANDONED, not on a fresh mutex.
  const holder = await holdMutex(FOREGROUND_LOCK, ABANDON_AFTER_MS, false);
  const click = await a.call("click", { pid: pad.pid, window_id: pad.hwnd, ...point, delivery_mode: "foreground" });
  holder.kill();
  await sleep(300);
  const text = await padText(observer, pad);
  return {
    click: brief(click), text,
    passed: !click.error && click.ms >= ABANDON_AFTER_MS * 0.8 && click.ms < MIN_WAITED_MS && clicksIn(text) === 1,
  };
}

// --- runner ---------------------------------------------------------------------------------

const CHECKS = {
  fgclicks: checkFgclicks, sametype: checkSametype, samehotkey: checkSamehotkey, held: checkHeld, abandoned: checkAbandoned,
} satisfies Record<string, (agents: Agents) => Promise<{ passed: boolean }>>;
type CheckName = keyof typeof CHECKS;
const isCheck = (name: string): name is CheckName => Object.hasOwn(CHECKS, name);

const requested = process.argv.slice(2);
const unknown = requested.filter((n) => !isCheck(n));
if (unknown.length) {
  console.error(`unknown check ${unknown.join(", ")}; checks: ${Object.keys(CHECKS).join(" ")}`);
  process.exit(2);
}
const results: Record<string, { passed: boolean; exception?: string }> = {};
for (const name of (requested.length ? requested : Object.keys(CHECKS)).filter(isCheck)) {
  console.log(`== ${name}`);
  const pads: Win[] = [];
  try {
    await using a = await McpClient.start([EXE, "mcp"], { env: ENV });
    await using b = await McpClient.start([EXE, "mcp"], { env: ENV });
    await using observer = await McpClient.start([EXE, "mcp"], { env: ENV });
    results[name] = await CHECKS[name]({ a: new Agent("A", a), b: new Agent("B", b), observer: new Agent("obs", observer), pads });
  } catch (e) {
    results[name] = { passed: false, exception: String(e).slice(0, 800) };
  } finally {
    const pids = [...new Set(pads.map((p) => p.pid))];
    if (pids.length) await ps(`Stop-Process -Id ${pids.join(",")} -Force -ErrorAction SilentlyContinue`);
  }
  console.log(`  -> passed=${results[name].passed}`);
}
mkdirSync(OUT, { recursive: true });
const out = path.join(OUT, `input-locks-${timestamp()}.json`);
const sha256 = createHash("sha256").update(readFileSync(EXE)).digest("hex");
writeFileSync(out, JSON.stringify({ driver: EXE, driver_sha256: sha256, results, calls: log }, null, 1));
console.log("written:", out);
