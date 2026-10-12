// Time one benchmark task in the Codex desktop app, by hand. Called by bench/codex_app_wizard.sh.
//
//   node bench/codex-app.ts run <task> <rep> <label>
//
// Sets the task up exactly as run.ts does, copies the same prompt to the Windows clipboard, then
// times from the Enter you press as you send it to the Enter you press when Codex finishes. The
// cursor/foreground sampler runs in between. The task's own checker decides pass or fail, and the
// result lands in bench/out/codex-app/<label>/<task>-r<rep>/metrics.json, the same shape run.ts
// writes, so `node bench/report.ts codex-app` puts it beside the other arms.

import { randomInt } from "node:crypto";
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import { createInterface } from "node:readline/promises";
import { setTimeout as sleep } from "node:timers/promises";
import { newMetrics, OUT, PREAMBLE } from "./run.ts";
import { isTaskId, rngFor, TASK_IDS, TASKS, type Task, type TaskId } from "./tasks.ts";
import { closeNewWindows, closeStrays, listWindows, ps, Sampler } from "./win.ts";

const rl = createInterface({ input: process.stdin, output: process.stdout });
const askYes = async (question: string) => (await rl.question(`  ? ${question} [y/N] `)).trim().toLowerCase().startsWith("y");

async function copyToClipboard(text: string): Promise<void> {
  const b64 = Buffer.from(text, "utf8").toString("base64");
  await ps(`Set-Clipboard -Value ([Text.Encoding]::UTF8.GetString([Convert]::FromBase64String('${b64}')))`);
}

async function runTask(taskId: TaskId, rep: number, label: string): Promise<void> {
  const task: Task = TASKS[taskId];
  const runDir = path.join(OUT, "codex-app", label, `${taskId}-r${rep}`);
  if (existsSync(path.join(runDir, "metrics.json")) && !(await askYes(`${taskId} r${rep} already recorded for ${label}. Redo it?`))) return;
  mkdirSync(runDir, { recursive: true });
  await closeStrays();
  const before = await listWindows();
  console.log("  • setting up the task...");
  const seed = randomInt(1_000_000);
  const check = await task.setup(rngFor(seed, taskId, rep));
  await copyToClipboard(PREAMBLE + task.prompt);
  const sampler = await Sampler.start(); // before you send, so the run's first moments are sampled and timed
  console.log("  • the prompt is on your clipboard. Paste it into a new Codex thread.");
  await rl.question("  Press Enter at the moment you send it... ");
  const t0 = Date.now() / 1000;
  await rl.question("  Press Enter when Codex has finished (its final message is shown)... ");
  const wall = Number((Date.now() / 1000 - t0).toFixed(1));
  sampler.stop();
  const disturbance = sampler.summary(t0);
  await sleep(1000);
  const { passed, detail } = await check("");
  const manual = {
    approval_prompt_shown: await askYes("Did Codex show an app approval prompt during this run?"),
    gave_up_or_asked_for_help: await askYes("Did Codex stop to ask you something or give up?"),
  };
  await task.teardown?.();
  const closed = await closeNewWindows(before);
  const m = { ...newMetrics(label, taskId, rep, seed), passed, check_detail: detail, wall_s: wall, model_id: label, disturbance };
  writeFileSync(path.join(runDir, "metrics.json"), JSON.stringify(m, null, 2));
  writeFileSync(path.join(runDir, "manual.json"), JSON.stringify(manual, null, 2));
  writeFileSync(path.join(runDir, "windows-closed.txt"), closed.join("\n"));
  console.log(`  ${passed ? "PASS" : "FAIL"}  ${wall}s  cursor moved ${disturbance.cursor_max_displacement_px} px, `
    + `focus changed ${disturbance.foreground_changes}x  (${detail.slice(0, 80)})`);
}

const [command, taskId, rep, label] = process.argv.slice(2);
if (command !== "run" || !taskId || !isTaskId(taskId) || !/^\d+$/.test(rep ?? "") || !label) {
  console.error(`usage: node bench/codex-app.ts run <task> <rep> <label>   tasks: ${TASK_IDS.join(", ")}`);
  process.exit(2);
}
try {
  await runTask(taskId, Number(rep), label);
} finally {
  rl.close();
}
