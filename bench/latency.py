"""Model-free latency of each CU stack's primitive operations on one TestPad window.

    python3 latency.py            # writes out/latency-<time>.json and prints a table

Calls each stack's MCP tools directly (no LLM), N times per operation, against a
TestPad window this script opens and closes. Also records whether the user's
cursor or foreground window changed during the stack's operations.
"""
from __future__ import annotations

import json
import statistics
import time
from pathlib import Path
from typing import Callable

import tasks as T
import win
from mcp_client import McpClient, image_count, text_of

ROOT = Path(__file__).resolve().parent
N = 5
CUA_ENV = {"DO_NOT_TRACK": "1", "WSLENV": "DO_NOT_TRACK"}


def timed(fn: Callable[[], object], n: int = N) -> dict[str, object]:
    ms, err = [], None
    for _ in range(n):
        t0 = time.perf_counter()
        try:
            fn()
        except Exception as e:  # keep going; record the failure
            err = str(e)[:200]
        ms.append((time.perf_counter() - t0) * 1000)
    return {"median_ms": round(statistics.median(ms), 1), "min_ms": round(min(ms), 1), "error": err}


def check(r: dict) -> dict:
    if r.get("isError"):
        raise RuntimeError(text_of(r)[:200])
    return r


def testpad_window() -> win.Win:
    for _ in range(20):
        ws = [w for w in win.list_windows(titles=True) if w.proc == "TestPad" and "TestPad" in w.title]
        if ws:
            return ws[0]
        time.sleep(0.5)
    raise RuntimeError("TestPad window not found")


def bench_cua(exe: Path, w: win.Win) -> dict[str, object]:
    with McpClient([str(exe), "mcp"], env=CUA_ENV) as c:
        res: dict[str, object] = {}
        call = lambda name, args: check(c.call(name, args)[0])
        res["list_windows"] = timed(lambda: call("list_windows", {"on_screen_only": True}))
        res["tree"] = timed(lambda: call("get_window_state", {"pid": w.pid, "window_id": w.hwnd, "include_screenshot": False}))
        res["tree+screenshot"] = timed(lambda: call("get_window_state", {"pid": w.pid, "window_id": w.hwnd, "include_screenshot": True, "max_image_dimension": 1200}))
        state = call("get_window_state", {"pid": w.pid, "window_id": w.hwnd, "include_screenshot": False, "query": "Text editor"})
        data = json.loads(text_of(state)) if text_of(state).startswith("{") else (state.get("structuredContent") or {})
        snap = data.get("snapshot_id")
        row = next((int(l.split("[")[1].split("]")[0]) for l in data.get("tree_markdown", "").splitlines() if "[" in l and "Text editor" in l), None)
        token = f"{snap}:{row}"
        res["set_value"] = timed(lambda: call("set_value", {"element_token": token, "pid": w.pid, "value": "hello"}))
        res["type_text(5 chars)"] = timed(lambda: call("type_text", {"element_token": token, "text": "abcde"}))
        res["hotkey ctrl+a"] = timed(lambda: call("hotkey", {"pid": w.pid, "window_id": w.hwnd, "keys": ["ctrl", "a"]}))
        return res


def bench_codex(w: win.Win) -> dict[str, object]:
    with McpClient([str(ROOT / "codex_cu_bridge.py")], env={"CODEX_CU_AUTO_APPROVE": "1"}) as c:
        js = lambda code: check(c.call("js", {"code": code}, timeout=180)[0])
        res: dict[str, object] = {}
        res["list_windows"] = timed(lambda: js("await cua.listWindows({emit:false});"))
        js(f"globalThis.app = await cua.getApp({{windowId:{w.hwnd}}});")
        res["tree"] = timed(lambda: js("await app.getAXState();"))
        res["tree+screenshot"] = timed(lambda: js("await app.getAXStateAndScreenshot();"))
        res["type_text(5 chars)"] = timed(lambda: js('await app.typeText("abcde");'))
        res["hotkey ctrl+a"] = timed(lambda: js('await app.pressKey("ctrl+a");'))
        return res


def main() -> None:
    results: dict[str, object] = {}
    stacks = {
        "cua-driver main": lambda w: bench_cua(ROOT.parent / "tools/cua-driver-main/cua-driver.exe", w),
        "codex runtime": bench_codex,
    }
    for name, fn in stacks.items():
        before = win.list_windows()
        T.edit_append_setup()  # opens TestPad on a scratch file
        w = testpad_window()
        sampler = win.Sampler()
        sampler.start()
        try:
            results[name] = {"ops": fn(w)}
        finally:
            sampler.stop()
        results[name]["disturbance"] = sampler.summary()  # type: ignore[index]
        win.close_new_windows(before)
        time.sleep(1)
    out = ROOT / "out" / f"latency-{time.strftime('%Y%m%d-%H%M%S')}.json"
    out.write_text(json.dumps(results, indent=2))
    ops = sorted({op for r in results.values() for op in r["ops"]})  # type: ignore[index]
    print(f"{'operation':22}" + "".join(f"{n:>20}" for n in results))
    for op in ops:
        cells = []
        for r in results.values():
            o = r["ops"].get(op)  # type: ignore[index]
            cells.append(f"{o['median_ms']:>12} ms" + (" ERR" if o and o["error"] else "    ") if o else f"{'n/a':>16}")
        print(f"{op:22}" + "".join(f"{c:>20}" for c in cells))
    for n, r in results.items():
        print(n, "disturbance:", r["disturbance"])  # type: ignore[index]
    print("written:", out)


if __name__ == "__main__":
    main()
