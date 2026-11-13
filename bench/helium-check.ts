// End-to-end check of the plugin's page API in the user's own Helium (or any Chromium browser with
// its remote-debugging toggle on), through the real plugin server and driver.
//
//   node bench/helium-check.ts            direct page-API run, then one headless Claude run
//   node bench/helium-check.ts --direct   page-API run only
//   node bench/helium-check.ts --claude   headless Claude run only (add --no-helium-mcp to hide the
//                                         user's own "helium" MCP server and test the plugin alone)
//
// The direct run passes only if every step succeeds (including the refusal of a stale ref), the form
// arrives, and the foreground and cursor end where they started.
//
// It serves a test form from WSL on 127.0.0.1:8765; the form reports each submission back to that
// server, so the check never reads the user's tabs. Everything happens in a tab the run opens. At
// the end it closes any test tab still open (by its tab-strip close button) and dismisses leftover
// "Allow remote debugging?" prompts with WM_CLOSE, which denies them. Writes
// bench/out/helium-check-<time>.json.

import { spawn } from "node:child_process";
import { once } from "node:events";
import { closeSync, mkdirSync, openSync, readFileSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import path from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import { parseArgs } from "node:util";
import { McpClient, textOf, type Structured } from "./mcp-client.ts";
import type { ClaudeEvent } from "./run.ts";
import { FORM_HTML } from "./tasks.ts";
import { listWindows, ps, Sampler, timestamp, WIN_TYPES, type Win } from "./win.ts";

const REPO = path.dirname(import.meta.dirname);
const OUT = path.join(REPO, "bench", "out");
const PORT = 8765;
const FORM_URL = `http://127.0.0.1:${PORT}/form.html`;
const WANT = { name: "Ada Lovelace", email: "ada@example.com", plan: "pro", agree: "yes", notes: "typed in the background" };

type Submission = Record<string, string>;
const submissions: Submission[] = [];

// The bench form, plus a contenteditable Notes box, and a beacon to this server on submit.
const PAGE = FORM_HTML
  .replaceAll("<title>Signup form</title>", "<title>Superuse Helium test</title>")
  .replaceAll('<button type="submit">Submit</button>',
    '<label>Notes <div id="notes" contenteditable="true" role="textbox" aria-label="Notes" '
    + 'style="border:1px solid #888;min-height:40px"></div></label>\n<button type="submit">Submit</button>')
  // The title keeps "Superuse Helium test" after submit, whatever was typed, so cleanup can find the tab.
  .replaceAll("document.title = 'SUBMITTED ' + s;",
    "document.title = 'Superuse Helium test: SUBMITTED ' + s; fetch('/submitted?' + new URLSearchParams({name: v('name').value, "
    + "email: v('email').value, plan: v('plan').value, agree: v('agree').checked ? 'yes' : 'no', "
    + "notes: v('notes').textContent}));");

/** Query parameters the way Python's parse_qs read them: blank values dropped, and the first value
 * of a repeated key kept. */
function submissionOf(params: URLSearchParams): Submission {
  const out: Submission = {};
  for (const [k, v] of params) if (v && !Object.hasOwn(out, k)) out[k] = v;
  return out;
}

const isWanted = (s: Submission | null) =>
  s !== null && Object.keys(s).length === Object.keys(WANT).length && Object.entries(WANT).every(([k, v]) => s[k] === v);

/** Serves the form on every path; /submitted records the form's beacon. */
const server = createServer((req, res) => {
  const u = new URL(req.url ?? "/", FORM_URL);
  if (u.pathname === "/submitted") submissions.push(submissionOf(u.searchParams));
  res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
  res.end(u.pathname === "/submitted" ? "ok" : PAGE);
});

async function heliumWindows(): Promise<Win[]> {
  return (await listWindows(true)).filter((w) => w.proc === "chrome" && w.title.endsWith("- Helium"));
}

async function debuggingPrompts(): Promise<Win[]> {
  return (await listWindows(true)).filter((w) => w.proc === "chrome" && w.title.toLowerCase().includes("remote debugging"));
}

/** Close test tabs left open (tab-strip Close buttons) and deny leftover debugging prompts. */
async function cleanup(): Promise<string[]> {
  const done: string[] = [];
  const prompts = await debuggingPrompts();
  if (prompts.length) {
    await ps(WIN_TYPES + prompts.map((w) => `[void][SuperuseW]::PostMessage([IntPtr]${w.hwnd},0x0010,[IntPtr]::Zero,[IntPtr]::Zero)\n`).join(""));
    done.push(`denied ${prompts.length} prompt(s)`);
  }
  await using c = await McpClient.start([path.join(REPO, "plugin/driver/superuse-driver.exe"), "mcp"], { env: { DO_NOT_TRACK: "1", WSLENV: "DO_NOT_TRACK" } });
  const indent = (line: string) => line.length - line.trimStart().length;
  for (const w of await heliumWindows()) {
    for (let i = 0; i < 5; i++) {
      const { result } = await c.call("get_window_state", { pid: w.pid, window_id: w.hwnd, include_screenshot: false, max_elements: 600 });
      const d: Structured = result.structuredContent ?? JSON.parse(textOf(result));
      const lines = (d.tree_markdown ?? "").split(/\r?\n/);
      // Only the test page, whose title always starts with its marker. Any other tab may be the
      // user's, including a chrome://inspect page, which the driver's setup can also open.
      const hit = lines.findIndex((l) => l.includes("TabItem") && l.includes('"Superuse Helium test'));
      if (hit < 0) break;
      // The tab's own Close button: one of the next few rows, nested under the tab.
      const close = lines.slice(hit + 1, hit + 6).find((l) => indent(l) > indent(lines[hit]) && l.includes('Button "Close"'));
      const row = close?.match(/\[(\d+)\]/)?.[1];
      if (!row) break;
      await c.call("click", { element_token: `${d.snapshot_id}:${row}` });
      done.push("closed a test tab");
      await sleep(1000);
    }
  }
  return done;
}

async function js(c: McpClient, code: string): Promise<{ text: string; error: boolean; ms: number }> {
  const { result, ms } = await c.call("js", { code }, 180_000);
  return { text: textOf(result), error: !!result.isError, ms };
}

// The page API by hand: open a background tab, fill the form, submit with Enter, close the tab.
const STEPS: Array<[label: string, code: string]> = [
  ["bind Helium + open tab", `const w = await desktop.window({app: "chrome", title: "Helium"}); globalThis.p = await w.page().newTab(${JSON.stringify(FORM_URL)}); return p.title`],
  ["read", "return await p.read()"],
  // A ref from a superseded read must throw, not return as if the text went in.
  ["stale ref refused", String.raw`const old = (await p.read({query: "Name"})).match(/\[(p\d+:\d+)\] textbox "Name"/)[1]; await p.read({query: "Name"}); try { await p.type(old, "STALE"); } catch (e) { if (/browser_ref_stale/.test(e.message)) return "refused"; throw e; } throw new Error("a stale ref was accepted")`],
  ["type name", String.raw`const r = await p.read({query: "Name"}); await p.type(r.match(/\[(p\d+:\d+)\] textbox "Name"/)[1], "Ada Lovelace", {replace: true}); return "ok"`],
  ["type email", String.raw`const r = await p.read({query: "Email"}); await p.type("ada@example.com", r.match(/\[(p\d+:\d+)\] textbox "Email"/)[1], {replace: true}); return "ok"`],
  ["type notes", String.raw`const r = await p.read({query: "Notes"}); await p.type("typed in the background", r.match(/\[(p\d+:\d+)\] textbox "Notes"/)[1]); return "ok"`],
  ["select plan", String.raw`const r = await p.read({query: "Plan"}); await p.select(r.match(/\[(p\d+:\d+)\] combobox "Plan"/)[1], "Pro"); return "ok"`],
  ["tick agree", String.raw`const r = await p.read({query: "agree"}); await p.click(r.match(/\[(p\d+:\d+)\] checkbox/)[1]); return "ok"`],
  // Text boxes declare type, not click, so typing is what puts the focus back in Name.
  ["Enter in Name", String.raw`const r = await p.read({query: "Name"}); await p.type(r.match(/\[(p\d+:\d+)\] textbox "Name"/)[1], "Ada Lovelace", {replace: true}); await p.key("Enter"); return "ok"`],
  ["screenshot refused fast", 'try { await p.screenshot(); return "captured" } catch (e) { return /isn.t painted/.test(e.message) ? "refused fast" : "ERR " + e.message }'],
  ["close tab", 'await p.close(); return "ok"'],
];

/** Run STEPS through one plugin server session, under the desktop sampler. */
async function runSteps() {
  await using c = await McpClient.start(["node", path.join(REPO, "plugin/server/main.ts")], { env: { SUPERUSE_AUDIT: "off" } });
  const sampler = await Sampler.start();
  const t0 = Date.now();
  const steps: Array<{ step: string; ms: number; ok: boolean; detail: string }> = [];
  try {
    for (const [label, code] of STEPS) {
      const { text, error, ms } = await js(c, code);
      steps.push({ step: label, ms: Math.round(ms), ok: !error, detail: text.slice(0, 300) });
      console.log(`  ${label.padEnd(24)} ${ms.toFixed(0).padStart(6)} ms  ${error ? "ERR " + text.slice(0, 200) : text.slice(0, 100).replaceAll("\n", " | ")}`);
    }
  } finally {
    sampler.stop();
  }
  return { steps, wall_s: Number(((Date.now() - t0) / 1000).toFixed(1)), sampler };
}

async function directRun() {
  const before = submissions.length;
  const { steps, wall_s, sampler } = await runSteps();
  await sleep(500);
  const submission = submissions[before] ?? null;
  // The page API never needs the foreground or the cursor, so both must end where the user had them,
  // including after the browser's "Allow remote debugging?" prompt takes the foreground.
  const disturbance = sampler.summary();
  const background = disturbance.foreground_restored === true && disturbance.cursor_max_displacement_px === 0;
  return { steps, wall_s, disturbance, submission, passed: steps.every((s) => s.ok) && isWanted(submission) && background };
}

/** The same job as a user prompt through headless Claude Code with the plugin. */
async function claudeRun(hideHeliumMcp: boolean) {
  const prompt = `In my Helium browser, open ${FORM_URL} in a new tab and fill in the signup form: name Ada Lovelace, `
    + "email ada@example.com, plan Pro, notes 'typed in the background', tick the terms box, and submit it. "
    + "Then close that tab and tell me what the page showed after submitting.";
  const before = submissions.length;
  const transcript = path.join(OUT, `helium-claude-${timestamp()}.jsonl`);
  const sampler = await Sampler.start();
  const t0 = Date.now();
  try {
    const stdout = openSync(transcript, "w");
    // --no-helium-mcp hides the user's own chrome-devtools-mcp server ("helium"), to test the plugin path alone.
    const hide = hideHeliumMcp ? ["--disallowedTools", "mcp__helium"] : [];
    const proc = spawn("claude", ["-p", prompt, "--allowedTools", "mcp__plugin_superuse_computer__js", "Skill", ...hide,
      "--output-format", "stream-json", "--verbose", "--no-session-persistence"], { stdio: ["ignore", stdout, "ignore"], cwd: "/tmp" });
    closeSync(stdout);
    const deadline = setTimeout(() => proc.kill("SIGKILL"), 400_000);
    await once(proc, "exit").finally(() => clearTimeout(deadline));
  } finally {
    sampler.stop();
  }
  const wallS = (Date.now() - t0) / 1000;
  const calls: string[] = [];
  let result = "";
  let cost: number | null = null;
  for (const line of readFileSync(transcript, "utf8").split("\n")) {
    let ev: ClaudeEvent;
    try {
      ev = JSON.parse(line);
    } catch {
      continue;
    }
    if (ev.type === "assistant") calls.push(...ev.message.content.flatMap((b) => (b.type === "tool_use" ? [b.name] : [])));
    else if (ev.type === "result") [result, cost] = [ev.result ?? "", ev.total_cost_usd ?? null];
  }
  const submission = submissions[before] ?? null;
  const out = {
    wall_s: Number(wallS.toFixed(1)), cost_usd: cost, tool_calls: calls, submission, passed: isWanted(submission),
    disturbance: sampler.summary(), result: result.slice(0, 400),
  };
  console.log(`  claude: ${out.passed ? "PASS" : "FAIL"} ${out.wall_s}s $${cost} calls=${calls.length} disturbance=${JSON.stringify(out.disturbance)}`);
  return out;
}

const { values: flags } = parseArgs({
  options: {
    direct: { type: "boolean", default: false },
    claude: { type: "boolean", default: false },
    "no-helium-mcp": { type: "boolean", default: false },
  },
});
process.chdir(REPO);
mkdirSync(OUT, { recursive: true });
server.listen(PORT, "127.0.0.1");
await once(server, "listening");
const report: {
  direct?: Awaited<ReturnType<typeof directRun>>;
  claude?: Awaited<ReturnType<typeof claudeRun>>;
  cleanup?: string[];
  leftover_prompts?: number;
} = {};
try {
  if (!flags.claude) {
    console.log("direct page-API run:");
    report.direct = await directRun();
    console.log(`  ${report.direct.passed ? "PASS" : "FAIL"} submission=${JSON.stringify(report.direct.submission)} disturbance=${JSON.stringify(report.direct.disturbance)}`);
  }
  if (!flags.direct) {
    console.log("headless Claude run:");
    report.claude = await claudeRun(flags["no-helium-mcp"]);
  }
} finally {
  report.cleanup = await cleanup();
  report.leftover_prompts = (await debuggingPrompts()).length;
  console.log("cleanup:", report.cleanup, "| prompts left:", report.leftover_prompts);
  server.close();
  server.closeAllConnections();
}
const out = path.join(OUT, `helium-check-${timestamp()}.json`);
writeFileSync(out, JSON.stringify(report, null, 2));
console.log(out);
process.exitCode = [report.direct, report.claude].every((r) => r === undefined || r.passed) ? 0 : 1;
