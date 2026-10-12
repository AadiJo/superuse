// Benchmark runner: one agent and one computer-use stack ("arm") on one task per run.
//
//   node bench/run.ts --arms claude-bcu3-v4,claude-bcu3 --tasks calc_mul,edge_form --reps 1 [--seed 42] [--batch name]
//
// Every run writes bench/out/<batch>/<arm>/<task>-r<n>/ with:
//   transcript.jsonl    raw agent event stream, each line prefixed by its receive time
//   screenshot-*.jpg    every image the model saw
//   metrics.json        success (from the task's own checker), wall time, turns, tool calls,
//                       tokens, cost, per-call latency, desktop disturbance, seed
//   windows-closed.txt  what teardown closed
//   server-trace.jsonl  claude-bcu3 arms: the server's per-call timings (BCU_TRACE; v4 servers write none)
//
// Arms differ only in the CU stack; the prompt text is identical. A restarted batch skips runs
// that already wrote metrics.json. --seed fixes the xapp_* tasks' random values (invoice lines,
// files, contact) so runs can be replayed; without it a batch reuses the seed it started with, or
// picks one and prints it.

import { spawn } from "node:child_process";
import { randomInt } from "node:crypto";
import { createWriteStream, existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { createInterface } from "node:readline";
import { setTimeout as sleep } from "node:timers/promises";
import { parseArgs } from "node:util";
import { finalLine, isTaskId, rngFor, SUITE, TASK_IDS, TASKS, type Task, type TaskId } from "./tasks.ts";
import { closeNewWindows, closeStrays, killNewOpenwith, killTestPad, listWindows, openwithPids, Sampler, timestamp, type Disturbance } from "./win.ts";

const ROOT = import.meta.dirname;
const REPO = path.dirname(ROOT);
export const OUT = path.join(ROOT, "out");
const WORKDIR = path.join(ROOT, "workdir"); // empty cwd so no project instructions leak in
const CUA_RELEASE = path.join(REPO, "tools/cua-driver/cua-driver-rs-0.34.1-windows-x86_64/cua-driver.exe");
const CUA_MAIN = path.join(REPO, "tools/cua-driver-main/cua-driver.exe");
// Benchmark copy of ~/.local/bin/codex-cu-mcp: browser backends off, tab records redacted.
const CODEX_CU = path.join(ROOT, "codex-cu-bridge.ts");
const CUA_ENV = { DO_NOT_TRACK: "1", WSLENV: "DO_NOT_TRACK" };
const SUITE_APPS = "TestPad,Calculator,msedge,File Explorer";
const MODEL = "opus";
const EFFORT = "medium";

export const PREAMBLE =
  "You are controlling a Windows 11 desktop through the computer-use tools you have been given. "
  + "Use only those tools. Only interact with the app(s) the task names; do not touch other windows. "
  + "Work efficiently: batch actions when the tools allow it, and check the result before finishing. "
  + "When done, reply with one line starting with FINAL: followed by the requested answer, or 'done'.\n\nTask: ";

/** MCP server config for an arm's CU stack, registered under the name "cu". */
type McpServer = { command: string; args?: string[]; env?: Record<string, string> };

/** Every arm is Claude Code; they differ in the "cu" server, which may depend on the run folder. */
const ARMS = {
  "claude-codexcu": () => ({ command: "node", args: [CODEX_CU], env: { CODEX_CU_AUTO_APPROVE: "1" } }),
  "claude-cua": () => ({ command: CUA_RELEASE, args: ["mcp"], env: CUA_ENV }),
  "claude-cua-main": () => ({ command: CUA_MAIN, args: ["mcp"], env: CUA_ENV }),
  "claude-bcu": () => ({ command: "node", args: [path.join(REPO, "proto/v1/bcu-mcp.ts")] }),
  "claude-bcu-fork": () => ({
    command: "node", args: [path.join(REPO, "proto/v1/bcu-mcp.ts")],
    env: { BCU_CUA_DRIVER: path.join(REPO, "tools/cua-driver-fork/cua-driver.exe") },
  }),
  // v2 prototype over the v2 fork. BCU_APPS scopes window lists to the suite's apps (apps it
  // launches are always in scope); everything else on the desktop stays hidden from the model.
  "claude-bcu2": () => ({
    command: "node", args: [path.join(REPO, "proto/v2/bcu-mcp.ts")],
    env: { BCU_CUA_DRIVER: path.join(REPO, "tools/cua-driver-fork/v2/cua-driver.exe"), BCU_APPS: SUITE_APPS },
  }),
  // v3 and later: the plugin's server (QuickJS sandbox, policy) over the driver the plugin ships.
  "claude-bcu3": (runDir: string) => pluginServer(path.join(REPO, "plugin"), runDir),
  // Round 4 baseline: the v4 server and driver, frozen by `git archive` of the round 3 commit into
  // tools/baseline/v4/plugin (gitignored), with the v4 cua-driver.exe in its driver/ folder.
  "claude-bcu3-v4": (runDir: string) => pluginServer(path.join(REPO, "tools/baseline/v4/plugin"), runDir),
} satisfies Record<string, (runDir: string) => McpServer>;

/** The plugin server at `pluginDir` (server/main.ts, which finds driver/cua-driver.exe beside it).
 *  Headless runs can't show approval prompts, so the suite's apps are pre-approved and foreground
 *  input is allowed as in v2; a throwaway policy file keeps the user's own approvals out of the runs.
 *  BCU_TRACE has the server log each driver call's timing into the run folder. */
function pluginServer(pluginDir: string, runDir: string): McpServer {
  return {
    command: "node", args: [path.join(pluginDir, "server/main.ts")],
    env: {
      BCU_APPS: SUITE_APPS, BCU_FOREGROUND: "allow",
      BCU_POLICY: path.join(WORKDIR, "policy.json"), BCU_AUDIT: path.join(WORKDIR, "actions.jsonl"),
      BCU_TRACE: path.join(runDir, "server-trace.jsonl"),
    },
  };
}

type ArmId = keyof typeof ARMS;
const isArmId = (id: string): id is ArmId => Object.hasOwn(ARMS, id);

/** One run's metrics.json. Field names stay snake_case so every batch, old or new, loads in report.ts. */
export type Metrics = {
  arm: string;
  task: string;
  rep: number;
  seed: number;
  passed: boolean;
  check_detail: string;
  final: string;
  wall_s: number;
  first_tool_s: number | null; // startup cost: launch -> first tool call
  turns: number | null;
  tool_calls: number;
  images_seen: number;
  tool_time_s: number; // summed time inside tool calls
  model_time_s: number; // wall minus tool time minus startup
  input_tokens: number | null;
  output_tokens: number | null;
  cache_read_tokens: number | null;
  cost_usd: number | null;
  model_id: string | null;
  error: string | null;
  timed_out: boolean;
  disturbance: Disturbance;
  tool_latencies_s: number[];
};

/** Metrics of a run that hasn't happened yet; codex-app.ts fills in the rest by hand. */
export function newMetrics(arm: string, task: string, rep: number, seed: number): Metrics {
  return {
    arm, task, rep, seed, passed: false, check_detail: "", final: "", wall_s: 0, first_tool_s: null, turns: null,
    tool_calls: 0, images_seen: 0, tool_time_s: 0, model_time_s: 0, input_tokens: null, output_tokens: null,
    cache_read_tokens: null, cost_usd: null, model_id: null, error: null, timed_out: false, disturbance: { samples: 0 },
    tool_latencies_s: [],
  };
}

// The parts of Claude Code's stream-json output that the runner and trace.ts read.
type TextBlock = { type: "text"; text: string };
type ImageBlock = { type: "image"; source: { media_type?: string; data: string } };
type ToolUseBlock = { type: "tool_use"; id: string; name: string; input: Record<string, unknown> };
type ThinkingBlock = { type: "thinking" };
export type ToolResultBlock = { type: "tool_result"; tool_use_id: string; content?: string | Array<TextBlock | ImageBlock> };
type Usage = Partial<Record<"input_tokens" | "cache_creation_input_tokens" | "cache_read_input_tokens" | "output_tokens", number>>;

export type ClaudeEvent =
  | { type: "system"; subtype?: string; model?: string; tools?: unknown[] }
  | { type: "assistant"; message: { content: Array<TextBlock | ToolUseBlock | ThinkingBlock> } }
  | { type: "user"; message: { content: string | Array<ToolResultBlock | TextBlock> } }
  | { type: "result"; subtype?: string; num_turns?: number; total_cost_usd?: number; is_error?: boolean; result?: string; usage?: Usage };

type TimedEvent = [ts: number, event: ClaudeEvent];

const now = () => Date.now() / 1000;
const round = (x: number, digits: number) => Number(x.toFixed(digits));

function claudeArgs(prompt: string, cfg: string): string[] {
  return ["-p", prompt, "--tools", "", "--strict-mcp-config", "--mcp-config", cfg,
    "--allowedTools", "mcp__cu", "--model", MODEL, "--effort", EFFORT,
    "--output-format", "stream-json", "--verbose", "--no-session-persistence",
    // Skip project/local settings: the parent folder sets an output style that adds prose to every run.
    "--setting-sources", "user"];
}

/** Launch the agent and timestamp every JSON event as it arrives. Past the deadline it's killed. */
async function runAgent(server: McpServer, prompt: string, runDir: string, timeoutS: number): Promise<{ events: TimedEvent[]; timedOut: boolean }> {
  const cfg = path.join(runDir, "mcp.json");
  writeFileSync(cfg, JSON.stringify({ mcpServers: { cu: server } }, null, 2));
  const proc = spawn("claude", claudeArgs(prompt, cfg), {
    cwd: WORKDIR,
    env: { ...process.env, MCP_TIMEOUT: "120000", MCP_TOOL_TIMEOUT: "180000" },
    stdio: ["ignore", "pipe", "pipe"],
  });
  proc.stderr.pipe(createWriteStream(path.join(runDir, "stderr.txt")));
  const transcript = createWriteStream(path.join(runDir, "transcript.jsonl"));
  const events: TimedEvent[] = [];
  let timedOut = false;
  const deadline = setTimeout(() => {
    timedOut = true;
    proc.kill("SIGKILL");
  }, timeoutS * 1000);
  createInterface({ input: proc.stdout }).on("line", (line) => {
    if (timedOut) return;
    const ts = now();
    transcript.write(`${ts.toFixed(3)}\t${line}\n`);
    try {
      events.push([ts, JSON.parse(line)]);
    } catch { /* not an event */ }
  });
  // Normally "close" ends the run. If a stray child holds stdout open after the agent exits,
  // stop reading 2 s after the exit instead of waiting forever.
  await new Promise<void>((resolve, reject) => {
    proc.on("error", reject);
    proc.on("close", () => resolve());
    proc.on("exit", () => setTimeout(resolve, 2000).unref());
  });
  clearTimeout(deadline);
  proc.stdout.destroy();
  proc.stderr.destroy();
  await new Promise((resolve) => transcript.end(resolve));
  return { events, timedOut };
}

type Parsed = Pick<Metrics, "model_id" | "tool_calls" | "first_tool_s" | "tool_latencies_s" | "images_seen" | "turns"
  | "cost_usd" | "input_tokens" | "cache_read_tokens" | "output_tokens" | "final" | "error">;

/** Pull the metrics out of Claude's event stream, saving every image the model saw as screenshot-N. */
function parseClaude(events: TimedEvent[], t0: number, runDir: string): Parsed {
  const p: Parsed = {
    model_id: null, tool_calls: 0, first_tool_s: null, tool_latencies_s: [], images_seen: 0, turns: null,
    cost_usd: null, input_tokens: null, cache_read_tokens: null, output_tokens: null, final: "", error: null,
  };
  const started = new Map<string, number>();
  for (const [ts, ev] of events) {
    switch (ev.type) {
      case "system":
        if (ev.subtype === "init") p.model_id = ev.model ?? null;
        break;
      case "assistant":
        for (const b of ev.message.content) {
          if (b.type !== "tool_use") continue;
          p.tool_calls++;
          started.set(b.id, ts);
          p.first_tool_s ??= ts - t0;
        }
        break;
      case "user":
        if (typeof ev.message.content === "string") break;
        for (const b of ev.message.content) {
          if (b.type !== "tool_result") continue;
          const start = started.get(b.tool_use_id);
          if (start !== undefined) {
            p.tool_latencies_s.push(round(ts - start, 3));
            started.delete(b.tool_use_id);
          }
          for (const part of Array.isArray(b.content) ? b.content : []) {
            if (part.type !== "image") continue;
            const ext = part.source.media_type?.includes("png") ? "png" : "jpg";
            writeFileSync(path.join(runDir, `screenshot-${++p.images_seen}.${ext}`), Buffer.from(part.source.data, "base64"));
          }
        }
        break;
      case "result": {
        const u = ev.usage ?? {};
        p.turns = ev.num_turns ?? null;
        p.cost_usd = ev.total_cost_usd ?? null;
        p.input_tokens = (u.input_tokens ?? 0) + (u.cache_creation_input_tokens ?? 0) + (u.cache_read_input_tokens ?? 0);
        p.cache_read_tokens = u.cache_read_input_tokens ?? null;
        p.output_tokens = u.output_tokens ?? null;
        p.final = finalLine(ev.result ?? "");
        if (ev.is_error) p.error = ev.subtype ?? "error";
        break;
      }
    }
  }
  return p;
}

/** Set up the task, run the agent under the desktop sampler, check, tear down, write the run folder. */
async function runOne(armId: ArmId, taskId: TaskId, rep: number, seed: number, batchDir: string, timeoutS: number): Promise<Metrics> {
  const task: Task = TASKS[taskId];
  const runDir = path.join(batchDir, armId, `${taskId}-r${rep}`);
  mkdirSync(runDir, { recursive: true });
  await closeStrays(); // windows left by an interrupted earlier run would confuse this one
  const before = await listWindows();
  const pickersBefore = await openwithPids();
  const check = await task.setup(rngFor(seed, taskId, rep));
  const sampler = await Sampler.start();
  const t0 = now();
  const { events, timedOut } = await runAgent(ARMS[armId](runDir), PREAMBLE + task.prompt, runDir, timeoutS)
    .finally(() => sampler.stop());
  const wall_s = round(now() - t0, 2);
  const parsed = parseClaude(events, t0, runDir);
  const tool_time_s = round(parsed.tool_latencies_s.reduce((a, b) => a + b, 0), 2);
  const disturbance = sampler.summary();
  await sleep(1000);
  const { passed, detail } = await check(parsed.final);
  await task.teardown?.();
  const closed = await closeNewWindows(before);
  await sleep(1000); // the Open With picker appears a moment after its interim window
  closed.push(...(await killNewOpenwith(pickersBefore)).map((p) => `killed OpenWith:${p}`));
  await killTestPad(); // TestPad is only ever ours; a modal dialog can block WM_CLOSE
  const m: Metrics = {
    arm: armId, task: taskId, rep, seed, passed, check_detail: detail, final: parsed.final, wall_s,
    first_tool_s: parsed.first_tool_s, turns: parsed.turns, tool_calls: parsed.tool_calls, images_seen: parsed.images_seen,
    tool_time_s, model_time_s: round(wall_s - tool_time_s - (parsed.first_tool_s ?? 0), 2),
    input_tokens: parsed.input_tokens, output_tokens: parsed.output_tokens, cache_read_tokens: parsed.cache_read_tokens,
    cost_usd: parsed.cost_usd, model_id: parsed.model_id, error: parsed.error, timed_out: timedOut, disturbance,
    tool_latencies_s: parsed.tool_latencies_s,
  };
  writeFileSync(path.join(runDir, "windows-closed.txt"), closed.join("\n"));
  writeFileSync(path.join(runDir, "metrics.json"), JSON.stringify(m, null, 2));
  return m;
}

/** The seed a batch already ran with, so a restarted batch keeps drawing the same values. */
function previousSeed(batchDir: string): number | undefined {
  for (const file of readdirSync(batchDir, { recursive: true, encoding: "utf8" })) {
    if (path.basename(file) !== "metrics.json") continue;
    const { seed }: Partial<Metrics> = JSON.parse(readFileSync(path.join(batchDir, file), "utf8"));
    if (typeof seed === "number") return seed;
  }
}

function fail(message: string): never {
  console.error(message);
  process.exit(2);
}

function wholeNumber(name: string, value: string): number {
  const n = Number(value);
  return Number.isInteger(n) && n >= 0 ? n : fail(`--${name} must be a whole number, got ${JSON.stringify(value)}`);
}

async function main() {
  const { values } = parseArgs({
    options: {
      arms: { type: "string", default: "claude-codexcu,claude-cua" },
      tasks: { type: "string", default: SUITE.join(",") },
      reps: { type: "string", default: "1" },
      timeout: { type: "string", default: "420" },
      batch: { type: "string", default: timestamp() },
      seed: { type: "string" },
    },
  });
  const arms = values.arms.split(",").map((a) => (isArmId(a) ? a : fail(`unknown arm ${a}; arms: ${Object.keys(ARMS).join(", ")}`)));
  const tasks = values.tasks.split(",").map((t) => (isTaskId(t) ? t : fail(`unknown task ${t}; tasks: ${TASK_IDS.join(", ")}`)));
  const reps = wholeNumber("reps", values.reps);
  const timeoutS = Number(values.timeout) > 0 ? Number(values.timeout) : fail("--timeout must be a positive number of seconds");
  mkdirSync(WORKDIR, { recursive: true });
  const batchDir = path.join(OUT, values.batch);
  mkdirSync(batchDir, { recursive: true });
  const seed = values.seed !== undefined ? wholeNumber("seed", values.seed) : previousSeed(batchDir) ?? randomInt(1_000_000);
  console.log(`batch ${values.batch}, seed ${seed}`);
  // Interleave arms per task so drift (app state, network) doesn't favor one arm, and rotate who
  // goes first: the arms share most of the prompt, so a fixed order hands the later arms a warm
  // prompt cache (batch v5's second arm started about 0.8 s faster per run and cost a third less).
  for (let rep = 1; rep <= reps; rep++) {
    for (const [t, taskId] of tasks.entries()) {
      const shift = (rep - 1 + t) % arms.length;
      for (const armId of [...arms.slice(shift), ...arms.slice(0, shift)]) {
        if (existsSync(path.join(batchDir, armId, `${taskId}-r${rep}`, "metrics.json"))) continue; // finished before a restart
        const m = await runOne(armId, taskId, rep, seed, batchDir, timeoutS);
        const d = m.disturbance;
        console.log(`${armId.padEnd(16)} ${taskId.padEnd(16)} r${rep} ${m.passed ? "PASS" : "FAIL"} `
          + `wall=${m.wall_s.toFixed(1).padStart(6)}s start=${(m.first_tool_s ?? 0).toFixed(1).padStart(5)}s tools=${String(m.tool_calls).padStart(2)} `
          + `tool_t=${m.tool_time_s.toFixed(1).padStart(5)}s turns=${m.turns} cost=${m.cost_usd} `
          + `cursor_px=${d.cursor_max_displacement_px} fg_chg=${d.foreground_changes} `
          + `${m.timed_out ? "TIMEOUT " : ""}${m.error ?? ""}`);
      }
    }
  }
  console.log(`artifacts: ${batchDir}`);
}

if (import.meta.main) await main();
