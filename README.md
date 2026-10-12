# better-computer-use

Windows computer use for Claude Code. Claude gets one MCP tool, `js`, and writes short JavaScript programs against a `cua` API: bind a window, read its accessibility tree, click, type, set values, walk menus, and check the result, several steps per call. Input goes to the target window in the background, so your mouse and focus stay yours.

On a 6-task Windows suite, Claude on this stack finished tasks in a median 12 s at $0.05 each. On Codex's own computer-use runtime the same tasks took Claude 44 s at $0.23 (`research/08-experiments.md`).

## Install (WSL)

```bash
scripts/install.sh
```

It builds the driver if `plugin/driver/cua-driver.exe` is missing (`fork/build.sh`), installs the server's one dependency, registers this checkout as a local plugin marketplace, and installs `bcu@better-computer-use` at user scope. Start a new Claude Code session afterwards. The plugin loads in place, so edits under `plugin/` apply after `/reload-plugins`.

Requirements: Windows 11 with WSL2, Node 24+ in WSL, and Rust (rustup) only if the driver needs building.

## Approvals and privacy

- The first time Claude binds an app, Claude Code asks you to allow it. "Always allow" writes the app to `~/.config/bcu/policy.json`, which you can edit by hand (`allow`, `deny`, `foreground`).
- Until you approve an app, Claude sees its name but none of its window titles.
- Terminals, password managers, security prompts and other agents are blocked unless the policy file's `allow` names them.
- `{foreground: true}` (real cursor and focus) asks first by default.
- Every action is logged, without typed text, to `~/.local/state/bcu/actions.jsonl`.
- Model code runs in a QuickJS sandbox with no filesystem, network or process access.

Headless runs (`claude -p`) can't show prompts. Pre-approve apps there with `BCU_APPS=TestPad,Calculator`.

## Layout

| Path | What |
| --- | --- |
| `plugin/` | The Claude Code plugin: `server/` (MCP server), `skills/computer-use/`, `driver/` (built exe, not in git) |
| `fork/` | Our Cua Driver fork: upstream pin, patches, build script, notes, live acceptance checks |
| `bench/` | End-to-end benchmark on the real desktop, plus `server_check.py` for the sandbox and policy |
| `research/` | Research reports (`00-synthesis.md` first) and experiment results (`08-experiments.md`) |
| `proto/` | Archived front ends measured in rounds 1 and 2 |

Server checks: `python3 bench/server_check.py`. Type check: `npm run typecheck` in `plugin/server`.
