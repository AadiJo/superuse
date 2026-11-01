# better-computer-use

Windows computer use for Claude Code. Claude gets one MCP tool, `js`, and writes short JavaScript programs against a `cua` API: bind a window, read its accessibility tree, click, type, set values, walk menus, and check the result, several steps per call. Input goes to the target window in the background, so your mouse and focus stay yours.

On a 9-task Windows suite, three of them across several apps, Claude on this stack finished tasks in a median 12 s at $0.09 each, and the cursor never moved. On Codex's own computer-use runtime the same tasks took Claude 45 s at $0.26, and it moved the cursor in 24 of 27 runs (`research/08-experiments.md`).

## Install (WSL)

Point your agent at this repo and say "configure this for me". `AGENTS.md` walks it through setup. Or run it yourself from a permanent clone:

```bash
scripts/install.sh                    # Claude Code and Codex, whichever are installed
scripts/install.sh --clients=codex    # just one
scripts/doctor.sh                     # check an install without changing it; --verify drives a test app
```

The installer finds Node 24+ or downloads one for bcu, installs the server's one dependency, and downloads the driver release that `driver/release.json` pins, checking its SHA-256. The repo is private, so the download needs `gh auth login`. `--build` compiles the driver from source instead, which needs Rust. Then it registers bcu with each client through the client's own CLI, records the Node it used for GUI-launched clients, and starts the server once to prove it works. Reruns repair what's stale and leave everything else alone, including your policy file. The report ends on `server_verified`, or `restart_required` when a client needs a new session to load the change.

Claude Code loads the plugin in place from `plugin/`, so edits apply after `/reload-plugins`. Other MCP clients run `plugin/server/run.sh` as a stdio server with no arguments; the report prints the full path.

Requirements: Windows 11 with WSL2 (x64). Rust only for `--build`.

## Approvals and privacy

- The first time Claude binds an app, Claude Code asks you to allow it. "Always allow" writes the app to `~/.config/bcu/policy.json`, which you can edit by hand (`allow`, `deny`, `foreground`); edits apply to running sessions. `"allow": ["*"]` approves every app, and `"foreground": "allow"` skips the foreground prompt.
- `"browsers": "attach"` lets `w.page()` reach web pages in a running Chrome, Edge or Helium over the browser's own DevTools, with your logged-in profile. It needs the browser's remote debugging toggle (`chrome://inspect/#remote-debugging`) on; the driver answers the browser's "Allow remote debugging?" prompt itself, once per session. Off by default.
- Some clients never show these prompts. T3 Code declines them automatically, so use the policy file there (`scripts/install.sh --allow-apps=TestPad,Calculator` adds apps to it).
- Until you approve an app, Claude sees its name but none of its window titles.
- Terminals, password managers, security prompts and other agents are blocked unless the policy file's `allow` names them by exact key (`"*"` doesn't lift these blocks).
- `{foreground: true}` (real cursor and focus) asks first by default.
- Every action is logged, without typed text, to `~/.local/state/bcu/actions.jsonl`.
- Model code runs in a QuickJS sandbox with no filesystem, network or process access.

Headless runs (`claude -p`) can't show prompts. Pre-approve apps there with `BCU_APPS=TestPad,Calculator`.

## Layout

| Path | What |
| --- | --- |
| `plugin/` | The Claude Code plugin: `server/` (MCP server), `skills/computer-use/`, `driver/` (built exe, not in git) |
| `driver/` | Our hard fork of Cua Driver (Rust): source, release pin, `NOTES.md` on what we changed and why |
| `scripts/` | `install.sh`, `doctor.sh` and the setup they run; `release-driver.ts` publishes a driver build |
| `bench/` | End-to-end benchmark on the real desktop, plus `server-check.ts` for the sandbox and policy and `ui-check.ts` for the window API |
| `research/` | Research reports (`00-synthesis.md` first) and experiment results (`08-experiments.md`) |

Server checks: `node bench/server-check.ts` (sandbox and policy, read-only on the desktop) and `node bench/ui-check.ts` (the window API on fixture windows; sends input, so keep the desktop idle). Setup checks: `node bench/setup-check.ts` (fresh clones in isolated client config). Driver checks: `node bench/acceptance.ts`. Codex app baseline: `bench/codex_app_wizard.sh`. Type check: `npm run typecheck` in `plugin/server`, and at the repo root for the `bench/` and `fork/` scripts.
