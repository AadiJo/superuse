"""Live acceptance checks for the fork-v2 Cua Driver on the Windows desktop.

    python3 fork/acceptance.py [saveas] [replace] [edge] [calc]

Drives v2/cua-driver.exe over MCP stdio against windows this script opens
itself (TestPad, the throwaway-profile Edge form, Calculator), records every
tool call with its time, samples the real cursor and foreground window, and
writes fork/acceptance-runs/acceptance-<time>.json. Only windows of pids this script launched
are listed or read.
"""
from __future__ import annotations

import json
import re
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
    s = win.Sampler()
    s.start()
    try:
        out = fn()
    finally:
        s.stop()
    return out, s.summary()


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


CHECKS = {"saveas": check_saveas, "replace": check_replace, "edge": check_edge,
          "edge_alert": check_edge_alert, "calc": check_calc}


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
