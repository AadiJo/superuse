# Windows computer-use benchmark

End-to-end comparison of computer-use stacks on the real Windows desktop, driven from WSL. Each run is one agent, one CU stack ("arm"), one task. Success comes from each task's own checker, which reads real Windows state (file contents, Calculator's display through UIA, Edge's window title). The agent's claim doesn't count.

```bash
node run.ts --arms claude-superuse,claude-cua-038,claude-agent-desktop-headed --tasks calc_mul,edge_form --reps 2 --batch mybatch
node report.ts mybatch          # out/mybatch/report.md; a path to a batch folder works too
node trace.ts out/mybatch/claude-superuse/calc_mul-r1          # step-by-step trace of one run
node trace.ts out/mybatch/claude-superuse/calc_mul-r1 --calls  # each tool call: duration, code, result
```

The scripts run on Node 24+ through type stripping, with no build step. `npm install` and `npm run typecheck` at the repo root check them.

`node session-check.ts [--idle]` checks that the plugin's driver client starts its session again after the driver ends it, through the real driver, and writes `out/session-check-<time>.json`. `--idle` waits out the driver's real 5-minute idle timeout instead of ending the session.

`node agent-labels.ts` starts two plugin servers at once, has each click in its own MenuPad window, and captures both windows to `out/agent-labels-<time>/labels.png`, where both cursors must show different labels. It sends input, so run it on an idle desktop.

`node helium-check.ts [--direct | --claude]` checks the plugin's page API in your own Helium. It fills a test form in a tab it opens and closes again, and writes `out/helium-check-<time>.json`.

`node cursor-colors.ts [--baseline <exe>]` checks that drivers running side by side draw different cursor colors, and that a driver which exits frees its color. It sends input to three MenuPads it opens, and writes `out/cursor-colors/<time>.json` with PNGs.

## Results

The write-up is [research/08-experiments.md](../research/08-experiments.md). The competitor comparison comes from `out/v6-competitors` (this plugin, Cua Driver 0.38.0 and agent-desktop 1.0.2 with and without `--headed`, 72 runs, seed 412487). Earlier rounds used arms that are retired now, along with the `proto/` front ends they ran. Round 4 numbers come from `out/v5` (the round 3 code frozen as `claude-superuse-v4` against the round 4 code, 54 runs, seed 4471). Round 3 numbers come from `out/v3` (Codex runtime, the round 2 stack and the plugin on fork v3, 81 runs over 9 tasks) and `out/v4` (the plugin on fork v4 after the review fixes, 27 runs). Round 2 numbers come from `out/v2` (Codex runtime, Cua Driver and the v2 front end, 54 runs) and `out/v2.1` through `out/v2.3` (the v2 front end after each fix, 18 runs each). Round 1 numbers come from `out/final` (48 runs), `out/final-findfix` (2 runs after the prototype's `find()` fix), `out/latency-*.json`, and `out/matrix2` for the Cua Driver release arm. `out/final-contaminated` holds six runs that executed while a stray Open With picker held the foreground; they were rerun. Earlier batches were shake-outs or were contaminated, and aren't used.

## Arms

| Arm | Agent | CU stack |
| --- | --- | --- |
| `claude-codexcu` | Claude Code, Opus | Codex's own CU runtime (`cua_repl`, `js` tool) via `codex-cu-bridge.ts` |
| `claude-superuse` | Claude Code, Opus | `plugin/server/main.ts` (QuickJS sandbox, per-app policy) over `plugin/driver/superuse-driver.exe`, whatever this checkout holds (fork v6 after round 4) |
| `claude-cua-038` | Claude Code, Opus | Cua Driver 0.38.0 release (`tools/cua-driver-0.38.0/`), all 63 tools |
| `claude-agent-desktop` | Claude Code, Opus | agent-desktop 1.0.2 CLI (`tools/agent-desktop-1.0.2/`) through Bash limited to `agent-desktop`, with its bundled skills in the system prompt |
| `claude-agent-desktop-headed` | Claude Code, Opus | Same, with physical input (`--headed`) allowed, as `SUPERUSE_FOREGROUND=allow` does for the plugin arms |

All arms get the same prompt text and effort level (`medium`). MCP arms run Claude with `--tools ""` (no built-in tools); CLI arms get only Bash, allowed for their one command. Every arm uses `--strict-mcp-config` and `--setting-sources user`. No config file is changed.

## Tasks

| Task | App | What it exercises |
| --- | --- | --- |
| `calc_mul` | Calculator (UWP) | Launching a packaged app, button input, reading a display |
| `edit_append` | TestPad (WinForms) | Editing a text box, Ctrl+S |
| `edit_saveas` | TestPad | Menu, the real Windows Save As dialog |
| `edit_replace` | TestPad | Menu, a modal Replace dialog |
| `explorer_move` | File Explorer | New folder, rename, move a file |
| `edge_form` | Edge (Chromium), isolated profile, accessibility forced on | Web form: text, select, checkbox, submit |
| `xapp_invoice` | Edge, Calculator, TestPad | Read a table, compute in another app, save the result through Save As |
| `xapp_csv_list` | File Explorer, TestPad | Read a folder listing (extensions may be hidden), write a sorted list, save |
| `xapp_form_from_file` | TestPad, Edge | Read a contact card, fill and submit the form |

The `xapp_*` tasks draw random values each run (invoice lines, which files exist, which contact), and their checkers compare against answers kept in the benchmark process's memory, where the agent can't edit them. The draws come from a PRNG keyed on the batch seed, task and rep. `run.ts` prints the seed and records it in `metrics.json`. `--seed <n>` replays the same values, and without it a new batch picks a seed while a restarted one keeps its own.

TestPad (`apps/TestPad.cs`, compiled to its own exe) stands in for Windows Notepad, because Notepad restores the user's own session tabs, and some of those hold secrets. Task files live in `%TEMP%\superuse`. Edge runs in a throwaway profile there.

## Codex desktop app baseline

`bench/codex_app_wizard.sh` walks you through timing the real Codex app (GPT-6 Astra, any speed tier) on the same six core tasks: it sets each task up, puts the identical prompt on your clipboard, times from your "sent" to your "done" keypress while sampling the cursor and focus, and runs the same checker. Results land in `out/codex-app/` in the same format, so `node report.ts codex-app` compares them. `REPS=2` runs each task twice.

## What each run records

`out/<batch>/<arm>/<task>-r<n>/`:

- `transcript.jsonl`: the agent's event stream, each line prefixed with its receive time.
- `screenshot-*`: every image the model saw (Claude arms).
- `metrics.json`: pass/fail, wall time, startup, summed tool time, model time, tool calls, turns, tokens, cost, seed.
- Desktop disturbance in `metrics.json`: how far the real cursor moved and how often the foreground window changed during the run, sampled every 100 ms.
- `windows-closed.txt`: what teardown closed.
- `server-trace.jsonl` (`claude-superuse`): the server's timing for each `js` call, API call and driver call, written through `SUPERUSE_TRACE`. Servers older than round 4 write none.

Teardown only closes windows that appeared during the run and belong to the task apps (`TASK_WINDOWS` in `win.ts`, plus File Explorer windows showing a folder under `%TEMP%\superuse`). It force-kills only processes a run started: TestPad (the benchmark's own exe), an Open With picker that appeared during the run, and Edge in the throwaway profile. Everything else gets a normal close. Teardown can't tell a window the agent opened from one a person opened mid-run, so a Notepad or UWP window opened by hand during a run gets the same close; keep the desktop idle while a batch runs.

## Caveats

- `codex-cu-bridge.ts` is a port of `~/.local/bin/codex-cu-mcp` with Codex's browser backends disabled and browser tab records redacted.
- The GPT arm (`gpt-codexcu`, the Windows Codex CLI) is retired and no longer in `run.ts`; older batches still hold its runs. When Windows `codex.exe` is the MCP client, Codex's runtime attaches to the user's Chrome extension and `cua.getState()` returns their real open tabs (titles and URLs), which the bridge did not reliably strip. Run standalone, it also isn't a fair Codex baseline: without the desktop app's native pipe, `cua.listWindows` disappears after `getState()` on most tasks.

- The `claude-codexcu` arm sends window titles from the whole desktop to the model (Codex's `listWindows` returns all of them), and they land in its transcripts. That's why the default arm is the plugin (`claude-superuse`), which hides unapproved apps' titles. Run the baseline only on a desktop with nothing private open, and keep `out/` local.
- Elevated windows can't be closed from a normal process. A task that opens one (for example `sysdm.cpl`) leaves it behind, so it's not in the default suite.
- Cost for the GPT arm isn't reported, because it runs on a ChatGPT plan.
