// Live acceptance checks for the forked Cua Driver on the Windows desktop.
//
//   node bench/acceptance.ts [saveas] [closedmenu] [replace] [edge] [edge_alert] [calc] [explorer]
//       [win32menu] [win32menu_bypos] [menubg] [ownership] [fgpoint] [cursorclip] [cursoroverlay] [helium]
//
// Drives the driver (BCU_CUA_DRIVER, default plugin/driver/cua-driver.exe) over MCP stdio against
// windows this script opens itself (TestPad, MenuPad from bench/apps, an Explorer window on
// %TEMP%\bcu\explorer_move, the throwaway-profile Edge form, Calculator), records every tool call
// with its time, samples the real cursor and foreground window, and writes
// bench/out/acceptance-runs/acceptance-<time>.json. Tool calls only target windows this script opened.
// Explorer windows share the shell's pid, so the explorer check matches titles in memory to find
// its own window and logs none of them.
//
// `cursoroverlay` drives the plugin server (plugin/server/run.sh, over the driver under test) as
// clients do, and maximizes one of its own windows for a few seconds.
//
// `helium` is the exception: it attaches to the user's running Helium with `--grant
// existing-profile`, but only acts in a background tab it opens itself and closes again. Bind
// results list the user's tabs, so that check logs no result text from them and reads tab URLs only
// to find its own test page.

import { once } from "node:events";
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { createServer, type Server } from "node:http";
import path from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import { McpClient, textOf, type Args, type Structured, type ToolResult } from "./mcp-client.ts";
import { calcDisplay, edgeFormSetup, editReplaceSetup, editSaveasSetup, equalLists, explorerMoveSetup, openFormPage, readLines, start } from "./tasks.ts";
import { closeNewWindows, killBenchEdge, killTestPad, listWindows, ps, Sampler, timestamp, WIN_TEMP, WSL_TEMP, type Disturbance, type Win } from "./win.ts";

const HERE = import.meta.dirname;
// The driver under test: BCU_CUA_DRIVER, else the one the plugin ships.
const EXE = process.env.BCU_CUA_DRIVER ?? path.join(HERE, "..", "plugin/driver/cua-driver.exe");
const OUT = path.join(HERE, "out", "acceptance-runs");
const STAMP = timestamp(); // names this run's JSON and the images checks save beside it
const ENV = { DO_NOT_TRACK: "1", WSLENV: "DO_NOT_TRACK" };
const ROW = /^\s*- \[(\d+)\] (\w+)(?: "([^"]*)")?(.*)$/s; // s: a multi-line value leaves a \r on the row, which . must match

/** An element row of a get_window_state tree, `- [N] Role "Name" rest`, with its ready-made token. */
type Row = { token: string; role: string; name: string; rest: string };
type Called = { result: ToolResult; ms: number; text: string };
type LogEntry = { tool: string; args: Args; ms: number; error: boolean; text: string; refusal?: string | null };
type Sampled = Disturbance & { foreground_sequence: number[] };

const round1 = (x: number) => Number(x.toFixed(1));

/** One MCP session plus a log of every call: tool, args, ms, error flag and text. The helium check
 * uses the client and log directly, to keep the user's tabs out of the log. */
class Run {
  readonly client: McpClient;
  readonly log: LogEntry[];

  constructor(client: McpClient, log: LogEntry[]) {
    this.client = client;
    this.log = log;
  }

  async call(tool: string, args: Args): Promise<Called> {
    const { result, ms } = await this.client.call(tool, args);
    const text = textOf(result);
    this.log.push({ tool, args, ms: round1(ms), error: !!result.isError, text: text.slice(0, tool === "get_window_state" ? 200 : 600) });
    console.log(`  ${tool.padEnd(18)} ${ms.toFixed(1).padStart(7)} ms ${result.isError ? "ERR " : ""}${JSON.stringify(text.slice(0, 260))}`);
    return { result, ms, text };
  }

  /** The window's element rows, without a screenshot. */
  async state(pid: number, hwnd: number): Promise<{ rows: Row[]; ms: number }> {
    const { result, ms } = await this.call("get_window_state", { pid, window_id: hwnd, include_screenshot: false });
    const sc = result.structuredContent ?? {};
    const snap = sc.snapshot_id ?? "";
    const rows = (sc.tree_markdown ?? "").split("\n").flatMap((line) => {
      const m = ROW.exec(line);
      return m ? [{ token: `${snap}:${m[1]}`, role: m[2], name: m[3] ?? "", rest: m[4] }] : [];
    });
    return { rows, ms };
  }
}

/** The structured error code of a tool result, wherever its envelope puts it. */
function codeOf(result: ToolResult): string | null {
  const sc = result.structuredContent ?? {};
  return sc.code || sc.refusal?.code || sc.error?.code || null;
}

/** What a check keeps of a call: time, error flag, structured error code and text. */
const outcome = ({ result, ms, text }: Called) => ({ ms: round1(ms), error: !!result.isError, code: codeOf(result), text: text.slice(0, 300) });

function find(rows: Row[], role: string, name: string): Row {
  const row = rows.find((r) => r.role === role && r.name === name);
  if (!row) throw new Error(`no ${role} ${JSON.stringify(name)} in ${JSON.stringify(rows.slice(0, 60).map((r) => [r.role, r.name]))}`);
  return row;
}

async function windowsOf(pids: Set<number>): Promise<Win[]> {
  return (await listWindows(true)).filter((w) => pids.has(w.pid));
}

async function waitWindow(pids: Set<number>, pred: (w: Win) => boolean, timeoutS = 10): Promise<Win> {
  const end = Date.now() + timeoutS * 1000;
  while (Date.now() < end) {
    const w = (await windowsOf(pids)).find(pred);
    if (w) return w;
    await sleep(300);
  }
  throw new Error("window not found");
}

async function waitFor(pred: () => boolean | Promise<boolean>, timeoutS = 3): Promise<boolean> {
  const end = Date.now() + timeoutS * 1000;
  while (Date.now() < end) {
    if (await pred()) return true;
    await sleep(100);
  }
  return false;
}

/** Run `fn` under the cursor/foreground sampler. The summary adds `foreground_sequence`: each
 * foreground window in turn, so a change can be traced to the window that took it. */
async function sampled<T>(fn: () => Promise<T>): Promise<[T, Sampled]> {
  const sampler = await Sampler.start();
  const out = await fn().finally(() => sampler.stop());
  const seq = sampler.samples.map((s) => s.fg);
  return [out, { ...sampler.summary(), foreground_sequence: seq.filter((fg, i) => i === 0 || fg !== seq[i - 1]) }];
}

/** No foreground change, or only among the app's own windows `own`. An app that launched into the
 * foreground hands it to its own dialog and back; that isn't the driver activating anything. */
function noForegroundSteal(s: Sampled, own: number[]): boolean {
  return s.foreground_changes === 0 || s.foreground_sequence.every((fg) => own.includes(fg));
}

async function testpad(): Promise<Win> {
  const pids = new Set((await listWindows()).filter((w) => w.proc === "TestPad").map((w) => w.pid));
  return waitWindow(pids, (w) => w.title.endsWith("TestPad"));
}

// --- 1. Save As -------------------------------------------------------------------

async function checkSaveas(run: Run) {
  await editSaveasSetup();
  const tp = await testpad();
  const { pid } = tp;
  const target = `${WIN_TEMP}\\edit_saveas\\saved.txt`;
  const [res, sampler] = await sampled(async () => {
    const { rows } = await run.state(pid, tp.hwnd);
    await run.call("set_value", { pid, element_token: find(rows, "Edit", "Text editor").token, value: "alpha\r\nbeta" });
    const menu = await run.call("invoke_menu", { pid, window_id: tp.hwnd, path: ["File", "Save As..."] });
    const dlg = await waitWindow(new Set([pid]), (w) => w.title === "Save As", 5);
    const dialog = await run.state(pid, dlg.hwnd);
    await run.call("set_value", { pid, element_token: find(dialog.rows, "Edit", "File name:").token, value: target });
    const save = await run.call("click", { pid, element_token: find(dialog.rows, "Button", "Save").token });
    await sleep(500);
    return {
      invoke_menu_ms: menu.ms, invoke_menu_text: menu.text, own_windows: [tp.hwnd, dlg.hwnd], dialog_state_ms: dialog.ms,
      dialog_elements: dialog.rows.length, save_click_ms: save.ms, save_click_text: save.text,
    };
  });
  const lines = readLines(path.join(WSL_TEMP, "edit_saveas", "saved.txt"));
  const title = (await windowsOf(new Set([pid]))).find((w) => w.title.endsWith("TestPad"))?.title ?? "";
  return {
    ...res, sampler, file_lines: lines, title,
    passed: equalLists(lines, ["alpha", "beta"]) && title === "saved.txt - TestPad" && res.invoke_menu_ms < 500 && res.dialog_elements > 0,
  };
}

// --- 1b. Click a MenuItem token of a closed drop-down ------------------------------

async function checkClosedmenu(run: Run) {
  await editSaveasSetup();
  const tp = await testpad();
  const { pid } = tp;
  const [res, sampler] = await sampled(async () => {
    const { rows } = await run.state(pid, tp.hwnd);
    // File is closed: "Save As..." is in the tree but has no rectangle.
    const click = await run.call("click", { pid, element_token: find(rows, "MenuItem", "Save As...").token });
    const dlg = await waitWindow(new Set([pid]), (w) => w.title === "Save As", 5);
    const dialog = await run.state(pid, dlg.hwnd);
    await run.call("click", { pid, element_token: find(dialog.rows, "Button", "Cancel").token });
    await sleep(300);
    return {
      click_ms: click.ms, click_text: click.text, click_error: !!click.result.isError, own_windows: [tp.hwnd, dlg.hwnd],
      dialog_state_ms: dialog.ms, dialog_elements: dialog.rows.length,
    };
  });
  return {
    ...res, sampler,
    passed: !res.click_error && res.click_text.includes("closed drop-down") && res.click_ms < 1000 && res.dialog_elements > 0
      && noForegroundSteal(sampler, res.own_windows) && sampler.cursor_max_displacement_px === 0,
  };
}

// --- 2. Replace + Ctrl+S --------------------------------------------------------------

async function checkReplace(run: Run) {
  await editReplaceSetup();
  const tp = await testpad();
  const { pid } = tp;
  const [res, sampler] = await sampled(async () => {
    const menu = await run.call("invoke_menu", { pid, window_id: tp.hwnd, path: ["Edit", "Replace..."] });
    const dlg = await waitWindow(new Set([pid]), (w) => w.title === "Replace", 5);
    const dialog = await run.state(pid, dlg.hwnd);
    await run.call("set_value", { pid, element_token: find(dialog.rows, "Edit", "Find what").token, value: "foo" });
    await run.call("set_value", { pid, element_token: find(dialog.rows, "Edit", "Replace with").token, value: "bar" });
    const replaceAll = await run.call("click", { pid, element_token: find(dialog.rows, "Button", "Replace All").token });
    const { rows } = await run.state(pid, tp.hwnd);
    const editorRow = find(rows, "Edit", "Text editor").rest;
    const hotkey = await run.call("hotkey", { pid, window_id: tp.hwnd, keys: ["ctrl", "s"] });
    await sleep(500);
    return {
      invoke_menu_ms: menu.ms, invoke_menu_text: menu.text, dialog_state_ms: dialog.ms, dialog_elements: dialog.rows.length,
      replace_all_ms: replaceAll.ms, replace_all_text: replaceAll.text, editor_row: editorRow, hotkey_ms: hotkey.ms,
    };
  });
  const lines = readLines(path.join(WSL_TEMP, "edit_replace", "words.txt"));
  return {
    ...res, sampler, file_lines: lines,
    passed: equalLists(lines, ["bar one", "bar two bar", "three bar bar", "four"]) && !res.editor_row.includes("foo"),
  };
}

// --- 3. Edge form -----------------------------------------------------------------

/** PIDs of Edge processes running the throwaway bcu profile. */
async function edgePids(): Promise<Set<number>> {
  const out = await ps("Get-CimInstance Win32_Process -Filter \"Name='msedge.exe'\" | "
    + "Where-Object { $_.CommandLine -like '*bcu\\edge-profile*' } | ForEach-Object { $_.ProcessId }");
  return new Set(out.split(/\s+/).filter((x) => /^\d+$/.test(x)).map(Number));
}

async function checkEdge(run: Run) {
  await edgeFormSetup();
  const pids = await edgePids();
  const ew = await waitWindow(pids, (w) => w.cls === "Chrome_WidgetWin_1" && w.title.includes("Signup form"), 15);
  const { pid } = ew;
  const plan = (rows: Row[]) => find(rows, "ComboBox", "Plan").rest;
  try {
    const [res, sampler] = await sampled(async () => {
      const steps: Array<{ step: string; ms: number; error: boolean; text: string }> = [];
      const step = (name: string, c: Called) => steps.push({ step: name, ms: round1(c.ms), error: !!c.result.isError, text: c.text.slice(0, 300) });
      const state = async () => (await run.state(pid, ew.hwnd)).rows;
      const at = (rows: Row[], role: string, name: string, args: Args = {}) => ({ pid, element_token: find(rows, role, name).token, ...args });
      let rows = await state();
      step("name", await run.call("set_value", at(rows, "Edit", "Name", { value: "Ada Lovelace" })));
      step("email", await run.call("set_value", at(rows, "Edit", "Email", { value: "ada@example.com" })));
      // (a) set_value on the <select>
      step("plan set_value Team", await run.call("set_value", at(rows, "ComboBox", "Plan", { value: "Team" })));
      rows = await state();
      const afterSetValue = plan(rows);
      // (b) expand + option click with action select
      step("plan expand", await run.call("click", at(rows, "ComboBox", "Plan", { action: "expand" })));
      await sleep(300);
      rows = await state();
      step("option Free select", await run.call("click", at(rows, "ListItem", "Free", { action: "select" })));
      await sleep(300);
      rows = await state();
      const afterSelect = plan(rows);
      // (c) expand + plain option click (no action)
      step("plan expand", await run.call("click", at(rows, "ComboBox", "Plan", { action: "expand" })));
      await sleep(300);
      rows = await state();
      step("option Pro click", await run.call("click", at(rows, "ListItem", "Pro")));
      await sleep(300);
      rows = await state();
      const afterClick = plan(rows);
      // (d) set_value back to Pro by name, case-insensitively, after a change
      step("plan set_value team", await run.call("set_value", at(rows, "ComboBox", "Plan", { value: "team" })));
      step("plan set_value Pro", await run.call("set_value", at(rows, "ComboBox", "Plan", { value: "Pro" })));
      rows = await state();
      const final = plan(rows);
      step("agree", await run.call("click", at(rows, "CheckBox", "I agree to the terms")));
      await sleep(200);
      rows = await state();
      const agreeRow = find(rows, "CheckBox", "I agree to the terms").rest;
      step("submit", await run.call("click", at(rows, "Button", "Submit")));
      await sleep(1000);
      return { steps, plan_after_set_value: afterSetValue, plan_after_select: afterSelect, plan_after_click: afterClick, plan_final: final, agree_row: agreeRow };
    });
    const titles = (await windowsOf(pids)).filter((w) => w.cls === "Chrome_WidgetWin_1").map((w) => w.title);
    const want = "SUBMITTED name=Ada Lovelace|email=ada@example.com|plan=pro|agree=yes";
    return { ...res, sampler, titles, passed: titles.some((t) => t.startsWith(want)) };
  } finally {
    await killBenchEdge();
  }
}

// --- 3b. Does Chromium's UIA Invoke block on a page that calls alert()? -----------------

const ALERT_HTML = `<!doctype html><html><head><meta charset="utf-8"><title>Alert test</title></head><body>
<button onclick="alert('hello from page')">Show alert</button></body></html>`;

async function checkEdgeAlert(run: Run) {
  await openFormPage("edge_form", ALERT_HTML); // same throwaway-profile launch as the form task, different page
  const pids = await edgePids();
  const ew = await waitWindow(pids, (w) => w.cls === "Chrome_WidgetWin_1" && w.title.includes("Alert test"), 15);
  const { pid } = ew;
  try {
    const [res, sampler] = await sampled(async () => {
      const { rows } = await run.state(pid, ew.hwnd);
      const invoke = await run.call("click", { pid, element_token: find(rows, "Button", "Show alert").token });
      await sleep(500);
      const after = await run.state(pid, ew.hwnd);
      const alertRows = after.rows.filter((r) => r.name.includes("hello from page") || r.name === "OK" || r.name === "Cancel");
      return { invoke_ms: invoke.ms, invoke_text: invoke.text, state_after_ms: after.ms, alert_rows: alertRows.map((r) => [r.role, r.name]) };
    });
    return { ...res, sampler, passed: res.invoke_ms < 1500 && !res.invoke_text.includes("Dispatched") };
  } finally {
    await killBenchEdge();
  }
}

// --- 5. File Explorer: new folder, move a file, all in the background -------------------

async function checkExplorer(run: Run) {
  await explorerMoveSetup();
  const shell = new Set((await listWindows()).filter((w) => w.proc === "explorer").map((w) => w.pid));
  const { pid, hwnd } = await waitWindow(shell, (w) => w.cls === "CabinetWClass" && w.title.startsWith("explorer_move"), 10);
  const dir = path.join(WSL_TEMP, "explorer_move");
  const [res, sampler] = await sampled(async () => {
    const steps: Array<{ step: string; ms: number; error: boolean }> = [];
    const step = async (name: string, tool: string, args: Args) => {
      const c = await run.call(tool, args);
      steps.push({ step: name, ms: round1(c.ms), error: !!c.result.isError });
    };
    await run.state(pid, hwnd);
    await step("new folder", "hotkey", { pid, window_id: hwnd, keys: ["ctrl", "shift", "n"] });
    const newFolderCreated = await waitFor(() => existsSync(path.join(dir, "New folder")));
    await step("type name", "type_text", { pid, window_id: hwnd, text: "archive" });
    await step("enter", "press_key", { pid, window_id: hwnd, key: "return" });
    const renamed = await waitFor(() => statSync(path.join(dir, "archive"), { throwIfNoEntry: false })?.isDirectory() ?? false);
    let rows: Row[] = [];
    for (let i = 0; i < 10; i++) { // the view lists the renamed folder a moment after the disk does
      ({ rows } = await run.state(pid, hwnd));
      if (rows.some((r) => r.role === "ListItem" && r.name === "archive")) break;
      await sleep(200);
    }
    await step("select a.bcu", "click", { pid, element_token: find(rows, "ListItem", "a.bcu").token, action: "select" });
    await step("cut", "hotkey", { pid, window_id: hwnd, keys: ["ctrl", "x"] });
    await step("open archive", "click", { pid, element_token: find(rows, "ListItem", "archive").token });
    const navigated = await waitFor(async () => (await windowsOf(new Set([pid]))).some((w) => w.hwnd === hwnd && w.title.startsWith("archive")), 5);
    await step("paste", "hotkey", { pid, window_id: hwnd, keys: ["ctrl", "v"] });
    const moved = await waitFor(() => existsSync(path.join(dir, "archive", "a.bcu")) && !existsSync(path.join(dir, "a.bcu")));
    return { steps, new_folder_created: newFolderCreated, renamed, navigated, moved, tool_ms_total: round1(steps.reduce((t, s) => t + s.ms, 0)) };
  });
  const contents = readdirSync(dir, { recursive: true, encoding: "utf8" }).toSorted();
  return {
    ...res, sampler, contents,
    passed: equalLists(contents, ["archive", "archive/a.bcu", "b.bcu"]) && !res.steps.some((s) => s.error) && sampler.cursor_max_displacement_px === 0,
  };
}

// --- 6. Win32 menu bar (HMENU): commands posted without opening the menu -------------------

const MENUPAD_SRC = path.join(HERE, "apps", "MenuPad.cs");

/** Build bench/apps/MenuPad.cs into %TEMP%\bcu\MenuPad.exe (like TestPad) and start it with `flags`,
 * plus `--title` when given. Start-Process joins arguments with spaces, so none may contain one.
 * Returns the new window with that title. */
async function openMenupad(flags: string[] = [], title?: string): Promise<Win> {
  const exe = path.join(WSL_TEMP, "MenuPad.exe");
  if (!existsSync(exe) || statSync(exe).mtimeMs < statSync(MENUPAD_SRC).mtimeMs) {
    mkdirSync(WSL_TEMP, { recursive: true });
    copyFileSync(MENUPAD_SRC, path.join(WSL_TEMP, "MenuPad.cs"));
    await ps(`Remove-Item '${WIN_TEMP}\\MenuPad.exe' -ErrorAction SilentlyContinue
Add-Type -TypeDefinition (Get-Content -Raw '${WIN_TEMP}\\MenuPad.cs') -OutputAssembly '${WIN_TEMP}\\MenuPad.exe' -OutputType WindowsApplication -ReferencedAssemblies System.Windows.Forms,System.Drawing`, 120_000);
  }
  const want = title ?? "MenuPad";
  const before = new Set((await listWindows()).filter((w) => w.proc === "MenuPad").map((w) => w.hwnd));
  await start(`${WIN_TEMP}\\MenuPad.exe`, ...flags, ...(title ? ["--title", title] : []));
  const end = Date.now() + 10_000;
  while (Date.now() < end) {
    const found = (await listWindows(true)).find((w) => w.proc === "MenuPad" && w.title === want && !before.has(w.hwnd));
    if (found) return found;
    await sleep(300);
  }
  throw new Error(`MenuPad window ${JSON.stringify(want)} not found`);
}

async function stopMenupads(): Promise<void> {
  await ps("Stop-Process -Name MenuPad -Force -ErrorAction SilentlyContinue");
}

async function checkWin32menu(run: Run) {
  const mp = await openMenupad();
  const { pid } = mp;
  const [res, sampler] = await sampled(async () => {
    const stamp = await run.call("invoke_menu", { pid, window_id: mp.hwnd, path: ["Edit", "Stamp"] });
    await sleep(200);
    const { rows } = await run.state(pid, mp.hwnd);
    const editorRow = find(rows, "Edit", "Text editor").rest;
    const saveas = await run.call("invoke_menu", { pid, window_id: mp.hwnd, path: ["File", "Save As..."] });
    const dlg = await waitWindow(new Set([pid]), (w) => w.title === "Save As", 5);
    const dialog = await run.state(pid, dlg.hwnd);
    const cancel = await run.call("click", { pid, element_token: find(dialog.rows, "Button", "Cancel").token });
    await sleep(300);
    return {
      stamp_ms: stamp.ms, stamp_text: stamp.text, editor_row: editorRow, saveas_ms: saveas.ms, saveas_text: saveas.text,
      own_windows: [mp.hwnd, dlg.hwnd], dialog_state_ms: dialog.ms, dialog_elements: dialog.rows.length, cancel_ms: cancel.ms,
    };
  }).finally(stopMenupads);
  return {
    ...res, sampler,
    passed: res.stamp_text.includes("WM_COMMAND") && res.editor_row.includes("stamped") && res.saveas_text.includes("WM_COMMAND")
      && res.dialog_elements > 0 && noForegroundSteal(sampler, res.own_windows) && sampler.cursor_max_displacement_px === 0,
  };
}

// --- 6b. MNS_NOTIFYBYPOS menu bar: WM_MENUCOMMAND, not WM_COMMAND --------------------------

async function checkWin32menuBypos(run: Run) {
  const mp = await openMenupad(["--bypos"], "MenuPad-bypos");
  const [res, sampler] = await sampled(async () => {
    // Stamp is Edit's third item (Clear, separator, Stamp): position 2.
    const stamp = await run.call("invoke_menu", { pid: mp.pid, window_id: mp.hwnd, path: ["Edit", "Stamp"] });
    await sleep(200);
    const { rows } = await run.state(mp.pid, mp.hwnd);
    return { stamp_ms: stamp.ms, stamp_text: stamp.text, editor_row: find(rows, "Edit", "Text editor").rest };
  }).finally(stopMenupads);
  return {
    ...res, sampler,
    passed: res.stamp_text.includes("WM_MENUCOMMAND (position 2)") && res.editor_row.includes("via-WM_MENUCOMMAND stamped")
      && sampler.foreground_changes === 0 && sampler.cursor_max_displacement_px === 0,
  };
}

// --- 6c. invoke_menu delivery_mode: background never activates ---------------------------

async function checkMenubg(run: Run) {
  const mp = await openMenupad();
  const menu = async (path: string[], args: Args = {}) => outcome(await run.call("invoke_menu", { pid: mp.pid, window_id: mp.hwnd, path, ...args }));
  const phases = async () => {
    const background = await sampled(async () => {
      // Disabled in the static HMENU, and a typo: both need the menu opened, so the window active.
      const disabled = await menu(["File", "Disabled item"]);
      const typo = await menu(["Edit", "Stomp"]);
      const stamp = await menu(["Edit", "Stamp"]);
      await sleep(200);
      const { rows } = await run.state(mp.pid, mp.hwnd);
      return { disabled, typo, stamp, editor_row: find(rows, "Edit", "Text editor").rest };
    });
    const foreground = await sampled(async () => {
      const disabledFg = await menu(["File", "Disabled item"], { delivery_mode: "foreground" });
      await sleep(500);
      return { disabled_fg: disabledFg };
    });
    return { background, foreground };
  };
  const { background: [res, sampler], foreground: [fg, samplerForeground] } = await phases().finally(stopMenupads);
  return {
    ...res, ...fg, sampler, sampler_foreground: samplerForeground,
    passed: res.disabled.code === "background_unavailable"
      && res.typo.code === "background_unavailable" && res.typo.text.includes("Stomp")
      && !res.stamp.error && res.editor_row.includes("stamped")
      && sampler.foreground_changes === 0 && sampler.cursor_max_displacement_px === 0
      && fg.disabled_fg.error && fg.disabled_fg.code !== "background_unavailable"
      && samplerForeground.foreground_restored === true,
  };
}

// --- 7. Window ownership: a pid that doesn't own the window is refused ---------------------

async function checkOwnership(run: Run) {
  const mp = await openMenupad();
  const other = 4; // System: owns no window, so (4, MenuPad's hwnd) is a mismatched pair
  const call = async (tool: string, args: Args) => outcome(await run.call(tool, args));
  const [res, sampler] = await sampled(async () => {
    const mismatches = {
      press_key_mismatch: await call("press_key", { pid: other, window_id: mp.hwnd, key: "a" }),
      hotkey_mismatch: await call("hotkey", { pid: other, window_id: mp.hwnd, keys: ["ctrl", "a"] }),
      type_text_mismatch: await call("type_text", { pid: other, window_id: mp.hwnd, text: "x" }),
      click_fg_mismatch: await call("click", { pid: other, window_id: mp.hwnd, x: 60, y: 120, delivery_mode: "foreground" }),
    };
    const { rows } = await run.state(mp.pid, mp.hwnd);
    const editor = find(rows, "Edit", "Text editor");
    // The token's window closes: its HWND is dead, and the token must not reach anything.
    await stopMenupads();
    const end = Date.now() + 5000;
    while (Date.now() < end && (await listWindows()).some((w) => w.hwnd === mp.hwnd)) await sleep(200);
    return { ...mismatches, editor_row: editor.rest, token_closed_window: await call("press_key", { element_token: editor.token, key: "a" }) };
  }).finally(stopMenupads);
  const mismatched = [res.press_key_mismatch, res.hotkey_mismatch, res.type_text_mismatch, res.click_fg_mismatch];
  return {
    ...res, sampler,
    passed: mismatched.every((r) => r.code === "window_target_mismatch")
      && res.token_closed_window.code === "window_target_not_found"
      && !/value="[^"]/.test(res.editor_row) // nothing was typed
      && sampler.foreground_changes === 0 && sampler.cursor_max_displacement_px === 0,
  };
}

// --- 8. Foreground pixel input must land on the target ------------------------------------

/** DWM frame bounds of a window in screen pixels, from the driver's list_windows. */
async function boundsOf(run: Run, pid: number, hwnd: number): Promise<[x: number, y: number, width: number, height: number]> {
  const { result } = await run.call("list_windows", { pid });
  const w = result.structuredContent?.windows?.find((w) => w.window_id === hwnd);
  const b = w?.bounds ?? w;
  if (b?.x == null || b.y == null || b.width == null || b.height == null) throw new Error(`window ${hwnd} not in list_windows`);
  return [b.x, b.y, b.width, b.height];
}

const HIT_PS = String.raw`
Add-Type @"
using System; using System.Runtime.InteropServices;
public class BcuHit {
  [StructLayout(LayoutKind.Sequential)] public struct POINT { public int X, Y; }
  [DllImport("user32.dll")] public static extern IntPtr SetThreadDpiAwarenessContext(IntPtr c);
  [DllImport("user32.dll")] public static extern IntPtr WindowFromPoint(POINT p);
  [DllImport("user32.dll")] public static extern IntPtr GetAncestor(IntPtr h, uint f);
}
"@
[void][BcuHit]::SetThreadDpiAwarenessContext([IntPtr](-4))
$p = New-Object BcuHit+POINT; $p.X = %X%; $p.Y = %Y%
[BcuHit]::GetAncestor([BcuHit]::WindowFromPoint($p), 2).ToInt64()
`;

/** Top-level window at screen pixel (x, y), as a per-monitor DPI-aware caller sees it. */
async function topWindowAt([x, y]: readonly [number, number]): Promise<number> {
  const out = (await ps(HIT_PS.replaceAll("%X%", String(x)).replaceAll("%Y%", String(y)))).split(/\s+/).filter(Boolean);
  const last = out[out.length - 1] ?? "";
  return /^-?\d+$/.test(last) ? Number(last) : 0;
}

/** A: target. B: an always-on-top window over part of A, which activating A doesn't uncover. C: an
 * ordinary window over another part of A, which activating A does uncover. C opens last, so A is
 * not the foreground window and a refusal that activated A first would show up. */
async function checkFgpoint(run: Run) {
  const a = await openMenupad(["--at", "100", "100"], "MenuPad-A");
  try {
    const b = await openMenupad(["--topmost", "--at", "360", "220"], "MenuPad-B");
    const c = await openMenupad(["--at", "40", "330"], "MenuPad-C");
    const [ax, ay, aw, ah] = await boundsOf(run, a.pid, a.hwnd);
    const [bx, by, bw, bh] = await boundsOf(run, b.pid, b.hwnd);
    const [cx, cy, cw, ch] = await boundsOf(run, c.pid, c.hwnd);
    const mid = (lo: number, hi: number) => Math.floor((lo + hi) / 2);
    // Screenshot pixels map to screen as frame origin + 1 (bitmap_to_screen); the windows are small
    // enough that the screenshot isn't downscaled.
    const local = ([sx, sy]: readonly [number, number]) => [sx - ax - 1, sy - ay - 1] as const;
    const covered = local([mid(Math.max(ax, bx), Math.min(ax + aw, bx + bw)), mid(Math.max(ay, by), Math.min(ay + ah, by + bh))]);
    // In A and C, left of B.
    const clearScreen = [mid(Math.max(ax, cx), Math.min(bx, ax + aw, cx + cw)), mid(Math.max(ay, cy), Math.min(ay + ah, cy + ch))] as const;
    const clear = local(clearScreen);
    await run.call("get_window_state", { pid: a.pid, window_id: a.hwnd, include_screenshot: true });
    const points = { a_bounds: [ax, ay, aw, ah], b_bounds: [bx, by, bw, bh], c_bounds: [cx, cy, cw, ch], covered, clear, clear_screen: clearScreen };

    const call = async (tool: string, args: Args) => {
      const called = await run.call(tool, { pid: a.pid, window_id: a.hwnd, ...args });
      return { ...outcome(called), hit_pid: called.result.structuredContent?.hit_pid ?? null };
    };
    const [outside, sampler] = await sampled(async () => ({
      click_outside: await call("click", { x: -40, y: 120, delivery_mode: "foreground" }),
      drag_outside: await call("drag", { from_x: -40, from_y: 120, to_x: 60, to_y: 120, delivery_mode: "foreground" }),
      click_covered_bg: await call("click", { x: covered[0], y: covered[1] }),
    }));
    const [coveredFg, samplerCovered] = await sampled(async () => {
      const res = { click_covered_fg: await call("click", { x: covered[0], y: covered[1], delivery_mode: "foreground" }) };
      // After a foreground call the driver polls for 3 s and restores the prior foreground whenever the
      // target's app holds it, so a second foreground call on the same app inside that window can be undone.
      await sleep(3500);
      return res;
    });
    const [clearFg, samplerClear] = await sampled(async () => {
      const res = {
        clear_hit_before: await topWindowAt(clearScreen), a_hwnd: a.hwnd, c_hwnd: c.hwnd,
        click_clear_fg: await call("click", { x: clear[0], y: clear[1], delivery_mode: "foreground" }),
      };
      await sleep(600);
      return res;
    });
    return {
      ...outside, ...points, ...coveredFg, ...clearFg, sampler, sampler_covered: samplerCovered, sampler_clear: samplerClear,
      passed: outside.click_outside.code === "target_not_at_point"
        && outside.drag_outside.code === "target_not_at_point"
        && !outside.click_covered_bg.error
        && sampler.foreground_changes === 0 && sampler.cursor_max_displacement_px === 0
        && coveredFg.click_covered_fg.code === "target_not_at_point"
        && coveredFg.click_covered_fg.hit_pid === b.pid
        && samplerCovered.cursor_max_displacement_px === 0 && samplerCovered.foreground_changes === 0
        // another window covered the point until activation raised A, and the click wasn't refused
        && clearFg.clear_hit_before !== 0 && clearFg.clear_hit_before !== a.hwnd && !clearFg.click_clear_fg.error,
    };
  } finally {
    await stopMenupads();
  }
}

// --- 9. The agent cursor only shows on its target window -----------------------------------

// Counts agent-cursor pixels in screen rects, from one capture of `x,y,w,h` that it also saves as a
// PNG. The cursor's colour varies by session, so a cursor pixel is one that is strongly coloured
// and differs from the same pixel in the capture at `basePath`; window chrome is grey or keeps its
// colour. Per-monitor DPI aware, like the driver, so all coordinates are physical pixels.
const CURSOR_PS = String.raw`
Add-Type -ReferencedAssemblies System.Drawing @"
using System; using System.Drawing; using System.Drawing.Imaging; using System.Runtime.InteropServices;
public class BcuCursor {
  [DllImport("user32.dll")] public static extern IntPtr SetThreadDpiAwarenessContext(IntPtr c);
  [DllImport("user32.dll")] public static extern bool SetWindowPos(IntPtr h, IntPtr after, int x, int y, int w, int ht, uint f);
  public static string Count(int x, int y, int w, int h, string path, string basePath, int[] rects) {
    SetThreadDpiAwarenessContext(new IntPtr(-4));
    using (var bmp = new Bitmap(w, h, PixelFormat.Format32bppArgb)) {
      using (var g = Graphics.FromImage(bmp)) g.CopyFromScreen(x, y, 0, 0, bmp.Size);
      bmp.Save(path, ImageFormat.Png);
      if (basePath == "") return "";
      var bas = new Bitmap(basePath);
      var counts = new int[rects.Length / 4];
      for (int i = 0; i < counts.Length; i++) {
        int rx = rects[4 * i] - x, ry = rects[4 * i + 1] - y;
        for (int py = Math.Max(0, ry); py < Math.Min(h, ry + rects[4 * i + 3]); py++)
          for (int px = Math.Max(0, rx); px < Math.Min(w, rx + rects[4 * i + 2]); px++) {
            Color c = bmp.GetPixel(px, py), o = bas.GetPixel(px, py);
            int hi = Math.Max(c.R, Math.Max(c.G, c.B)), lo = Math.Min(c.R, Math.Min(c.G, c.B));
            int moved = Math.Max(Math.Abs(c.R - o.R), Math.Max(Math.Abs(c.G - o.G), Math.Abs(c.B - o.B)));
            if (hi - lo >= 60 && moved >= 40) counts[i]++;
          }
      }
      bas.Dispose();
      return string.Join(",", counts);
    }
  }
}
"@
`;

type Rect = readonly [x: number, y: number, w: number, h: number];

/** Cursor pixels in each of `rects`, from a capture of `area` saved as <OUT>/<stamp>-<name>.png and
 * compared with the earlier capture named `before`. Without `before` it only captures, and returns []. */
async function cursorPixels(area: Rect, name: string, rects: Rect[], before?: string): Promise<number[]> {
  const file = `cursorclip-${name}.png`;
  const base = before ? `${WIN_TEMP}\\cursorclip-${before}.png` : "";
  const out = await ps(`${CURSOR_PS}[BcuCursor]::Count(${area.join(",")}, '${WIN_TEMP}\\${file}', '${base}', [int[]]@(${rects.flat().join(",")}))`);
  mkdirSync(OUT, { recursive: true });
  copyFileSync(path.join(WSL_TEMP, file), path.join(OUT, `${STAMP}-${file}`));
  return base ? (out.trim().split(/\s+/).at(-1) ?? "").split(",").map(Number) : [];
}

/** Move and size a window this script opened and put it at the front of the ordinary windows,
 * without activating it. Topmost and back is the lock-free way to raise another app's window. */
async function placeOnTop(hwnd: number, [x, y, w, h]: Rect): Promise<void> {
  const pos = (after: number, flags: number) => `[void][BcuCursor]::SetWindowPos([IntPtr]${hwnd}, [IntPtr](${after}), ${x}, ${y}, ${w}, ${h}, ${flags});`;
  await ps(`${CURSOR_PS}[void][BcuCursor]::SetThreadDpiAwarenessContext([IntPtr](-4)); ${pos(-1, 0x10)} ${pos(-2, 0x13)}`); // HWND_TOPMOST, then HWND_NOTOPMOST; SWP_NOACTIVATE (| NOSIZE | NOMOVE)
}

/** A: target. B: an ordinary window raised above A. With a session label the driver draws its
 * cursor at each click; it must show on A's visible part and nowhere else:
 * - beside: a click in A just left of B. The arrow reaches into B.
 * - edge: a click just above A's bottom edge, clear of B. The arrow reaches below A.
 * - covered: B moved over all of A (a full-screen app over the target), then an element click.
 * Each count is the cursor pixels in that region after the click, against a capture just before it. */
async function checkCursorclip(run: Run) {
  const session = "bcu"; // as the plugin's calls carry
  const a = await openMenupad(["--at", "100", "100"], "MenuPad-A");
  try {
    const b = await openMenupad(["--at", "700", "100"], "MenuPad-B");
    const [ax, ay, aw, ah] = await boundsOf(run, a.pid, a.hwnd);
    await placeOnTop(b.hwnd, [ax + Math.floor(aw / 2), ay - 40, aw, Math.floor(ah / 2) + 40]);
    const [bx, by, bw, bh] = await boundsOf(run, b.pid, b.hwnd);
    const area: Rect = [ax - 60, ay - 60, aw + 120 + aw, ah + 120];
    const beside = [bx - 12, ay + Math.floor(ah / 4)] as const;
    const onTopBeside = { a: await topWindowAt(beside), b: await topWindowAt([bx + 20, beside[1]]) };
    const edge = [ax + Math.floor(aw / 4), ay + ah - 8] as const;
    const regions = {
      beside_in_a: [beside[0] - 2, beside[1] - 2, 14, 40],
      beside_over_b: [bx, beside[1] - 2, 40, 40],
      edge_in_a: [edge[0] - 2, edge[1] - 2, 40, 10],
      edge_below_a: [edge[0] - 2, ay + ah, 40, 40],
      a_whole: [ax, ay, aw, ah],
    } satisfies Record<string, Rect>;
    const names = Object.keys(regions) as Array<keyof typeof regions>;
    /** Run `act` between two captures named `<shot>-0` and `<shot>`, and count what it drew. */
    const counted = async <T,>(shot: string, act: () => Promise<T>): Promise<[T, Record<keyof typeof regions, number>]> => {
      await cursorPixels(area, `${shot}-0`, []);
      const res = await act();
      await sleep(900);
      const n = await cursorPixels(area, shot, names.map((k) => regions[k]), `${shot}-0`);
      return [res, Object.fromEntries(names.map((k, i) => [k, n[i]])) as Record<keyof typeof regions, number>];
    };
    // Screenshot pixels map to screen as frame origin + 1 (bitmap_to_screen); MenuPad is small
    // enough that the screenshot isn't downscaled.
    const local = ([sx, sy]: readonly [number, number]) => ({ x: sx - ax - 1, y: sy - ay - 1 });
    await run.call("get_window_state", { pid: a.pid, window_id: a.hwnd, include_screenshot: true, session });

    // A pixel click right after a state read can come back "UIA pixel click busy" with nothing
    // sent; the driver says to retry.
    const pixelClick = async (at: readonly [number, number]) => {
      const args = { pid: a.pid, window_id: a.hwnd, ...local(at), session };
      let called = await run.call("click", args);
      for (let i = 0; i < 4 && called.result.isError && called.text.includes("busy"); i++) {
        await sleep(700);
        called = await run.call("click", args);
      }
      return outcome(called);
    };
    const [clickBeside, besideCounts] = await counted("beside", () => pixelClick(beside));
    const [clickEdge, edgeCounts] = await counted("edge", () => pixelClick(edge));

    await placeOnTop(b.hwnd, [ax - 20, ay - 20, aw + 40, ah + 40]);
    const { rows } = await run.state(a.pid, a.hwnd);
    const [clickCovered, coveredCounts] = await counted("covered",
      async () => outcome(await run.call("click", { element_token: find(rows, "Edit", "Text editor").token, session })));
    const onTopCovered = await topWindowAt(edge);

    return {
      a_bounds: [ax, ay, aw, ah], b_bounds: [bx, by, bw, bh], beside_point: beside, edge_point: edge, regions,
      click_beside: clickBeside, beside: besideCounts, click_edge: clickEdge, edge: edgeCounts,
      click_covered: clickCovered, covered: coveredCounts, a_hwnd: a.hwnd, b_hwnd: b.hwnd,
      on_top_beside: onTopBeside, on_top_covered: onTopCovered,
      passed: onTopBeside.a === a.hwnd && onTopBeside.b === b.hwnd && onTopCovered === b.hwnd
        && !clickBeside.error && !clickEdge.error && !clickCovered.error
        && besideCounts.beside_in_a > 0 && besideCounts.beside_over_b === 0
        && edgeCounts.edge_in_a > 0 && edgeCounts.edge_below_a === 0
        && coveredCounts.a_whole === 0,
    };
  } finally {
    await stopMenupads();
  }
}

// --- 10. The bcu cursor hides when windows move over its background window --------------------

const SHOTS_SRC = path.join(HERE, "apps", "CursorShots.cs");
const SHOTS_DLL = `${WIN_TEMP}\\CursorShots.dll`;

/** Run `script` with bench/apps/CursorShots.cs loaded, compiling it when the source is newer. */
async function shots(script: string, timeoutMs = 60_000): Promise<string> {
  const dll = path.join(WSL_TEMP, "CursorShots.dll");
  if (!existsSync(dll) || statSync(dll).mtimeMs < statSync(SHOTS_SRC).mtimeMs) {
    mkdirSync(WSL_TEMP, { recursive: true });
    copyFileSync(SHOTS_SRC, path.join(WSL_TEMP, "CursorShots.cs"));
    await ps(`Remove-Item '${SHOTS_DLL}' -ErrorAction SilentlyContinue
Add-Type -TypeDefinition (Get-Content -Raw '${WIN_TEMP}\\CursorShots.cs') -OutputAssembly '${SHOTS_DLL}' -OutputType Library -ReferencedAssemblies System.Drawing`, 120_000);
  }
  return ps(`Add-Type -Path '${SHOTS_DLL}'\n${script}`, timeoutMs);
}

type Frame = { t: number; counts: number[] };
/** `rects[i]` is counted only where window `owners[i]` is on top. */
type SeriesSpec = { name: string; area: Rect; rects: Rect[]; owners: number[]; frames: number; everyMs: number; place?: { hwnd: number; rect: Rect } };

/** Start a CursorShots.Series that counts cursor-coloured pixels in `spec.rects` that belong to
 * `spec.owners` (another app opening on top meanwhile doesn't count), moving
 * `spec.place` over them first. Resolves once the first frame is taken, so the caller can act while
 * it runs; `done` gives every frame. Saved frames go to <OUT>/<stamp>-cursoroverlay-<name>-<n>.png. */
async function startSeries(spec: SeriesSpec, rgb: number[]): Promise<{ done: Promise<Frame[]> }> {
  const tag = `cursoroverlay-${spec.name}`;
  const started = path.join(WSL_TEMP, `${tag}.started`);
  for (const f of readdirSync(WSL_TEMP).filter((f) => f.startsWith(`${tag}-`))) rmSync(path.join(WSL_TEMP, f)); // an earlier run's frames
  writeFileSync(started, ""); // filled in by the first frame
  const list = (xs: readonly number[]) => `[int[]]@(${xs.join(",")})`;
  const done = shots(`[CursorShots]::Series(${spec.place?.hwnd ?? 0}, ${list(spec.place?.rect ?? [])}, $false, ${list(spec.area)}, `
    + `${spec.frames}, ${spec.everyMs}, ${list(rgb)}, 20, ${list(spec.rects.flat())}, [long[]]@(${spec.owners.join(",")}), '${WIN_TEMP}\\${tag}', '${WIN_TEMP}\\${tag}.started')`, 120_000)
    .then((out) => {
      mkdirSync(OUT, { recursive: true });
      for (const f of readdirSync(WSL_TEMP).filter((f) => f.startsWith(`${tag}-`) && f.endsWith(".png"))) {
        copyFileSync(path.join(WSL_TEMP, f), path.join(OUT, `${STAMP}-${f}`));
      }
      return out.trim().split("\n").filter((l) => /^\d+ /.test(l)).map((l) => {
        const [t, c] = l.split(" ");
        return { t: Number(t), counts: c.split(",").map(Number) };
      });
    });
  if (!(await waitFor(() => readFileSync(started, "utf8") !== "", 30))) throw new Error(`series ${spec.name} never started`);
  return { done };
}

/** A MenuPad's text box in screen pixels: its frame minus the border, title and menu bar, whose
 * accent colours and ClearType text fringes could pass for the cursor. `scale` is the display's. */
const inner = ([x, y, w, h]: Rect, scale: number): Rect => {
  const [side, top, bottom] = [12, 70, 14].map((m) => Math.round(m * scale));
  return [x + side, y + top, w - 2 * side, h - top - bottom];
};

/** bcu works in A, a MenuPad in the background, through the real plugin server (plugin/server/run.sh
 * over the driver under test, with the session label and fast cursor clients get). Then windows
 * start to cover it, and the cursor must not show on any of them:
 * - shown: a click at A's centre. The cursor must show there, its tip within 12 px of the click
 *   point, and this reads its colour.
 * - slide: B slides over the resting cursor. Frames start the moment B moves.
 * - under: bcu keeps clicking points of A under B, by pixel and by element.
 * - again: a click on a part of A nothing covers. The cursor must show again.
 * - opened: a new app window (C) opens over the resting cursor.
 * - fullscreen: B is maximized over everything while bcu keeps clicking A.
 * Frame series are counted inside each covering window's client area, on pixels where that window
 * is on top: other sessions' windows can open on this desktop mid-run. */
async function checkCursoroverlay(run: Run) {
  const policy = path.join(mkdtempSync(path.join(tmpdir(), "bcu-overlay-")), "policy.json");
  writeFileSync(policy, JSON.stringify({ allow: ["MenuPad"], foreground: "deny" }));
  const a = await openMenupad(["--at", "520", "100"], "MenuPad-A");
  try {
    const b = await openMenupad(["--at", "900", "500"], "MenuPad-B");
    // Other apps on the desktop may sit over A, and a new window doesn't always get the foreground.
    // So: A to the front without activating it, then B to the foreground. A is in the background,
    // directly under B, and on top wherever B isn't.
    const [ax, ay, aw, ah] = await boundsOf(run, a.pid, a.hwnd);
    await placeOnTop(a.hwnd, [ax - 7, ay, aw + 14, ah + 7]); // window rect = DWM frame plus the invisible border
    const foreground = async () => Number((await shots("[CursorShots]::Foreground()")).trim());
    await run.call("bring_to_front", { pid: b.pid, window_id: b.hwnd });
    if (await foreground() === a.hwnd) await run.call("bring_to_front", { pid: b.pid, window_id: b.hwnd }); // it doesn't always stick
    const foregroundAtStart = await foreground();
    // MenuPad places itself in logical pixels; A was asked for x = 520, so its frame position gives the display scale.
    const scale = (ax - 7) / 520;
    const client = (r: Rect) => inner(r, scale);
    await using bcu = await McpClient.start([path.join(HERE, "..", "plugin/server/run.sh")], {
      env: { BCU_CUA_DRIVER: path.resolve(EXE), BCU_POLICY: policy, BCU_AUDIT: "off" }, elicit: "unsupported",
    });
    const js = async (code: string) => {
      const { result, ms } = await bcu.call("js", { code }, 60_000);
      const text = textOf(result);
      run.log.push({ tool: "bcu js", args: { code }, ms: round1(ms), error: !!result.isError, text: text.slice(0, 600) });
      console.log(`  bcu js ${ms.toFixed(1).padStart(7)} ms ${result.isError ? "ERR " : ""}${JSON.stringify(text.slice(0, 200))}`);
      return { ms: round1(ms), error: !!result.isError, text: text.slice(0, 300) };
    };
    // Screenshot pixels map to screen as frame origin + 1; MenuPad's screenshot isn't downscaled.
    // A click right after a read can come back "busy" with nothing sent, so each retries.
    const clickCode = (target: string) => `{ const w = await cua.window({title: "MenuPad-A"}); let err;
      for (let i = 0; i < 5; i++) { try { await w.click(${target}); return "ok" } catch (e) { err = String(e); if (!err.includes("busy")) break; await cua.sleep(300) } }
      throw new Error(err) }`;
    const clickAt = ([sx, sy]: readonly [number, number]) => js(clickCode(`[${sx - ax - 1}, ${sy - ay - 1}]`));
    const clickEditor = () => js(clickCode(`await w.find("Text editor")`));

    const centre = [ax + Math.floor(aw / 2), ay + Math.floor(ah / 2) + 20] as const;
    const visible = [ax + 60, ay + ah - 40] as const;
    const slideRect: Rect = [ax + Math.floor(aw / 4), ay + Math.floor(ah / 4), Math.floor(aw / 2) + 40, Math.floor(ah / 2) + 40];
    const under = [centre, [centre[0] - 40, centre[1] - 20], [centre[0] + 40, centre[1] + 30]] as const;
    const area: Rect = [ax - 40, ay - 40, aw + 260, ah + 260];

    const onTopAtStart = { centre: await topWindowAt(centre), visible: await topWindowAt(visible) };
    // shown: the cursor's colour comes off the screen, from captures before and after one click.
    // A wide spot: a driver that draws the cursor away from its click point still gets caught.
    const SPOT = 300;
    const spot = [centre[0] - SPOT, centre[1] - SPOT, 2 * SPOT, 2 * SPOT] as const;
    await shots(`[CursorShots]::Capture(${spot.join(",")}, '${WIN_TEMP}\\cursoroverlay-shown-0.png')`);
    const shownClick = await clickAt(centre);
    // The arrow's fill, read just below and right of its tip: the session badge under the arrow is
    // larger, and its accent blue also turns up in window chrome. A new driver's overlay can take a
    // moment to show its first cursor.
    let colour = "";
    for (let i = 0; i < 6 && !colour; i++) {
      await sleep(500);
      colour = (await shots(`[CursorShots]::Capture(${spot.join(",")}, '${WIN_TEMP}\\cursoroverlay-shown.png'); `
        + `[CursorShots]::CursorColor('${WIN_TEMP}\\cursoroverlay-shown-0.png', '${WIN_TEMP}\\cursoroverlay-shown.png', ${SPOT}, ${SPOT}, 24, 24)`)).trim();
    }
    mkdirSync(OUT, { recursive: true });
    for (const f of ["cursoroverlay-shown-0.png", "cursoroverlay-shown.png"]) copyFileSync(path.join(WSL_TEMP, f), path.join(OUT, `${STAMP}-${f}`));
    if (!/^\d+,\d+,\d+$/.test(colour)) {
      throw new Error(`the cursor never showed on A (${JSON.stringify(colour)}); on top at A's centre: ${onTopAtStart.centre} (A is ${a.hwnd}); click: ${shownClick.text}`);
    }
    const rgb = colour.split(",").map(Number);
    // Where the arrow's tip landed relative to the click point.
    const tip = (await shots(`[CursorShots]::Top('${WIN_TEMP}\\cursoroverlay-shown.png', [int[]]@(${rgb.join(",")}), 20)`)).trim().split(",").map(Number);
    const cursorOffset = tip.length === 2 ? [tip[0] - SPOT, tip[1] - SPOT] : null;

    // slide: B moves over the resting cursor inside the series call, before its first frame.
    const slide = await (await startSeries({ name: "slide", area, rects: [client(slideRect)], owners: [b.hwnd], frames: 14, everyMs: 100, place: { hwnd: b.hwnd, rect: slideRect } }, rgb)).done;

    // under: bcu keeps working in A beneath B.
    const underSeries = await startSeries({ name: "under", area, rects: [client(slideRect)], owners: [b.hwnd], frames: 30, everyMs: 150 }, rgb);
    const underClicks = [await clickAt(under[0]), await clickAt(under[1]), await clickAt(under[2]), await clickEditor()];
    const underFrames = await underSeries.done;

    // again: an uncovered part of A shows the cursor.
    const onTopAgain = await topWindowAt(visible);
    const againSeries = await startSeries({ name: "again", area, rects: [[visible[0] - 20, visible[1] - 20, 60, 60]], owners: [a.hwnd], frames: 10, everyMs: 150 }, rgb);
    const againClick = await clickAt(visible);
    const againFrames = await againSeries.done;

    // opened: a new app window opens right on the resting cursor.
    const logical = (v: number) => String(Math.round(v / scale));
    const c = await openMenupad(["--at", logical(visible[0] - 300), logical(visible[1] - 300)], "MenuPad-C");
    const cBounds = await boundsOf(run, c.pid, c.hwnd);
    const [cx0, cy0, cw0, ch0] = client(cBounds);
    const cCoversCursor = visible[0] > cx0 && visible[0] + 40 < cx0 + cw0 && visible[1] > cy0 && visible[1] + 40 < cy0 + ch0;
    const opened = await (await startSeries({ name: "opened", area, rects: [client(cBounds)], owners: [c.hwnd], frames: 14, everyMs: 150 }, rgb)).done;

    // fullscreen: B is maximized over everything, and bcu keeps clicking A underneath.
    await shots(`[CursorShots]::Maximize(${b.hwnd})`);
    await sleep(500);
    const full = await boundsOf(run, b.pid, b.hwnd);
    const fullSeries = await startSeries({ name: "fullscreen", area: full, rects: [client(full)], owners: [b.hwnd], frames: 30, everyMs: 150 }, rgb);
    const fullClicks = [await clickEditor(), await clickAt(centre), await clickAt(visible), await clickAt(under[1])];
    const fullFrames = await fullSeries.done;

    const peak = (frames: Frame[]) => Math.max(0, ...frames.map((f) => f.counts[0]));
    const clicks = [shownClick, ...underClicks, againClick, ...fullClicks];
    return {
      a_hwnd: a.hwnd, b_hwnd: b.hwnd, c_hwnd: c.hwnd, foreground_at_start: foregroundAtStart, a_bounds: [ax, ay, aw, ah],
      on_top_at_start: onTopAtStart, on_top_again: onTopAgain, c_covers_cursor: cCoversCursor, cursor_offset: cursorOffset,
      slide_rect: slideRect, c_bounds: cBounds, full_bounds: full, cursor_rgb: rgb, clicks,
      peaks: { slide: peak(slide), under: peak(underFrames), again: peak(againFrames), opened: peak(opened), fullscreen: peak(fullFrames) },
      frames: { slide, under: underFrames, again: againFrames, opened, fullscreen: fullFrames },
      passed: foregroundAtStart !== a.hwnd && onTopAtStart.centre === a.hwnd && onTopAgain === a.hwnd && cCoversCursor
        && cursorOffset !== null && Math.abs(cursorOffset[0]) <= 12 && Math.abs(cursorOffset[1]) <= 12 && clicks.every((k) => !k.error)
        && peak(slide) === 0 && peak(underFrames) === 0 && peak(againFrames) > 0 && peak(opened) === 0 && peak(fullFrames) === 0,
    };
  } finally {
    await stopMenupads();
  }
}

// --- 6. Helium: the browser_* route on the user's real browser, in a background tab ----------

const HELIUM_EXE = String.raw`\imput\Helium\Application\chrome.exe`;
const HELIUM_FORM = `<!doctype html><html><head><meta charset="utf-8"><title>BCU Helium test</title></head><body>
<form id="f">
<label>Name <input id="name"></label>
<label>Email <input id="email" type="email"></label>
<label>Plan <select id="plan"><option value="">Choose...</option><option value="free">Free</option>
<option value="pro">Pro</option><option value="team">Team</option></select></label>
<label><input id="agree" type="checkbox"> I agree to the terms</label>
<label>Notes <div id="notes" contenteditable="true" role="textbox" aria-label="Notes"></div></label>
<button type="submit">Submit</button>
</form><p id="out"></p><p id="keys">keys:</p>
<script>
const v = (id) => document.getElementById(id);
const log = (t) => { v('keys').textContent += ' ' + t; };
v('f').addEventListener('submit', (e) => {
  e.preventDefault();
  v('out').textContent = \`Submitted: name=\${v('name').value}|email=\${v('email').value}|plan=\${v('plan').value}\` +
    \`|agree=\${v('agree').checked ? 'yes' : 'no'}|notes=\${v('notes').textContent}\`;
});
document.addEventListener('keyup', (e) => {
  const a = document.activeElement;
  const sel = (a && a.selectionStart != null) ? \`:\${a.selectionStart}-\${a.selectionEnd}/\${a.value.length}\` : '';
  log(\`\${e.ctrlKey ? 'ctrl+' : ''}\${e.key}@\${a ? a.id || a.tagName : '?'}\${sel}\`);
});
v('plan').addEventListener('change', (e) => log(\`change:\${e.target.value}:trusted=\${e.isTrusted}\`));
</script></body></html>`;
const HELIUM_SUBMITTED = "Submitted: name=Ada Lovelace|email=ada@example.com|plan=pro|agree=yes|notes=typed in a contenteditable";

/** Serve `html` at http://127.0.0.1:<free port>/form.html from this process (Windows reaches WSL's
 * loopback through localhost forwarding). */
async function servePage(html: string): Promise<{ server: Server; url: string }> {
  const server = createServer((req, res) => {
    const found = req.url === "/form.html";
    res.writeHead(found ? 200 : 404, { "Content-Type": "text/html; charset=utf-8" });
    res.end(found ? html : "");
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  server.unref(); // like the Python's daemon thread: a check that throws early can't hang the run
  const address = server.address();
  if (address === null || typeof address === "string") throw new Error("the test page server has no port");
  return { server, url: `http://127.0.0.1:${address.port}/form.html` };
}

/** Helium's browser windows, top of the z-order first. EnumWindows lists top-level windows top to
 * bottom, so the first is the one the user activated last: where Chromium puts background tabs. */
async function heliumWindows(): Promise<Win[]> {
  const out = await ps(`Get-Process chrome -ErrorAction SilentlyContinue | Where-Object { $_.Path -like '*${HELIUM_EXE}' } | ForEach-Object { $_.Id }`);
  const pids = new Set(out.split(/\s+/).filter((x) => /^\d+$/.test(x)).map(Number));
  return (await listWindows(true)).filter((w) => pids.has(w.pid) && w.cls === "Chrome_WidgetWin_1" && w.title.endsWith("Helium"));
}

async function debuggingPrompts(): Promise<number> {
  return (await listWindows(true)).filter((w) => w.title.toLowerCase().includes("remote debugging")).length;
}

/** A tool's refusal code: from the structured result, or for ActionResult tools (browser_click,
 * browser_type, browser_pointer) from the "refused (<code>)" text prefix. */
function refusalCode(result: ToolResult): string | null {
  return codeOf(result) ?? /^refused \((\w+)\)/.exec(textOf(result))?.[1] ?? null;
}

/** Names of tab-strip tabs that are ours (test page) or a leftover remote-debugging setup page, read
 * from each Helium window's UIA tree in memory. Only those names are returned. */
async function heliumStripStrays(run: Run, wins: Win[]): Promise<string[]> {
  const strays: string[] = [];
  for (const w of wins) {
    const { result } = await run.client.call("get_window_state", {
      session: "acceptance-helium-strip", pid: w.pid, window_id: w.hwnd, include_screenshot: false, full_output: true,
    });
    for (const [, name] of (result.structuredContent?.tree_markdown ?? "").matchAll(/TabItem "([^"]*)"/g)) {
      if (name.startsWith("BCU Helium test") || name.startsWith("Inspect with")) strays.push(name);
    }
  }
  return strays;
}

/** Names in `after` beyond those already in `before`, counting duplicates. */
function newNames(before: string[], after: string[]): string[] {
  const left = [...before];
  return after.filter((name) => {
    const i = left.indexOf(name);
    if (i < 0) return true;
    left.splice(i, 1);
    return false;
  });
}

/** Fill a form in a background tab of the user's Helium through browser_* tools only, then close
 * the tab. Passes when the form submits, every action stays under 300 ms and every snapshot under
 * 400 ms, the cursor and foreground never move, the user's selected tab never changes, and no test
 * tab, inspect tab or remote-debugging prompt is left. */
async function checkHelium(run: Run) {
  const wins = await heliumWindows();
  if (!wins.length) return { passed: false, skipped: "Helium is not running" };
  const w = wins[0];
  const { server, url } = await servePage(HELIUM_FORM);
  const steps: Array<{ step: string; tool: string; ms: number; error: boolean; refusal: string | null }> = [];

  /** Call a tool and record it as `step`. Bind results describe the user's tabs, so their text
   * stays out of the log, and so do URLs other than the test page's. */
  const call = async (tool: string, args: Args, step = tool, { record = true, client = run.client } = {}) => {
    const { result, ms } = await client.call(tool, args);
    const entry = { tool, ms: round1(ms), error: !!result.isError, refusal: refusalCode(result) };
    const safe = tool !== "get_browser_state" && tool !== "browser_prepare";
    // A refusal's message is the driver's own text, so it's kept even where the rest is hidden.
    const why = result.structuredContent?.refusal?.message;
    run.log.push({
      ...entry, args: Object.fromEntries(Object.entries(args).filter(([k, v]) => k !== "url" || v === url)),
      text: safe ? textOf(result).slice(0, 300) : "",
      ...(why ? { refusal_message: why.slice(0, 300) } : {}),
    });
    if (record) steps.push({ step, ...entry });
    console.log(`  ${step.padEnd(24)} ${ms.toFixed(1).padStart(7)} ms ${entry.refusal ?? ""}`);
    return { sc: result.structuredContent ?? {}, error: entry.error, refusal: entry.refusal };
  };
  const bind = async (session: string, client = run.client) => {
    await call("browser_prepare", { session, pid: w.pid, window_id: w.hwnd, strategy: { kind: "existing_profile" } }, "prepare", { client });
    return (await call("get_browser_state", { session, pid: w.pid, window_id: w.hwnd }, "bind", { client })).sc;
  };
  const ours = (tabs: Structured["tabs"]) => (tabs ?? []).filter((t) => t.url === url);
  const textRows = (sc: Structured, needle: string) => (sc.outline ?? "").split("\n").filter((l) => l.includes(needle)).map((l) => l.trim());
  /** Page refs by (role, name); a missing one throws, as the check can't go on without it. */
  const refsOf = (sc: Structured) => {
    const refs = new Map((sc.refs ?? []).map((x) => [JSON.stringify([x.role, x.name]), x.ref]));
    return (role: string, name: string) => {
      const ref = refs.get(JSON.stringify([role, name]));
      if (ref === undefined) throw new Error(`no ${role} ${JSON.stringify(name)} in the test page's refs`);
      return ref;
    };
  };

  const titleBefore = w.title;
  const strayBefore = await heliumStripStrays(run, wins); // the user's own inspect tabs aren't ours
  const promptsBefore = await debuggingPrompts();
  const S = "acceptance-helium";
  // The test tab while it's open. The shared teardown skips this check, so a step that throws
  // would otherwise leave the tab in the user's Helium.
  let openTab: { target_id: string; tab_id: string } | null = null;

  /** A second driver can see the tab but may not close it. It runs in its own process: two
   * sessions of one driver share a single pooled socket per browser, and ending either one drops
   * it for both. (Helium anchors its remote-debugging prompt to the window the user activated
   * last, and the driver only accepts it in the window it prepares, so this check never prepares
   * Helium's other windows: that would leave a stale prompt.) Returns the refusal, if it tried. */
  const closeFromOtherDriver = async () => {
    await using other = await McpClient.start([EXE, "mcp", "--grant", "existing-profile"], { env: ENV });
    const S2 = "acceptance-helium-other";
    const b2 = await bind(S2, other);
    const [foreign] = ours(b2.tabs);
    const refusal = foreign
      ? (await call("browser_close_tab", { session: S2, target_id: b2.target_id, tab_id: foreign.tab_id }, "close_foreign_tab", { client: other })).refusal
      : undefined;
    await call("end_session", { session: S2 }, "end_session", { record: false, client: other });
    return refusal;
  };

  const drive = async () => {
    const [binding, prepareSampler] = await sampled(() => bind(S));
    const target = binding.target_id;
    if (target === undefined) throw new Error("get_browser_state returned no target_id");
    const tabsBefore = (binding.tabs ?? []).length;

    const [out, sampler] = await sampled(async () => {
      const tab = (await call("browser_open_tab", { session: S, target_id: target, url }, "open_tab")).sc.tab_id ?? null;
      if (tab !== null) openTab = { target_id: target, tab_id: tab };
      const t = { session: S, target_id: target, tab_id: tab };
      await sleep(500); // let the new tab load before the first snapshot
      const snap = async (query?: string) => (await call("get_browser_state", { ...t, snapshot_format: "semantic_v2", ...(query ? { query } : {}) }, "snapshot")).sc;
      let ref = refsOf(await snap());
      await call("browser_type", { ...t, ref: ref("textbox", "Name"), text: "Grace" }, "type");
      await call("browser_type", { ...t, ref: ref("textbox", "Name"), text: "Ada Lovelace", replace: true }, "type_replace");
      await call("browser_type", { ...t, ref: ref("textbox", "Email"), text: "wrong@example.com" }, "type");
      const email = await call("browser_type", { ...t, ref: ref("textbox", "Email"), text: "ada@example.com", replace: true }, "type_replace_email");
      await call("browser_type", { ...t, ref: ref("textbox", "Notes"), text: "typed in a contenteditable" }, "type");
      const closedOption = await call("browser_click", { ...t, ref: ref("option", "Team") }, "click_closed_option");
      const select = await call("browser_select", { ...t, ref: ref("combobox", "Plan"), option: "Pro" }, "select");
      await call("browser_click", { ...t, ref: ref("checkbox", "I agree to the terms") }, "click");
      await call("browser_press_key", { ...t, ref: ref("textbox", "Name"), key: "a", modifiers: ["ctrl"] }, "press_key");
      await call("browser_press_key", { ...t, key: "Tab" }, "press_key");
      await call("browser_press_key", { ...t, key: "Escape" }, "press_key");
      const keyLog = textRows(await snap("keys:"), "keys:");
      ref = refsOf(await snap());
      await call("browser_click", { ...t, ref: ref("button", "Submit") }, "click");
      await sleep(300);
      const submitted = textRows(await snap("Submitted"), "Submitted");
      await call("browser_navigate", { ...t, url }, "navigate");
      return {
        tab_id: tab, email_replace_ok: !email.error, closed_option_refusal: closedOption.refusal,
        select_value: select.sc.value ?? null, key_log: keyLog, submitted,
      };
    });

    const foreignCloseRefusal = await closeFromOtherDriver();
    const closed = out.tab_id ? !!(await call("browser_close_tab", { session: S, target_id: target, tab_id: out.tab_id }, "close_tab")).sc.closed : undefined;
    if (closed) openTab = null; // a refused or failed close leaves it to the finally below
    const after = (await call("get_browser_state", { session: S, pid: w.pid, window_id: w.hwnd }, "bind")).sc;
    return {
      prepare_sampler: prepareSampler, binding_quality: binding.binding_quality ?? null, sampler, ...out,
      foreign_close_refusal: foreignCloseRefusal, closed,
      tabs_restored: (after.tabs ?? []).length === tabsBefore, test_tabs_left: ours(after.tabs).length,
    };
  };

  // The session ends only here, after any retry: ending it drops the driver's record that the tab
  // is ours, and without that record the tab can no longer be closed.
  const res = await drive().finally(async () => {
    if (openTab) await call("browser_close_tab", { session: S, ...openTab }, "close_tab_after_error", { record: false }).catch(() => {});
    await call("end_session", { session: S }, "end_session", { record: false }).catch(() => {});
    server.close();
    server.closeAllConnections();
  });
  await sleep(500);
  const stripStrays = newNames(strayBefore, await heliumStripStrays(run, wins));
  const promptsLeft = await debuggingPrompts();
  const selectedTabUnchanged = equalLists((await heliumWindows()).filter((x) => x.hwnd === w.hwnd).map((x) => x.title), [titleBefore]);
  const timed = steps.filter((s) => s.step !== "prepare" && s.step !== "bind");
  const maxActionMs = Math.max(0, ...timed.filter((s) => s.step !== "snapshot").map((s) => s.ms));
  const maxSnapshotMs = Math.max(0, ...timed.filter((s) => s.step === "snapshot").map((s) => s.ms));
  const keys = res.key_log.join(" ");
  const s = res.sampler;
  return {
    window_id: w.hwnd, pid: w.pid, helium_windows: wins.length, steps, ...res,
    strip_strays: stripStrays, prompts_before: promptsBefore, prompts_left: promptsLeft, selected_tab_unchanged: selectedTabUnchanged,
    max_action_ms: maxActionMs, max_snapshot_ms: maxSnapshotMs,
    passed: res.binding_quality === "exact"
      && res.submitted.length > 0 && res.submitted[0].includes(HELIUM_SUBMITTED)
      && res.email_replace_ok && res.select_value === "pro"
      && res.closed_option_refusal === "browser_action_unavailable"
      && ["change:pro", "ctrl+a@name:0-12/12", "Tab@email", "Escape@email"].every((k) => keys.includes(k))
      && res.foreign_close_refusal === "browser_action_unavailable"
      && res.closed === true && res.tabs_restored && res.test_tabs_left === 0
      && !stripStrays.length && promptsLeft === 0 && selectedTabUnchanged
      && s.cursor_max_displacement_px === 0 && s.foreground_changes === 0
      && maxActionMs < 300 && maxSnapshotMs < 400,
  };
}

// --- 4. Calculator (UWP regression) --------------------------------------------------------

async function checkCalc(run: Run) {
  const [res, sampler] = await sampled(async () => {
    const launch = await run.call("launch_app", { aumid: "Microsoft.WindowsCalculator_8wekyb3d8bbwe!App" });
    const sc = launch.result.structuredContent ?? {};
    const pid = sc.pid;
    const hwnd = sc.windows?.[0]?.window_id;
    if (pid === undefined || hwnd === undefined) throw new Error(`launch_app returned no window: ${launch.text.slice(0, 200)}`);
    let { rows } = await run.state(pid, hwnd);
    const clicksMs: number[] = [];
    for (const name of ["One", "Two", "Multiply by", "One", "Two", "Equals"]) {
      clicksMs.push(round1((await run.call("click", { pid, element_token: find(rows, "Button", name).token })).ms));
    }
    await sleep(300);
    ({ rows } = await run.state(pid, hwnd));
    const named = (pred: (r: Row) => boolean) => rows.filter(pred).map((r) => r.name);
    const display = named((r) => r.name.includes("Display is"));
    return {
      launch_ms: launch.ms, launch_keys: Object.keys(sc).toSorted(), pid, hwnd, clicks_ms: clicksMs,
      display: display.length ? display : named((r) => r.role === "Text" && r.name.includes("Display")),
    };
  });
  const shown = await calcDisplay();
  return { ...res, sampler, display_uia: shown, passed: shown.some((s) => s.trim().endsWith("144")) };
}

type Outcome = { passed: boolean; sampler?: Sampled; exception?: string };

const CHECKS = {
  saveas: checkSaveas, closedmenu: checkClosedmenu, replace: checkReplace, edge: checkEdge, edge_alert: checkEdgeAlert,
  calc: checkCalc, explorer: checkExplorer, win32menu: checkWin32menu, win32menu_bypos: checkWin32menuBypos,
  menubg: checkMenubg, ownership: checkOwnership, fgpoint: checkFgpoint, cursorclip: checkCursorclip, cursoroverlay: checkCursoroverlay,
  helium: checkHelium,
} satisfies Record<string, (run: Run) => Promise<Outcome>>;
type CheckName = keyof typeof CHECKS;

// Extra `cua-driver mcp` arguments per check.
const CHECK_ARGS: Partial<Record<CheckName, string[]>> = { helium: ["--grant", "existing-profile"] };
// Checks that open no task windows and clean up after themselves skip the shared teardown, which
// closes new task windows and kills TestPad.
const SELF_CLEANING = new Set<CheckName>(["helium"]);

const isCheck = (name: string): name is CheckName => Object.hasOwn(CHECKS, name);

const requested = process.argv.slice(2);
const unknown = requested.filter((n) => !isCheck(n));
if (unknown.length) {
  console.error(`unknown check ${unknown.join(", ")}; checks: ${Object.keys(CHECKS).join(" ")}`);
  process.exit(2);
}
const results: Record<string, Outcome> = {};
const log: LogEntry[] = [];
for (const name of (requested.length ? requested : Object.keys(CHECKS)).filter(isCheck)) {
  console.log(`== ${name}`);
  const before = await listWindows();
  try {
    await using client = await McpClient.start([EXE, "mcp", ...(CHECK_ARGS[name] ?? [])], { env: ENV });
    results[name] = await CHECKS[name](new Run(client, log));
  } catch (e) { // record and keep going
    results[name] = { passed: false, exception: String(e).slice(0, 800) };
  } finally {
    if (!SELF_CLEANING.has(name)) {
      console.log("  closed:", await closeNewWindows(before));
      await killTestPad();
    }
  }
  console.log(`  -> passed=${results[name].passed} sampler=${JSON.stringify(results[name].sampler)}`);
}
mkdirSync(OUT, { recursive: true });
const out = path.join(OUT, `acceptance-${STAMP}.json`);
writeFileSync(out, JSON.stringify({ results, calls: log }, null, 1));
console.log("written:", out);
