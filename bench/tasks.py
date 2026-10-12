"""The Windows desktop task suite.

Each task prepares its own files under %TEMP%\\bcu\\<task id>, optionally opens
the app, and checks the outcome by reading real Windows state (file contents,
Calculator's display through UIA, Edge's window title), never by trusting the
agent's claim. Apps the agent touches are closed by the runner afterwards.
"""
from __future__ import annotations

import re
import shutil
import time
from dataclasses import dataclass
from pathlib import Path
from typing import Callable

import win

EDGE = r"C:\Program Files (x86)\Microsoft\Edge\Application\msedge.exe"
COMPUTER_NAME = "HOME-PC"


@dataclass(frozen=True)
class Check:
    passed: bool
    detail: str


@dataclass(frozen=True)
class Task:
    id: str
    prompt: str
    setup: Callable[[], None]
    check: Callable[[str], Check]  # receives the agent's final text
    teardown: Callable[[], None] = lambda: None


def task_dir(task_id: str, fresh: bool = True) -> tuple[str, "win.Path"]:
    """Return (windows path, wsl path) of the task's scratch folder."""
    wsl = win.WSL_TEMP / task_id
    if fresh and wsl.exists():
        shutil.rmtree(wsl)
    wsl.mkdir(parents=True, exist_ok=True)
    return f"{win.WIN_TEMP}\\{task_id}", wsl


def start(exe: str, *args: str) -> None:
    arglist = ",".join("'" + a.replace("'", "''") + "'" for a in args)
    win.ps(f"Start-Process -FilePath '{exe}'" + (f" -ArgumentList {arglist}" if args else ""))


def read_lines(path: "win.Path") -> list[str]:
    if not path.exists():
        return []
    raw = path.read_bytes()
    text = raw.decode("utf-16") if raw[:2] in (b"\xff\xfe", b"\xfe\xff") else raw.decode("utf-8-sig", errors="replace")
    return text.replace("\r\n", "\n").rstrip("\n").split("\n") if text.strip() else []


# --- calc_mul: launch Calculator, compute, read display ---------------------

def calc_display() -> list[str]:
    return [l for l in win.ps(r'''
Add-Type -AssemblyName UIAutomationClient,UIAutomationTypes
$A=[System.Windows.Automation.AutomationElement]; $S=[System.Windows.Automation.TreeScope]
$ws=$A::RootElement.FindAll($S::Children,(New-Object System.Windows.Automation.PropertyCondition($A::NameProperty,"Calculator")))
foreach($w in $ws){ $r=$w.FindFirst($S::Descendants,(New-Object System.Windows.Automation.PropertyCondition($A::AutomationIdProperty,"CalculatorResults"))); if($r){$r.Current.Name} }
''').splitlines() if l.strip()]


def calc_check(final: str) -> Check:
    shown = calc_display()
    ok = any("7,006,652" in s or "7006652" in s for s in shown)
    return Check(ok, f"display={shown}")


# --- TestPad tasks -----------------------------------------------------------
# Windows Notepad restores the user's own session tabs (some hold secrets), so the
# editor tasks use TestPad (apps/TestPad.cs, built into its own exe): a WinForms editor with a menu, the
# real Save As dialog and a Replace dialog.

TESTPAD_SRC = Path(__file__).resolve().parent / "apps" / "TestPad.cs"
TESTPAD_EXE = f"{win.WIN_TEMP}\\TestPad.exe"


def build_testpad() -> None:
    """Compile apps/TestPad.cs into %TEMP%\\bcu\\TestPad.exe with the C# compiler built into
    Windows PowerShell. It must be its own exe: Codex's computer use hides terminal hosts
    such as powershell.exe, so a script-hosted window would be invisible to that stack."""
    exe = win.WSL_TEMP / "TestPad.exe"
    if exe.exists() and exe.stat().st_mtime >= TESTPAD_SRC.stat().st_mtime:
        return
    win.WSL_TEMP.mkdir(parents=True, exist_ok=True)
    shutil.copy(TESTPAD_SRC, win.WSL_TEMP / "TestPad.cs")
    out = win.ps(f"""$src = Get-Content -Raw '{win.WIN_TEMP}\\TestPad.cs'
Remove-Item '{TESTPAD_EXE}' -ErrorAction SilentlyContinue
Add-Type -TypeDefinition $src -OutputAssembly '{TESTPAD_EXE}' -OutputType WindowsApplication -ReferencedAssemblies System.Windows.Forms,System.Drawing""", timeout=120)
    if not exe.exists():
        raise RuntimeError(f"TestPad build failed: {out[-800:]}")


def open_testpad(file_wpath: str = "") -> None:
    build_testpad()
    start(TESTPAD_EXE, *([file_wpath] if file_wpath else []))
    time.sleep(2)


def edit_append_setup() -> None:
    wpath, wsl = task_dir("edit_append")
    (wsl / "notes.txt").write_text("first line\r\nsecond line\r\nthird line\r\n")
    open_testpad(f"{wpath}\\notes.txt")


def edit_append_check(final: str) -> Check:
    lines = read_lines(win.WSL_TEMP / "edit_append" / "notes.txt")
    ok = lines[:3] == ["first line", "second line", "third line"] and len(lines) == 4 and lines[3].strip() == "DONE 42"
    return Check(ok, f"lines={lines}")


def edit_saveas_setup() -> None:
    task_dir("edit_saveas")
    open_testpad()


def edit_saveas_check(final: str) -> Check:
    lines = [l.strip() for l in read_lines(win.WSL_TEMP / "edit_saveas" / "saved.txt")]
    return Check(lines == ["alpha", "beta"], f"lines={lines}")


REPLACE_TEXT = "foo one\r\nbar two foo\r\nthree foo foo\r\nfour\r\n"


def edit_replace_setup() -> None:
    wpath, wsl = task_dir("edit_replace")
    (wsl / "words.txt").write_text(REPLACE_TEXT)
    open_testpad(f"{wpath}\\words.txt")


def edit_replace_check(final: str) -> Check:
    lines = read_lines(win.WSL_TEMP / "edit_replace" / "words.txt")
    want = ["bar one", "bar two bar", "three bar bar", "four"]
    return Check(lines == want, f"lines={lines}")


# --- explorer_move ------------------------------------------------------------

def explorer_move_setup() -> None:
    wpath, wsl = task_dir("explorer_move")
    # Unknown extension on purpose: a stray double-click must not open Notepad, which
    # would restore the user's own session tabs.
    (wsl / "a.bcu").write_text("a")
    (wsl / "b.bcu").write_text("b")
    start("explorer.exe", wpath)
    time.sleep(2)


def explorer_move_check(final: str) -> Check:
    d = win.WSL_TEMP / "explorer_move"
    ok = (d / "archive" / "a.bcu").exists() and not (d / "a.bcu").exists() and (d / "b.bcu").exists()
    return Check(ok, f"contents={sorted(str(p.relative_to(d)) for p in d.rglob('*'))}")


# --- sysdm_name: classic Win32 dialog, read-only ------------------------------

def sysdm_check(final: str) -> Check:
    return Check(COMPUTER_NAME.lower() in final.lower(), f"final={final[-200:]!r}")


# --- edge_form: Chromium page in an isolated Edge profile ----------------------

FORM_HTML = """<!doctype html><html><head><meta charset="utf-8"><title>Signup form</title>
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
  const s = `name=${v('name').value}|email=${v('email').value}|plan=${v('plan').value}|agree=${v('agree').checked?'yes':'no'}`;
  document.title = 'SUBMITTED ' + s; v('out').textContent = 'Submitted: ' + s;
});
</script></body></html>"""


def edge_form_setup() -> None:
    wpath, wsl = task_dir("edge_form")
    (wsl / "form.html").write_text(FORM_HTML)
    url = "file:///" + (wpath + "\\form.html").replace("\\", "/")
    # Chromium hides a page's accessibility tree while its window is covered by another one
    # (occlusion tracking), so without these flags the task depended on what the user had on top.
    start(EDGE, f"--user-data-dir={win.WIN_TEMP}\\edge-profile", "--no-first-run", "--no-default-browser-check",
          "--force-renderer-accessibility", "--disable-features=CalculateNativeWinOcclusion,msEdgeWelcomePage,msImplicitSignin",
          "--new-window", url)
    time.sleep(4)


def edge_form_check(final: str) -> Check:
    titles = [w.title for w in win.list_windows(titles=True) if w.proc == "msedge" and "SUBMITTED" in w.title]
    want = "name=Ada Lovelace|email=ada@example.com|plan=pro|agree=yes"
    return Check(any(want in t for t in titles), f"titles={titles}")


def edge_form_teardown() -> None:
    win.ps("Get-CimInstance Win32_Process -Filter \"Name='msedge.exe'\" | "
           "Where-Object { $_.CommandLine -like '*bcu\\edge-profile*' } | "
           "ForEach-Object { Stop-Process -Id $_.ProcessId -Force -ErrorAction SilentlyContinue }")


def p(path: str) -> str:
    return f"{win.WIN_TEMP}\\{path}"


TASKS: dict[str, Task] = {t.id: t for t in [
    Task("calc_mul", "Open the Windows Calculator app and use it to compute 1234 × 5678. Report the result shown on Calculator's display.",
         lambda: None, calc_check),
    Task("edit_append", f"The TestPad text editor is open with the file {p('edit_append')}\\notes.txt. Add a new last line that says exactly DONE 42, then save the file (keep it in place).",
         edit_append_setup, edit_append_check),
    Task("edit_saveas", f"A new, empty TestPad text editor window is open. Type a document with exactly two lines, alpha and beta, then use File > Save As to save it as {p('edit_saveas')}\\saved.txt.",
         edit_saveas_setup, edit_saveas_check),
    Task("edit_replace", f"The TestPad text editor is open with the file {p('edit_replace')}\\words.txt. Use TestPad's Edit > Replace feature to replace every occurrence of foo with bar, then save the file.",
         edit_replace_setup, edit_replace_check),
    Task("explorer_move", f"A File Explorer window is open at {p('explorer_move')}. Using File Explorer, create a new folder named archive in that folder and move a.bcu into archive.",
         explorer_move_setup, explorer_move_check),
    Task("sysdm_name", "Open the classic System Properties dialog (sysdm.cpl) and report the full computer name it shows on the Computer Name tab. Close the dialog when done.",
         lambda: None, sysdm_check),
    Task("edge_form", "A Microsoft Edge window shows a Signup form. Fill it in: Name = Ada Lovelace, Email = ada@example.com, Plan = Pro, tick 'I agree to the terms', then click Submit.",
         edge_form_setup, edge_form_check, edge_form_teardown),
]}


def final_line(text: str) -> str:
    m = re.findall(r"FINAL:\s*(.*)", text)
    return m[-1] if m else text.strip().splitlines()[-1] if text.strip() else ""
