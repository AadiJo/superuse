"""Windows-side helpers for the benchmark, driven from WSL through PowerShell.

- `ps(script)` runs a PowerShell snippet and returns stdout.
- `list_windows()` snapshots visible top-level windows (hwnd, pid, process, class).
- `close_new_windows(before)` closes only windows that appeared after `before`.
- `Sampler` records cursor position and foreground window every 100 ms while an
  agent runs, which is how we measure whether a CU stack disturbs the desktop.

Window titles are only read for specific task checks, never logged wholesale,
because other windows on this desktop belong to the user.
"""
from __future__ import annotations

import base64
import json
import subprocess
import threading
import time
from dataclasses import dataclass, field
from pathlib import Path

POWERSHELL = "/mnt/c/Windows/System32/WindowsPowerShell/v1.0/powershell.exe"
WIN_TEMP = r"C:\Users\Aadi\AppData\Local\Temp\bcu"
WSL_TEMP = Path("/mnt/c/Users/Aadi/AppData/Local/Temp/bcu")

# Win32 helpers compiled once per PowerShell process.
WIN_TYPES = r'''
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
'''


def ps(script: str, timeout: float = 60) -> str:
    """Run a PowerShell snippet on Windows and return its stdout."""
    encoded = base64.b64encode(script.encode("utf-16-le")).decode()
    out = subprocess.run([POWERSHELL, "-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass",
                          "-EncodedCommand", encoded], capture_output=True, text=True, timeout=timeout,
                         stdin=subprocess.DEVNULL)
    return out.stdout.replace("\r", "")


@dataclass(frozen=True)
class Win:
    hwnd: int
    pid: int
    cls: str
    proc: str
    title: str = ""


def list_windows(titles: bool = False) -> list[Win]:
    script = WIN_TYPES + f'''
$procs = @{{}}; Get-Process | ForEach-Object {{ $procs[[int]$_.Id] = $_.ProcessName }}
foreach ($l in [BcuW]::Windows(${str(titles).lower()})) {{
  $p = $l.Split("`t"); "$($p[0])`t$($p[1])`t$($p[2])`t$($procs[[int]$p[1]])`t$($p[3])"
}}'''
    wins = []
    for line in ps(script).splitlines():
        parts = line.split("\t")
        if len(parts) >= 4 and parts[0].isdigit():
            wins.append(Win(int(parts[0]), int(parts[1]), parts[2], parts[3], parts[4] if len(parts) > 4 else ""))
    return wins


# Only these (process, window class) pairs are ever closed by teardown. Anything
# else that appears during a run (system helper windows, the user's own apps)
# is left alone. A class of None matches any window of that process.
TASK_WINDOWS: set[tuple[str, str | None]] = {
    ("ApplicationFrameHost", "ApplicationFrameWindow"),  # UWP frames such as Calculator
    ("CalculatorApp", None),
    ("TestPad", None),  # the benchmark's editor and its dialogs
    ("Notepad", None),  # only if a run opened it (e.g. double-clicking a file)
    ("OpenWith", None),  # "How do you want to open this file?" picker
    ("explorer", "CabinetWClass"),  # File Explorer folder windows, not the shell
    ("msedge", None),
    ("rundll32", "#32770"),  # sysdm.cpl dialog
    ("SystemPropertiesComputerName", None),
    ("SystemPropertiesAdvanced", None),
}


def is_task_window(w: Win) -> bool:
    return any(w.proc == proc and (cls is None or w.cls == cls or (cls.endswith("*") and w.cls.startswith(cls[:-1])))
               for proc, cls in TASK_WINDOWS)


def close_new_windows(before: list[Win], grace_s: float = 3.0) -> list[str]:
    """WM_CLOSE task-app windows that weren't in `before`; kill processes that
    were new and still hold windows after the grace period. Returns what was closed."""
    before_hwnds = {w.hwnd for w in before}
    before_pids = {w.pid for w in before}
    new = [w for w in list_windows() if w.hwnd not in before_hwnds and is_task_window(w)]
    if not new:
        return []
    hwnds = ",".join(str(w.hwnd) for w in new)
    ps(WIN_TYPES + f'foreach ($h in @({hwnds})) {{ [void][BcuW]::PostMessage([IntPtr]$h, 0x0010, [IntPtr]::Zero, [IntPtr]::Zero) }}')
    time.sleep(grace_s)
    still = [w for w in list_windows() if w.hwnd in {n.hwnd for n in new}]
    killable = sorted({w.pid for w in still if w.pid not in before_pids})
    if killable:
        ps("Stop-Process -Force -Id " + ",".join(map(str, killable)) + " -ErrorAction SilentlyContinue")
    return [f"{w.proc}:{w.cls}" for w in new] + [f"killed:{p}" for p in killable]


@dataclass
class Sample:
    t: float
    x: int
    y: int
    fg: int


@dataclass
class Sampler:
    """Polls cursor position and foreground hwnd every `interval_ms` on Windows."""
    interval_ms: int = 100
    samples: list[Sample] = field(default_factory=list)

    def start(self) -> None:
        script = WIN_TYPES + f'''
$p = New-Object BcuW+POINT
while ($true) {{
  [void][BcuW]::GetCursorPos([ref]$p)
  $fg = [BcuW]::GetForegroundWindow().ToInt64()
  [Console]::Out.WriteLine("$($p.X) $($p.Y) $fg"); [Console]::Out.Flush()
  Start-Sleep -Milliseconds {self.interval_ms}
}}'''
        encoded = base64.b64encode(script.encode("utf-16-le")).decode()
        self.proc = subprocess.Popen([POWERSHELL, "-NoProfile", "-NonInteractive", "-EncodedCommand", encoded],
                                     stdout=subprocess.PIPE, stderr=subprocess.DEVNULL, stdin=subprocess.DEVNULL, text=True, bufsize=1)
        self.ready = threading.Event()
        threading.Thread(target=self._read, daemon=True).start()
        self.ready.wait(20)

    def _read(self) -> None:
        for line in self.proc.stdout:  # type: ignore[union-attr]
            parts = line.split()
            if len(parts) == 3:
                self.samples.append(Sample(time.time(), int(parts[0]), int(parts[1]), int(parts[2])))
                self.ready.set()

    def stop(self) -> None:
        self.proc.kill()

    def summary(self) -> dict[str, object]:
        """Desktop disturbance: how far the real cursor moved and how often the
        foreground window changed while the agent ran."""
        if not self.samples:
            return {"samples": 0}
        s0 = self.samples[0]
        max_disp = max(abs(s.x - s0.x) + abs(s.y - s0.y) for s in self.samples)
        moves = sum(1 for a, b in zip(self.samples, self.samples[1:]) if (a.x, a.y) != (b.x, b.y))
        fg_changes = sum(1 for a, b in zip(self.samples, self.samples[1:]) if a.fg != b.fg)
        return {"samples": len(self.samples), "cursor_max_displacement_px": max_disp, "cursor_move_samples": moves,
                "foreground_changes": fg_changes, "foreground_restored": self.samples[-1].fg == s0.fg}


def openwith_pids() -> set[int]:
    """PIDs of running OpenWith.exe ("Select an app to open this file") pickers. Its window
    is not a visible top-level window, so window-based teardown cannot see it."""
    out = ps("Get-Process OpenWith -ErrorAction SilentlyContinue | ForEach-Object { $_.Id }")
    return {int(x) for x in out.split() if x.isdigit()}


def kill_new_openwith(before: set[int]) -> list[int]:
    """Kill pickers started during this run (double-clicking a .bcu file opens one). Pickers
    that already existed, such as one the user opened, are left alone."""
    new = sorted(openwith_pids() - before)
    if new:
        ps("Stop-Process -Force -ErrorAction SilentlyContinue -Id " + ",".join(map(str, new)))
    return new


def close_strays() -> None:
    """Kill benchmark-only processes left behind by an interrupted run: TestPad and Edge
    running in the throwaway bcu profile. Both exist only because of this benchmark."""
    ps("Stop-Process -Name TestPad -Force -ErrorAction SilentlyContinue; "
       "Get-CimInstance Win32_Process -Filter \"Name='msedge.exe'\" | "
       "Where-Object { $_.CommandLine -like '*bcu\\edge-profile*' } | "
       "ForEach-Object { Stop-Process -Id $_.ProcessId -Force -ErrorAction SilentlyContinue }")

