"""Benchmark runner: one agent + one CU stack ("arm") on one task per run.

    python3 run.py --arms claude-codexcu,claude-cua --tasks calc_mul,edge_form --reps 1

Every run writes bench/out/<batch>/<arm>/<task>-r<n>/ with:
  transcript.jsonl   raw agent event stream, each line prefixed by a receive timestamp
  screenshot-*.jpg   every image the model saw (Claude arms)
  metrics.json       success (from the task's own checker), wall time, turns,
                     tool calls, tokens, cost, per-call latency, desktop disturbance
  windows-closed.txt what teardown closed

Arms differ only in the CU stack and agent; the prompt text is identical.
"""
from __future__ import annotations

import argparse
import base64
import json
import os
import shutil
import subprocess
import sys
import time
from dataclasses import asdict, dataclass, field
from pathlib import Path
from typing import Any, Literal

import tasks as T
import win

ROOT = Path(__file__).resolve().parent
OUT = ROOT / "out"
WORKDIR = ROOT / "workdir"  # empty cwd so no project instructions leak in
CUA_RELEASE = ROOT.parent / "tools/cua-driver/cua-driver-rs-0.34.1-windows-x86_64/cua-driver.exe"
CUA_MAIN = ROOT.parent / "tools/cua-driver-main/cua-driver.exe"
# Benchmark copy of ~/.local/bin/codex-cu-mcp: browser backends off, tab records redacted.
CODEX_CU = ROOT / "codex_cu_bridge.py"

PREAMBLE = (
    "You are controlling a Windows 11 desktop through the computer-use tools you have been given. "
    "Use only those tools. Only interact with the app(s) the task names; do not touch other windows. "
    "Work efficiently: batch actions when the tools allow it, and check the result before finishing. "
    "When done, reply with one line starting with FINAL: followed by the requested answer, or 'done'.\n\nTask: "
)

CUA_ENV = {"DO_NOT_TRACK": "1", "WSLENV": "DO_NOT_TRACK"}


@dataclass(frozen=True)
class Arm:
    id: str
    agent: Literal["claude", "codex"]
    server: dict[str, Any]  # MCP server config, registered under the name "cu"
    model: str
    effort: str = "medium"


ARMS: dict[str, Arm] = {a.id: a for a in [
    Arm("claude-codexcu", "claude", {"command": str(CODEX_CU), "env": {"CODEX_CU_AUTO_APPROVE": "1"}}, "opus"),
    Arm("claude-cua", "claude", {"command": str(CUA_RELEASE), "args": ["mcp"], "env": CUA_ENV}, "opus"),
    Arm("claude-cua-main", "claude", {"command": str(CUA_MAIN), "args": ["mcp"], "env": CUA_ENV}, "opus"),
    Arm("claude-bcu", "claude", {"command": "node", "args": [str(ROOT.parent / "proto/v1/bcu-mcp.ts")]}, "opus"),
    Arm("claude-bcu-fork", "claude", {"command": "node", "args": [str(ROOT.parent / "proto/v1/bcu-mcp.ts")],
        "env": {"BCU_CUA_DRIVER": str(ROOT.parent / "tools/cua-driver-fork/cua-driver.exe")}}, "opus"),
    # v2 prototype over the v2 fork. BCU_APPS scopes window lists to the suite's apps (apps it
    # launches are always in scope); everything else on the desktop stays hidden from the model.
    Arm("claude-bcu2", "claude", {"command": "node", "args": [str(ROOT.parent / "proto/v2/bcu-mcp.ts")],
        "env": {"BCU_CUA_DRIVER": str(ROOT.parent / "tools/cua-driver-fork/v2/cua-driver.exe"),
                "BCU_APPS": "TestPad,Calculator,msedge,File Explorer"}}, "opus"),
    # v3: the plugin's server (QuickJS sandbox, policy) over the driver the plugin ships. Headless
    # runs can't show approval prompts, so the suite's apps are pre-approved and foreground input is
    # allowed as in v2; a throwaway policy file keeps the user's own approvals out of the runs.
    Arm("claude-bcu3", "claude", {"command": "node", "args": [str(ROOT.parent / "plugin/server/main.ts")],
        "env": {"BCU_APPS": "TestPad,Calculator,msedge,File Explorer", "BCU_FOREGROUND": "allow",
                "BCU_POLICY": str(ROOT / "workdir" / "policy.json"), "BCU_AUDIT": str(ROOT / "workdir" / "actions.jsonl")}}, "opus"),
    Arm("gpt-codexcu", "codex", {"command": str(CODEX_CU), "env": {"CODEX_CU_AUTO_APPROVE": "1"}}, "gpt-6-astra"),
]}


@dataclass
class Metrics:
    arm: str
    task: str
    rep: int
    passed: bool = False
    check_detail: str = ""
    final: str = ""
    wall_s: float = 0.0
    first_tool_s: float | None = None  # startup cost: launch -> first tool call
    turns: int | None = None
    tool_calls: int = 0
    images_seen: int = 0
    tool_time_s: float = 0.0  # summed time inside tool calls
    model_time_s: float = 0.0  # wall minus tool time minus startup
    input_tokens: int | None = None
    output_tokens: int | None = None
    cache_read_tokens: int | None = None
    cost_usd: float | None = None
    model_id: str | None = None
    error: str | None = None
    timed_out: bool = False
    disturbance: dict[str, Any] = field(default_factory=dict)
    tool_latencies_s: list[float] = field(default_factory=list)


def claude_cmd(arm: Arm, prompt: str, cfg: Path) -> list[str]:
    return ["claude", "-p", prompt, "--tools", "", "--strict-mcp-config", "--mcp-config", str(cfg),
            "--allowedTools", "mcp__cu", "--model", arm.model, "--effort", arm.effort,
            "--output-format", "stream-json", "--verbose", "--no-session-persistence",
            # Skip project/local settings: the parent folder sets an output style that adds prose to every run.
            "--setting-sources", "user"]


# Windows Codex CLI. It uses the user's existing Windows login; every override
# below is a per-run `-c` flag, so the user's config.toml is never written.
CODEX_WIN = "/mnt/c/Users/Aadi/AppData/Local/OpenAI/Codex/bin/8aaf1547b825b104/codex.exe"
CODEX_WIN_CWD = r"C:\Users\Aadi\AppData\Local\Temp\bcu\codex-work"


def windows_codex_overrides() -> list[str]:
    """Turn off everything except our `cu` MCP server, so GPT gets the same
    tool layer as the Claude arm and no shell or file tools to bypass the GUI."""
    cfg = Path("/mnt/c/Users/Aadi/.codex/config.toml").read_text()
    import re
    plugins = re.findall(r'^\[plugins\."([^"]+)"\]', cfg, re.M)
    servers = re.findall(r"^\[mcp_servers\.([A-Za-z0-9_-]+)\]$", cfg, re.M)
    flags = ['approval_policy="never"', 'sandbox_mode="read-only"', "notify=[]", 'web_search="disabled"']
    flags += [f"features.{f}=false" for f in ("shell_tool", "unified_exec", "multi_agent", "apps", "browser_use",
                                              "computer_use", "tool_suggest", "goals", "js_repl")]
    flags += [f'plugins."{p}".enabled=false' for p in plugins]
    flags += [f"mcp_servers.{s}.enabled=false" for s in servers]
    # The same codex-cu-mcp bridge the Claude arm uses, launched through WSL.
    # cmd.exe clears CODEX_CLI_PATH first: codex.exe hands it to MCP children, Windows processes
    # started from WSL inherit it, and it makes Codex's JS kernel try (and fail) to start in the
    # Windows sandbox. The bridge strips it for the same reason.
    flags += ['mcp_servers.cu.command="cmd.exe"',
              f'mcp_servers.cu.args=["/d","/c","set CODEX_CLI_PATH=&& wsl.exe -e env CODEX_CU_AUTO_APPROVE=1 {CODEX_CU}"]',
              "mcp_servers.cu.startup_timeout_sec=120", "mcp_servers.cu.tool_timeout_sec=180",
              'mcp_servers.cu.default_tools_approval_mode="approve"']
    return [x for f in flags for x in ("-c", f)]


def codex_cmd(arm: Arm, prompt: str) -> list[str]:
    (win.WSL_TEMP / "codex-work").mkdir(parents=True, exist_ok=True)
    return [CODEX_WIN, "exec", "--json", "--skip-git-repo-check", "--ephemeral", "-C", CODEX_WIN_CWD,
            "-m", arm.model, "-c", f'model_reasoning_effort="{arm.effort}"', *windows_codex_overrides(), prompt]


def run_agent(arm: Arm, prompt: str, run_dir: Path, timeout_s: float) -> tuple[list[tuple[float, dict[str, Any]]], bool]:
    """Launch the agent, timestamp every JSON event as it arrives."""
    env = {**os.environ, "MCP_TIMEOUT": "120000", "MCP_TOOL_TIMEOUT": "180000"}
    if arm.agent == "claude":
        cfg = run_dir / "mcp.json"
        cfg.write_text(json.dumps({"mcpServers": {"cu": arm.server}}, indent=2))
        cmd = claude_cmd(arm, prompt, cfg)
    else:
        cmd = codex_cmd(arm, prompt)
    events: list[tuple[float, dict[str, Any]]] = []
    proc = subprocess.Popen(cmd, cwd=WORKDIR, env=env, stdin=subprocess.DEVNULL, stdout=subprocess.PIPE,
                            stderr=open(run_dir / "stderr.txt", "w"), text=True, bufsize=1)
    deadline = time.time() + timeout_s
    timed_out = False
    with open(run_dir / "transcript.jsonl", "w") as tf:
        os.set_blocking(proc.stdout.fileno(), True)  # type: ignore[union-attr]
        import selectors
        sel = selectors.DefaultSelector()
        sel.register(proc.stdout, selectors.EVENT_READ)  # type: ignore[arg-type]
        while True:
            if time.time() > deadline:
                timed_out = True
                proc.kill()
                break
            if not sel.select(timeout=1.0):
                if proc.poll() is not None:
                    break
                continue
            line = proc.stdout.readline()  # type: ignore[union-attr]
            if not line:
                break
            now = time.time()
            tf.write(f"{now:.3f}\t{line}")
            try:
                events.append((now, json.loads(line)))
            except json.JSONDecodeError:
                pass
    proc.wait(timeout=30)
    return events, timed_out


def parse_claude(events: list[tuple[float, dict[str, Any]]], t0: float, m: Metrics, run_dir: Path) -> None:
    pending: dict[str, float] = {}
    shots = 0
    for ts, ev in events:
        typ = ev.get("type")
        if typ == "system" and ev.get("subtype") == "init":
            m.model_id = ev.get("model")
        elif typ == "assistant":
            for b in ev["message"].get("content", []):
                if b.get("type") == "tool_use":
                    m.tool_calls += 1
                    pending[b["id"]] = ts
                    if m.first_tool_s is None:
                        m.first_tool_s = ts - t0
        elif typ == "user":
            for b in ev["message"].get("content", []):
                if isinstance(b, dict) and b.get("type") == "tool_result":
                    if b.get("tool_use_id") in pending:
                        m.tool_latencies_s.append(round(ts - pending.pop(b["tool_use_id"]), 3))
                    for part in b.get("content", []) if isinstance(b.get("content"), list) else []:
                        if part.get("type") == "image":
                            shots += 1
                            ext = "png" if "png" in part["source"].get("media_type", "") else "jpg"
                            (run_dir / f"screenshot-{shots}.{ext}").write_bytes(base64.b64decode(part["source"]["data"]))
        elif typ == "result":
            m.turns = ev.get("num_turns")
            m.cost_usd = ev.get("total_cost_usd")
            u = ev.get("usage") or {}
            m.input_tokens = (u.get("input_tokens") or 0) + (u.get("cache_creation_input_tokens") or 0) + (u.get("cache_read_input_tokens") or 0)
            m.cache_read_tokens = u.get("cache_read_input_tokens")
            m.output_tokens = u.get("output_tokens")
            m.final = T.final_line(ev.get("result") or "")
            if ev.get("is_error"):
                m.error = str(ev.get("subtype"))
    m.images_seen = shots


def parse_codex(events: list[tuple[float, dict[str, Any]]], t0: float, m: Metrics) -> None:
    started: dict[str, float] = {}
    last_msg = ""
    turns = 0
    for ts, ev in events:
        typ = ev.get("type", "")
        item = ev.get("item") or {}
        itype = item.get("type") or item.get("item_type")
        if typ == "item.started" and itype == "mcp_tool_call":
            m.tool_calls += 1
            started[item.get("id", "")] = ts
            if m.first_tool_s is None:
                m.first_tool_s = ts - t0
        elif typ == "item.completed" and itype == "mcp_tool_call" and item.get("id") in started:
            m.tool_latencies_s.append(round(ts - started.pop(item["id"]), 3))
        elif typ == "item.completed" and itype in ("agent_message", "assistant_message"):
            last_msg = item.get("text", "")
        elif typ == "turn.completed":
            turns += 1
            u = ev.get("usage") or {}
            m.input_tokens = (m.input_tokens or 0) + (u.get("input_tokens") or 0)
            m.cache_read_tokens = (m.cache_read_tokens or 0) + (u.get("cached_input_tokens") or 0)
            m.output_tokens = (m.output_tokens or 0) + (u.get("output_tokens") or 0)
        elif typ in ("turn.failed", "error"):
            m.error = json.dumps(ev)[:300]
    m.turns = turns
    m.final = T.final_line(last_msg)
    m.model_id = m.model_id or "gpt"


def run_one(arm: Arm, task: T.Task, rep: int, batch_dir: Path, timeout_s: float) -> Metrics:
    run_dir = batch_dir / arm.id / f"{task.id}-r{rep}"
    run_dir.mkdir(parents=True, exist_ok=True)
    m = Metrics(arm.id, task.id, rep)
    win.close_strays()  # windows left by an interrupted earlier run would confuse this one
    before = win.list_windows()
    pickers_before = win.openwith_pids()
    task.setup()
    sampler = win.Sampler()
    sampler.start()
    t0 = time.time()
    try:
        events, m.timed_out = run_agent(arm, PREAMBLE + task.prompt, run_dir, timeout_s)
        m.wall_s = round(time.time() - t0, 2)
    finally:
        sampler.stop()
    (parse_claude(events, t0, m, run_dir) if arm.agent == "claude" else parse_codex(events, t0, m))
    m.tool_time_s = round(sum(m.tool_latencies_s), 2)
    m.model_time_s = round(m.wall_s - m.tool_time_s - (m.first_tool_s or 0), 2)
    m.disturbance = sampler.summary()
    time.sleep(1)
    chk = task.check(m.final)
    m.passed, m.check_detail = chk.passed, chk.detail
    task.teardown()
    closed = win.close_new_windows(before)
    time.sleep(1)  # the Open With picker appears a moment after its interim window
    closed += [f"killed OpenWith:{p}" for p in win.kill_new_openwith(pickers_before)]
    # TestPad is only ever our app; a modal dialog can block WM_CLOSE, so make sure it's gone.
    win.ps("Stop-Process -Name TestPad -Force -ErrorAction SilentlyContinue")
    (run_dir / "windows-closed.txt").write_text("\n".join(closed))
    (run_dir / "metrics.json").write_text(json.dumps(asdict(m), indent=2))
    return m


def main() -> None:
    ap = argparse.ArgumentParser()
    ap.add_argument("--arms", default="claude-codexcu,claude-cua")
    ap.add_argument("--tasks", default=",".join(T.TASKS))
    ap.add_argument("--reps", type=int, default=1)
    ap.add_argument("--timeout", type=float, default=420)
    ap.add_argument("--batch", default=time.strftime("%Y%m%d-%H%M%S"))
    args = ap.parse_args()
    WORKDIR.mkdir(exist_ok=True)
    batch_dir = OUT / args.batch
    batch_dir.mkdir(parents=True, exist_ok=True)
    arms = [ARMS[a] for a in args.arms.split(",")]
    # The GPT arm is retired: under codex.exe, Codex's runtime attaches to the user's Chrome
    # extension and returns their real tabs (titles, URLs) to the model, and the bridge could
    # not reliably strip them. See README "Caveats".
    if any(a.agent == "codex" for a in arms):
        sys.exit("gpt-codexcu is disabled: it leaks the user's browser tabs into the model context")
    task_list = [T.TASKS[t] for t in args.tasks.split(",")]
    # Interleave arms per task so drift (app state, network) doesn't favor one arm.
    for rep in range(1, args.reps + 1):
        for task in task_list:
            for arm in arms:
                if (batch_dir / arm.id / f"{task.id}-r{rep}" / "metrics.json").exists():
                    continue  # resumable: a restarted batch skips runs that already finished
                m = run_one(arm, task, rep, batch_dir, args.timeout)
                d = m.disturbance
                print(f"{arm.id:16} {task.id:16} r{rep} {'PASS' if m.passed else 'FAIL'} "
                      f"wall={m.wall_s:6.1f}s start={m.first_tool_s or 0:5.1f}s tools={m.tool_calls:2d} "
                      f"tool_t={m.tool_time_s:5.1f}s turns={m.turns} cost={m.cost_usd} "
                      f"cursor_px={d.get('cursor_max_displacement_px')} fg_chg={d.get('foreground_changes')} "
                      f"{'TIMEOUT ' if m.timed_out else ''}{m.error or ''}", flush=True)
    print(f"artifacts: {batch_dir}")


if __name__ == "__main__":
    sys.exit(main())
