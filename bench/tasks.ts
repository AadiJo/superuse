// The Windows desktop task suite, used by run.ts, codex-app.ts, latency.ts and fork/acceptance.ts.
//
// Each task prepares its own files under %TEMP%\bcu\<task id>, optionally opens the app, and
// returns a checker that reads real Windows state (file contents, Calculator's display through
// UIA, Edge's window title), never trusting the agent's claim. The runner closes the apps the
// agent touched afterwards (win.ts).

import { copyFileSync, existsSync, mkdirSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import path from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import { killBenchEdge, listWindows, ps, WIN_TEMP, WSL_TEMP } from "./win.ts";

const EDGE = String.raw`C:\Program Files (x86)\Microsoft\Edge\Application\msedge.exe`;
const COMPUTER_NAME = "HOME-PC";

export type Check = { passed: boolean; detail: string };
/** Decides a run from real Windows state. Receives the agent's final line. */
export type Checker = (final: string) => Promise<Check>;

export type Task = {
  prompt: string;
  /** Prepare files and apps, and return this run's checker. Expected answers live in the
   * checker's closure, in this process's memory: the agent can save files into the task folder,
   * so an answer file there could be overwritten. */
  setup: (rng: Rng) => Promise<Checker>;
  teardown?: () => Promise<void>;
};

/** Seeded random draws for one run. */
export type Rng = {
  /** An integer in [lo, hi], both inclusive. */
  int(lo: number, hi: number): number;
  pick<T>(xs: readonly T[]): T;
  /** `k` distinct elements, in draw order. */
  sample<T>(xs: readonly T[], k: number): T[];
};

/** A small seeded PRNG (mulberry32) keyed on (seed, task, rep), so a rerun with the same seed
 * draws the same invoice lines, files and contact for every run. */
export function rngFor(seed: number, taskId: string, rep: number): Rng {
  let state = 2166136261; // FNV-1a over the key
  for (const ch of `${seed}:${taskId}:${rep}`) state = Math.imul(state ^ ch.charCodeAt(0), 16777619);
  const next = () => {
    state = (state + 0x6d2b79f5) | 0;
    let t = Math.imul(state ^ (state >>> 15), 1 | state);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 2 ** 32;
  };
  const below = (n: number) => Math.floor(next() * n);
  return {
    int: (lo, hi) => lo + below(hi - lo + 1),
    pick: (xs) => xs[below(xs.length)],
    sample(xs, k) {
      const pool = [...xs];
      for (let i = 0; i < k; i++) {
        const j = i + below(pool.length - i);
        [pool[i], pool[j]] = [pool[j], pool[i]];
      }
      return pool.slice(0, k);
    },
  };
}

/** Recreate the task's scratch folder and return its Windows and WSL paths. */
function taskDir(taskId: string): { win: string; wsl: string } {
  const wsl = path.join(WSL_TEMP, taskId);
  rmSync(wsl, { recursive: true, force: true });
  mkdirSync(wsl, { recursive: true });
  return { win: `${WIN_TEMP}\\${taskId}`, wsl };
}

/** Start a Windows program without waiting for it. Start-Process joins the arguments with spaces. */
export async function start(exe: string, ...args: string[]): Promise<void> {
  const argList = args.map((a) => `'${a.replaceAll("'", "''")}'`).join(",");
  await ps(`Start-Process -FilePath '${exe}'` + (args.length ? ` -ArgumentList ${argList}` : ""));
}

/** Lines of a text file the agent saved (UTF-8 or UTF-16 with a BOM, CRLF or LF); [] if missing or blank. */
export function readLines(file: string): string[] {
  if (!existsSync(file)) return [];
  const raw = readFileSync(file);
  const encoding = raw[0] === 0xff && raw[1] === 0xfe ? "utf-16le" : raw[0] === 0xfe && raw[1] === 0xff ? "utf-16be" : "utf-8";
  const text = new TextDecoder(encoding).decode(raw); // drops the BOM
  return text.trim() ? text.replaceAll("\r\n", "\n").replace(/\n+$/, "").split("\n") : [];
}

export const equalLists = (a: readonly string[], b: readonly string[]) => a.length === b.length && a.every((x, i) => x === b[i]);

const show = (value: unknown) => JSON.stringify(value);

// --- calc_mul: launch Calculator, compute, read display ----------------------

/** Every Calculator window's display text, read through UIA. */
export async function calcDisplay(): Promise<string[]> {
  const out = await ps(String.raw`
Add-Type -AssemblyName UIAutomationClient,UIAutomationTypes
$A=[System.Windows.Automation.AutomationElement]; $S=[System.Windows.Automation.TreeScope]
$ws=$A::RootElement.FindAll($S::Children,(New-Object System.Windows.Automation.PropertyCondition($A::NameProperty,"Calculator")))
foreach($w in $ws){ $r=$w.FindFirst($S::Descendants,(New-Object System.Windows.Automation.PropertyCondition($A::AutomationIdProperty,"CalculatorResults"))); if($r){$r.Current.Name} }
`);
  return out.split("\n").filter((l) => l.trim());
}

async function checkCalc(): Promise<Check> {
  const shown = await calcDisplay();
  return { passed: shown.some((s) => s.includes("7,006,652") || s.includes("7006652")), detail: `display=${show(shown)}` };
}

// --- TestPad tasks -------------------------------------------------------------
// Windows Notepad restores the user's own session tabs (some hold secrets), so the editor tasks
// use TestPad (apps/TestPad.cs, built into its own exe): a WinForms editor with a menu, the real
// Save As dialog and a Replace dialog.

const TESTPAD_SRC = path.join(import.meta.dirname, "apps", "TestPad.cs");
const TESTPAD_EXE = `${WIN_TEMP}\\TestPad.exe`;

/** Compile apps/TestPad.cs into %TEMP%\bcu\TestPad.exe with the C# compiler built into Windows
 * PowerShell. It must be its own exe: Codex's computer use hides terminal hosts such as
 * powershell.exe, so a script-hosted window would be invisible to that stack. */
async function buildTestpad(): Promise<void> {
  const exe = path.join(WSL_TEMP, "TestPad.exe");
  if (existsSync(exe) && statSync(exe).mtimeMs >= statSync(TESTPAD_SRC).mtimeMs) return;
  mkdirSync(WSL_TEMP, { recursive: true });
  copyFileSync(TESTPAD_SRC, path.join(WSL_TEMP, "TestPad.cs"));
  const out = await ps(`$src = Get-Content -Raw '${WIN_TEMP}\\TestPad.cs'
Remove-Item '${TESTPAD_EXE}' -ErrorAction SilentlyContinue
Add-Type -TypeDefinition $src -OutputAssembly '${TESTPAD_EXE}' -OutputType WindowsApplication -ReferencedAssemblies System.Windows.Forms,System.Drawing`, 120_000);
  if (!existsSync(exe)) throw new Error(`TestPad build failed: ${out.slice(-800)}`);
}

async function openTestpad(fileWinPath?: string): Promise<void> {
  await buildTestpad();
  await start(TESTPAD_EXE, ...(fileWinPath ? [fileWinPath] : []));
  await sleep(2000);
}

export async function editAppendSetup(): Promise<Checker> {
  const dir = taskDir("edit_append");
  writeFileSync(path.join(dir.wsl, "notes.txt"), "first line\r\nsecond line\r\nthird line\r\n");
  await openTestpad(`${dir.win}\\notes.txt`);
  return async () => {
    const lines = readLines(path.join(dir.wsl, "notes.txt"));
    const passed = equalLists(lines.slice(0, 3), ["first line", "second line", "third line"]) && lines.length === 4 && lines[3].trim() === "DONE 42";
    return { passed, detail: `lines=${show(lines)}` };
  };
}

export async function editSaveasSetup(): Promise<Checker> {
  const dir = taskDir("edit_saveas");
  await openTestpad();
  return async () => {
    const lines = readLines(path.join(dir.wsl, "saved.txt")).map((l) => l.trim());
    return { passed: equalLists(lines, ["alpha", "beta"]), detail: `lines=${show(lines)}` };
  };
}

export async function editReplaceSetup(): Promise<Checker> {
  const dir = taskDir("edit_replace");
  writeFileSync(path.join(dir.wsl, "words.txt"), "foo one\r\nbar two foo\r\nthree foo foo\r\nfour\r\n");
  await openTestpad(`${dir.win}\\words.txt`);
  return async () => {
    const lines = readLines(path.join(dir.wsl, "words.txt"));
    return { passed: equalLists(lines, ["bar one", "bar two bar", "three bar bar", "four"]), detail: `lines=${show(lines)}` };
  };
}

// --- explorer_move ----------------------------------------------------------------

export async function explorerMoveSetup(): Promise<Checker> {
  const dir = taskDir("explorer_move");
  // Unknown extension on purpose: a stray double-click must not open Notepad, which would restore
  // the user's own session tabs.
  writeFileSync(path.join(dir.wsl, "a.bcu"), "a");
  writeFileSync(path.join(dir.wsl, "b.bcu"), "b");
  await start("explorer.exe", dir.win);
  await sleep(2000);
  return async () => {
    const at = (...parts: string[]) => existsSync(path.join(dir.wsl, ...parts));
    const contents = readdirSync(dir.wsl, { recursive: true, encoding: "utf8" }).toSorted();
    return { passed: at("archive", "a.bcu") && !at("a.bcu") && at("b.bcu"), detail: `contents=${show(contents)}` };
  };
}

// --- edge_form: Chromium page in an isolated Edge profile --------------------------

export const FORM_HTML = `<!doctype html><html><head><meta charset="utf-8"><title>Signup form</title>
<style>body{font:16px system-ui;margin:40px} label{display:block;margin:14px 0}</style></head><body>
<h1>Signup</h1>
<form id="f">
<label>Name <input id="name" name="name"></label>
<label>Email <input id="email" name="email" type="email"></label>
<label>Plan <select id="plan" name="plan"><option value="">Choose...</option><option value="free">Free</option>
<option value="pro">Pro</option><option value="team">Team</option></select></label>
<label><input id="agree" type="checkbox"> I agree to the terms</label>
<button type="submit">Submit</button>
</form><p id="out"></p>
<script>
document.getElementById('f').addEventListener('submit', e => {
  e.preventDefault();
  const v = id => document.getElementById(id);
  const s = \`name=\${v('name').value}|email=\${v('email').value}|plan=\${v('plan').value}|agree=\${v('agree').checked?'yes':'no'}\`;
  document.title = 'SUBMITTED ' + s; v('out').textContent = 'Submitted: ' + s;
});
</script></body></html>`;

/** Edge in a throwaway profile under %TEMP%\bcu. Chromium hides a page's accessibility tree while
 * its window is covered by another one (occlusion tracking), so without these flags a task
 * depended on what the user had on top. Teardown kills this Edge, so the profile is marked as
 * cleanly exited first; otherwise Edge opens a "Restore pages" bubble as an extra window.
 * `forceAccessibility: false` leaves the page's tree unbuilt until a UIA client connects, as in a
 * user's own browser or Electron app. */
async function openEdge(url: string, { forceAccessibility = true } = {}): Promise<void> {
  const prefs = path.join(WSL_TEMP, "edge-profile", "Default", "Preferences");
  if (existsSync(prefs)) {
    const data: { profile?: object } = JSON.parse(readFileSync(prefs, "utf8"));
    data.profile = { ...data.profile, exit_type: "Normal", exited_cleanly: true };
    writeFileSync(prefs, JSON.stringify(data));
  }
  await start(EDGE, `--user-data-dir=${WIN_TEMP}\\edge-profile`, "--no-first-run", "--no-default-browser-check",
    "--hide-crash-restore-bubble",
    ...(forceAccessibility ? ["--force-renderer-accessibility"] : []),
    "--disable-features=CalculateNativeWinOcclusion,msEdgeWelcomePage,msImplicitSignin",
    "--new-window", url);
  await sleep(4000);
}

const fileUrl = (winPath: string) => "file:///" + winPath.replaceAll("\\", "/");

/** Write `html` as <task folder>/form.html and open it in the throwaway Edge. */
export async function openFormPage(taskId: string, html: string, opts?: { forceAccessibility?: boolean }): Promise<void> {
  const dir = taskDir(taskId);
  writeFileSync(path.join(dir.wsl, "form.html"), html);
  await openEdge(fileUrl(`${dir.win}\\form.html`), opts);
}

/** Pass when some bench Edge window's title shows the form was submitted with `want`. */
async function checkSubmitted(want: string): Promise<Check> {
  const titles = (await listWindows(true)).filter((w) => w.proc === "msedge" && w.title.includes("SUBMITTED")).map((w) => w.title);
  return { passed: titles.some((t) => t.includes(want)), detail: `want=${want} titles=${show(titles)}` };
}

export async function edgeFormSetup(): Promise<Checker> {
  await openFormPage("edge_form", FORM_HTML);
  return () => checkSubmitted("name=Ada Lovelace|email=ada@example.com|plan=pro|agree=yes");
}

// --- Cross-app tasks: values are drawn per run, so a stale answer can't pass ------------

async function xappInvoiceSetup(rng: Rng): Promise<Checker> {
  const dir = taskDir("xapp_invoice");
  const items = ["Cables", "Adapters", "Mounts", "Labels"].map((name) => ({ name, qty: rng.int(2, 9), price: rng.int(11, 99) }));
  const rows = items.map((i) => `<tr><td>${i.name}</td><td>${i.qty}</td><td>${i.price}</td></tr>`).join("");
  writeFileSync(path.join(dir.wsl, "invoice.html"), `<!doctype html><html><head><meta charset="utf-8"><title>Invoice 4471</title>
<style>body{font:16px system-ui;margin:40px} td,th{border:1px solid #999;padding:6px 14px}</style></head><body>
<h1>Invoice 4471</h1><table><tr><th>Item</th><th>Quantity</th><th>Unit price</th></tr>${rows}</table>
<p>Total: (to be calculated)</p></body></html>`);
  const total = items.reduce((sum, i) => sum + i.qty * i.price, 0);
  await openEdge(fileUrl(`${dir.win}\\invoice.html`));
  await openTestpad();
  return async () => {
    const lines = readLines(path.join(dir.wsl, "total.txt"));
    const got = lines.length ? lines[0].replaceAll(",", "").trim() : "";
    return { passed: got === String(total), detail: `want=${total} lines=${show(lines)}` };
  };
}

const CSV_FILES = ["budget_2026.csv", "contacts.csv", "q3_sales.csv", "zones.csv", "inventory.csv"];
const OTHER_FILES = ["budget_2026.bcu", "notes.log", "readme.bcu", "contacts_old.bcu"];

async function xappCsvListSetup(rng: Rng): Promise<Checker> {
  const dir = taskDir("xapp_csv_list");
  const picked = rng.sample(CSV_FILES, 3);
  for (const name of [...picked, ...OTHER_FILES]) writeFileSync(path.join(dir.wsl, name), "x");
  writeFileSync(path.join(dir.wsl, "report.txt"), "");
  const want = picked.toSorted();
  await start("explorer.exe", dir.win);
  await openTestpad(`${dir.win}\\report.txt`);
  return async () => {
    const lines = readLines(path.join(dir.wsl, "report.txt")).map((l) => l.trim()).filter(Boolean);
    return { passed: equalLists(lines, want), detail: `want=${show(want)} lines=${show(lines)}` };
  };
}

const PEOPLE = [
  ["Grace Hopper", "grace@example.com"],
  ["Alan Turing", "alan@example.com"],
  ["Katherine Johnson", "katherine@example.com"],
  ["Edsger Dijkstra", "edsger@example.com"],
] as const;

async function xappFormFromFileSetup(rng: Rng): Promise<Checker> {
  const dir = taskDir("xapp_form_from_file");
  const [name, email] = rng.pick(PEOPLE);
  const plan = rng.pick(["Free", "Pro", "Team"]);
  writeFileSync(path.join(dir.wsl, "contact.txt"), `Contact card\r\nName: ${name}\r\nEmail: ${email}\r\nPlan: ${plan}\r\n`);
  writeFileSync(path.join(dir.wsl, "form.html"), FORM_HTML);
  await openTestpad(`${dir.win}\\contact.txt`);
  await openEdge(fileUrl(`${dir.win}\\form.html`));
  return () => checkSubmitted(`name=${name}|email=${email}|plan=${plan.toLowerCase()}|agree=yes`);
}

/** The last "FINAL: ..." answer in the agent's reply, else its last line. */
export function finalLine(text: string): string {
  const answers = [...text.matchAll(/FINAL:\s*(.*)/g)];
  if (answers.length) return answers[answers.length - 1][1];
  const lines = text.trim().split(/\r\n|\r|\n/);
  return text.trim() ? lines[lines.length - 1] : "";
}

const p = (sub: string) => `${WIN_TEMP}\\${sub}`;

export const TASKS = {
  calc_mul: {
    prompt: "Open the Windows Calculator app and use it to compute 1234 × 5678. Report the result shown on Calculator's display.",
    setup: async () => checkCalc,
  },
  edit_append: {
    prompt: `The TestPad text editor is open with the file ${p("edit_append")}\\notes.txt. Add a new last line that says exactly DONE 42, then save the file (keep it in place).`,
    setup: editAppendSetup,
  },
  edit_saveas: {
    prompt: `A new, empty TestPad text editor window is open. Type a document with exactly two lines, alpha and beta, then use File > Save As to save it as ${p("edit_saveas")}\\saved.txt.`,
    setup: editSaveasSetup,
  },
  edit_replace: {
    prompt: `The TestPad text editor is open with the file ${p("edit_replace")}\\words.txt. Use TestPad's Edit > Replace feature to replace every occurrence of foo with bar, then save the file.`,
    setup: editReplaceSetup,
  },
  explorer_move: {
    prompt: `A File Explorer window is open at ${p("explorer_move")}. Using File Explorer, create a new folder named archive in that folder and move a.bcu into archive.`,
    setup: explorerMoveSetup,
  },
  sysdm_name: {
    prompt: "Open the classic System Properties dialog (sysdm.cpl) and report the full computer name it shows on the Computer Name tab. Close the dialog when done.",
    setup: async () => async (final) => ({ passed: final.toLowerCase().includes(COMPUTER_NAME.toLowerCase()), detail: `final=${show(final.slice(-200))}` }),
  },
  edge_form: {
    prompt: "A Microsoft Edge window shows a Signup form. Fill it in: Name = Ada Lovelace, Email = ada@example.com, Plan = Pro, tick 'I agree to the terms', then click Submit.",
    setup: edgeFormSetup,
    teardown: killBenchEdge,
  },
  xapp_invoice: {
    prompt: `A Microsoft Edge window shows an invoice, and an empty TestPad text editor window is open. Use the Windows Calculator app to work out the invoice total (the sum of quantity × unit price over every line). Then type just the total, digits only, into TestPad and save it as ${p("xapp_invoice")}\\total.txt.`,
    setup: xappInvoiceSetup,
    teardown: killBenchEdge,
  },
  xapp_csv_list: {
    prompt: `A File Explorer window is open at ${p("xapp_csv_list")}, and TestPad is open with ${p("xapp_csv_list")}\\report.txt. Using File Explorer to look, write the full names of the .csv files in that folder (including the .csv extension) into report.txt, one per line in alphabetical order, then save the file.`,
    setup: xappCsvListSetup,
  },
  xapp_form_from_file: {
    prompt: "TestPad shows a contact card, and a Microsoft Edge window shows a Signup form. Fill in the form with the name, email and plan from the contact card, tick 'I agree to the terms', then click Submit.",
    setup: xappFormFromFileSetup,
    teardown: killBenchEdge,
  },
} satisfies Record<string, Task>;

export type TaskId = keyof typeof TASKS;
export const isTaskId = (id: string): id is TaskId => Object.hasOwn(TASKS, id);
export const TASK_IDS = Object.keys(TASKS).filter(isTaskId);
/** The default suite: every task except sysdm_name, whose elevated dialog teardown can't close. */
export const SUITE: TaskId[] = TASK_IDS.filter((id) => id !== "sysdm_name");
