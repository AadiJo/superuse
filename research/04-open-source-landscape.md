# Open-source computer-use landscape and fork candidates

Research date: 2026-10-11. Star counts and push dates come from the GitHub API on that day. Source was read for Cua Driver (trycua/cua), open-codex-computer-use, agent-desktop, terminator, Windows-MCP, pi-computer-use, LCU and UFO by shallow-cloning into `/tmp/cu-research`. Everything else is from READMEs, release pages and web search, and is marked where I could not confirm it.

## TL;DR

- **Cua Driver is the strongest base by a wide margin.** It lives at `libs/cua-driver` in [trycua/cua](https://github.com/trycua/cua) and is MIT licensed. It's a Rust MCP server for Windows, macOS and Linux (X11, Sway, GNOME, KDE) with background-first input, snapshot-bound element tokens, `run_steps` batching, a QuickJS `run_script` tool, `since:"latest"` tree diffs and an E2E harness on all three OSes. It's also huge (around 370k lines of Rust) and owned by a VC-backed company. Telemetry is on by default.
- **iFurySt/open-codex-computer-use is the closest clone of Codex CU's tool shape.** It has the 9 native tools plus a persistent Node `js`/`js_reset` REPL with a `cua.getApp()` API, and it's MIT. Its macOS layer is deep, built on reverse-engineered SkyLight background input and 15-45 ms window capture. Its Windows layer is weak: it spawns `powershell.exe` once per tool call, and the project's own quality doc grades it "C".
- **Codex CU on Windows is reportedly foreground-only** (since its 2026-05-29 launch, per [TechTimes](https://www.techtimes.com/articles/317531/20260601/openai-codex-computer-use-now-windows-foreground-takeover-europe-excluded.htm)). Cua Driver already does background delivery on Windows through a UIA Invoke, then pen/touch injection, then PostMessage ladder. So on Windows, "match Codex" may really mean "beat Codex". I haven't verified whether OpenAI added Windows background mode after June.
- **The Windows-only options are weaker bases.** Windows-MCP (8.7k stars) is Python, resolves labels to screen coordinates and sends real `SendInput`, which steals the cursor, and has PostHog telemetry on by default. Terminator has a good Rust UIA engine with cache requests, but it's Windows-only, its last release was April 2026, the company pivoted to a commercial IDE, and the MCP server is a single 10.9k-line file.
- **The agent frameworks don't fit our goal.** Agent-S, UI-TARS-desktop, UFO, Bytebot (archived) and OmniTool each own their own LLM loop and mostly use screenshots plus model-predicted coordinates. They're useful for grounding-model ideas, not as a tool layer for "any agent over MCP".
- **Ideas worth borrowing:** agent-desktop's skeleton traversal (Slack goes from 30,743 tokens to 383), pi-computer-use's immutable, epoch-checked state model, terminator and Windows-MCP's UIA `CacheRequest` tree builders, and computer-use-linux's compositor-aware Wayland window registry. From the browser tools: cross-run action caching (Stagehand, Skyvern, OpenAdapt) and "screenshot only when needed" (browser-use says each screenshot adds about 0.8 s of inference latency).
- **Watch out for these licenses.** mcp-server-macos-use is BSL 1.1, not open source. Skyvern is AGPL. Older OmniParser icon detectors are AGPL, and Cua's optional perception extension pulls in AGPL. Cua's Spaces apps and crates are FSL-1.1-MIT and sit in the same monorepo as the MIT driver.
- **Recommendation: don't fork a whole project yet.** Build a thin Codex-style MCP front end (one persistent `js` tool, per-app approval through elicitation) on top of Cua Driver as the native layer, and only fork `libs/cua-driver` if upstream won't take our changes. The fallback is to fork open-codex-computer-use for its front end and macOS layer and swap its Windows and Linux runtimes for Cua Driver's platform crates.

## What "Codex CU parity" needs, and who has it

| Capability | Codex CU | Cua Driver | open-codex-computer-use | Windows-MCP | Terminator |
| --- | --- | --- | --- | --- | --- |
| Persistent JS REPL tool (`js`) with bindings across calls | Yes | No. `run_script` builds a fresh QuickJS runtime per call and returns text only ([WORKFLOW.md](https://github.com/trycua/cua/blob/main/libs/cua-driver/rust/Skills/cua-driver/WORKFLOW.md)) | Yes, Node worker plus `cua.getApp()` ([kernel](https://github.com/iFurySt/open-codex-computer-use/tree/main/scripts/node-repl)) | No | Partial. Runs JS/TS workflow scripts, but not as a REPL |
| AX tree plus screenshot per window | Yes | Yes (UIA, AX, AT-SPI) | Yes | Yes (UIA plus dxcam) | Yes (UIA) |
| Act by element index | Yes | Yes, snapshot-bound `element_token` | Yes, `element_index` | Label resolved to coordinates | Selectors such as `role:Button\|name:Save` |
| Background input on Windows | Reportedly no | Yes by default, with exact refusal codes | Partial (PostMessage, `EM_REPLACESEL`) | No (`SendInput`) | Claimed |
| Background input on macOS | Yes | Yes | Yes (SkyLight SPI) | n/a | n/a |
| Batching and diffs | JS code mode | `run_steps`, `run_script`, `since:"latest"` | `call --calls`, JS | `MultiEdit`, `MultiSelect` | `execute_sequence`, tree diff |
| Per-app approval through MCP elicitation | Yes | Cautious. Its consent plan rejects plain elicitation as a trust boundary ([plan](https://github.com/trycua/cua/blob/main/libs/cua-driver/docs/driver-permission-modes-and-consent-plan.md)) | No, only a password-manager denylist | Control-takeover gate only | `ask_user` tool |
| Platforms | macOS, Windows, Linux (via ChatGPT app) | macOS, Windows, Linux | macOS (strong), Windows and Linux (grade C) | Windows | Windows |

## Comparison table

Stars and last push are as of 2026-10-11. "Fit" means fit as a fork base for a model-agnostic, MCP-exposed, Windows-first but cross-platform CU tool server.

| Project | License | Stack | Stars | Last push | Platforms | Observation | Action | Model-agnostic | MCP | Notable speed features | Fit |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| [trycua/cua](https://github.com/trycua/cua) (Cua Driver) | MIT (driver); FSL-1.1-MIT for Spaces dirs | Rust, plus UniFFI Python/TS SDKs | 29,363 | 2026-10-11 | Win, mac, Linux X11/Wayland | Hybrid: AX/UIA/AT-SPI plus window capture (WGC on Windows) | Element tokens, pixels, QuickJS script | Yes | Yes, stdio, MCP 2026-07-28 plus legacy | Background input, `run_steps`, `run_script`, query-filtered reads (about 2K vs 42K chars), `since` diffs, UIA cache requests | Best |
| [iFurySt/open-codex-computer-use](https://github.com/iFurySt/open-codex-computer-use) | MIT | Swift (mac), Go plus PowerShell (Win), Go plus Python (Linux), Node REPL | 2,385 | 2026-10-10 | mac strong, Win and Linux experimental | Hybrid AX plus window screenshot | `element_index`, coords, persistent JS | Yes | Yes | Persistent `js` REPL, SkyLight background click (about 82 ms return p50), private window capture 15-45 ms | Good for front end and mac, weak on Windows |
| [CursorTouch/Windows-MCP](https://github.com/CursorTouch/Windows-MCP) | MIT | Python 3.14, FastMCP, vendored `uiautomation` | 8,666 | 2026-10-10 | Windows | Hybrid UIA tree plus dxcam screenshot | Label to coords, then `SendInput` | Yes | Yes | UIA cache requests, threaded tree walk, screenshot-only fast path, claims 0.2-0.5 s between actions | Low |
| [mediar-ai/terminator](https://github.com/mediar-ai/terminator) | MIT | Rust (`uiautomation`, `windows` crates), rmcp | 1,653 | 2026-06-02 (last release 2026-04-05) | Windows only | UIA tree, optional screenshot/OCR | Selectors, coords | Yes | Yes | UIA `CacheRequest` in one IPC call, deterministic workflows, tree diff | Borrow the UIA layer only |
| [lahfir/agent-desktop](https://github.com/lahfir/agent-desktop) | Apache-2.0 | Rust CLI plus C-ABI cdylib | 1,786 | 2026-10-06 | macOS only (Win/Linux are 76-line stubs) | AX tree, skeleton traversal | Snapshot refs `@s..:eN` | Yes | No (CLI and FFI) | Skeleton traversal (78-96% fewer tokens), in-process FFI | Borrow ideas |
| [injaneity/pi-computer-use](https://github.com/injaneity/pi-computer-use) | MIT | TypeScript plus Rust (Win, Linux) and Swift (mac) helpers | 2,038 | 2026-10-11 | mac, Win, Linux | Hybrid AX plus optional image/OCR | State-scoped refs, multi-step `act_ui` | Yes | No (Pi extension) | Immutable cached observations, per-resource scheduler, compact diffs | Borrow the state model |
| [microsoft/UFO](https://github.com/microsoft/UFO) | MIT | Python (pywinauto, uiautomation) | 9,991 | 2026-10-07 | Windows (UFO2); Galaxy adds others | UIA plus OmniParser fusion | Control IDs plus COM APIs | Yes (own loop) | Internal MCP servers | Hybrid GUI plus API (Word/Excel/PPT COM) | Low as a base, borrow the API idea |
| [simular-ai/Agent-S](https://github.com/simular-ai/Agent-S) | Apache-2.0 | Python, pyautogui | 12,582 | 2026-10-08 (last release 2025-12-16) | Win, mac, Linux | Screenshot only | Grounding-model coords, code agent | Yes, but needs a grounding model | No | Behavior Best-of-N (72.6% OSWorld) | Low |
| [bytedance/UI-TARS-desktop](https://github.com/bytedance/UI-TARS-desktop) | Apache-2.0 | TypeScript, Electron, nut-js | 39,233 | 2026-10-09 | Win, mac | Screenshot | VLM coords | UI-TARS Desktop is model-tied; Agent TARS is multi-provider | Agent TARS mounts MCP servers | n/a | Low |
| [bytebot-ai/bytebot](https://github.com/bytebot-ai/bytebot) | Apache-2.0 | TypeScript (NestJS), Docker | 11,076 | 2025-09-12, archived | Linux container | Screenshot | Coords | Yes | No | n/a | None (archived) |
| [openinterpreter/openinterpreter](https://github.com/openinterpreter/openinterpreter) | Apache-2.0 | Rust (Codex fork) | 68,546 | 2026-10-11 | n/a | n/a | n/a | n/a | n/a | Pivoted to a coding harness; old OS mode is gone | None |
| [OpenAdaptAI/OpenAdapt](https://github.com/OpenAdaptAI/OpenAdapt) | MIT | Python | 1,771 | 2026-10-10 | mac, others | Recording | Compiled replay | Model only while authoring | No | Compiles demos to runs with 0 model calls | Borrow the idea |
| [e2b-dev/desktop](https://github.com/e2b-dev/desktop) / [surf](https://github.com/e2b-dev/surf) | Apache-2.0 | Python/TS SDK, Linux VMs | 1,523 / 873 | 2026-10-09 / 2026-09-09 | Linux sandbox | Screenshot, VNC stream | xdotool coords | Yes | No | n/a | None (sandbox infra) |
| [huggingface/screenenv](https://github.com/huggingface/screenenv) | MIT | Python, Docker XFCE | 459 | 2026-09-24 | Linux container | Screenshot plus Playwright | Coords | Yes | Yes | n/a | None (sandbox) |
| [openclaw/Peekaboo](https://github.com/openclaw/Peekaboo) | MIT | Swift 6.2, Node MCP launcher | 5,282 | 2026-10-11 | macOS 15+ | Hybrid AX plus capture | Element IDs, coords | Yes | Yes | Background semantic input on exact snapshots | Borrow for mac |
| [mediar-ai/mcp-server-macos-use](https://github.com/mediar-ai/mcp-server-macos-use) | BSL 1.1 | Swift | 357 | 2026-09-30 | macOS | AX traversal after every action | Coords | Yes | Yes | Act-and-traverse in one call | None (license) |
| [microsoft/OmniParser](https://github.com/microsoft/OmniParser) | Code MIT per README (GitHub detects CC-BY-4.0); older detectors AGPL | Python | 25,512 | 2026-07-20 | Any (vision); OmniTool is a Win11 VM | Screenshot to element list | Coords | Yes | No | n/a | Optional fallback only |
| [xlang-ai/OpenCUA](https://github.com/xlang-ai/OpenCUA) | MIT | Python, models | 852 | 2026-05-25 | Model | Screenshot | Coords | Open-weight model | No | vLLM serving | Model, not a base |
| [anthropics/claude-quickstarts](https://github.com/anthropics/claude-quickstarts) computer-use-demo | MIT | Python, Docker | 17,881 | 2026-10-08 | Linux container | Screenshot | xdotool coords | Anthropic tool schema | No | n/a | Reference only |
| [google-gemini/computer-use-preview](https://github.com/google-gemini/computer-use-preview) | Apache-2.0 | Python, Playwright | 3,218 | 2026-07-28 | Browser | Screenshot | Coords | Gemini | No | n/a | Reference only |
| [browser-use/browser-use](https://github.com/browser-use/browser-use) | MIT | Python, raw CDP | 117,634 | 2026-10-09 | Browser | DOM first, screenshot when needed | Element index | Yes | Yes | DOM shrunk to about 200 elements, CDP sessions cached | Comparator |
| [browserbase/stagehand](https://github.com/browserbase/stagehand) | MIT | TypeScript, CDP | 25,620 | 2026-10-10 | Browser | DOM/a11y | NL act to cached selector | Yes | Yes | Action cache (10-100x claimed), self-heal | Comparator |
| [Skyvern-AI/skyvern](https://github.com/Skyvern-AI/skyvern) | AGPL-3.0 | Python | 23,181 | 2026-10-11 | Browser | Vision plus DOM | Generated Playwright code | Yes | Yes | Adaptive caching scripts (3-5x claimed) | Comparator |
| [microsoft/playwright-mcp](https://github.com/microsoft/playwright-mcp) | Apache-2.0 | TypeScript | 38,019 | 2026-10-08 | Browser | Accessibility snapshot | Snapshot refs `eN` | Yes | Yes | No screenshots by default | Comparator, and a pattern to copy |

### 2026 newcomers worth knowing

| Project | License | Stack | Stars | Last push | Notes |
| --- | --- | --- | --- | --- | --- |
| [amontlabs/lcu](https://github.com/amontlabs/lcu) | MIT wrapper | JS | 895 | 2026-10-10 | Runs OpenAI's own CU runtime from the installed ChatGPT app inside other harnesses. Not forkable, since the runtime is proprietary. Useful as a side-by-side benchmark target |
| [QwenLM/open-computer-use](https://github.com/QwenLM/open-computer-use) | MIT | Swift | 285 | 2026-06-10 | A QwenLM fork of iFurySt's project (its README says so). Stale since June |
| [agent-sh/computer-use-linux](https://github.com/agent-sh/computer-use-linux) | MIT | Rust | 679 | 2026-10-10 | Linux MCP server extracted from codex-desktop-linux. Wayland first: portal RemoteDesktop, ydotool, and window registries for GNOME, KWin, Hyprland, niri, i3 and COSMIC. AT-SPI selectors |
| [ghostwright/ghost-os](https://github.com/ghostwright/ghost-os) | MIT | Swift | 1,670 | 2026-03-23 | macOS AX-only "no screenshots" agent tool. Stale since March |
| [browser-use/macos-harness](https://github.com/browser-use/macos-harness) | MIT | Python | 906 | 2026-08-17 | Thinnest-possible Mac harness where the agent writes missing helpers mid-task. It's the code-mode philosophy taken to the extreme |
| [Harusame64/desktop-touch-mcp](https://github.com/Harusame64/desktop-touch-mcp) | MIT | TS plus Rust napi addon | 22 | 2026-10-08 | Windows. Claims UIA reads in 2 ms from a dedicated COM thread, `run_macro` batching, screenshot diff mode, and elicitation before typing into terminals. Small project, worth reading for Windows tricks |
| [mrpulor-gh/nuphus-mcp](https://github.com/mrpulor-gh/nuphus-mcp), [zavora-ai/computer-use-mcp](https://github.com/zavora-ai/computer-use-mcp), [bigduu/Nova](https://github.com/bigduu/Nova), [munimtechnologies/munim-computer-use](https://github.com/munimtechnologies/munim-computer-use), [domdomegg/computer-use-mcp](https://github.com/domdomegg/computer-use-mcp) | MIT / Apache-2.0 | Rust or TS | 14-384 | 2026 | Many small cross-platform "computer use MCP" servers. None has the test depth or adoption of Cua Driver. I didn't read their source |
| [microsoft/fara](https://github.com/microsoft/fara) | MIT | Python, models | 6,217 | 2026-09-22 | Fara1.5 4B/9B/27B open-weight web CUA models (released 2026-07-22). A model, not a tool layer |

## Per-project notes

### Cua Driver (trycua/cua, `libs/cua-driver`)

- **What it is.** "Background computer-use driver for any agents. Speaks MCP over stdio" ([README](https://github.com/trycua/cua/blob/main/libs/cua-driver/README.md)). It's the MIT part of a monorepo that also holds the FSL-licensed Cua Spaces app, Lume VMs and a benchmark ([LICENSING.md](https://github.com/trycua/cua/blob/main/LICENSING.md)). Version 0.34.0.
- **Architecture, from source.** A Rust workspace with `cua-driver-core` (89k lines: tool registry, snapshot store, element tokens, policy, consent, script tool), plus `platform-windows` (42k), `platform-macos` (51k), `platform-linux` (71k), a contract crate, a UniFFI SDK, and a 29k-line E2E crate. The Windows crate uses the `windows` 0.58 crate directly for UIA with cache requests, Windows.Graphics.Capture (`wgc.rs`), MSAA, PostMessage and pen/touch injection.
- **Background delivery on Windows.** `delivery_mode:"background"` is the default and never raises or fronts the target. Pixel clicks first try a UIA hit-test and Invoke, then pen/touch injection only if the target is the visible window at that point, then PostMessage for plain Win32. If none of those can work, it returns `background_unavailable` or `background_occluded` instead of quietly stealing focus. `"foreground"` uses `SendInput` with a scoped `SetForegroundWindow` and restore ([WINDOWS.md](https://github.com/trycua/cua/blob/main/libs/cua-driver/rust/Skills/cua-driver/WINDOWS.md)).
- **Evidence culture.** [action-support.md](https://github.com/trycua/cua/blob/main/libs/cua-driver/docs/action-support.md) is an empirical ledger. Windows/Win32 passed 122/122 rows (99 delivered, 23 exact refusals), macOS 145/145, and Linux X11 and Sway 116/116 each, with focus, z-order, cursor and input-leak checks. It also documents the hard limits. For example, on Windows, background typing into Electron is refused while Tauri works.
- **Token and round-trip savings.** Query-filtered `get_window_state` returns about 2K characters against about 42K for a full snapshot. `run_steps` with `observe:{}` returns only what changed. `since:"latest"` re-reads as a diff. `run_script` runs model-written JS in an embedded QuickJS sandbox (30 s default, 100 driver calls, 32 MiB heap), with every call going through the same policy checks ([SKILL.md](https://github.com/trycua/cua/blob/main/libs/cua-driver/rust/Skills/cua-driver/SKILL.md)).
- **MCP.** Supports MCP revision 2026-07-28 and the legacy 2025-06-18 `initialize` flow, plus a skills extension that serves its own SKILL.md over MCP ([mcp-protocol-and-skills.md](https://github.com/trycua/cua/blob/main/libs/cua-driver/docs/mcp-protocol-and-skills.md)).
- **In-process SDK.** `@trycua/cua-driver` (TS) and `cua_driver` (Python) load the native runtime in-process through UniFFI. RFC 2447 makes MCP a downstream consumer of that same-process runtime ([rationale doc](https://github.com/trycua/cua/blob/main/libs/cua-driver/docs/why-cua-driver-uses-mcp-instead-of-uniffi.md)). This matters for us because a persistent Node REPL could call the driver without one process hop per action. The SDK is labeled experimental, and I haven't tested it.
- **Benchmarking.** [Cua Driver Bench v2](https://github.com/trycua/cua/tree/main/benchmarks/cua-driver-bench) holds the agent fixed (Claude Code with Sonnet 5.5) and swaps the tool layer, including an arm that runs OpenAI's unmodified `cua_repl` from the ChatGPT app through an MCP bridge. It's macOS-only and has no published results yet.
- **Red flags.** Telemetry is on by default (content-free PostHog-style events, opt-out via `CUA_TELEMETRY` and config) per `crates/cua-driver/src/telemetry.rs`. The codebase is very large and fast-moving: 100+ commits touching the driver in the last 30 days, with one maintainer (`f-trycua`) making most of the last 90 days of commits. The monorepo has 1,173 open issues. `run_script` doesn't persist bindings between calls and can't emit images. Its consent design deliberately avoids treating generic MCP elicitation as a human-only channel, so Codex-style per-app approval through elicitation would need design work.

### iFurySt/open-codex-computer-use ("open-computer-use")

- **What it is.** An "open-source alternative to Codex Computer Use" wrapped as MCP. It reproduces Codex's 9 native tools (`list_apps`, `get_app_state`, `click`, `perform_secondary_action`, `scroll`, `drag`, `type_text`, `press_key`, `set_value`) and adds a persistent Node `js`/`js_reset` REPL with `cua.getApp()`, `app.click()`, `app.getAXState()` and `nodeRepl.emitImage()` ([README](https://github.com/iFurySt/open-codex-computer-use)). v1.0.0 shipped 2026-10-10. It has installers for Codex, Claude Code, Gemini CLI and opencode.
- **macOS, from source.** `OpenComputerUseKit` is about 12k lines of Swift, covering AX snapshotting with a 1,200-node / 64-depth budget, Electron wrapper compression, SkyLight private-API background click and keys, a virtual "agent display" to park windows, and a software cursor overlay. Its own [benchmarks](https://github.com/iFurySt/open-codex-computer-use/blob/main/docs/references/background-input-benchmarks.md) show background click returns at p50 81.8 ms (observed effect at 260 ms) and background typing at 30 ms (observed at 237 ms).
- **Codex internals.** The `docs/references/codex-computer-use-reverse-engineering/` folder documents the official bundle (`SkyComputerUseService` plus `SkyComputerUseClient mcp`, a `turn-ended` hook, state rendering). It's in Chinese and useful to the other research tracks.
- **Windows, from source.** `apps/OpenComputerUseWindows/main.go` embeds a 1,092-line `runtime.ps1` and runs `powershell.exe -File` once per tool call (line 614). That's hundreds of ms of startup per call on top of the managed `System.Windows.Automation` walk. It defaults to background-friendly routes (UIA patterns, `PostMessage`, `EM_REPLACESEL`) and refuses to launch apps or `SetFocus` unless env flags allow it. The project's [QUALITY_SCORE.md](https://github.com/iFurySt/open-codex-computer-use/blob/main/docs/QUALITY_SCORE.md) grades Windows and Linux "C" and plans "a more native Go UIA implementation".
- **Red flags.** It's effectively a single-maintainer project (179 of about 240 commits) and, per the author, mostly AI-generated ([blog](https://www.ifuryst.com/blog/2026/speedrunning-the-ai-era/)). It has no session or app approval, only a password-manager denylist (`docs/SECURITY.md`). Most docs are in Chinese.

### CursorTouch/Windows-MCP

- **What it is.** A Python 3.14 FastMCP server with about 25 tools (`App`, `Snapshot`, `Screenshot`, `Click`, `Type`, `Scroll`, `Shortcut`, `PowerShell`, `FileSystem`, `Registry`, `MultiEdit`, and others) ([README](https://github.com/CursorTouch/Windows-MCP)). It's very active (v0.8.8 on 2026-10-10) and has the most stars of any Windows-specific CU MCP server.
- **From source.** It vendors yinkaisheng's `uiautomation` (Apache-2.0, about 11k lines under `src/windows_mcp/uia/`). It builds trees with `CacheRequestFactory` and a thread pool (`tree/service.py`) and captures with `dxcam` (DXGI). `Click` resolves a label to a point and then calls `desktop.click(loc)` with physical input (`tools/input.py`), so it takes over the user's mouse. A "control gate" lets the user grab control back.
- **Speed claim.** "0.2 to 0.5 secs" between actions, not counting LLM time. Unverified.
- **Red flags.** PostHog telemetry is on by default (`ANONYMIZED_TELEMETRY=true`). Clicks are foreground only. It's Windows only. Python packaging (3.14, pywin32, comtypes) is heavier to ship than a single binary.

### mediar-ai/terminator

- **What it is.** "Playwright for desktop": a Rust SDK, CLI, MCP agent (`terminator-mcp-agent`), workflow recorder, and Node and Python bindings ([README](https://github.com/mediar-ai/terminator)). Windows only by its own feature table.
- **From source.** `crates/terminator/src/platforms/windows/tree_builder.rs` creates a UIA cache request so that ControlType, Name, BoundingRectangle, IsEnabled, focus and AutomationId come back "in ONE IPC call". That's the single most important Windows tree-speed trick, and it's MIT and easy to lift. The MCP server (`server.rs`) is 10,912 lines in one file and ships PostHog and Sentry modules.
- **Status.** The last release was v0.24.32 on 2026-04-05, and the last push (a crates.io workflow) was 2026-06-02. The company's README now pushes "Mediar IDE", a commercial product. Treat it as unmaintained for our purposes.

### lahfir/agent-desktop

- **What it is.** A Rust CLI plus a C-ABI cdylib for AX-tree-driven desktop control, Apache-2.0 ([README](https://github.com/lahfir/agent-desktop)). The README platform table marks Windows and Linux "Planned", and in source both crates are 76-line stubs that fail closed.
- **Worth borrowing.** Progressive skeleton traversal: a depth-3 overview, then drill-down by ref, which takes Slack from 30,743 tokens to 383. Snapshot-qualified refs (`@s8f3k2p9:e12`) with stale-ref and ambiguous-target error codes and recovery hints. Trace export to a single HTML file. A clean adapter trait split (`ObservationOps`, `ActionOps`, `InputOps`, `SystemOps`). There's no MCP server.

### injaneity/pi-computer-use

- **What it is.** A Pi coding-agent extension (TypeScript) with native helpers: Swift on macOS, Rust on Windows (`windows` 0.58) and Linux (AT-SPI2). MIT ([README](https://github.com/injaneity/pi-computer-use)). Its tools are `find_roots`, `observe_ui`, `search_ui`, `expand_ui`, `inspect_ui`, `act_ui`, `read_text` and `wait_for`.
- **Worth borrowing.** The state model in [architecture.md](https://github.com/injaneity/pi-computer-use/blob/main/docs/architecture.md). Observations are immutable and keyed by `stateId`. A scheduler serializes only calls that hit the same process or CDP target. Each resource has an epoch, so a stale write is rejected before dispatch. Cached search and expand calls skip the live OS entirely. The author also commits to Cua Driver (11 commits in the last 90 days).
- **Limits.** It's not MCP. Its Windows helper (5.5k lines Rust) doesn't use UIA cache requests (I grepped and found none).

### microsoft/UFO (UFO2 and UFO3 Galaxy)

- **What it is.** A full Windows agent ("Desktop AgentOS") with HostAgent and AppAgents, plus UFO3 "Galaxy" multi-device DAG orchestration. MIT, Python ([README](https://github.com/microsoft/UFO), papers [2504.14603](https://arxiv.org/abs/2504.14603) and [2511.11332](https://arxiv.org/abs/2511.11332)).
- **From source.** It uses pywinauto 0.6.8 and `uiautomation` 2.0.18 with a UIA cache request in `ufo/automator/ui_control/inspector.py`, and it fuses OmniParser grounding. It uses MCP internally: the client spins up local servers such as `word_wincom_mcp_server.py`, `excel_wincom_mcp_server.py` and `ppt_wincom_mcp_server.py` to call app COM APIs instead of clicking.
- **Fit.** It owns the LLM loop, so it isn't a tool layer for other agents. The idea worth taking is "prefer the app's API when one exists" (COM for Office), exposed as extra tools next to GUI actions.

### simular-ai/Agent-S (S3)

- An agent framework with screenshot-only observation, a separate grounding model (they recommend UI-TARS-1.5-7B) that turns descriptions into coordinates, and pyautogui for execution. Agent S3 reports 72.6% on OSWorld with Behavior Best-of-N ([README](https://github.com/simular-ai/Agent-S), [paper](https://arxiv.org/abs/2510.02250)). The last release was 2025-12-16, and commercial work moved to Sai and the Simular API. It's relevant to accuracy research (best-of-N, grounding), not as a base.

### bytedance/UI-TARS-desktop and Agent TARS

- An Electron app driven by the UI-TARS and Seed VLMs, using screenshots and model coordinates through a nut-js operator (`packages/ui-tars/operators/nut-js`). Agent TARS is a separate multi-provider agent whose "kernel is built on MCP" for tools ([README](https://github.com/bytedance/UI-TARS-desktop)). v0.3.1 shipped 2026-10-08 after almost a year without a release. It's tied to its own loop and to vision grounding, so it doesn't fit.

### bytebot-ai/bytebot

- Archived. Last push 2025-09-12. It was a containerized Ubuntu desktop with a NestJS agent and coordinate actions ([repo](https://github.com/bytebot-ai/bytebot)). Skip it.

### Open Interpreter

- The repo is now [openinterpreter/openinterpreter](https://github.com/openinterpreter/openinterpreter), "a fork of OpenAI's Codex" that emulates other agents' harnesses for cheap models. The old Python OS mode isn't part of it. Not relevant.

### OpenAdapt

- It now records a demonstration and compiles it into a program that replays "without a generative-model API" and checks effects against the system of record ([README](https://github.com/OpenAdaptAI/OpenAdapt), compiler in [openadapt-flow](https://github.com/OpenAdaptAI/openadapt-flow)). The idea worth taking for speed is compiling repeated workflows. It's not a live tool layer.

### E2B desktop and surf, Hugging Face ScreenEnv and smolagents

- E2B Desktop is a Linux VM sandbox with an SDK for screenshots, xdotool-style input and VNC streaming. The SDK source moved into the E2B monorepo ([README](https://github.com/e2b-dev/desktop)). Surf is their Next.js demo of OpenAI CUA on that sandbox.
- ScreenEnv is a Docker XFCE desktop with Playwright and an MCP server with 30+ tools ([README](https://github.com/huggingface/screenenv)). smolagents is a general agent framework that can use it.
- These are sandbox infrastructure, not native desktop drivers. They could serve as a Linux test target later.

### macOS-only tools

- [Peekaboo](https://github.com/openclaw/Peekaboo) moved from steipete to the openclaw org. It's MIT, Swift 6.2, macOS 15+, v4.9.0 (2026-10-07). It's a CLI, menu-bar app, agent and MCP server. It does background semantic input when it can resolve the process and requires a fresh exact snapshot for background-only MCP policy. Its macOS implementation is mature and worth reading.
- [mcp-server-macos-use](https://github.com/mediar-ai/mcp-server-macos-use) is under Business Source License 1.1 (checked the LICENSE file), so it's not usable as open source. Its "act then traverse" tools that return the new AX tree after every action are a pattern worth copying.
- [ghost-os](https://github.com/ghostwright/ghost-os) and [macos-harness](https://github.com/browser-use/macos-harness) are smaller. macos-harness is interesting as the extreme code-mode design: the agent writes Python against raw macOS primitives.

### Vision models and parsers (OmniParser, OmniTool, OpenCUA, Fara)

- OmniParser turns a screenshot into a list of interactable regions. A 2026-07 update added an MIT YOLOv9-based detector; earlier Ultralytics detectors stay AGPL ([README](https://github.com/microsoft/OmniParser)). GitHub detects the repo LICENSE file as CC-BY-4.0, which conflicts with the README's MIT badge, so check before vendoring. OmniTool drives a Windows 11 VM with OmniParser plus any vision model.
- OpenCUA ships open models (7B, 32B, 72B) and the AgentNet dataset. vLLM supports all three ([README](https://github.com/xlang-ai/OpenCUA)). Fara1.5 is Microsoft's open-weight web CUA family ([README](https://github.com/microsoft/fara)).
- Use: an optional fallback for surfaces with no accessibility tree (games, canvases, RDP), and a path for open-weight-model users. Cua Driver already treats this as an opt-in extension that requires the observation's `capture_id` before any pixel click.

### Anthropic and Google reference implementations

- `claude-quickstarts/computer-use-demo` is a Docker Ubuntu desktop with xdotool, written around Anthropic's computer-use tool schema ([repo](https://github.com/anthropics/claude-quickstarts/tree/main/computer-use-demo)). [google-gemini/computer-use-preview](https://github.com/google-gemini/computer-use-preview) is browser-only (Playwright or Browserbase). [openai-cua-sample-app](https://github.com/openai/openai-cua-sample-app) is similar. These are good for checking each lab's native CU tool schema if we want an adapter, but none is a base.

### Browser-only comparators and their speed tricks

- **browser-use** moved from Playwright to raw CDP, shrinks the DOM to about 200 interactive elements (5-10 KB), and screenshots only when needed. They say each screenshot adds about 0.8 s of LLM latency ([post](https://browser-use.com/posts/speed-matters), [CDP post](https://browser-use.com/posts/playwright-to-cdp)).
- **Stagehand v3** also moved to raw CDP (44% faster per [Browserbase](https://www.browserbase.com/blog/stagehand-v3)). With a `cacheDir`, a resolved `act()` is cached and replayed without the LLM, and self-heal re-asks the LLM when a cached selector breaks ([docs](https://docs.stagehand.dev/v3/best-practices/deterministic-agent)).
- **Skyvern** has "adaptive caching": successful blocks become Playwright scripts replayed on later runs, with the agent as fallback (3-5x faster per their [products page](https://www.skyvern.com/products), [changelog](https://www.skyvern.com/docs/changelog)). It's AGPL.
- **Playwright MCP** returns accessibility snapshots with short-lived refs (`e5`) instead of screenshots ([docs](https://playwright.dev/mcp/snapshots)). This is the same element-index pattern Codex CU uses for desktop.
- **Takeaway for desktop:** the cross-run cache (resolve "the Save button in Notepad" once, replay by AutomationId or a role/name path, re-ground only on failure) is the biggest speed lever none of the desktop CU servers fully implement. Terminator's deterministic workflows and OpenAdapt's compiler come closest.

### Microsoft's built-in Windows 11 agent features

- **MCP on Windows / On-device Agent Registry (ODR).** `odr.exe mcp` registers MCP servers (local or remote) behind an OS proxy with consent and audit. Built-in connectors cover File Explorer and Settings ([Microsoft Learn](https://learn.microsoft.com/en-us/windows/ai/mcp/overview), [Ignite 2025 post](https://blogs.windows.com/windowsdeveloper/2025/11/18/ignite-2025-furthering-windows-as-the-premier-platform-for-developers-governed-by-security/), [ODR internals](https://www.originhq.com/blog/msft-odr-mcp)). This isn't UI automation. It's a distribution and consent channel we could register our server with later.
- **Agent Workspace.** A separate desktop session under a dedicated standard "agent account", off by default behind "Experimental agentic features" ([Microsoft support](https://support.microsoft.com/en-us/windows/ai/ai-features/experimental-agentic-features)). That would give real background operation without fighting focus. I couldn't find Microsoft docs on how a third-party agent gets its own workspace, so this is unverified.
- **App Actions.** App-defined actions, also surfaced as MCP servers ([Build 2025 post](https://blogs.windows.com/windowsdeveloper/2025/05/19/advancing-windows-for-ai-development-new-platform-capabilities-and-tools-introduced-at-build-2025/)). Same "prefer the API" idea as UFO.
- Reports of a "Windows Agent Runtime" and an open-source "Windows Agent Framework" from Build 2026 come only from aggregator sites and contradict each other ([Redmondmag](https://redmondmag.com/articles/2026/06/02/microsoft-uses-build-2026-to-put-ai-agents-at-the-center-of-windows.aspx), [Rework](https://resources.rework.com/news/ai-at-work/microsoft-build-2026-windows-agent-platform-store-cto)). Unverified.

### Codex CU itself, for context

- Codex CU on macOS has done background control since April 2026. Windows support arrived 2026-05-29 in Codex app 26.527 and was reported as foreground-only, taking over the active desktop ([TechTimes](https://www.techtimes.com/articles/317531/20260601/openai-codex-computer-use-now-windows-foreground-takeover-europe-excluded.htm), [PCWorld](https://www.pcworld.com/article/3154677/openai-codex-can-finally-control-windows-11-pcs-on-its-own.html)). It now ships inside the ChatGPT desktop app (LCU and Cua's bench both reference ChatGPT app builds 26.930 and later) and has a Linux X11 runtime ([LCU README](https://github.com/amontlabs/lcu)).

## Recommendation: fork vs build

### Ranked options

**1. Recommended: build a thin Codex-style front end on Cua Driver, and fork only if forced.**

Our part would be a small MCP server, probably TypeScript on Node, exposing one persistent `js` tool (plus `js_reset`) with a `cua` API shaped like Codex's: `cua.getApp`, `app.getAXState`, `app.click(index | [x, y])`, `nodeRepl.emitImage`. It would also handle per-app approval through MCP elicitation where the client supports it, with a fallback for clients that don't. Native work goes to Cua Driver, either in-process through `@trycua/cua-driver` (UniFFI) or through a long-lived `cua-driver` daemon.

Why:
- It's the only project with real background input on Windows, macOS and Linux and an empirical per-platform ledger proving it.
- It already has the speed pieces: UIA cache requests, WGC capture, query-filtered reads, `since` diffs and batching.
- MIT.
- It's moving faster than anything else in the space.
- What it lacks relative to Codex is exactly what a front end adds: persistent REPL bindings across calls, image emission from code, and Codex-style app binding.

We avoid owning 370k lines of Rust on day one. If upstream rejects something we need (telemetry default, consent model, tool surface), we fork `libs/cua-driver` only, which is MIT and separable from the FSL directories.

Risks:
- The UniFFI TS SDK is labeled experimental.
- A single company sets the roadmap.
- Upstream churns heavily (100+ commits a month).
- Latency on Windows is unmeasured, and Bench v2 is macOS-only with no published results.

**2. Fallback: fork iFurySt/open-codex-computer-use and replace its Windows and Linux runtimes.**

Keep its Codex-shaped surface, Node REPL kernel, agent installers, smoke tests and macOS Swift layer. Replace `apps/OpenComputerUseWindows` (PowerShell per call) with either Cua Driver's `platform-windows` crate behind a small Rust binary, or a new Rust UIA helper that copies terminator's cache-request tree builder. Replace the Linux Python AT-SPI bridge with Cua's `platform-linux` or agent-sh/computer-use-linux.

Choose this if we want a smaller codebase we fully control and are willing to own the Windows layer. Downsides: we'd inherit a mostly AI-generated codebase with Chinese-language docs and one main author, and we'd have no approval system.

**3. Greenfield Rust core assembled from parts.** This gives the most control and is the most work. Only worth it if options 1 and 2 both hit walls, for example on license, telemetry or architecture.

### What to borrow, by component

| Component | Take from | License | Why |
| --- | --- | --- | --- |
| Windows UIA tree and background input | Cua Driver `platform-windows` (UIA plus WGC plus PostMessage plus pen/touch ladder) | MIT | Proven background delivery with exact refusals |
| Windows UIA cache-request tree walk (if building our own) | terminator `tree_builder.rs`; Windows-MCP `tree/service.py` | MIT | One cross-process call per batch of properties |
| macOS AX and background input | Cua Driver `platform-macos`, or iFurySt `OpenComputerUseKit` (SkyLight) | MIT | Both measured. iFurySt publishes per-action p50s |
| Linux (Wayland) | Cua Driver `platform-linux`, or agent-sh/computer-use-linux | MIT | Compositor-specific window identity and portal input |
| Codex-shaped `js` REPL front end | iFurySt `scripts/node-repl/` (worker-based persistent session, `emitImage`) | MIT | Already mirrors the Codex `cua` API |
| Token-light observation | agent-desktop skeleton traversal; Cua `query` and `since` | Apache-2.0 / MIT | 78-96% fewer tokens on dense apps |
| State and concurrency model | pi-computer-use (`stateId`, epochs, per-resource lanes) | MIT | Safe parallel agents and stale-write rejection |
| Cross-run action cache | Ideas from Stagehand, Skyvern, OpenAdapt (no code) | n/a | Largest speed win nobody has on desktop yet |
| App APIs before GUI | UFO COM MCP servers; Windows App Actions and ODR | MIT / platform | Skips the GUI entirely for Office and similar apps |
| Vision fallback for treeless surfaces | OmniParser YOLOv9 detector (MIT weights only), or an open grounding model (OpenCUA, UI-TARS) | Check per file | Games, canvases, RDP |

### Not recommended as a base

- Windows-MCP: Python, foreground-only input, telemetry on by default, Windows-only.
- Terminator: Windows-only, effectively unmaintained since April 2026, monolithic MCP server.
- UFO, Agent-S, UI-TARS-desktop, Bytebot, OmniTool: agent frameworks with their own loop, mostly screenshot-and-coordinates.
- agent-desktop: macOS-only, no MCP.
- pi-computer-use: tied to the Pi agent.
- LCU: wraps OpenAI's proprietary runtime.
- mcp-server-macos-use: BSL 1.1.
- Skyvern: AGPL and browser-only.

## Open questions

1. What is Cua Driver's real per-action latency on Windows (observe, click, type, re-observe) compared with Codex CU on the same machine? No public numbers exist. Measure with a fixed harness, since Cua's bench design (fixed agent, swapped tool layer) is a good template.
2. Is `@trycua/cua-driver` in-process mode stable enough to sit under a persistent Node REPL, or should the front end talk to a long-lived `cua-driver` daemon over a socket?
3. Would trycua accept upstream a persistent-REPL `js` tool, a telemetry-off default for our distribution, and an elicitation-based per-app approval mode? Their consent plan argues that elicitation is not a trusted human channel.
4. Does Codex CU on Windows still require the foreground as of October 2026? If so, background Windows input is a clear advantage for us. If not, figure out how OpenAI does it.
5. Can a third-party agent get its own Windows Agent Workspace session today? That could solve the hard cases Cua refuses in background mode (Electron keyboard, occluded drags) without stealing the user's desktop.
6. Electron and Chromium apps on Windows refuse background keyboard input. Is a CDP side-channel (as in agent-desktop `launch --cdp` and Cua `get_browser_state`) acceptable for our users, given it requires relaunching the app with a debug port?
7. License hygiene if we fork from the Cua monorepo: confirm that no FSL crate is a transitive dependency of `cua-driver`'s default build, and keep the AGPL perception extension out.
8. How much does a persistent REPL (Codex style) beat one-shot sandboxed scripts (Cua `run_script`) on model accuracy and turn count across Claude, GPT, Gemini and open-weight models? This is worth a small A/B before committing to the front-end design.
