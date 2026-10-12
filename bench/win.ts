// Windows-side helpers for the benchmark, driven from WSL through PowerShell.
//
// - ps(script) runs a PowerShell snippet and returns its stdout.
// - listWindows() snapshots visible top-level windows (hwnd, pid, process, class).
// - closeNewWindows(before) closes only task windows that appeared after `before`.
// - Sampler records the cursor position and foreground window every 100 ms while an agent runs,
//   which is how we measure whether a CU stack disturbs the desktop.
//
// Window titles are only read for specific task checks, never logged wholesale, because other
// windows on this desktop belong to the user.

import { spawn, type ChildProcess } from "node:child_process";
import { createInterface } from "node:readline";
import { setTimeout as sleep } from "node:timers/promises";

const POWERSHELL = "/mnt/c/Windows/System32/WindowsPowerShell/v1.0/powershell.exe";
export const WIN_TEMP = String.raw`C:\Users\Aadi\AppData\Local\Temp\bcu`;
export const WSL_TEMP = "/mnt/c/Users/Aadi/AppData/Local/Temp/bcu";

// Win32 helpers compiled once per PowerShell process.
export const WIN_TYPES = String.raw`
Add-Type -TypeDefinition @"
using System;
using System.Collections.Generic;
using System.Runtime.InteropServices;
using System.Text;
public static class BcuW {
  public delegate bool EnumProc(IntPtr h, IntPtr l);
  [DllImport("user32.dll")] public static extern bool EnumWindows(EnumProc cb, IntPtr l);
  [DllImport("user32.dll")] public static extern bool IsWindowVisible(IntPtr h);
  [DllImport("user32.dll")] public static extern uint GetWindowThreadProcessId(IntPtr h, out uint pid);
  [DllImport("user32.dll", CharSet=CharSet.Unicode)] public static extern int GetClassName(IntPtr h, StringBuilder s, int n);
  [DllImport("user32.dll", CharSet=CharSet.Unicode)] public static extern int GetWindowText(IntPtr h, StringBuilder s, int n);
  [DllImport("user32.dll")] public static extern IntPtr GetForegroundWindow();
  [DllImport("user32.dll")] public static extern bool GetCursorPos(out POINT p);
  [DllImport("user32.dll")] public static extern bool PostMessage(IntPtr h, uint m, IntPtr w, IntPtr l);
  [DllImport("user32.dll")] public static extern bool IsWindow(IntPtr h);
  [StructLayout(LayoutKind.Sequential)] public struct POINT { public int X; public int Y; }
  public static List<string> Windows(bool titles) {
    var r = new List<string>();
    EnumWindows((h, l) => {
      if (!IsWindowVisible(h)) return true;
      uint pid; GetWindowThreadProcessId(h, out pid);
      var c = new StringBuilder(256); GetClassName(h, c, 256);
      var t = new StringBuilder(512); if (titles) GetWindowText(h, t, 512);
      r.Add(h.ToInt64() + "\t" + pid + "\t" + c + "\t" + t);
      return true;
    }, IntPtr.Zero);
    return r;
  }
}
"@
`;

const encode = (script: string) => Buffer.from(script, "utf16le").toString("base64");

/** Run a PowerShell snippet on Windows and return its stdout. The exit code is ignored; a run
 * past `timeoutMs` is killed and throws. stdin stays closed, because WSL interop would relay ours. */
export function ps(script: string, timeoutMs = 60_000): Promise<string> {
  const proc = spawn(POWERSHELL, ["-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-EncodedCommand", encode(script)],
    { stdio: ["ignore", "pipe", "pipe"] });
  let out = "";
  proc.stdout.setEncoding("utf8").on("data", (chunk: string) => (out += chunk));
  proc.stderr.resume();
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      proc.kill("SIGKILL");
      reject(new Error(`PowerShell timed out after ${timeoutMs / 1000}s`));
    }, timeoutMs);
    proc.on("error", (e) => {
      clearTimeout(timer);
      reject(e);
    });
    proc.on("close", () => {
      clearTimeout(timer);
      resolve(out.replaceAll("\r", ""));
    });
  });
}

export type Win = { hwnd: number; pid: number; cls: string; proc: string; title: string };

const isDigits = (s: string) => /^\d+$/.test(s);

/** Visible top-level windows. Titles are read only when asked for. */
export async function listWindows(titles = false): Promise<Win[]> {
  const out = await ps(WIN_TYPES + `
$procs = @{}; Get-Process | ForEach-Object { $procs[[int]$_.Id] = $_.ProcessName }
foreach ($l in [BcuW]::Windows($${titles})) {
  $p = $l.Split("\`t"); "$($p[0])\`t$($p[1])\`t$($p[2])\`t$($procs[[int]$p[1]])\`t$($p[3])"
}`);
  return out.split("\n").flatMap((line) => {
    const [hwnd, pid, cls, proc, title = ""] = line.split("\t");
    return proc !== undefined && isDigits(hwnd) ? [{ hwnd: Number(hwnd), pid: Number(pid), cls, proc, title }] : [];
  });
}

// Teardown closes only windows a run can have created, and kills only the benchmark's own exe:
// - TestPad (benchmark-only exe): closed, then killed if it's still open.
// - Calculator, Notepad, the Open With picker, System Properties: WM_CLOSE only, never killed, so
//   an unsaved document of the user's gets its normal prompt instead of being destroyed.
// - File Explorer: only folder windows showing a path under %TEMP%\bcu (benchExplorerWindows).
// - Edge: not here. Tasks run Edge in a throwaway profile that teardown kills by command line.
// A class of null matches any window of that process.
export const TASK_WINDOWS: ReadonlyArray<readonly [proc: string, cls: string | null]> = [
  ["ApplicationFrameHost", "ApplicationFrameWindow"], // UWP frames such as Calculator
  ["CalculatorApp", null],
  ["TestPad", null],
  ["Notepad", null], // only if a run opened it (e.g. double-clicking a file)
  ["OpenWith", null],
  ["rundll32", "#32770"], // sysdm.cpl dialog
  ["SystemPropertiesComputerName", null],
  ["SystemPropertiesAdvanced", null],
];
const KILLABLE = new Set(["TestPad"]);

const isTaskWindow = (w: Win) => TASK_WINDOWS.some(([proc, cls]) => w.proc === proc && (cls === null || w.cls === cls));

/** HWNDs of File Explorer windows currently showing a folder under %TEMP%\bcu. */
async function benchExplorerWindows(): Promise<Set<number>> {
  const out = await ps(String.raw`$s = New-Object -ComObject Shell.Application
foreach ($w in $s.Windows()) { try { if ($w.Document.Folder.Self.Path -like '*\Temp\bcu*') { [int64]$w.HWND } } catch {} }`);
  return new Set(out.split(/\s+/).filter(isDigits).map(Number));
}

/** WM_CLOSE the task windows that weren't in `before`; kill only KILLABLE processes that are new
 * and still hold windows after the grace period. Returns what was closed. */
export async function closeNewWindows(before: Win[], graceMs = 3000): Promise<string[]> {
  const beforeHwnds = new Set(before.map((w) => w.hwnd));
  const beforePids = new Set(before.map((w) => w.pid));
  const explorer = await benchExplorerWindows();
  const created = (await listWindows()).filter((w) => !beforeHwnds.has(w.hwnd) && (isTaskWindow(w) || explorer.has(w.hwnd)));
  if (!created.length) return [];
  const hwnds = created.map((w) => w.hwnd).join(",");
  await ps(WIN_TYPES + `foreach ($h in @(${hwnds})) { [void][BcuW]::PostMessage([IntPtr]$h, 0x0010, [IntPtr]::Zero, [IntPtr]::Zero) }`);
  await sleep(graceMs);
  const createdHwnds = new Set(created.map((w) => w.hwnd));
  const still = (await listWindows()).filter((w) => createdHwnds.has(w.hwnd));
  const killable = [...new Set(still.filter((w) => !beforePids.has(w.pid) && KILLABLE.has(w.proc)).map((w) => w.pid))]
    .toSorted((a, b) => a - b);
  if (killable.length) await ps(`Stop-Process -Force -Id ${killable.join(",")} -ErrorAction SilentlyContinue`);
  return [...created.map((w) => `${w.proc}:${w.cls}`), ...killable.map((p) => `killed:${p}`)];
}

type Sample = { t: number; x: number; y: number; fg: number };

/** Desktop disturbance over a run. Only `samples` is present when nothing was sampled. */
export type Disturbance = {
  samples: number;
  cursor_max_displacement_px?: number;
  cursor_move_samples?: number;
  foreground_changes?: number;
  foreground_restored?: boolean;
};

/** Polls the real cursor position and foreground hwnd every `intervalMs` on Windows. */
export class Sampler {
  readonly samples: Sample[] = [];
  private readonly proc: ChildProcess;

  private constructor(proc: ChildProcess) {
    this.proc = proc;
  }

  /** Start sampling; resolves at the first sample, or after 20 s if none arrives. */
  static async start(intervalMs = 100): Promise<Sampler> {
    const script = WIN_TYPES + `
$p = New-Object BcuW+POINT
while ($true) {
  [void][BcuW]::GetCursorPos([ref]$p)
  $fg = [BcuW]::GetForegroundWindow().ToInt64()
  [Console]::Out.WriteLine("$($p.X) $($p.Y) $fg"); [Console]::Out.Flush()
  Start-Sleep -Milliseconds ${intervalMs}
}`;
    const proc = spawn(POWERSHELL, ["-NoProfile", "-NonInteractive", "-EncodedCommand", encode(script)], { stdio: ["ignore", "pipe", "ignore"] });
    const sampler = new Sampler(proc);
    const ready = Promise.withResolvers<void>();
    const timer = setTimeout(ready.resolve, 20_000);
    createInterface({ input: proc.stdout }).on("line", (line) => {
      const nums = line.trim().split(/\s+/).map(Number);
      if (nums.length !== 3 || !nums.every(Number.isInteger)) return;
      const [x, y, fg] = nums;
      sampler.samples.push({ t: Date.now() / 1000, x, y, fg });
      ready.resolve();
    });
    await ready.promise;
    clearTimeout(timer);
    return sampler;
  }

  stop(): void {
    this.proc.kill("SIGKILL");
  }

  /** How far the real cursor moved and how often the foreground window changed while the agent
   * ran. `since` (epoch seconds) drops earlier samples: the manual baseline starts the sampler
   * before the human pastes the prompt, and their own mouse use isn't the agent's. */
  summary(since = 0): Disturbance {
    const s = this.samples.filter((x) => x.t >= since);
    if (!s.length) return { samples: 0 };
    const first = s[0];
    const steps = s.slice(1).map((b, i) => [s[i], b] as const);
    return {
      samples: s.length,
      cursor_max_displacement_px: s.reduce((max, p) => Math.max(max, Math.abs(p.x - first.x) + Math.abs(p.y - first.y)), 0),
      cursor_move_samples: steps.filter(([a, b]) => a.x !== b.x || a.y !== b.y).length,
      foreground_changes: steps.filter(([a, b]) => a.fg !== b.fg).length,
      foreground_restored: s[s.length - 1].fg === first.fg,
    };
  }
}

/** PIDs of running OpenWith.exe ("Select an app to open this file") pickers. Its window is not a
 * visible top-level window, so window-based teardown cannot see it. */
export async function openwithPids(): Promise<Set<number>> {
  const out = await ps("Get-Process OpenWith -ErrorAction SilentlyContinue | ForEach-Object { $_.Id }");
  return new Set(out.split(/\s+/).filter(isDigits).map(Number));
}

/** Kill pickers started during this run (double-clicking a .bcu file opens one). Pickers that
 * already existed, such as one the user opened, are left alone. */
export async function killNewOpenwith(before: Set<number>): Promise<number[]> {
  const created = [...(await openwithPids())].filter((p) => !before.has(p)).toSorted((a, b) => a - b);
  if (created.length) await ps(`Stop-Process -Force -ErrorAction SilentlyContinue -Id ${created.join(",")}`);
  return created;
}

const KILL_BENCH_EDGE = "Get-CimInstance Win32_Process -Filter \"Name='msedge.exe'\" | "
  + "Where-Object { $_.CommandLine -like '*bcu\\edge-profile*' } | "
  + "ForEach-Object { Stop-Process -Id $_.ProcessId -Force -ErrorAction SilentlyContinue }";

/** Kill Edge running in the throwaway bcu profile. Only the benchmark starts that profile. */
export async function killBenchEdge(): Promise<void> {
  await ps(KILL_BENCH_EDGE);
}

/** Kill TestPad, the benchmark's own exe. A modal dialog can block WM_CLOSE, so teardown ends with this. */
export async function killTestPad(): Promise<void> {
  await ps("Stop-Process -Name TestPad -Force -ErrorAction SilentlyContinue");
}

/** Kill benchmark-only processes left behind by an interrupted run: TestPad and Edge running in
 * the throwaway bcu profile. Both exist only because of this benchmark. */
export async function closeStrays(): Promise<void> {
  await ps("Stop-Process -Name TestPad -Force -ErrorAction SilentlyContinue; " + KILL_BENCH_EDGE);
}

/** Local time as 20261012-130905, for batch and output file names. */
export function timestamp(): string {
  const [date, time] = new Date().toLocaleString("sv-SE").split(" ");
  return `${date.replaceAll("-", "")}-${time.replaceAll(":", "")}`;
}
