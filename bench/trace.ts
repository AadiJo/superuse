// Print a compact trace of one run folder from its transcript.
//
//   node bench/trace.ts bench/out/v4/claude-bcu3/calc_mul-r1 [width]           every call, result and text, with times (width 300)
//   node bench/trace.ts bench/out/v4/claude-bcu3/calc_mul-r1 --calls [width]   each tool call's duration, code and result (width 200)

import { readFileSync } from "node:fs";
import path from "node:path";
import { parseArgs } from "node:util";
import type { ClaudeEvent, Metrics, ToolResultBlock } from "./run.ts";

/** transcript.jsonl as [receive time, event] pairs. Lines that aren't JSON are skipped. */
function readEvents(dir: string): Array<[ts: number, ev: ClaudeEvent]> {
  return readFileSync(path.join(dir, "transcript.jsonl"), "utf8").split("\n").flatMap((line): Array<[number, ClaudeEvent]> => {
    const tab = line.indexOf("\t");
    if (tab < 0) return [];
    try {
      return [[Number(line.slice(0, tab)), JSON.parse(line.slice(tab + 1))]];
    } catch {
      return [];
    }
  });
}

/** The text blocks of a tool result; a plain string result counts as one. */
function texts(content: ToolResultBlock["content"]): string[] {
  if (typeof content === "string") return [content];
  return (content ?? []).flatMap((b) => (b.type === "text" ? [b.text] : []));
}

/** Tool results among a user event's blocks. */
const toolResults = (ev: Extract<ClaudeEvent, { type: "user" }>) =>
  typeof ev.message.content === "string" ? [] : ev.message.content.filter((b) => b.type === "tool_result");

function trace(dir: string, width: number) {
  const m: Metrics = JSON.parse(readFileSync(path.join(dir, "metrics.json"), "utf8"));
  const keys = ["passed", "wall_s", "first_tool_s", "tool_calls", "turns", "images_seen", "tool_time_s", "model_time_s",
    "input_tokens", "cache_read_tokens", "output_tokens", "cost_usd", "disturbance"] satisfies Array<keyof Metrics>;
  console.log(JSON.stringify(Object.fromEntries(keys.map((k) => [k, m[k]]))));
  const events = readEvents(dir);
  const t0 = events[0]?.[0] ?? 0;
  for (const [ts, ev] of events) {
    const rel = (ts - t0).toFixed(1).padStart(6);
    if (ev.type === "assistant") {
      for (const b of ev.message.content) {
        if (b.type === "tool_use") console.log(rel, "CALL", b.name.replace("mcp__cu__", ""), JSON.stringify(b.input).slice(0, width));
        else if (b.type === "text") console.log(rel, "TEXT", b.text.slice(0, 150).replaceAll("\n", " "));
      }
    } else if (ev.type === "user") {
      for (const b of toolResults(ev)) {
        const txt = texts(b.content).join(" | ");
        const imgs = Array.isArray(b.content) ? b.content.filter((p) => p.type === "image").length : 0;
        console.log(rel, "RSLT", `[${txt.length} chars, ${imgs} img]`, txt.slice(0, width).replaceAll("\n", " "));
      }
    } else if (ev.type === "system" && ev.subtype === "init") {
      console.log(rel, "INIT", "tools:", ev.tools?.length ?? 0);
    }
  }
}

function calls(dir: string, width: number) {
  const events = readEvents(dir);
  const t0 = events[0]?.[0] ?? 0;
  const started = new Map<string, { ts: number; code: string }>();
  for (const [ts, ev] of events) {
    if (ev.type === "assistant") {
      for (const b of ev.message.content) {
        if (b.type === "tool_use") started.set(b.id, { ts, code: JSON.stringify(b.input.code ?? b.input) });
      }
    } else if (ev.type === "user") {
      for (const b of toolResults(ev)) {
        const call = started.get(b.tool_use_id);
        if (!call) continue;
        started.delete(b.tool_use_id);
        console.log(`${(call.ts - t0).toFixed(1).padStart(6)}s +${(ts - call.ts).toFixed(1).padStart(5)}s ${call.code.slice(0, width)}`);
        console.log(`${" ".repeat(15)}-> ${JSON.stringify(texts(b.content).join(" ").slice(0, width))}`);
      }
    }
  }
}

const { values, positionals } = parseArgs({ allowPositionals: true, options: { calls: { type: "boolean", default: false } } });
const [dir, width] = positionals;
if (!dir) {
  console.error("usage: node bench/trace.ts <run dir> [--calls] [width]");
  process.exit(2);
}
if (values.calls) calls(dir, Number(width ?? 200));
else trace(dir, Number(width ?? 300));
