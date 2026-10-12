# Synthesis: Codex-grade computer use for Claude

Research date: 2026-10-11. Goal, as set by the user: **better computer use for Claude now**, because Claude is clearly behind Codex. Support for other labs is a later bonus, not the v1 target.

This note pulls together seven research reports in this folder. Each claim points at the report that sources it; those reports carry the primary links. Claims the plan depends on were re-checked by hand and are marked **(re-verified)**.

| File | Topic |
| --- | --- |
| [01-codex-cu-internals.md](01-codex-cu-internals.md) | How the Codex CU runtime installed on this machine works |
| [02-codex-cu-public.md](02-codex-cu-public.md) | What OpenAI shipped and said, and what "Ultra" and "Ultrafast" are |
| [03-frontier-models-and-benchmarks.md](03-frontier-models-and-benchmarks.md) | Current models from every lab, leaderboards, action-space conventions, how to evaluate |
| [04-open-source-landscape.md](04-open-source-landscape.md) | Open-source projects and fork candidates |
| [05-speed-and-accuracy-techniques.md](05-speed-and-accuracy-techniques.md) | What makes CU agents fast and accurate, with numbers |
| [06-platform-automation-apis.md](06-platform-automation-apis.md) | UIA, AX, AT-SPI, input, capture, background operation |
| [07-model-agnostic-interface.md](07-model-agnostic-interface.md) | Provider tool schemas, MCP support per harness, adapter design |
| [08-experiments.md](08-experiments.md) | Benchmark on this Windows machine: Codex runtime vs Cua Driver vs our prototype, all driven by Claude |

**Update after the experiments (report 08).** The base is decided: a local fork of Cua Driver (nothing goes upstream) with our own TypeScript code-mode front end. Round 1 showed the gap is tooling: Claude passed 12/12 tasks on Codex's own runtime. Round 2 fixed what round 1 measured: modal dialogs, Chromium input, model sleeps, the cursor animation tax, and API paper cuts found in traces. On the same Windows suite, Claude on our stack now finishes tasks in a median of 12.4 s (worst case 33.5 s), against 44.2 s (worst 81.8 s) on Codex's runtime. It costs $0.05 per task against $0.23, and moved the user's cursor in 2 of 18 runs against 15 of 18.

## The short version

1. **Claude is behind because of the harness, not the model.** Claude Fable 5 has the top single-model score on the maintainers' OSWorld-Verified board (85.96%). Opus 5.5 and Sonnet 5.5 lead OSWorld 2.1 partial. OpenAI quotes OSWorld 2.0 for GPT-6 Astra, so cross-lab comparisons are loose, but nothing suggests Claude is the weaker model. [03]
2. **Claude's own computer use is screenshot-only and pixel-clicking.** The Claude Code CLI version is macOS-only and downscales every frame to about 1372x887. It hides your other apps while it works, and only one session can use it at a time. Claude Desktop adds Windows, with background mode documented only for macOS 15+. Anthropic's own help article calls it "slower" and "more error-prone" than connectors **(re-verified: [Claude Code computer use](https://code.claude.com/docs/en/computer-use), [Cowork computer use](https://support.claude.com/en/articles/14128542-let-claude-use-your-computer-in-cowork))**.
3. **On this machine, Claude has no first-party computer use at all.** The CLI runs in WSL, and computer use "is not available on Linux or Windows" in the CLI. The user's `codex-cu-mcp` bridge is the only route, and it already proved Claude can drive Codex's accessibility-tree `js` harness (5 turns, 15.9 s on Calculator). [01]
4. **Codex's harness speed is simple and copyable.** It has one `js` tool backed by a persistent REPL. Several actions plus the next observation go in one call. The runtime waits for the UI to settle (about 1 s, capped near 5 s). Observations are compact indexed accessibility trees, and coordinate clicks are tied to a screenshot id. [01]
5. **"Ultra-fast" is mostly model-side.** Ultrafast is a paid inference tier with up to 8x decode on GPT-6 Astra, at 6x credit cost, on Pro $500 and Enterprise/Edu **(re-verified: [OpenAI speed docs](https://learn.chatgpt.com/docs/agent-configuration/speed))**. Claude's equivalent lever is Opus fast mode at up to 2.5x [03]. That leaves a decode gap we can't close. The harness has to make up for it with fewer, smaller turns.
6. **Model calls are 75-96% of task time.** Screenshots, clicks and grounding together are under 6% (OSWorld-Human). Cutting turns is everything. [05]
7. **Codex on Windows takes over the desktop.** It moves the real mouse and steals focus. A background-capable engine beats it outright on Windows. [01, 02, 06]
8. **The best open base is Cua Driver.** It's MIT, Rust, and covers Windows, macOS and Linux over MCP. It does background input by default (UIA patterns, then pen injection, then PostMessage on Windows) and already has batching and a QuickJS script tool **(re-verified: repo MIT, 29.4k stars, pushed 2026-10-11; `batch_tools.rs`, `script_tool.rs`, `platform-windows/src/input/inject.rs` exist)**. Its gaps are a persistent REPL, images from code, and app binding, which is what a Codex-style front end adds. [04, 06]
9. **Don't fork Codex.** It's proprietary. Treat it as a behavioral spec. [01]

## Claude today vs Codex vs the target

| | Claude CU today | Codex CU | Target for Claude |
| --- | --- | --- | --- |
| Platforms | CLI: macOS only. Desktop: macOS, Windows | Desktop app on macOS, Windows | Any Claude Code session on Windows, macOS, Linux, including WSL |
| Observation | Screenshots only | AX tree plus screenshots | AX tree, diffed, plus screenshots on demand |
| Targeting | Pixel coordinates | Element index or pixels | Element index first, pixels as fallback |
| Actions per turn | API toolset batches; built-in CLI server undocumented | Many, as JS | Many, as sandboxed JS |
| Waiting | Not documented | Settle in runtime, ~1-5 s | Event plus pixel settle, `waitFor()` |
| Background | CLI hides other apps. Desktop backgrounds on macOS 15+ | macOS yes. Windows takes over | Background on Windows (pen injection) and macOS via Cua Driver |
| Fast tier | Opus fast mode, up to 2.5x | Ultrafast, up to 8x | Claude fast mode, plus fewer turns |

## What we copy, and what's Claude-specific

| Source of Codex's speed | Our version for Claude |
| --- | --- |
| Many actions per call (JS code mode) | Persistent sandboxed `js` tool. Claude is strong at code, and Anthropic reports +11% accuracy and -24% tokens from programmatic tool calling [07] |
| Settle detection in the runtime | Event-driven waits, `waitFor(...)` in the API, no model-side sleeps |
| Compact AX tree, stable ids | Window-scoped snapshots, bulk UIA cache requests, diffs on every OS (Codex diffs only macOS and the browser) |
| Screenshot discipline | Per-window JPEG, frame-id-bound coordinates, frames at or under 1372x887 so neither Claude Code nor the API rescales them [07] |
| Model co-trained on the harness | Can't copy. Compensate with an API in Claude's own vocabulary and a skill carrying worked examples (below) |
| Plugin with MCP + skill + Stop hooks | Ship as a Claude Code plugin with the same parts. Codex's plugin is "one MCP server and one skill" plus Stop/Interrupt hooks [01, 02] |

**Design the API for Claude, not as a copy of Codex.** Claude's priors come from its own computer tool and from Playwright, not from OpenAI's `cua` object. So:

- Use Claude's computer-tool action names and xdotool-style key strings (`key("ctrl+s")`).
- Use `zoom(region)`, since Claude's toolset ships zoom on by default.
- Use Playwright-style locators (`find({ role, name })`), which Claude knows well.
- Accept an app name, a window id or a query everywhere. Codex's e2e run lost its first turn because Windows wanted `{ windowId }`. [01]

**Claude Code limits to design around.** [07]

- Results warn above 10,000 tokens and cap at 25,000 by default, so keep trees compact and paged.
- Calls over 2 minutes auto-background, so keep `js` calls short.
- Tool search defers MCP tool definitions, so the server `instructions` and the skill have to carry the workflow.
- Claude Code supports elicitation. It also has an `Elicitation` hook that can auto-answer, so approvals need server-side memory and policy, not trust in the prompt alone.

**Where we can go past Codex.**

- Guarded replay ("muscle memory"): 8.5-13x on repeat tasks, but only with state checks. [05]
- Program-state shortcuts: COM, PowerShell, CDP. UFO2 used 58.5% fewer steps. [05]
- UIA remote operations for Windows tree reads, which no open-source project uses yet. [06]

## Recommendation: a Claude Code plugin on top of Cua Driver, measure first

```
  Claude Code (CLI in WSL / Windows / macOS / Linux, Desktop later)
        |  plugin: MCP server + skill (API docs, worked examples) + Stop/SubagentStop hooks
        v
  MCP server, profile "code": js, js_reset
        |
  sandboxed persistent JS runtime (isolated-vm or QuickJS); its only authority is `cua`
        |
  broker: approvals + policy + Esc kill switch + frames/coords + audit log + replay cache
        |
  Cua Driver (MIT Rust core, unmodified at first): UIA/AX/AT-SPI, WGC/SCK capture,
             background input ladder, batching, diffs
```

From WSL, the MCP server launches a Windows-side process to reach the desktop, the same way the user's bridge does. [01]

### Disagreements between the reports, resolved

- **Fork or depend on Cua Driver (04 vs 06).** Fork, locally. Measured primitives are 15-85 ms with no cursor movement, and we already needed a patch for modal dialogs that upstream doesn't have. [08]
- **Plain Node REPL or sandbox (04 vs 07).** Sandbox. A plain Node REPL is a shell escape. [07]
- **Elicitation for approvals (01 vs 07).** Use elicitation as the prompt UI in Claude Code, but keep policy and remembered approvals in the engine. [01, 07]
- **Coordinates.** Element indices first. Pixels are "in the frame we sent", which is Claude's native convention. Normalized spaces wait until we support other labs. [03, 07]

## Plan

### Phase 0: measure (done, see [08](08-experiments.md))

What actually ran: A (Claude + Codex runtime), B (Claude + Cua Driver `main`), and E (Claude + our prototype, with and without the patched driver), 6 tasks × 2 reps. C (GPT on Codex) was retired: under Windows `codex.exe` the runtime returned the user's real Chrome tabs to the model, and outside the Codex desktop app it isn't a fair baseline anyway. D (Claude Desktop computer use) wasn't run. The original plan follows.

All arms use the same task suite and record repeatable artifacts: transcript, frames, action log, wall-clock, turns, tokens and success.

| Arm | What it tells us |
| --- | --- |
| A. Claude Code + Codex CU via the `codex-cu` bridge | Claude on Codex's harness |
| B. Claude Code + stock Cua Driver MCP | Claude on the open base, and Cua's real Windows latency |
| C. Codex app + GPT-6.x on the same tasks | The bar we're chasing |
| D. Claude Desktop computer use (Windows) | Claude's first-party baseline |
| E. Claude Code + ours, once it exists | Our progress |

- **A vs C** separates model from harness.
- **A, B and D** show how much the harness alone is worth for Claude.

Suite: 10-15 Windows desktop tasks (Calculator, Notepad, Explorer, Settings, a browser form, an Office paste, an Electron app). Later, OSWorld-Verified `test_small` (39 tasks) for cross-platform accuracy. [03] This machine has an RTX 4090, KVM and 15 GB of RAM in WSL with no Docker. That's enough for this suite and one or two OSWorld VMs, and full runs belong on a cloud box.

### Phase 1: the Claude Code plugin (MVP)

1. MCP server with `js` and `js_reset` in a persistent sandboxed runtime.
2. The Claude-shaped `cua` API above, with capability flags instead of per-OS errors.
3. Actions that settle by default and return a small change summary.
4. Frames at or under 1372x887, JPEG, frame-id-bound, plus `zoom(region)`.
5. A skill with the API reference and three or four worked examples.
6. Stop hooks that release the cursor and end the turn.
7. Engine-owned approvals with session and always scopes, a default deny list, an Esc kill switch and a static overlay. Telemetry off.

### Phase 2: speed past the baseline

Guarded replay, program-state shortcuts (COM, PowerShell, CDP), and a UIA remote-operations prototype. Also check whether a local grounding model on the 4090 helps Claude's pixel fallback. Claude may not need it. [03, 05, 06]

### Later: other labs

A "tools" profile for weaker coders, then native adapters for direct API agents (OpenAI `computer`, Gemini `computer_use`) and normalized coordinates. The engine design in [07] already leaves room for this.

## Decisions (made 2026-10-11)

1. **Base.** A local fork of Cua Driver as the native layer, chosen on measured results (report 08).
2. **Where the REPL lives.** In our own TypeScript front end. The user ruled out sending anything upstream, so extending Cua Driver's `run_script` upstream is off the table.
3. **Platform order.** Windows and WSL first, the user's platform.

Rounds 2 and 3 built the plan through Phase 1: the plugin (`plugin/`, QuickJS sandbox, per-app approvals, skill, installer) over fork v4 of the driver, after an external review's findings were fixed. On a 9-task suite that includes cross-app work, Claude on it finished tasks in a median 12 s at $0.09, against 45 s and $0.26 on Codex's runtime, without moving the cursor ([08, round 3](08-experiments.md#round-3-the-plugin-on-a-harder-suite)). Next: time the real Codex app with `bench/codex_app_wizard.sh`, use the plugin day to day, and add longer tasks.

## What's still unknown

- ~~Cua Driver's per-action latency on Windows compared with Codex CU.~~ Answered: tree 31 ms vs 29 ms, tree plus screenshot 85 ms vs about 2 s, actions 15-30 ms vs 38-49 ms. [08]
- How fast the real Codex desktop app is on the same tasks. Only Claude on Codex's runtime was measured. The app with GPT-6.x has to be timed by hand.
- Whether Claude does better on an accessibility-tree code harness than on its own trained screenshot tool. Arm A against D answers it. Cua Driver Bench v2 runs this comparison on macOS but hasn't published results. [04, 07]
- How much of Codex's edge is Ultrafast decode alone. OpenAI hasn't published a CU-specific number. [02]
- Reliable background keyboard input to Chromium on Windows without CDP or a focus swap. Nobody has a clean answer [06], and every arm in our benchmark hit it on the Edge form. [08]
- Many model names and scores here are newer than parts of our tooling's training data. The reports cite primary pages, but scores should reproduce in our own harness before we plan around them.
