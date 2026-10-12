"""Minimal stdio MCP client used to probe CU servers and time raw tool calls.

Usage as a library:
    with McpClient(["./cua-driver.exe", "mcp"], env=...) as c:
        tools = c.list_tools()
        res, ms = c.call("list_windows", {})

Speaks the legacy `initialize` flow (2025-06-18), which every server here
supports. Server-initiated elicitations (per-app approvals) are answered with
`elicit_action` ("accept" or "decline") so headless probes never hang.
"""
from __future__ import annotations

import json
import os
import subprocess
import threading
import time
from typing import Any


class McpError(RuntimeError):
    pass


class McpClient:
    def __init__(self, argv: list[str], env: dict[str, str] | None = None, cwd: str | None = None,
                 elicit_action: str = "accept", log_path: str | None = None) -> None:
        self.argv, self.env, self.cwd = argv, env, cwd
        self.elicit_action = elicit_action
        self.log = open(log_path, "a") if log_path else None
        self.next_id = 1
        self.responses: dict[int, dict[str, Any]] = {}
        self.cond = threading.Condition()
        self.elicitations: list[dict[str, Any]] = []
        self.stderr_lines: list[str] = []

    def __enter__(self) -> "McpClient":
        self.proc = subprocess.Popen(self.argv, stdin=subprocess.PIPE, stdout=subprocess.PIPE,
                                     stderr=subprocess.PIPE, text=True, bufsize=1,
                                     env={**os.environ, **(self.env or {})}, cwd=self.cwd)
        threading.Thread(target=self._read, daemon=True).start()
        threading.Thread(target=self._read_err, daemon=True).start()
        self.request("initialize", {"protocolVersion": "2025-06-18", "capabilities": {"elicitation": {}},
                                    "clientInfo": {"name": "bcu-bench", "version": "0.1"}}, timeout=120)
        self._send({"jsonrpc": "2.0", "method": "notifications/initialized"})
        return self

    def __exit__(self, *exc: object) -> None:
        try:
            self.proc.stdin.close()  # type: ignore[union-attr]
            self.proc.wait(timeout=10)
        except Exception:
            self.proc.kill()
        if self.log:
            self.log.close()

    def _send(self, msg: dict[str, Any]) -> None:
        line = json.dumps(msg)
        if self.log:
            self.log.write(f">> {line[:4000]}\n")
        self.proc.stdin.write(line + "\n")  # type: ignore[union-attr]
        self.proc.stdin.flush()  # type: ignore[union-attr]

    def _read(self) -> None:
        for line in self.proc.stdout:  # type: ignore[union-attr]
            try:
                msg = json.loads(line)
            except json.JSONDecodeError:
                continue
            if self.log:
                self.log.write(f"<< {line[:4000].rstrip()}\n")
            if "method" in msg and "id" in msg:  # server -> client request
                if msg["method"] == "elicitation/create":
                    self.elicitations.append(msg)
                    content = {"persist": "session"} if self.elicit_action == "accept" else None
                    self._send({"jsonrpc": "2.0", "id": msg["id"], "result": {"action": self.elicit_action, "content": content}})
                else:
                    self._send({"jsonrpc": "2.0", "id": msg["id"], "result": {}})
            elif "id" in msg:
                with self.cond:
                    self.responses[msg["id"]] = msg
                    self.cond.notify_all()

    def _read_err(self) -> None:
        for line in self.proc.stderr:  # type: ignore[union-attr]
            self.stderr_lines.append(line.rstrip())

    def request(self, method: str, params: dict[str, Any], timeout: float = 120) -> dict[str, Any]:
        rid = self.next_id
        self.next_id += 1
        self._send({"jsonrpc": "2.0", "id": rid, "method": method, "params": params})
        deadline = time.time() + timeout
        with self.cond:
            while rid not in self.responses:
                left = deadline - time.time()
                if left <= 0 or not self.cond.wait(left):
                    if rid not in self.responses:
                        raise McpError(f"timeout waiting for {method}; stderr tail: {self.stderr_lines[-5:]}")
        msg = self.responses.pop(rid)
        if "error" in msg:
            raise McpError(f"{method}: {msg['error']}")
        return msg["result"]

    def list_tools(self) -> list[dict[str, Any]]:
        return self.request("tools/list", {})["tools"]

    def call(self, name: str, args: dict[str, Any], timeout: float = 120) -> tuple[dict[str, Any], float]:
        """Call a tool and return (result, elapsed_ms)."""
        t0 = time.perf_counter()
        res = self.request("tools/call", {"name": name, "arguments": args}, timeout=timeout)
        return res, (time.perf_counter() - t0) * 1000


def text_of(result: dict[str, Any]) -> str:
    """Concatenate the text blocks of a tool result."""
    return "\n".join(b.get("text", "") for b in result.get("content", []) if b.get("type") == "text")


def image_count(result: dict[str, Any]) -> int:
    return sum(1 for b in result.get("content", []) if b.get("type") == "image")
