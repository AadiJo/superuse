"""End-to-end checks of the bcu MCP server's sandbox and policy, through the real server and driver.

    python3 bench/server_check.py        # writes bench/out/server-check-<time>.json, exits 1 on failure

Read-only on the desktop: it lists windows and binds them, but never sends input, so it can run
while something else is driving apps. Each case lists the failure it guards against.
"""
from __future__ import annotations

import json
import os
import sys
import tempfile
import time
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
from mcp_client import McpClient, text_of  # noqa: E402

ROOT = Path(__file__).resolve().parents[1]
SERVER = ["node", str(ROOT / "plugin/server/main.ts")]
results: list[dict] = []


def check(name: str, ok: bool, detail: str) -> None:
    results.append({"case": name, "ok": ok, "detail": detail[:400]})
    print(f"{'PASS' if ok else 'FAIL'}  {name}: {detail[:160]}")


def server(env: dict[str, str], elicit: str | None) -> McpClient:
    """elicit=None: the client doesn't advertise elicitation. Otherwise "accept"/"decline"."""
    c = McpClient(SERVER, env=env, elicit_action=elicit or "decline")
    if elicit is None:  # drop the capability McpClient advertises by default
        orig = c.request
        def request(method, params, timeout=120):  # noqa: ANN001
            if method == "initialize":
                params = {**params, "capabilities": {}}
            return orig(method, params, timeout)
        c.request = request  # type: ignore[method-assign]
    return c


def js(c: McpClient, code: str, timeout: float = 60) -> tuple[str, bool]:
    r, _ = c.call("js", {"code": code}, timeout=timeout)
    return text_of(r), bool(r.get("isError"))


def main() -> int:
    policy = Path(tempfile.mkdtemp()) / "policy.json"  # empty policy: nothing pre-approved
    base = {"BCU_POLICY": str(policy), "BCU_AUDIT": "off"}

    with server(base, elicit=None) as c:
        t, _ = js(c, "return [typeof process, typeof require, typeof fetch, typeof __bcu_host, (async()=>1)().constructor.constructor('return typeof process')()]")
        check("no Node capabilities in the sandbox", t == '["undefined","undefined","undefined","undefined","undefined"]', t)
        t, _ = js(c, 'try { return typeof log.constructor.constructor("return process")() } catch (e) { return "blocked" }')
        check("API functions don't lead to the host's Function", t == "blocked", t)
        t, _ = js(c, "cua = null; log = null; return typeof cua.window + ' ' + typeof log")
        check("cua and log can't be overwritten", t == "function function", t)
        js(c, "const answer = 41")
        t, _ = js(c, "return answer + 1")
        check("top-level const persists across calls", t == "42", t)
        t, _ = js(c, "const order = []; cua.sleep(50).then(() => order.push('a')); cua.sleep(1).then(() => order.push('b')); await cua.sleep(1); return order")
        check("un-awaited calls run in written order", t == '["a","b"]', t)
        t, err = js(c, "cua.window('zz-no-such-app-zz'); return 'kept going'")
        check("un-awaited failure is reported, call continues", err and "kept going" in t and "wasn't awaited" in t, t)
        t, err = js(c, "while (true) {}", timeout=30)
        check("infinite loop is interrupted", err and "interrupted" in t, t)
        t, err = js(c, "return 1 +")
        check("syntax error is reported", err and "SyntaxError" in t, t)
        t, _ = js(c, "return 'still alive'")
        check("server usable after loop and syntax error", t == "still alive", t)
        js(c, "async function twice(x) { return 2 * x }\nclass Box { constructor(v) { this.v = v } }")
        t, _ = js(c, "return [await twice(21), new Box(7).v]")
        check("top-level functions and classes persist", t == "[42,7]", t)
        t, err = js(c, 'return await cua.open("C:\\\\Windows\\\\System32\\\\cmd.exe\\u0000C:\\\\testpad.exe")')
        check("launch name with a NUL is refused", err and "not a plain app name" in t, t)
        c.call("js_reset", {})
        t, _ = js(c, "return typeof answer")
        check("js_reset clears variables", t == "undefined", t)

        t, _ = js(c, "return await cua.windows()")
        rows = json.loads(t) if t.startswith("[") else []
        leaked = [r for r in rows if not r.get("approved", True) and ("title" in r or "id" in r)]
        check("unapproved apps show no titles or ids", bool(rows) and not leaked, f"{len(rows)} rows, {len(leaked)} leaking")
        terminals = [r for r in rows if "terminal" in str(r.get("app", "")).lower()]
        check("denied apps (terminals) are hidden", not terminals, f"terminal rows: {len(terminals)}")
        t, err = js(c, "return await cua.window('WindowsTerminal')")
        check("denied app can't be bound", err and "no window matches" in t, t)
        other = next((r["app"] for r in rows if r.get("approved") is False), None)
        t, err = js(c, f"return await cua.window({json.dumps(other)})") if other else ("no unapproved app on screen", True)
        check("no elicitation: refusal says how to approve", err and "allow" in t and str(policy) in t, t)

    # Timeouts, with a 3 s limit: calls queued by the timed-out js call must not run afterwards,
    # and js_reset right after a timeout (live host calls) must not crash the server.
    with server({**base, "BCU_CALL_TIMEOUT_MS": "3000"}, elicit=None) as c:
        t, err = js(c, "globalThis.ran = 0; for (let i = 0; i < 20; i++) cua.sleep(300).then(() => ran++); await new Promise(() => {})")
        check("stuck js call times out", err and "timed out" in t, t)
        t, _ = js(c, "for (let i = 0; i < 5; i++) await cua.sleep(300); return ran")
        check("calls queued by a timed-out call are cancelled", t.isdigit() and int(t) < 15, f"ran={t} of 20")
        js(c, "cua.sleep(300); await new Promise(() => {})")
        c.call("js_reset", {})
        t, _ = js(c, "return 'alive after reset'")
        check("js_reset after a timeout keeps the server alive", t == "alive after reset", t)

    if other:
        with server(base, elicit="decline") as c:
            t, err = js(c, f"return await cua.window({json.dumps(other)})")
            check("declined prompt refuses", err and "declined" in t, t)
            asked = len(c.elicitations)
            js(c, f"try {{ await cua.window({json.dumps(other)}) }} catch (e) {{}}")
            check("declined app isn't asked again", len(c.elicitations) == asked == 1, f"prompts: {len(c.elicitations)}")
        with server(base, elicit="accept") as c:
            t, err = js(c, f"const w = await cua.window({json.dumps(other)}); return [typeof w.state, w.app]")
            check("accepted prompt binds the window", not err and '"function"' in t, t)
            check("prompt names the app", bool(c.elicitations) and other in json.dumps(c.elicitations[0]), f"prompts: {len(c.elicitations)}")
            t, _ = js(c, "return (await cua.windows()).filter(r => r.app === " + json.dumps(other) + ").map(r => 'title' in r)")
            check("approved app now listed with titles", "true" in t, t)

    out = ROOT / "bench" / "out" / f"server-check-{time.strftime('%Y%m%d-%H%M%S')}.json"
    out.parent.mkdir(parents=True, exist_ok=True)
    out.write_text(json.dumps(results, indent=2))
    failed = [r for r in results if not r["ok"]]
    print(f"{len(results) - len(failed)}/{len(results)} passed; {out}")
    return 1 if failed else 0


if __name__ == "__main__":
    sys.exit(main())
