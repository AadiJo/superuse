"""Live acceptance checks for the forked Cua Driver on the Windows desktop.

    python3 fork/acceptance.py [saveas] [closedmenu] [replace] [edge] [edge_alert] [calc] [explorer] [win32menu]
        [win32menu_bypos] [menubg] [ownership] [fgpoint]

Drives the driver (BCU_CUA_DRIVER, default plugin/driver/cua-driver.exe) over
MCP stdio against windows this script opens itself (TestPad, MenuPad from
fork/apps, an Explorer window on %TEMP%\\bcu\\explorer_move, the throwaway-profile
Edge form, Calculator), records every tool call with its time, samples the
real cursor and foreground window, and writes
fork/acceptance-runs/acceptance-<time>.json. Tool calls only target windows
this script opened. Explorer windows share the shell's pid, so the explorer
check matches titles in memory to find its own window and logs none of them.
"""
from __future__ import annotations

import json
import re
import shutil
import sys
import time
from pathlib import Path

BENCH = Path(__file__).resolve().parents[1] / "bench"
sys.path.insert(0, str(BENCH))

import tasks as T  # noqa: E402
import win  # noqa: E402
from mcp_client import McpClient, text_of  # noqa: E402

import os

HERE = Path(__file__).resolve().parent
# The driver under test: BCU_CUA_DRIVER, else the one the plugin ships.
EXE = os.environ.get("BCU_CUA_DRIVER", str(HERE.parent / "plugin/driver/cua-driver.exe"))
OUT = HERE / "acceptance-runs"
ENV = {"DO_NOT_TRACK": "1", "WSLENV": "DO_NOT_TRACK"}
ROW = re.compile(r'^\s*- \[(\d+)\] (\w+)(?: "([^"]*)")?(.*)$')


class Run:
    """One MCP session plus a log of every call: tool, args, ms, error flag, text."""

    def __init__(self, client: McpClient, log: list[dict]):
        self.c, self.log = client, log

    def call(self, name: str, args: dict) -> tuple[dict, float]:
        r, ms = self.c.call(name, args)
        text = text_of(r)
        self.log.append({"tool": name, "args": args, "ms": round(ms, 1), "error": bool(r.get("isError")),
                         "text": text[:600] if name != "get_window_state" else text[:200]})
        print(f"  {name:18} {ms:7.1f} ms {'ERR ' if r.get('isError') else ''}{text[:260]!r}")
        return r, ms

    def state(self, pid: int, hwnd: int, query: str | None = None) -> tuple[str, list[tuple[str, str, str, str]], float]:
        args = {"pid": pid, "window_id": hwnd, "include_screenshot": False}
        if query:
            args["query"] = query
        r, ms = self.call("get_window_state", args)
        sc = r.get("structuredContent") or {}
        snap = sc.get("snapshot_id", "")
        rows = []
        for line in sc.get("tree_markdown", "").splitlines():
            m = ROW.match(line)
            if m:
                rows.append((f"{snap}:{m.group(1)}", m.group(2), m.group(3) or "", m.group(4)))
        return snap, rows, ms


def code_of(r: dict) -> str | None:
    """The structured error code of a tool result, wherever its envelope puts it."""
    sc = r.get("structuredContent") or {}
    return sc.get("code") or (sc.get("refusal") or {}).get("code") or (sc.get("error") or {}).get("code")


def find(rows, role: str, name: str, contains: bool = False) -> tuple[str, str, str, str]:
    for row in rows:
        if row[1] == role and (name in row[2] if contains else row[2] == name):
            return row
    raise LookupError(f"no {role} {name!r} in {[(r[1], r[2]) for r in rows][:60]}")


def windows_of(pids: set[int]) -> list[win.Win]:
    return [w for w in win.list_windows(titles=True) if w.pid in pids]


def wait_window(pids: set[int], pred, timeout: float = 10) -> win.Win:
    end = time.time() + timeout
    while time.time() < end:
        for w in windows_of(pids):
            if pred(w):
                return w
        time.sleep(0.3)
    raise LookupError("window not found")


def sampled(fn):
    """Run `fn` under the cursor/foreground sampler. The summary adds `foreground_sequence`: each
    foreground window in turn, so a change can be traced to the window that took it."""
    s = win.Sampler()
    s.start()
    try:
        out = fn()
    finally:
        s.stop()
    summary = s.summary()
    seq = [smp.fg for smp in s.samples]
    summary["foreground_sequence"] = [fg for i, fg in enumerate(seq) if i == 0 or fg != seq[i - 1]]
    return out, summary


def no_foreground_steal(summary: dict, own: set[int]) -> bool:
    """No foreground change, or only among the app's own windows `own`. An app that launched into the
    foreground hands it to its own dialog and back; that isn't the driver activating anything."""
    return summary.get("foreground_changes") == 0 or set(summary.get("foreground_sequence", [])) <= own


def testpad() -> win.Win:
    return wait_window(set(p.pid for p in win.list_windows() if p.proc == "TestPad"),
                       lambda w: w.title.endswith("TestPad"))


# --- 1. Save As -------------------------------------------------------------

def check_saveas(run: Run) -> dict:
    T.edit_saveas_setup()
    tp = testpad()
    pid = tp.pid
    target = rf"{win.WIN_TEMP}\edit_saveas\saved.txt"

    def body() -> dict:
        res: dict = {}
        _, rows, _ = run.state(pid, tp.hwnd)
        run.call("set_value", {"pid": pid, "element_token": find(rows, "Edit", "Text editor")[0], "value": "alpha\r\nbeta"})
        r, res["invoke_menu_ms"] = run.call("invoke_menu", {"pid": pid, "window_id": tp.hwnd, "path": ["File", "Save As..."]})
        res["invoke_menu_text"] = text_of(r)
        dlg = wait_window({pid}, lambda w: w.title == "Save As", timeout=5)
        res["own_windows"] = [tp.hwnd, dlg.hwnd]
        _, rows, res["dialog_state_ms"] = run.state(pid, dlg.hwnd)
        res["dialog_elements"] = len(rows)
        name = find(rows, "Edit", "File name:")
        run.call("set_value", {"pid": pid, "element_token": name[0], "value": target})
        r, res["save_click_ms"] = run.call("click", {"pid": pid, "element_token": find(rows, "Button", "Save")[0]})
        res["save_click_text"] = text_of(r)
        time.sleep(0.5)
        return res

    res, res_s = sampled(body)
    lines = T.read_lines(win.WSL_TEMP / "edit_saveas" / "saved.txt")
    title = next((w.title for w in windows_of({pid}) if w.title.endswith("TestPad")), "")
    res.update(sampler=res_s, file_lines=lines, title=title,
               passed=lines == ["alpha", "beta"] and title == "saved.txt - TestPad"
               and res["invoke_menu_ms"] < 500 and res["dialog_elements"] > 0)
    return res


# --- 1b. Click a MenuItem token of a closed drop-down ------------------------

def check_closedmenu(run: Run) -> dict:
    T.edit_saveas_setup()
    tp = testpad()
    pid = tp.pid

    def body() -> dict:
        res: dict = {}
        _, rows, _ = run.state(pid, tp.hwnd)
        # File is closed: "Save As..." is in the tree but has no rectangle.
        r, res["click_ms"] = run.call("click", {"pid": pid, "element_token": find(rows, "MenuItem", "Save As...")[0]})
        res["click_text"] = text_of(r)
        res["click_error"] = bool(r.get("isError"))
        dlg = wait_window({pid}, lambda w: w.title == "Save As", timeout=5)
        res["own_windows"] = [tp.hwnd, dlg.hwnd]
        _, rows, res["dialog_state_ms"] = run.state(pid, dlg.hwnd)
        res["dialog_elements"] = len(rows)
        run.call("click", {"pid": pid, "element_token": find(rows, "Button", "Cancel")[0]})
        time.sleep(0.3)
        return res

    res, res_s = sampled(body)
    res.update(sampler=res_s,
               passed=not res["click_error"] and "closed drop-down" in res["click_text"]
               and res["click_ms"] < 1000 and res["dialog_elements"] > 0
               and no_foreground_steal(res_s, set(res["own_windows"])) and res_s.get("cursor_max_displacement_px") == 0)
    return res


# --- 2. Replace + Ctrl+S --------------------------------------------------------

def check_replace(run: Run) -> dict:
    T.edit_replace_setup()
    tp = testpad()
    pid = tp.pid

    def body() -> dict:
        res: dict = {}
        r, res["invoke_menu_ms"] = run.call("invoke_menu", {"pid": pid, "window_id": tp.hwnd, "path": ["Edit", "Replace..."]})
        res["invoke_menu_text"] = text_of(r)
        dlg = wait_window({pid}, lambda w: w.title == "Replace", timeout=5)
        _, rows, res["dialog_state_ms"] = run.state(pid, dlg.hwnd)
        res["dialog_elements"] = len(rows)
        run.call("set_value", {"pid": pid, "element_token": find(rows, "Edit", "Find what")[0], "value": "foo"})
        run.call("set_value", {"pid": pid, "element_token": find(rows, "Edit", "Replace with")[0], "value": "bar"})
        r, res["replace_all_ms"] = run.call("click", {"pid": pid, "element_token": find(rows, "Button", "Replace All")[0]})
        res["replace_all_text"] = text_of(r)
        _, rows, _ = run.state(pid, tp.hwnd)
        res["editor_row"] = find(rows, "Edit", "Text editor")[3]
        r, res["hotkey_ms"] = run.call("hotkey", {"pid": pid, "window_id": tp.hwnd, "keys": ["ctrl", "s"]})
        time.sleep(0.5)
        return res

    res, res_s = sampled(body)
    lines = T.read_lines(win.WSL_TEMP / "edit_replace" / "words.txt")
    res.update(sampler=res_s, file_lines=lines,
               passed=lines == ["bar one", "bar two bar", "three bar bar", "four"] and "foo" not in res["editor_row"])
    return res


# --- 3. Edge form -----------------------------------------------------------

def edge_pids() -> set[int]:
    out = win.ps("Get-CimInstance Win32_Process -Filter \"Name='msedge.exe'\" | "
                 "Where-Object { $_.CommandLine -like '*bcu\\edge-profile*' } | ForEach-Object { $_.ProcessId }")
    return {int(x) for x in out.split() if x.isdigit()}


def check_edge(run: Run) -> dict:
    T.edge_form_setup()
    pids = edge_pids()
    ew = wait_window(pids, lambda w: w.cls == "Chrome_WidgetWin_1" and "Signup form" in w.title, timeout=15)
    pid = ew.pid

    def plan(rows) -> str:
        return find(rows, "ComboBox", "Plan")[3]

    def body() -> dict:
        res: dict = {"steps": []}
        step = lambda name, r, ms: res["steps"].append({"step": name, "ms": round(ms, 1), "error": bool(r.get("isError")), "text": text_of(r)[:300]})
        _, rows, _ = run.state(pid, ew.hwnd)
        r, ms = run.call("set_value", {"pid": pid, "element_token": find(rows, "Edit", "Name")[0], "value": "Ada Lovelace"}); step("name", r, ms)
        r, ms = run.call("set_value", {"pid": pid, "element_token": find(rows, "Edit", "Email")[0], "value": "ada@example.com"}); step("email", r, ms)
        # (a) set_value on the <select>
        r, ms = run.call("set_value", {"pid": pid, "element_token": find(rows, "ComboBox", "Plan")[0], "value": "Team"}); step("plan set_value Team", r, ms)
        _, rows, _ = run.state(pid, ew.hwnd)
        res["plan_after_set_value"] = plan(rows)
        # (b) expand + option click with action select
        r, ms = run.call("click", {"pid": pid, "element_token": find(rows, "ComboBox", "Plan")[0], "action": "expand"}); step("plan expand", r, ms)
        time.sleep(0.3)
        _, rows, _ = run.state(pid, ew.hwnd)
        r, ms = run.call("click", {"pid": pid, "element_token": find(rows, "ListItem", "Free")[0], "action": "select"}); step("option Free select", r, ms)
        time.sleep(0.3)
        _, rows, _ = run.state(pid, ew.hwnd)
        res["plan_after_select"] = plan(rows)
        # (c) expand + plain option click (no action)
        r, ms = run.call("click", {"pid": pid, "element_token": find(rows, "ComboBox", "Plan")[0], "action": "expand"}); step("plan expand", r, ms)
        time.sleep(0.3)
        _, rows, _ = run.state(pid, ew.hwnd)
        r, ms = run.call("click", {"pid": pid, "element_token": find(rows, "ListItem", "Pro")[0]}); step("option Pro click", r, ms)
        time.sleep(0.3)
        _, rows, _ = run.state(pid, ew.hwnd)
        res["plan_after_click"] = plan(rows)
        # (d) set_value back to Pro by name, case-insensitively, after a change
        r, ms = run.call("set_value", {"pid": pid, "element_token": find(rows, "ComboBox", "Plan")[0], "value": "team"}); step("plan set_value team", r, ms)
        r, ms = run.call("set_value", {"pid": pid, "element_token": find(rows, "ComboBox", "Plan")[0], "value": "Pro"}); step("plan set_value Pro", r, ms)
        _, rows, _ = run.state(pid, ew.hwnd)
        res["plan_final"] = plan(rows)
        r, ms = run.call("click", {"pid": pid, "element_token": find(rows, "CheckBox", "I agree to the terms")[0]}); step("agree", r, ms)
        time.sleep(0.2)
        _, rows, _ = run.state(pid, ew.hwnd)
        res["agree_row"] = find(rows, "CheckBox", "I agree to the terms")[3]
        r, ms = run.call("click", {"pid": pid, "element_token": find(rows, "Button", "Submit")[0]}); step("submit", r, ms)
        time.sleep(1.0)
        return res

    try:
        res, res_s = sampled(body)
        titles = [w.title for w in windows_of(pids) if w.cls == "Chrome_WidgetWin_1"]
        want = "SUBMITTED name=Ada Lovelace|email=ada@example.com|plan=pro|agree=yes"
        res.update(sampler=res_s, titles=titles, passed=any(t.startswith(want) for t in titles))
    finally:
        T.edge_form_teardown()
    return res


# --- 3b. Does Chromium's UIA Invoke block on a page that calls alert()? -----------

ALERT_HTML = """<!doctype html><html><head><meta charset="utf-8"><title>Alert test</title></head><body>
<button onclick="alert('hello from page')">Show alert</button></body></html>"""


def check_edge_alert(run: Run) -> dict:
    form = T.FORM_HTML
    T.FORM_HTML = ALERT_HTML  # same throwaway-profile launch as the form task, different page
    try:
        T.edge_form_setup()
    finally:
        T.FORM_HTML = form
    pids = edge_pids()
    ew = wait_window(pids, lambda w: w.cls == "Chrome_WidgetWin_1" and "Alert test" in w.title, timeout=15)
    pid = ew.pid

    def body() -> dict:
        res: dict = {}
        _, rows, _ = run.state(pid, ew.hwnd)
        r, res["invoke_ms"] = run.call("click", {"pid": pid, "element_token": find(rows, "Button", "Show alert")[0]})
        res["invoke_text"] = text_of(r)
        time.sleep(0.5)
        _, rows, res["state_after_ms"] = run.state(pid, ew.hwnd)
        res["alert_rows"] = [(r[1], r[2]) for r in rows if "hello from page" in r[2] or r[2] in ("OK", "Cancel")]
        return res

    try:
        res, res_s = sampled(body)
        res.update(sampler=res_s, passed=res["invoke_ms"] < 1500 and "Dispatched" not in res["invoke_text"])
    finally:
        T.edge_form_teardown()
    return res


# --- 5. File Explorer: new folder, move a file, all in the background ---------

def check_explorer(run: Run) -> dict:
    T.explorer_move_setup()
    ew = wait_window({w.pid for w in win.list_windows() if w.proc == "explorer"},
                     lambda w: w.cls == "CabinetWClass" and w.title.startswith("explorer_move"), timeout=10)
    pid, hwnd = ew.pid, ew.hwnd
    d = win.WSL_TEMP / "explorer_move"

    def wait_for(pred, timeout: float = 3.0) -> bool:
        end = time.time() + timeout
        while time.time() < end:
            if pred():
                return True
            time.sleep(0.1)
        return False

    def body() -> dict:
        res: dict = {"steps": []}

        def step(name: str, tool: str, args: dict) -> dict:
            r, ms = run.call(tool, args)
            res["steps"].append({"step": name, "ms": round(ms, 1), "error": bool(r.get("isError"))})
            return r

        run.state(pid, hwnd)
        step("new folder", "hotkey", {"pid": pid, "window_id": hwnd, "keys": ["ctrl", "shift", "n"]})
        res["new_folder_created"] = wait_for(lambda: (d / "New folder").exists())
        step("type name", "type_text", {"pid": pid, "window_id": hwnd, "text": "archive"})
        step("enter", "press_key", {"pid": pid, "window_id": hwnd, "key": "return"})
        res["renamed"] = wait_for(lambda: (d / "archive").is_dir())
        for _ in range(10):  # the view lists the renamed folder a moment after the disk does
            _, rows, _ = run.state(pid, hwnd)
            if any(r[1] == "ListItem" and r[2] == "archive" for r in rows):
                break
            time.sleep(0.2)
        step("select a.bcu", "click", {"pid": pid, "element_token": find(rows, "ListItem", "a.bcu")[0], "action": "select"})
        step("cut", "hotkey", {"pid": pid, "window_id": hwnd, "keys": ["ctrl", "x"]})
        step("open archive", "click", {"pid": pid, "element_token": find(rows, "ListItem", "archive")[0]})
        res["navigated"] = wait_for(lambda: any(w.hwnd == hwnd and w.title.startswith("archive")
                                                for w in windows_of({pid})), timeout=5)
        step("paste", "hotkey", {"pid": pid, "window_id": hwnd, "keys": ["ctrl", "v"]})
        res["moved"] = wait_for(lambda: (d / "archive" / "a.bcu").exists() and not (d / "a.bcu").exists())
        res["tool_ms_total"] = round(sum(s["ms"] for s in res["steps"]), 1)
        return res

    res, res_s = sampled(body)
    contents = sorted(str(p.relative_to(d)).replace("\\", "/") for p in d.rglob("*"))
    res.update(sampler=res_s, contents=contents,
               passed=contents == ["archive", "archive/a.bcu", "b.bcu"]
               and not any(s["error"] for s in res["steps"])
               and res_s.get("cursor_max_displacement_px") == 0)
    return res


# --- 6. Win32 menu bar (HMENU): commands posted without opening the menu -----

MENUPAD_SRC = HERE / "apps" / "MenuPad.cs"


def open_menupad(*args: str, title: str = "MenuPad") -> win.Win:
    """Build fork/apps/MenuPad.cs into %TEMP%\\bcu\\MenuPad.exe (like TestPad) and start it with `args`
    (Start-Process joins them with spaces, so no spaces inside one). Returns the new window titled `title`."""
    exe = win.WSL_TEMP / "MenuPad.exe"
    if not exe.exists() or exe.stat().st_mtime < MENUPAD_SRC.stat().st_mtime:
        shutil.copy(MENUPAD_SRC, win.WSL_TEMP / "MenuPad.cs")
        win.ps(f"""Remove-Item '{win.WIN_TEMP}\\MenuPad.exe' -ErrorAction SilentlyContinue
Add-Type -TypeDefinition (Get-Content -Raw '{win.WIN_TEMP}\\MenuPad.cs') -OutputAssembly '{win.WIN_TEMP}\\MenuPad.exe' -OutputType WindowsApplication -ReferencedAssemblies System.Windows.Forms,System.Drawing""", timeout=120)
    before = {w.hwnd for w in win.list_windows() if w.proc == "MenuPad"}
    T.start(f"{win.WIN_TEMP}\\MenuPad.exe", *args)
    end = time.time() + 10
    while time.time() < end:
        found = [w for w in win.list_windows(titles=True)
                 if w.proc == "MenuPad" and w.title == title and w.hwnd not in before]
        if found:
            return found[0]
        time.sleep(0.3)
    raise LookupError(f"MenuPad window {title!r} not found")


def stop_menupads() -> None:
    win.ps("Stop-Process -Name MenuPad -Force -ErrorAction SilentlyContinue")


def check_win32menu(run: Run) -> dict:
    mp = open_menupad()
    pid = mp.pid

    def body() -> dict:
        res: dict = {}
        r, res["stamp_ms"] = run.call("invoke_menu", {"pid": pid, "window_id": mp.hwnd, "path": ["Edit", "Stamp"]})
        res["stamp_text"] = text_of(r)
        time.sleep(0.2)
        _, rows, _ = run.state(pid, mp.hwnd)
        res["editor_row"] = find(rows, "Edit", "Text editor")[3]
        r, res["saveas_ms"] = run.call("invoke_menu", {"pid": pid, "window_id": mp.hwnd, "path": ["File", "Save As..."]})
        res["saveas_text"] = text_of(r)
        dlg = wait_window({pid}, lambda w: w.title == "Save As", timeout=5)
        res["own_windows"] = [mp.hwnd, dlg.hwnd]
        _, rows, res["dialog_state_ms"] = run.state(pid, dlg.hwnd)
        res["dialog_elements"] = len(rows)
        r, res["cancel_ms"] = run.call("click", {"pid": pid, "element_token": find(rows, "Button", "Cancel")[0]})
        time.sleep(0.3)
        return res

    try:
        res, res_s = sampled(body)
    finally:
        stop_menupads()
    res.update(sampler=res_s,
               passed="WM_COMMAND" in res["stamp_text"] and "stamped" in res["editor_row"]
               and "WM_COMMAND" in res["saveas_text"] and res["dialog_elements"] > 0
               and no_foreground_steal(res_s, set(res["own_windows"])) and res_s.get("cursor_max_displacement_px") == 0)
    return res


# --- 6b. MNS_NOTIFYBYPOS menu bar: WM_MENUCOMMAND, not WM_COMMAND ------------

def check_win32menu_bypos(run: Run) -> dict:
    mp = open_menupad("--bypos", "--title", "MenuPad-bypos", title="MenuPad-bypos")
    pid = mp.pid

    def body() -> dict:
        res: dict = {}
        # Stamp is Edit's third item (Clear, separator, Stamp): position 2.
        r, res["stamp_ms"] = run.call("invoke_menu", {"pid": pid, "window_id": mp.hwnd, "path": ["Edit", "Stamp"]})
        res["stamp_text"] = text_of(r)
        time.sleep(0.2)
        _, rows, _ = run.state(pid, mp.hwnd)
        res["editor_row"] = find(rows, "Edit", "Text editor")[3]
        return res

    try:
        res, res_s = sampled(body)
    finally:
        stop_menupads()
    res.update(sampler=res_s,
               passed="WM_MENUCOMMAND (position 2)" in res["stamp_text"]
               and "via-WM_MENUCOMMAND stamped" in res["editor_row"]
               and res_s.get("foreground_changes") == 0 and res_s.get("cursor_max_displacement_px") == 0)
    return res


# --- 6c. invoke_menu delivery_mode: background never activates ----------------

def check_menubg(run: Run) -> dict:
    mp = open_menupad()
    pid = mp.pid

    def call(name: str, args: dict, res: dict) -> None:
        r, ms = run.call("invoke_menu", {"pid": pid, "window_id": mp.hwnd, **args})
        res[name] = {"ms": round(ms, 1), "error": bool(r.get("isError")), "code": code_of(r), "text": text_of(r)[:300]}

    def background() -> dict:
        res: dict = {}
        # Disabled in the static HMENU, and a typo: both need the menu opened, so the window active.
        call("disabled", {"path": ["File", "Disabled item"]}, res)
        call("typo", {"path": ["Edit", "Stomp"]}, res)
        call("stamp", {"path": ["Edit", "Stamp"]}, res)
        time.sleep(0.2)
        _, rows, _ = run.state(pid, mp.hwnd)
        res["editor_row"] = find(rows, "Edit", "Text editor")[3]
        return res

    def foreground() -> dict:
        res: dict = {}
        call("disabled_fg", {"path": ["File", "Disabled item"], "delivery_mode": "foreground"}, res)
        time.sleep(0.5)
        return res

    try:
        res, res_s = sampled(background)
        res_fg, res_fg_s = sampled(foreground)
    finally:
        stop_menupads()
    res.update(res_fg, sampler=res_s, sampler_foreground=res_fg_s)
    res.update(passed=res["disabled"]["code"] == "background_unavailable"
               and res["typo"]["code"] == "background_unavailable" and "Stomp" in res["typo"]["text"]
               and not res["stamp"]["error"] and "stamped" in res["editor_row"]
               and res_s.get("foreground_changes") == 0 and res_s.get("cursor_max_displacement_px") == 0
               and res["disabled_fg"]["error"] and res["disabled_fg"]["code"] != "background_unavailable"
               and res_fg_s.get("foreground_restored") is True)
    return res


# --- 7. Window ownership: a pid that doesn't own the window is refused ---------

def check_ownership(run: Run) -> dict:
    mp = open_menupad()
    pid = mp.pid
    other = 4  # System: owns no window, so (4, MenuPad's hwnd) is a mismatched pair

    def body() -> dict:
        res: dict = {}

        def call(name: str, tool: str, args: dict) -> None:
            r, ms = run.call(tool, args)
            res[name] = {"ms": round(ms, 1), "error": bool(r.get("isError")), "code": code_of(r), "text": text_of(r)[:300]}

        call("press_key_mismatch", "press_key", {"pid": other, "window_id": mp.hwnd, "key": "a"})
        call("hotkey_mismatch", "hotkey", {"pid": other, "window_id": mp.hwnd, "keys": ["ctrl", "a"]})
        call("type_text_mismatch", "type_text", {"pid": other, "window_id": mp.hwnd, "text": "x"})
        call("click_fg_mismatch", "click", {"pid": other, "window_id": mp.hwnd, "x": 60, "y": 120,
                                            "delivery_mode": "foreground"})
        _, rows, _ = run.state(pid, mp.hwnd)
        res["editor_row"] = find(rows, "Edit", "Text editor")[3]
        token = find(rows, "Edit", "Text editor")[0]
        # The token's window closes: its HWND is dead, and the token must not reach anything.
        stop_menupads()
        end = time.time() + 5
        while time.time() < end and any(w.hwnd == mp.hwnd for w in win.list_windows()):
            time.sleep(0.2)
        call("token_closed_window", "press_key", {"element_token": token, "key": "a"})
        return res

    try:
        res, res_s = sampled(body)
    finally:
        stop_menupads()
    mismatches = ["press_key_mismatch", "hotkey_mismatch", "type_text_mismatch", "click_fg_mismatch"]
    res.update(sampler=res_s,
               passed=all(res[k]["code"] == "window_target_mismatch" for k in mismatches)
               and res["token_closed_window"]["code"] == "window_target_not_found"
               and re.search(r'value="[^"]', res["editor_row"]) is None  # nothing was typed
               and res_s.get("foreground_changes") == 0 and res_s.get("cursor_max_displacement_px") == 0)
    return res


# --- 8. Foreground pixel input must land on the target ------------------------

def bounds_of(run: Run, pid: int, hwnd: int) -> tuple[int, int, int, int]:
    """DWM frame bounds of a window in screen pixels, from the driver's list_windows."""
    r, _ = run.call("list_windows", {"pid": pid})
    for w in (r.get("structuredContent") or {}).get("windows", []):
        if w.get("window_id") == hwnd:
            b = w.get("bounds") or w
            return b["x"], b["y"], b["width"], b["height"]
    raise LookupError(f"window {hwnd} not in list_windows")


HIT_PS = r'''
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
'''


def top_window_at(x: int, y: int) -> int:
    """Top-level window at screen pixel (x, y), as a per-monitor DPI-aware caller sees it."""
    out = win.ps(HIT_PS.replace("%X%", str(x)).replace("%Y%", str(y))).split()
    return int(out[-1]) if out and out[-1].lstrip("-").isdigit() else 0


def check_fgpoint(run: Run) -> dict:
    """A: target. B: an always-on-top window over part of A, which activating A doesn't uncover. C: an
    ordinary window over another part of A, which activating A does uncover. C opens last, so A is
    not the foreground window and a refusal that activated A first would show up."""
    a = open_menupad("--at", "100", "100", "--title", "MenuPad-A", title="MenuPad-A")
    b = open_menupad("--topmost", "--at", "360", "220", "--title", "MenuPad-B", title="MenuPad-B")
    c = open_menupad("--at", "40", "330", "--title", "MenuPad-C", title="MenuPad-C")

    def setup() -> dict:
        ax, ay, aw, ah = bounds_of(run, a.pid, a.hwnd)
        bx, by, bw, bh = bounds_of(run, b.pid, b.hwnd)
        cx, cy, cw, ch = bounds_of(run, c.pid, c.hwnd)
        # Screenshot pixels map to screen as frame origin + 1 (bitmap_to_screen); the windows are small
        # enough that the screenshot isn't downscaled.
        local = lambda sx, sy: (sx - ax - 1, sy - ay - 1)
        covered = local((max(ax, bx) + min(ax + aw, bx + bw)) // 2, (max(ay, by) + min(ay + ah, by + bh)) // 2)
        # In A and C, left of B.
        clear_screen = ((max(ax, cx) + min(bx, ax + aw, cx + cw)) // 2, (max(ay, cy) + min(ay + ah, cy + ch)) // 2)
        r, _ = run.call("get_window_state", {"pid": a.pid, "window_id": a.hwnd, "include_screenshot": True})
        return {"a_bounds": [ax, ay, aw, ah], "b_bounds": [bx, by, bw, bh], "c_bounds": [cx, cy, cw, ch],
                "covered": covered, "clear": local(*clear_screen), "clear_screen": clear_screen}

    pts = setup()
    target = {"pid": a.pid, "window_id": a.hwnd}

    def call(res: dict, name: str, tool: str, args: dict) -> None:
        r, ms = run.call(tool, {**target, **args})
        res[name] = {"ms": round(ms, 1), "error": bool(r.get("isError")), "code": code_of(r), "text": text_of(r)[:300],
                     "hit_pid": (r.get("structuredContent") or {}).get("hit_pid")}

    def outside() -> dict:
        res: dict = {}
        call(res, "click_outside", "click", {"x": -40, "y": 120, "delivery_mode": "foreground"})
        call(res, "drag_outside", "drag", {"from_x": -40, "from_y": 120, "to_x": 60, "to_y": 120,
                                            "delivery_mode": "foreground"})
        x, y = pts["covered"]
        call(res, "click_covered_bg", "click", {"x": x, "y": y})
        return res

    def covered() -> dict:
        res: dict = {}
        x, y = pts["covered"]
        call(res, "click_covered_fg", "click", {"x": x, "y": y, "delivery_mode": "foreground"})
        # After a foreground call the driver polls for 3 s and restores the prior foreground whenever the
        # target's app holds it, so a second foreground call on the same app inside that window can be undone.
        time.sleep(3.5)
        return res

    def clear() -> dict:
        res: dict = {"clear_hit_before": top_window_at(*pts["clear_screen"]), "a_hwnd": a.hwnd, "c_hwnd": c.hwnd}
        x, y = pts["clear"]
        call(res, "click_clear_fg", "click", {"x": x, "y": y, "delivery_mode": "foreground"})
        time.sleep(0.6)
        return res

    try:
        res, res_s = sampled(outside)
        res_c, res_c_s = sampled(covered)
        res_ok, res_ok_s = sampled(clear)
    finally:
        stop_menupads()
    res.update(pts, **res_c, **res_ok, sampler=res_s, sampler_covered=res_c_s, sampler_clear=res_ok_s)
    res["passed"] = (res["click_outside"]["code"] == "target_not_at_point"
                     and res["drag_outside"]["code"] == "target_not_at_point"
                     and not res["click_covered_bg"]["error"]
                     and res_s.get("foreground_changes") == 0 and res_s.get("cursor_max_displacement_px") == 0
                     and res["click_covered_fg"]["code"] == "target_not_at_point"
                     and res["click_covered_fg"]["hit_pid"] == b.pid
                     and res_c_s.get("cursor_max_displacement_px") == 0 and res_c_s.get("foreground_changes") == 0
                     # another window covered the point until activation raised A, and the click wasn't refused
                     and res["clear_hit_before"] not in (0, a.hwnd) and not res["click_clear_fg"]["error"])
    return res


# --- 4. Calculator (UWP regression) ------------------------------------------

def check_calc(run: Run) -> dict:
    def body() -> dict:
        res: dict = {}
        r, res["launch_ms"] = run.call("launch_app", {"aumid": "Microsoft.WindowsCalculator_8wekyb3d8bbwe!App"})
        sc = r.get("structuredContent") or {}
        res["launch_keys"] = sorted(sc.keys())
        pid = sc.get("pid")
        wins = sc.get("windows") or []
        hwnd = wins[0].get("window_id") if wins else None
        res["pid"], res["hwnd"] = pid, hwnd
        _, rows, _ = run.state(pid, hwnd)
        names = ["One", "Two", "Multiply by", "One", "Two", "Equals"]
        res["clicks_ms"] = []
        for n in names:
            r, ms = run.call("click", {"pid": pid, "element_token": find(rows, "Button", n)[0]})
            res["clicks_ms"].append(round(ms, 1))
        time.sleep(0.3)
        _, rows, _ = run.state(pid, hwnd)
        res["display"] = [r[2] for r in rows if "Display is" in r[2]] or [r[2] for r in rows if r[1] == "Text" and "Display" in r[2]]
        return res

    res, res_s = sampled(body)
    shown = T.calc_display()
    res.update(sampler=res_s, display_uia=shown, passed=any(s.strip().endswith("144") for s in shown))
    return res


CHECKS = {"saveas": check_saveas, "closedmenu": check_closedmenu, "replace": check_replace, "edge": check_edge,
          "edge_alert": check_edge_alert, "calc": check_calc, "explorer": check_explorer,
          "win32menu": check_win32menu, "win32menu_bypos": check_win32menu_bypos, "menubg": check_menubg,
          "ownership": check_ownership, "fgpoint": check_fgpoint}


def main() -> None:
    names = sys.argv[1:] or list(CHECKS)
    results: dict = {}
    log: list[dict] = []
    for name in names:
        print(f"== {name}")
        before = win.list_windows()
        try:
            with McpClient([EXE, "mcp"], env=ENV) as c:
                results[name] = CHECKS[name](Run(c, log))
        except Exception as e:  # record and keep going
            results[name] = {"passed": False, "exception": repr(e)[:800]}
        finally:
            print("  closed:", win.close_new_windows(before))
            win.ps("Stop-Process -Name TestPad -Force -ErrorAction SilentlyContinue")
        print(f"  -> passed={results[name].get('passed')} sampler={results[name].get('sampler')}")
    OUT.mkdir(exist_ok=True)
    out = OUT / f"acceptance-{time.strftime('%Y%m%d-%H%M%S')}.json"
    out.write_text(json.dumps({"results": results, "calls": log}, indent=1))
    print("written:", out)


if __name__ == "__main__":
    main()
