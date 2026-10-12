#!/usr/bin/env python3
"""Benchmark copy of ~/.local/bin/codex-cu-mcp with browser backends disabled.

Expose Windows Codex's Computer Use MCP server (cua_repl + @oai/sky) to WSL.

Register with Claude Code as a stdio MCP server:
    claude mcp add --scope user codex-cu -- ~/.local/bin/codex-cu-mcp

Each start re-reads the newest `unified-computer-use/<version>/.mcp.json` written
by the Windows Codex app, so Codex updates that move the bundled runtime keep
working. The app ships cua_repl with only the "browser" surface; this turns on
"computer" (Windows desktop control via @oai/sky) and runs it without the Codex
app: sky spawns its own codex-computer-use.exe helper.

It also proxies stdio to fix app approvals. Sky asks "Allow Codex to use <app>?"
through an MCP elicitation on every helper request, relying on the Codex client
to remember "allow for this session". This proxy plays that role: the first
request per app goes to the MCP client, and an accept is remembered for the life
of the server (one Claude session). CODEX_CU_AUTO_APPROVE=1 approves every app
without asking, for headless runs (`claude -p`) that can't show a dialog.
"""
from __future__ import annotations

import json
import re
import os
from contextlib import nullcontext
import subprocess
import sys
import threading
from pathlib import Path
from typing import IO, Any


def run(argv: list[str], cwd: str | None = None) -> str:
    # stdin must be DEVNULL: WSL interop relays our stdin into Windows children,
    # which would swallow the MCP client's initialize request.
    return subprocess.run(argv, cwd=cwd, stdin=subprocess.DEVNULL, capture_output=True, text=True, check=True).stdout.strip()


def wslpath(windows_path: str) -> str:
    return run(["wslpath", "-u", windows_path])


def windows_profile() -> Path:
    """%USERPROFILE% of the Windows user that owns this WSL session."""
    if override := os.environ.get("CODEX_CU_WINDOWS_PROFILE"):
        return Path(override)
    return Path(wslpath(run(["/mnt/c/Windows/System32/cmd.exe", "/d", "/c", "echo %USERPROFILE%"], cwd="/mnt/c")))


def newest_mcp_json(profile: Path) -> Path:
    root = profile / ".codex/plugins/cache/openai-bundled/unified-computer-use"
    versions = [p for p in root.iterdir() if (p / ".mcp.json").is_file()] if root.is_dir() else []
    if not versions:
        sys.exit(f"codex-cu-mcp: no unified-computer-use plugin under {root}. Install or open the Codex Windows app first.")
    # Versions look like 26.930.31730; compare numerically.
    return max(versions, key=lambda p: tuple(int(x) if x.isdigit() else -1 for x in p.name.split("."))) / ".mcp.json"


def server_env(server: dict[str, Any]) -> dict[str, str]:
    """The Codex app's cua_repl env, adjusted to run desktop control standalone."""
    env: dict[str, str] = dict(server.get("env", {}))
    env["CUA_REPL_ENABLED_SURFACES"] = os.environ.get("CODEX_CU_SURFACES", "computer")
    # Let cua-repl derive trusted services from the surfaces (adds @oai/sky/service).
    env.pop("NODE_REPL_TRUSTED_SERVICES", None)
    # The native pipe belongs to a running Codex app; without it sky spawns its own helper.
    env.pop("SKY_CUA_NATIVE_PIPE", None)
    env.pop("SKY_CUA_NATIVE_PIPE_DIRECTORY", None)
    # With CODEX_CLI_PATH set, node_repl starts its JS kernel inside Codex's Windows
    # sandbox, which fails outside the app (CreateProcessWithLogonW 1056). Claude's
    # own shell is already unsandboxed, so run the kernel directly.
    env.pop("CODEX_CLI_PATH", None)
    # Benchmark copy: browser tab records are redacted in server_to_client (redact_tabs).
    # Clearing BROWSER_USE_AVAILABLE_BACKENDS / BROWSER_USE_TINYSKY_ENABLED instead broke
    # computer.launch_app ("accessibility window-opened handler did not become ready").
    # WSL only forwards variables named in WSLENV to Windows processes.
    forwarded = [v for v in os.environ.get("WSLENV", "").split(":") if v] + list(env)
    return {**os.environ, **env, "WSLENV": ":".join(forwarded)}


class ApprovalProxy:
    """Relays newline-delimited JSON-RPC between the MCP client and cua_repl,
    answering repeat Computer Use app approvals from a per-session memory."""

    def __init__(self, child: subprocess.Popen[str]) -> None:
        assert child.stdin and child.stdout
        self.child_in, self.child_out = child.stdin, child.stdout
        self.auto_approve = os.environ.get("CODEX_CU_AUTO_APPROVE") == "1"
        self.approved_apps: set[str] = set()
        self.pending: dict[Any, str] = {}  # forwarded elicitation id -> app id
        self.lock = threading.Lock()

    @staticmethod
    def write(stream: IO[str], msg: dict[str, Any] | str, lock: threading.Lock | None = None) -> None:
        line = msg if isinstance(msg, str) else json.dumps(msg)
        with lock or nullcontext():
            stream.write(line if line.endswith("\n") else line + "\n")
            stream.flush()

    def client_to_server(self) -> None:
        for line in sys.stdin:
            msg = parse(line)
            if msg is not None and "method" not in msg and msg.get("id") in self.pending:
                app = self.pending.pop(msg["id"])
                if msg.get("result", {}).get("action") == "accept":
                    self.approved_apps.add(app)
            self.write(self.child_in, line, self.lock)
        self.child_in.close()

    def server_to_client(self) -> None:
        for line in self.child_out:
            msg = parse(line)
            app = approval_app(msg) if msg is not None else None
            if app is None:
                self.write(sys.stdout, redact_tabs(line))
            elif self.auto_approve or app in self.approved_apps:
                self.write(self.child_in, {"jsonrpc": "2.0", "id": msg["id"], "result": {"action": "accept", "content": {}}}, self.lock)
            else:
                self.pending[msg["id"]] = app
                params = msg["params"]
                params["message"] = params["message"].replace("Allow Codex to use", "Allow Claude to use") + " (Windows Computer Use, remembered for this session)"
                self.write(sys.stdout, msg)


# Benchmark guard: browser tab records (they carry "lastOpened" or "providerTabId" values)
# never leave this bridge with their titles or URLs, even if a browser backend is reachable.
TAB_RECORD = re.compile(r'\{[^{}]*(?:lastOpened|providerTabId)\\?"\s*:\s*\\?"[^{}]*\}')
TAB_FIELD = re.compile(r'(\\?"(?:url|title)\\?"\s*:\s*\\?")(?:[^"\\]|\\(?!"))*(\\?")')


def redact_tabs(line: str) -> str:
    return TAB_RECORD.sub(lambda m: TAB_FIELD.sub(r"\1<redacted>\2", m.group(0)), line)


def parse(line: str) -> dict[str, Any] | None:
    try:
        msg = json.loads(line)
    except json.JSONDecodeError:
        return None
    return msg if isinstance(msg, dict) else None


def approval_app(msg: dict[str, Any]) -> str | None:
    """App id when msg is sky's "Allow Codex to use <app>?" elicitation."""
    if msg.get("method") != "elicitation/create" or "id" not in msg:
        return None
    meta = msg.get("params", {}).get("_meta", {})
    app = meta.get("tool_params", {}).get("app")
    return app if meta.get("connector_id") == "computer-use" and isinstance(app, str) else None


def main() -> None:
    profile = windows_profile()
    server = json.loads(newest_mcp_json(profile).read_text())["mcpServers"]["cua_repl"]
    node = wslpath(server["command"])
    child = subprocess.Popen(
        [node, *server.get("args", [])],
        env=server_env(server),
        cwd=profile,  # A Windows cwd avoids \\wsl.localhost UNC working directories.
        stdin=subprocess.PIPE,
        stdout=subprocess.PIPE,
        text=True,
        bufsize=1,
    )
    proxy = ApprovalProxy(child)
    threading.Thread(target=proxy.client_to_server, daemon=True).start()
    proxy.server_to_client()
    sys.exit(child.wait())


if __name__ == "__main__":
    main()
