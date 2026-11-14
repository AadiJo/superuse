// End-to-end check that agent sessions share one DevTools connection to the user's browser, so the
// browser asks "Allow remote debugging?" once and not once per session. It runs two real plugin
// servers and the real driver against the user's own open browser.
//
//   node bench/browser-attach.ts [--title Helium]
//
// The browser shows that prompt for every new DevTools connection, and the driver answers it. The
// plugin's servers send page calls through one shared browser service, which keeps the connection.
// The run starts with no service, then checks, in order:
//   - session A binds the browser window: the one prompt
//   - session B binds it: no prompt, and the foreground stays put
//   - A exits, B binds again: no prompt
//   - session C starts and binds: no prompt
//   - the driver ends B's idle session, B binds again: no prompt
//   - B exits: the service exits by itself
//
// The driver's session idle timeout (5 minutes) and the service's exit-when-unused time (10
// minutes) are shortened to 5 seconds. Every open browser window is bound each time, so a browser
// with several windows also checks that each one binds. Only tab counts are read, never a page or
// a title. Writes bench/out/browser-attach-<time>.json.

import { spawn, type ChildProcess } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { createInterface } from "node:readline";
import { setTimeout as sleep } from "node:timers/promises";
import { parseArgs } from "node:util";
import { browserService } from "../plugin/server/driver.ts";
import { McpClient, textOf } from "./mcp-client.ts";
import { encode, listWindows, POWERSHELL, ps, Sampler, timestamp, WIN_TYPES } from "./win.ts";

const REPO = path.dirname(import.meta.dirname);
const OUT = path.join(REPO, "bench", "out");
const EXE = process.env.SUPERUSE_DRIVER ?? path.join(REPO, "plugin/driver/superuse-driver.exe");
const SHORT_S = 5;
const IDLE_WAIT_MS = (SHORT_S + 30 + 10) * 1000; // the session timeout, one sweep period, and slack
const SERVICE = browserService(EXE).pipe.split("\\").at(-1)!;

const { values: flags } = parseArgs({ options: { title: { type: "string", default: "Helium" } } });

const isPrompt = (title: string) => title.toLowerCase().includes("remote debugging");

/** Polls Windows every 50 ms for a visible "Allow remote debugging?" prompt and records when one
 *  appears. The driver answers a prompt about 500 ms after it opens, so none is missed. */
class PromptWatch {
  private readonly proc: ChildProcess;
  private showing = false;
  /** Epoch milliseconds at which a prompt appeared. */
  readonly appeared: number[] = [];

  private constructor(proc: ChildProcess) { this.proc = proc; }

  static async start(): Promise<PromptWatch> {
    const script = WIN_TYPES + `
while ($true) {
  $n = 0
  foreach ($l in [SuperuseW]::Windows($true)) { if ($l.Split("\`t")[3] -match 'remote debugging') { $n++ } }
  [Console]::Out.WriteLine($n); [Console]::Out.Flush()
  Start-Sleep -Milliseconds 50
}`;
    const proc = spawn(POWERSHELL, ["-NoProfile", "-NonInteractive", "-EncodedCommand", encode(script)], { stdio: ["ignore", "pipe", "ignore"] });
    const watch = new PromptWatch(proc);
    const ready = Promise.withResolvers<void>();
    createInterface({ input: proc.stdout! }).on("line", (line) => {
      const showing = Number(line.trim()) > 0;
      if (showing && !watch.showing) watch.appeared.push(Date.now());
      watch.showing = showing;
      ready.resolve();
    });
    await ready.promise;
    return watch;
  }

  stop() { this.proc.kill("SIGKILL"); }
}

/** Browser services running from this driver exe, whichever build started them. `stop` ends them.
 *  Windows keeps running the old image of an exe while a process started from that path is alive,
 *  so a service left from before a rebuild would make this run test the old code. */
async function services(stop = false): Promise<number> {
  const out = await ps(`$p = @(Get-CimInstance Win32_Process -Filter "Name='superuse-driver.exe'" | Where-Object { $_.ExecutablePath -like '*${EXE.replaceAll("/", "\\")}' -and $_.CommandLine -like '* serve *superuse-browser-*' })
${stop ? "$p | ForEach-Object { Stop-Process -Id $_.ProcessId -Force -ErrorAction SilentlyContinue }" : ""}
$p.Count`);
  return Number(out.trim()) || 0;
}

type Call = { driver: string; ms: number; ok: boolean };
const driverCalls = (trace: string): Call[] =>
  readFileSync(trace, "utf8").split("\n").filter(Boolean).map((l) => JSON.parse(l) as Partial<Call>)
    .filter((e): e is Call => typeof e.driver === "string");

type Result = { case: string; ok: boolean; detail: string };
const results: Result[] = [];
function check(name: string, ok: boolean, detail: string) {
  results.push({ case: name, ok, detail: detail.slice(0, 400) });
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}: ${detail.slice(0, 200)}`);
}

const traces = mkdtempSync(path.join(tmpdir(), "superuse-attach-"));

/** One plugin server, as an agent session, with its own driver-call trace. */
async function session(name: string) {
  const trace = path.join(traces, `${name}.jsonl`);
  writeFileSync(trace, ""); // the server creates it on its first driver call
  const vars = { CUA_DRIVER_RS_SESSION_IDLE_TTL_SECS: String(SHORT_S), SUPERUSE_DRIVER_EXIT_UNUSED_SECS: String(SHORT_S) };
  // WSLENV carries the shortened timeouts into the Windows processes; driver.ts keeps what's there.
  const client = await McpClient.start(["node", path.join(REPO, "plugin/server/main.ts")], {
    env: { SUPERUSE_AUDIT: "off", SUPERUSE_TRACE: trace, SUPERUSE_BROWSERS: "tab", SUPERUSE_APPS: "chrome", SUPERUSE_DRIVER: EXE, ...vars, WSLENV: Object.keys(vars).join(":") },
  });
  return { name, trace, client };
}
type Session = Awaited<ReturnType<typeof session>>;

// Bind every browser window and count the tabs each reaches. The driver refuses a window it can't
// tell from another of the same size (browser_binding_ambiguous); any other refusal is a failure.
const BIND = `const rows = (await desktop.windows()).filter((r) => r.id !== undefined && r.title.includes(${JSON.stringify(flags.title)}));
const out = { windows: rows.length, tabs: [], ambiguous: 0, failures: [] };
for (const row of rows) {
  try { out.tabs.push((await (await (await desktop.window({pid: row.pid, id: row.id})).page()).tabs()).length); }
  catch (e) { if (/browser_binding_ambiguous/.test(e.message)) out.ambiguous++; else out.failures.push(e.message.split("\\n")[0].slice(0, 160)); }
}
return JSON.stringify(out);`;
type Bound = { windows: number; tabs: number[]; ambiguous: number; failures: string[] };

/** Bind each browser window's page, under the prompt watch and desktop sampler. */
async function bind(s: Session, watch: PromptWatch) {
  const sampler = await Sampler.start();
  const [t0, callsBefore] = [Date.now(), driverCalls(s.trace).length];
  const { result, ms } = await s.client.call("js", { code: BIND }, 120_000);
  await sleep(300); // a prompt that opened at the very end still gets sampled
  sampler.stop();
  const calls = driverCalls(s.trace).slice(callsBefore);
  const text = textOf(result);
  const bound: Bound = result.isError ? { windows: 0, tabs: [], ambiguous: 0, failures: [text.slice(0, 200)] } : JSON.parse(text) as Bound;
  return {
    session: s.name, ...bound, ms: Math.round(ms),
    // Bound at least one window, and refused none for a reason other than ambiguity.
    ok: bound.tabs.length > 0 && bound.failures.length === 0,
    prompts: watch.appeared.filter((t) => t >= t0).length,
    attaches: calls.filter((x) => x.driver === "browser_prepare").map((x) => ({ ms: x.ms, ok: x.ok })),
    calls: calls.map((x) => `${x.driver}:${x.ok ? "ok" : "refused"}`),
    foreground_changes: sampler.summary().foreground_changes ?? 0,
  };
}
type Bind = Awaited<ReturnType<typeof bind>>;
const describe = (b: Bind) => `${b.tabs.length} of ${b.windows} window(s) bound${b.ambiguous ? `, ${b.ambiguous} ambiguous` : ""}${b.failures.length ? `, failed: ${b.failures.join(" | ")}` : ""}; ${b.prompts} prompt(s); attach ${b.attaches.map((a) => `${a.ms} ms`).join(", ") || "not needed"}; ${b.foreground_changes} foreground change(s)`;
const quiet = (b: Bind) => b.ok && b.prompts === 0 && b.foreground_changes === 0;

process.chdir(REPO);
mkdirSync(OUT, { recursive: true });
const binds: Bind[] = [];
const stopped = await services(true);
if (stopped) console.log(`stopped ${stopped} browser service(s) left from an earlier run`);
const watch = await PromptWatch.start();
try {
  const a = await session("a");
  const b = await session("b");
  try {
    binds.push(await bind(a, watch));
    check("session A binds, and the browser asks once", binds[0].ok && binds[0].prompts === 1, describe(binds[0]));
    check("one browser service is running", (await services()) === 1, `${await services()} service(s) on ${SERVICE}`);

    binds.push(await bind(b, watch));
    check("session B binds without a prompt", quiet(binds[1]), describe(binds[1]));
    check("still one browser service", (await services()) === 1, `${await services()} service(s)`);

    await a.client.close();
    binds.push(await bind(b, watch));
    check("after A exits, B binds without a prompt", quiet(binds[2]), describe(binds[2]));

    // A new session gets the cursor label A held. The service must still take it.
    {
      const c = await session("c");
      try {
        binds.push(await bind(c, watch));
        check("a session started after A exited binds without a prompt", quiet(binds[3]), describe(binds[3]));
      } finally {
        await c.client.close();
      }
    }

    console.log(`waiting ${IDLE_WAIT_MS / 1000}s for the driver to end B's idle session`);
    await sleep(IDLE_WAIT_MS);
    binds.push(await bind(b, watch));
    check("the driver ended B's idle session in between", binds[4].calls.includes("start_session:ok"), binds[4].calls.join(" > "));
    check("after its session ended, B binds without a prompt", quiet(binds[4]), describe(binds[4]));
  } finally {
    await a.client.close();
    await b.client.close();
  }
  let left = await services();
  for (const end = Date.now() + (SHORT_S + 10) * 1000; left > 0 && Date.now() < end; left = await services()) await sleep(1000);
  check("with no session left, the service exits", left === 0, `${left} service(s) running`);
} finally {
  watch.stop();
  await services(true);
}

// A prompt nobody answered denies on WM_CLOSE.
const leftover = (await listWindows(true)).filter((w) => w.proc === "chrome" && isPrompt(w.title));
if (leftover.length) await ps(WIN_TYPES + leftover.map((w) => `[void][SuperuseW]::PostMessage([IntPtr]${w.hwnd},0x0010,[IntPtr]::Zero,[IntPtr]::Zero)\n`).join(""));
check("no prompt is left open", leftover.length === 0, `${leftover.length} left`);

const out = path.join(OUT, `browser-attach-${timestamp()}.json`);
writeFileSync(out, JSON.stringify({ driver: EXE, service: SERVICE, shortened_timeouts_s: SHORT_S, binds, results }, null, 2));
console.log(out);
process.exitCode = results.every((r) => r.ok) ? 0 : 1;
