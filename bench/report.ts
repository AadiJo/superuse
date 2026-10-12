// Aggregate a benchmark batch into a Markdown report.
//
//   node bench/report.ts v4                (a batch under bench/out)
//   node bench/report.ts path/to/batch     (or any batch directory)
//
// Writes report.md into the batch directory and prints it. All numbers come from each run's
// metrics.json. Medians are used for times and tokens because a single stuck run would otherwise
// dominate a small sample. Numbers print the way the Python report.py printed them, so reports of
// old and new batches compare line by line.

import { existsSync, readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import path from "node:path";
import type { Metrics } from "./run.ts";

const OUT = path.join(import.meta.dirname, "out");

type Run = Pick<Metrics, "arm" | "task" | "rep" | "passed" | "check_detail" | "wall_s" | "first_tool_s" | "model_time_s"
  | "tool_time_s" | "tool_calls" | "turns" | "input_tokens" | "output_tokens" | "cost_usd" | "error" | "timed_out" | "disturbance">;

/** Python's round(x, digits). toFixed also rounds the exact binary value, but it sends exact ties
 * up where Python sends them to even. A tie is exactly odd / 2^(digits+1), so test for that first. */
function pyRound(x: number, digits: number): number {
  const tie = Number.isInteger(x * 2 ** (digits + 1)) && !Number.isInteger(x * 2 ** digits);
  if (!tie) return Number(x.toFixed(digits));
  const down = Math.floor(x * 10 ** digits); // exact: x * 10^digits is a half-integer here
  return (down % 2 === 0 ? down : down + 1) / 10 ** digits;
}

/** A float as Python prints it: whole values keep their ".0". */
const pyFloat = (x: number) => (Number.isInteger(x) ? x.toFixed(1) : String(x));

/** Median to one decimal, "None" when there are no values. Python kept an int median as an int,
 * so for integer fields (`whole`) an odd count prints the middle value bare, and an even count,
 * which averages two values, prints as a float. */
function med(values: ReadonlyArray<number | null | undefined>, whole = false): string {
  const xs = values.filter((x) => x != null).toSorted((a, b) => a - b);
  if (!xs.length) return "None";
  const mid = xs.length >> 1;
  if (xs.length % 2) return whole ? String(xs[mid]) : pyFloat(pyRound(xs[mid], 1));
  return pyFloat(pyRound((xs[mid - 1] + xs[mid]) / 2, 1));
}

/** The first `n` characters, counting code points as Python's slicing did. */
const clip = (s: string, n: number) => [...s].slice(0, n).join("");

/** Every <arm>/<run>/metrics.json in the batch, sorted level by level, the order the Python version's glob gave. */
function load(dir: string): Run[] {
  const subdirs = (d: string) => readdirSync(d, { withFileTypes: true }).filter((e) => e.isDirectory()).map((e) => e.name).toSorted();
  return subdirs(dir)
    .flatMap((arm) => subdirs(path.join(dir, arm)).map((run) => path.join(dir, arm, run, "metrics.json")))
    .filter((file) => existsSync(file))
    .map((file) => JSON.parse(readFileSync(file, "utf8")));
}

function report(batch: string, runs: Run[]): string {
  const byArm = Map.groupBy(runs, (r) => r.arm);
  const arms = [...byArm.keys()].toSorted();
  const lines = [
    `# Benchmark batch \`${batch}\``, "", `${runs.length} runs. Times in seconds, medians across runs.`, "",
    "| Arm | Pass | Hit time cap | Wall | Startup | Model time | Tool time | Tool calls | Turns | Input tok (k) | Output tok | Cost $ | Cursor moved | Focus changed |",
    "| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |",
  ];
  for (const arm of arms) {
    const rs = byArm.get(arm) ?? [];
    const count = (pred: (r: Run) => boolean) => rs.filter(pred).length;
    const costs = rs.map((r) => r.cost_usd).filter((c) => c != null);
    const cells = [
      arm,
      `${count((r) => r.passed)}/${rs.length}`,
      count((r) => r.timed_out),
      med(rs.map((r) => r.wall_s)),
      med(rs.map((r) => r.first_tool_s)),
      med(rs.map((r) => r.model_time_s)),
      med(rs.map((r) => r.tool_time_s)),
      med(rs.map((r) => r.tool_calls), true),
      med(rs.map((r) => r.turns), true),
      med(rs.map((r) => (r.input_tokens ? r.input_tokens / 1000 : null))),
      med(rs.map((r) => r.output_tokens), true),
      costs.length ? pyFloat(pyRound(costs.reduce((a, b) => a + b, 0) / costs.length, 2)) : "n/a",
      `${count((r) => (r.disturbance.cursor_max_displacement_px ?? 0) > 0)}/${rs.length}`,
      `${count((r) => (r.disturbance.foreground_changes ?? 0) > 0)}/${rs.length}`,
    ];
    lines.push(`| ${cells.join(" | ")} |`);
  }

  const tasks = [...new Set(runs.map((r) => r.task))].toSorted();
  lines.push("", "## Per task: passes and median wall time", "", `| Task | ${arms.join(" | ")} |`, `| --- |${" --- |".repeat(arms.length)}`);
  for (const task of tasks) {
    const cells = arms.map((arm) => {
      const rs = (byArm.get(arm) ?? []).filter((r) => r.task === task);
      return rs.length ? `${rs.filter((r) => r.passed).length}/${rs.length}, ${med(rs.map((r) => r.wall_s))}s` : "";
    });
    lines.push(`| ${task} | ${cells.join(" | ")} |`);
  }

  const fails = runs.filter((r) => !r.passed);
  if (fails.length) {
    lines.push("", "## Failures", "", ...fails.map((r) => `- ${r.arm} / ${r.task} r${r.rep}: ${clip(r.check_detail, 160)}`
      + `${r.timed_out ? " (timeout)" : ""}${r.error ? ` error: ${clip(r.error, 120)}` : ""}`));
  }
  return lines.join("\n") + "\n";
}

const isDir = (p: string) => statSync(p, { throwIfNoEntry: false })?.isDirectory() ?? false;

const arg = process.argv[2];
if (!arg) {
  console.error("usage: node bench/report.ts <batch name under bench/out | batch directory>");
  process.exit(2);
}
const dir = isDir(path.join(OUT, arg)) ? path.join(OUT, arg) : isDir(arg) ? path.resolve(arg) : null;
if (!dir) {
  console.error(`no batch ${arg} under ${OUT}, and no such directory`);
  process.exit(2);
}
const text = report(path.basename(dir), load(dir));
writeFileSync(path.join(dir, "report.md"), text);
console.log(text);
