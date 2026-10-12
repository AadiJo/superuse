# Windows computer-use benchmark

End-to-end comparison of computer-use stacks on the real Windows desktop, driven from WSL. Each run is one agent, one CU stack ("arm"), one task. Success comes from each task's own checker, which reads real Windows state (file contents, Calculator's display through UIA, Edge's window title). The agent's claim doesn't count.

```bash
python3 run.py --arms claude-codexcu,claude-cua-main,claude-bcu --tasks calc_mul,edge_form --reps 2 --batch mybatch
python3 report.py mybatch          # out/mybatch/report.md
python3 trace.py out/mybatch/claude-bcu/calc_mul-r1   # step-by-step trace of one run
```

## Results

The write-up is [research/08-experiments.md](../research/08-experiments.md). Round 2 numbers come from `out/v2` (Codex runtime, Cua Driver and the v2 front end, 54 runs) and `out/v2.1` through `out/v2.3` (the v2 front end after each fix, 18 runs each). Round 1 numbers come from `out/final` (48 runs), `out/final-findfix` (2 runs after the prototype's `find()` fix), `out/latency-*.json`, and `out/matrix2` for the Cua Driver release arm. `out/final-contaminated` holds six runs that executed while a stray Open With picker held the foreground; they were rerun. Earlier batches were shake-outs or were contaminated, and aren't used.

## Arms

| Arm | Agent | CU stack |
| --- | --- | --- |
| `claude-codexcu` | Claude Code, Opus | Codex's own CU runtime (`cua_repl`, `js` tool) via `codex_cu_bridge.py` |
| `claude-cua` | Claude Code, Opus | Cua Driver v0.34.1 release, all 59 tools |
| `claude-cua-main` | Claude Code, Opus | Cua Driver `main` build (adds `run_steps`, `run_script`), 61 tools |
| `claude-bcu` | Claude Code, Opus | `proto/v1/bcu-mcp.ts`: one `js` tool over Cua Driver `main` |
| `claude-bcu-fork` | Claude Code, Opus | Same, over the local Cua Driver fork with modal-safe Invoke (`tools/cua-driver-fork/`) |
| `claude-bcu2` | Claude Code, Opus | `proto/v2/bcu-mcp.ts` (v2: settling reads, `select`, explicit foreground, app scoping) over fork v2 (`tools/cua-driver-fork/v2/`) |
| `gpt-codexcu` | Windows Codex CLI, GPT-6 Astra | Same Codex runtime. **Retired**, see caveats |

All arms get the same prompt text and effort level (`medium`). Claude runs use `--tools ""` (no built-in tools), `--strict-mcp-config` and `--setting-sources user`. The Codex run disables its shell, exec, plugins, web search and other MCP servers through per-run `-c` flags, with a read-only sandbox. No config file is changed.

## Tasks

| Task | App | What it exercises |
| --- | --- | --- |
| `calc_mul` | Calculator (UWP) | Launching a packaged app, button input, reading a display |
| `edit_append` | TestPad (WinForms) | Editing a text box, Ctrl+S |
| `edit_saveas` | TestPad | Menu, the real Windows Save As dialog |
| `edit_replace` | TestPad | Menu, a modal Replace dialog |
| `explorer_move` | File Explorer | New folder, rename, move a file |
| `edge_form` | Edge (Chromium), isolated profile, accessibility forced on | Web form: text, select, checkbox, submit |

TestPad (`apps/TestPad.cs`, compiled to its own exe) stands in for Windows Notepad, because Notepad restores the user's own session tabs, and some of those hold secrets. Task files live in `%TEMP%\bcu`. Edge runs in a throwaway profile there.

## What each run records

`out/<batch>/<arm>/<task>-r<n>/`:

- `transcript.jsonl`: the agent's event stream, each line prefixed with its receive time.
- `screenshot-*`: every image the model saw (Claude arms).
- `metrics.json`: pass/fail, wall time, startup, summed tool time, model time, tool calls, turns, tokens, cost.
- Desktop disturbance in `metrics.json`: how far the real cursor moved and how often the foreground window changed during the run, sampled every 100 ms.
- `windows-closed.txt`: what teardown closed.

Teardown only closes windows that appeared during the run and belong to the task apps (`win.TASK_WINDOWS`).

## Caveats

- `codex_cu_bridge.py` is a copy of `~/.local/bin/codex-cu-mcp` with Codex's browser backends disabled and browser tab records redacted.
- The GPT arm is retired and `run.py` refuses it. When Windows `codex.exe` is the MCP client, Codex's runtime attaches to the user's Chrome extension and `cua.getState()` returns their real open tabs (titles and URLs), which the bridge did not reliably strip. Run standalone, it also isn't a fair Codex baseline: without the desktop app's native pipe, `cua.listWindows` disappears after `getState()` on most tasks.

- Transcripts include window titles from the whole desktop (Codex's `listWindows` returns all of them). Keep `out/` local.
- Elevated windows can't be closed from a normal process. A task that opens one (for example `sysdm.cpl`) leaves it behind, so it's not in the default suite.
- Cost for the GPT arm isn't reported, because it runs on a ChatGPT plan.
