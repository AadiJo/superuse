"""End-to-end check of the plugin's page API in the user's own Helium (or any Chromium browser with
its remote-debugging toggle on), through the real plugin server and driver.

    python3 bench/helium_check.py            # direct page-API run, then one headless Claude run
    python3 bench/helium_check.py --direct   # page-API run only
    python3 bench/helium_check.py --claude   # headless Claude run only

It serves a test form from WSL on 127.0.0.1:8765; the form reports each submission back to that
server, so the check never reads the user's tabs. Everything happens in a tab the run opens. At the
end it closes any test tab still open (by its tab-strip close button) and dismisses leftover
"Allow remote debugging?" prompts with WM_CLOSE, which denies them. Writes
bench/out/helium-check-<time>.json.
"""
from __future__ import annotations

import http.server
import json
import os
import re
import subprocess
import sys
import threading
import time
from pathlib import Path
from urllib.parse import parse_qs, urlparse

sys.path.insert(0, str(Path(__file__).resolve().parent))
import tasks as T  # noqa: E402
import win  # noqa: E402
from mcp_client import McpClient, text_of  # noqa: E402

ROOT = Path(__file__).resolve().parents[1]
PORT = 8765
URL = f"http://127.0.0.1:{PORT}/form.html"
WANT = {"name": "Ada Lovelace", "email": "ada@example.com", "plan": "pro", "agree": "yes", "notes": "typed in the background"}
submissions: list[dict[str, str]] = []

# The bench form, plus a contenteditable Notes box, and a beacon to this server on submit.
PAGE = T.FORM_HTML.replace("<title>Signup form</title>", "<title>BCU Helium test</title>").replace(
    '<button type="submit">Submit</button>',
    '<label>Notes <div id="notes" contenteditable="true" role="textbox" aria-label="Notes" '
    'style="border:1px solid #888;min-height:40px"></div></label>\n<button type="submit">Submit</button>').replace(
    "document.title = 'SUBMITTED ' + s;",
    "document.title = 'SUBMITTED ' + s; fetch('/submitted?' + new URLSearchParams({name: v('name').value, "
    "email: v('email').value, plan: v('plan').value, agree: v('agree').checked ? 'yes' : 'no', "
    "notes: v('notes').textContent}));")


class Handler(http.server.BaseHTTPRequestHandler):
    def do_GET(self) -> None:  # noqa: N802
        u = urlparse(self.path)
        if u.path == "/submitted":
            submissions.append({k: v[0] for k, v in parse_qs(u.query).items()})
            body = b"ok"
        else:
            body = PAGE.encode()
        self.send_response(200)
        self.send_header("Content-Type", "text/html; charset=utf-8")
        self.end_headers()
        self.wfile.write(body)

    def log_message(self, *_: object) -> None:
        pass


def helium_windows() -> list[win.Win]:
    return [w for w in win.list_windows(titles=True) if w.proc == "chrome" and w.title.endswith("- Helium")]


def debugging_prompts() -> list[win.Win]:
    return [w for w in win.list_windows(titles=True) if w.proc == "chrome" and "remote debugging" in w.title.lower()]


def cleanup() -> list[str]:
    """Close test tabs left open (tab-strip Close buttons) and deny leftover debugging prompts."""
    done = []
    prompts = debugging_prompts()
    if prompts:
        win.ps(win.WIN_TYPES + "".join(f"[void][BcuW]::PostMessage([IntPtr]{w.hwnd},0x0010,[IntPtr]::Zero,[IntPtr]::Zero)\n" for w in prompts))
        done.append(f"denied {len(prompts)} prompt(s)")
    with McpClient([str(ROOT / "plugin/driver/cua-driver.exe"), "mcp"], env={"DO_NOT_TRACK": "1", "WSLENV": "DO_NOT_TRACK"}) as c:
        for w in helium_windows():
            for _ in range(5):
                r, _ = c.call("get_window_state", {"pid": w.pid, "window_id": w.hwnd, "include_screenshot": False, "max_elements": 600})
                d = r.get("structuredContent") or json.loads(text_of(r))
                lines = d.get("tree_markdown", "").splitlines()
                hit = next((i for i, l in enumerate(lines) if "TabItem" in l and re.search(r'"(BCU Helium test|SUBMITTED name=|Inspect with Chrome)', l)), None)
                if hit is None:
                    break
                indent = len(lines[hit]) - len(lines[hit].lstrip())
                close = next((l for l in lines[hit + 1:hit + 6] if len(l) - len(l.lstrip()) > indent and 'Button "Close"' in l), None)
                if not close:
                    break
                c.call("click", {"element_token": f"{d['snapshot_id']}:{re.search(r'\\[(\\d+)\\]', close).group(1)}"})
                done.append("closed a test tab")
                time.sleep(1)
    return done


def js(c: McpClient, code: str) -> tuple[str, bool, float]:
    r, ms = c.call("js", {"code": code}, timeout=180)
    return text_of(r), bool(r.get("isError")), ms


def direct_run() -> dict:
    """The page API by hand: open a background tab, fill the form, submit with Enter, close the tab."""
    steps = [
        ("bind Helium + open tab", f'const w = await cua.window({{app: "chrome", title: "Helium"}}); globalThis.p = await w.page().newTab({json.dumps(URL)}); return p.title'),
        ("read", 'return await p.read()'),
        ("type name", 'const r = await p.read({query: "Name"}); await p.type(r.match(/\\[(p\\d+:\\d+)\\] textbox "Name"/)[1], "Ada Lovelace", {replace: true}); return "ok"'),
        ("type email", 'const r = await p.read({query: "Email"}); await p.type("ada@example.com", r.match(/\\[(p\\d+:\\d+)\\] textbox "Email"/)[1], {replace: true}); return "ok"'),
        ("type notes", 'const r = await p.read({query: "Notes"}); await p.type("typed in the background", r.match(/\\[(p\\d+:\\d+)\\] textbox "Notes"/)[1]); return "ok"'),
        ("select plan", 'const r = await p.read({query: "Plan"}); await p.select(r.match(/\\[(p\\d+:\\d+)\\] combobox "Plan"/)[1], "Pro"); return "ok"'),
        ("tick agree", 'const r = await p.read({query: "agree"}); await p.click(r.match(/\\[(p\\d+:\\d+)\\] checkbox/)[1]); return "ok"'),
        ("Enter in Name", 'const r = await p.read({query: "Name"}); await p.click(r.match(/\\[(p\\d+:\\d+)\\] textbox "Name"/)[1]); await p.key("Enter"); return "ok"'),
        ("screenshot refused fast", 'try { await p.screenshot(); return "captured" } catch (e) { return /isn.t painted/.test(e.message) ? "refused fast" : "ERR " + e.message }'),
        ("close tab", 'await p.close(); return "ok"'),
    ]
    out = {"steps": []}
    before = len(submissions)
    with McpClient(["node", str(ROOT / "plugin/server/main.ts")], env={"BCU_AUDIT": "off"}) as c:
        sampler = win.Sampler()
        sampler.start()
        t0 = time.time()
        for label, code in steps:
            text, err, ms = js(c, code)
            out["steps"].append({"step": label, "ms": round(ms), "ok": not err, "detail": text[:300]})
            print(f"  {label:24} {ms:6.0f} ms  {'ERR ' + text[:200] if err else text[:100].replace(chr(10), ' | ')}")
        out["wall_s"] = round(time.time() - t0, 1)
        sampler.stop()
    time.sleep(0.5)
    out["disturbance"] = sampler.summary()
    out["submission"] = submissions[before] if len(submissions) > before else None
    out["passed"] = out["submission"] == WANT
    return out


def claude_run() -> dict:
    """The same job as a user prompt through headless Claude Code with the plugin."""
    prompt = (f"In my Helium browser, open {URL} in a new tab and fill in the signup form: name Ada Lovelace, "
              "email ada@example.com, plan Pro, notes 'typed in the background', tick the terms box, and submit it. "
              "Then close that tab and tell me what the page showed after submitting.")
    before = len(submissions)
    sampler = win.Sampler()
    sampler.start()
    t0 = time.time()
    transcript = ROOT / "bench" / "out" / f"helium-claude-{time.strftime('%Y%m%d-%H%M%S')}.jsonl"
    with open(transcript, "w") as f:
        # --no-helium-mcp hides the user's own chrome-devtools-mcp server ("helium"), to test the plugin path alone.
        hide = ["--disallowedTools", "mcp__helium"] if "--no-helium-mcp" in sys.argv else []
        proc = subprocess.Popen(["claude", "-p", prompt, "--allowedTools", "mcp__plugin_bcu_computer__js", "Skill", *hide,
                                 "--output-format", "stream-json", "--verbose", "--no-session-persistence"],
                                stdout=f, stderr=subprocess.DEVNULL, stdin=subprocess.DEVNULL, cwd="/tmp")
        try:
            proc.wait(timeout=400)
        except subprocess.TimeoutExpired:
            proc.kill()
    wall = time.time() - t0
    sampler.stop()
    calls, result, cost = [], "", None
    for line in transcript.read_text().splitlines():
        try:
            ev = json.loads(line)
        except json.JSONDecodeError:
            continue
        if ev.get("type") == "assistant":
            calls += [b["name"] for b in ev["message"]["content"] if b.get("type") == "tool_use"]
        elif ev.get("type") == "result":
            result, cost = ev.get("result") or "", ev.get("total_cost_usd")
    sub = submissions[before] if len(submissions) > before else None
    out = {"wall_s": round(wall, 1), "cost_usd": cost, "tool_calls": calls, "submission": sub, "passed": sub == WANT,
           "disturbance": sampler.summary(), "result": result[:400]}
    print(f"  claude: {'PASS' if out['passed'] else 'FAIL'} {out['wall_s']}s ${cost} calls={len(calls)} disturbance={out['disturbance']}")
    return out


def main() -> int:
    server = http.server.ThreadingHTTPServer(("127.0.0.1", PORT), Handler)
    threading.Thread(target=server.serve_forever, daemon=True).start()
    report: dict = {}
    try:
        if "--claude" not in sys.argv:
            print("direct page-API run:")
            report["direct"] = direct_run()
            print(f"  {'PASS' if report['direct']['passed'] else 'FAIL'} submission={report['direct']['submission']} disturbance={report['direct']['disturbance']}")
        else:
            report["direct"] = {}
        if "--claude" in sys.argv:
            report.pop("direct")
        if "--direct" not in sys.argv:
            print("headless Claude run:")
            report["claude"] = claude_run()
    finally:
        report["cleanup"] = cleanup()
        report["leftover_prompts"] = len(debugging_prompts())
        print("cleanup:", report["cleanup"], "| prompts left:", report["leftover_prompts"])
        server.shutdown()
    out = ROOT / "bench" / "out" / f"helium-check-{time.strftime('%Y%m%d-%H%M%S')}.json"
    out.write_text(json.dumps(report, indent=2))
    print(out)
    return 0 if all(r.get("passed") for k, r in report.items() if isinstance(r, dict) and "passed" in r) else 1


if __name__ == "__main__":
    os.chdir(ROOT)
    sys.exit(main())
