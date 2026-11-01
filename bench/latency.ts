// Model-free latency of each CU stack's primitive operations on one TestPad window.
//
//   node bench/latency.ts        writes bench/out/latency-<time>.json and prints a table
//
// Calls each stack's MCP tools directly (no LLM), 5 times per operation, against a TestPad window
// this script opens and closes. Also records whether the user's cursor or foreground window
// changed while the stack worked.

import { writeFileSync } from "node:fs";
import path from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import { McpClient, textOf, type Args, type Structured, type ToolResult } from "./mcp-client.ts";
import { editAppendSetup } from "./tasks.ts";
import { closeNewWindows, listWindows, Sampler, timestamp, type Disturbance, type Win } from "./win.ts";

const ROOT = import.meta.dirname;
const N = 5;
const CUA_ENV = { DO_NOT_TRACK: "1", WSLENV: "DO_NOT_TRACK" };

type Timing = { median_ms: number; min_ms: number; error: string | null };
type Ops = Record<string, Timing>;

const round1 = (x: number) => Number(x.toFixed(1));

/** Run `fn` n times in a row; a failure is recorded and the timing goes on. */
async function timed(fn: () => Promise<unknown>, n = N): Promise<Timing> {
  const ms: number[] = [];
  let error: string | null = null;
  for (let i = 0; i < n; i++) {
    const t0 = performance.now();
    try {
      await fn();
    } catch (e) {
      error = String(e).slice(0, 200);
    }
    ms.push(performance.now() - t0);
  }
  const sorted = ms.toSorted((a, b) => a - b);
  const mid = sorted.length >> 1;
  const median = sorted.length % 2 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;
  return { median_ms: round1(median), min_ms: round1(sorted[0]), error };
}

function ok(result: ToolResult): ToolResult {
  if (result.isError) throw new Error(textOf(result).slice(0, 200));
  return result;
}

async function testpadWindow(): Promise<Win> {
  for (let i = 0; i < 20; i++) {
    const w = (await listWindows(true)).find((w) => w.proc === "TestPad" && w.title.includes("TestPad"));
    if (w) return w;
    await sleep(500);
  }
  throw new Error("TestPad window not found");
}

async function benchCua(exe: string, w: Win): Promise<Ops> {
  await using c = await McpClient.start([exe, "mcp"], { env: CUA_ENV });
  const call = async (name: string, args: Args) => ok((await c.call(name, args)).result);
  const window = { pid: w.pid, window_id: w.hwnd };
  const ops: Ops = {};
  ops.list_windows = await timed(() => call("list_windows", { on_screen_only: true }));
  ops.tree = await timed(() => call("get_window_state", { ...window, include_screenshot: false }));
  ops["tree+screenshot"] = await timed(() => call("get_window_state", { ...window, include_screenshot: true, max_image_dimension: 1200 }));
  const state = await call("get_window_state", { ...window, include_screenshot: false, query: "Text editor" });
  const text = textOf(state);
  const data: Structured = text.startsWith("{") ? JSON.parse(text) : state.structuredContent ?? {};
  const row = (data.tree_markdown ?? "").split("\n").find((l) => l.includes("[") && l.includes("Text editor"))?.match(/\[(\d+)\]/)?.[1];
  const token = `${data.snapshot_id}:${row}`;
  ops.set_value = await timed(() => call("set_value", { element_token: token, pid: w.pid, value: "hello" }));
  ops["type_text(5 chars)"] = await timed(() => call("type_text", { element_token: token, text: "abcde" }));
  ops["hotkey ctrl+a"] = await timed(() => call("hotkey", { ...window, keys: ["ctrl", "a"] }));
  return ops;
}

async function benchCodex(w: Win): Promise<Ops> {
  await using c = await McpClient.start(["node", path.join(ROOT, "codex-cu-bridge.ts")], { env: { CODEX_CU_AUTO_APPROVE: "1" } });
  const js = async (code: string) => ok((await c.call("js", { code }, 180_000)).result);
  const ops: Ops = {};
  ops.list_windows = await timed(() => js("await cua.listWindows({emit:false});"));
  await js(`globalThis.app = await cua.getApp({windowId:${w.hwnd}});`);
  ops.tree = await timed(() => js("await app.getAXState();"));
  ops["tree+screenshot"] = await timed(() => js("await app.getAXStateAndScreenshot();"));
  ops["type_text(5 chars)"] = await timed(() => js('await app.typeText("abcde");'));
  ops["hotkey ctrl+a"] = await timed(() => js('await app.pressKey("ctrl+a");'));
  return ops;
}

const stacks: Record<string, (w: Win) => Promise<Ops>> = {
  "driver": (w) => benchCua(path.join(ROOT, "..", "plugin/driver/cua-driver.exe"), w),
  "codex runtime": benchCodex,
};

const results: Record<string, { ops: Ops; disturbance: Disturbance }> = {};
for (const [name, bench] of Object.entries(stacks)) {
  const before = await listWindows();
  await editAppendSetup(); // opens TestPad on a scratch file
  const w = await testpadWindow();
  const sampler = await Sampler.start();
  const ops = await bench(w).finally(() => sampler.stop());
  results[name] = { ops, disturbance: sampler.summary() };
  await closeNewWindows(before);
  await sleep(1000);
}

const out = path.join(ROOT, "out", `latency-${timestamp()}.json`);
writeFileSync(out, JSON.stringify(results, null, 2));
const names = Object.keys(results);
const ops = [...new Set(Object.values(results).flatMap((r) => Object.keys(r.ops)))].toSorted();
console.log("operation".padEnd(22) + names.map((n) => n.padStart(20)).join(""));
for (const op of ops) {
  const cells = names.map((n) => {
    const o = results[n].ops[op];
    return o ? `${o.median_ms.toFixed(1).padStart(12)} ms${o.error ? " ERR" : "    "}` : "n/a".padStart(16);
  });
  console.log(op.padEnd(22) + cells.map((c) => c.padStart(20)).join(""));
}
for (const [n, r] of Object.entries(results)) console.log(n, "disturbance:", JSON.stringify(r.disturbance));
console.log("written:", out);
