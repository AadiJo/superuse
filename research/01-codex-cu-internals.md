# How Codex Computer Use works, from the copy installed on this machine

Research date: 2026-10-11. Everything below comes from files on disk (JS read directly, binaries read with `strings`), the Codex desktop log, and the user's own WSL bridge. Nothing was executed against the desktop. Claims I could not confirm from a primary file are marked "unverified".

Versions inspected: Codex desktop plugin bundle `26.930.31730`, runtime `cua_node/45309f9050f7314b`, `@oai/cua-repl` 0.1.0, `@oai/cua` 0.2.5, `@oai/sky` 0.7.5, `@oai/browser-desktop` 0.1.1.

Path aliases used in citations:

- `RT` = `/mnt/c/Users/Aadi/AppData/Local/OpenAI/Codex/runtimes/cua_node/45309f9050f7314b/bin`
- `OAI` = `RT/node_modules/@oai`
- `PLG` = `/mnt/c/Users/Aadi/.codex/plugins/cache/openai-bundled`
- `BRIDGE` = `/home/aadi/.t3/scratch/2026-10-08-i-saw-this-tweet-https-597f83a6`
- `LOG` = `/mnt/c/Users/Aadi/AppData/Local/Packages/OpenAI.Codex_2p2nqsd0c76g0/LocalCache/Local/Codex/Logs/2026/10/04/codex-desktop-ccefa862-...-025823-0.log`

## TL;DR

- The model sees one real tool, `js`, plus `js_reset` and a hidden `turn_ended`. It writes JavaScript against a pre-initialized `cua` object in a persistent Node kernel. Batching actions and the follow-up observation into one call is the main speed trick, and the docs say so repeatedly.
- The stack is five layers: MCP client, a tiny `cua-repl` launcher, `node_repl.exe` (a Rust MCP server that runs an untrusted Node kernel plus a separate trusted Node process), the `@oai/sky` client running as a trusted service, and a native helper that talks to the OS. Model code can only reach the helper through `nodeRepl.rpc("sky", ...)`.
- The Windows native layer exists twice. `codex-computer-use.exe` is a 1.5 MB Rust binary (windows-rs 0.61.3) speaking newline-delimited JSON over stdio. `codex-computer-use-swift.exe` is a 56 MB Swift-on-Windows build of a shared `ComputerUseCore` with a newer "Window3" protocol, background input, and Appshot. The desktop app resolves both; which one serves its named pipe is unverified.
- Observations are compact indexed text trees (one line per element, tab-indented, normalized role names, short state list, default actions hidden, "Secondary Actions" listed) plus focused element, selected text, and document text as separate fields. macOS and browser return diffs ("Removed element IDs: ..."), with a line budget fallback, truncation markers, and paging. Windows and Linux return full trees today.
- Screenshots are per-window Windows.Graphics.Capture frames encoded to JPEG data URLs, displayed automatically with `detail: "original"`. Coordinates are window-relative and are bound to a `screenshotId`. The helper refuses coordinate input if the window moved or the observation had no screenshot.
- On Windows the default helper does steal focus: it activates the target window and uses `SendInput` and `SetCursorPos`. It hides the real cursor through a separate `--system-cursor-manager` process and draws an animated fake cursor and a "ChatGPT is using your computer / Esc to cancel" overlay that is excluded from capture. A low-level keyboard hook makes physical Esc end the turn.
- Safety is layered: per-app approval through MCP elicitation (session or always), managed and product policy (allow and deny by AUMID or exe, URL policy for browsers), lock screen, UAC and elevation refusal, a user-input-detected guard, turn-scoped interrupt markers, and a long prompt-level confirmation taxonomy plus hard denies (no terminals, no Run dialog, no Win key, no password managers).
- OpenAI trains models on this exact API. The `cua-repl` README describes "TinySky" training producers that use `cua_repl`. Part of Codex's accuracy is model and tool co-training, which other labs' models will not have.
- None of it is redistributable. No `@oai` package declares a license, the plugin manifest says `"license": "Proprietary"`, and the source repo is OpenAI's private monorepo. Treat everything here as a behavioral spec for a clean-room build.

## 1. End-to-end architecture

### Processes and protocols

```
MCP client (Codex app-server, or Claude Code via the user's bridge)
  | stdio MCP (JSON-RPC, newline delimited)
node.exe  @oai/cua-repl/bin/cua-repl.mjs        launcher only, stdio inherited
  | spawn, env carries tool descriptions, banner, trusted services
node_repl.exe  (Rust MCP server: js, js_reset, js_add_node_module_dir, turn_ended)
  |-- untrusted Node kernel (node.exe): runs model JS. Banner: await import("@oai/cua/tinyskyAlt")
  |      globals: cua, nodeRepl, agent (browser runtime)
  |-- trusted Node process: hosts "trusted services" (@oai/sky/service, @oai/browser-desktop/service)
  |      reached from the kernel only via nodeRepl.rpc(serviceName, msg)
  | sky Windows client (WindowsComputerUseClient)
  |-- (a) spawn codex-computer-use.exe --parent-pid <pid>, JSON lines over stdio
  |-- (b) SKY_CUA_NATIVE_PIPE=1: \\.\pipe\codex-computer-use-<uuid>, hosted by the Codex desktop app,
  |       4-byte little-endian length prefix + JSON-RPC 2.0
native helper -> UI Automation, SendInput, Windows.Graphics.Capture, overlay windows
  side processes: codex-computer-use.exe --system-cursor-manager ; codex-computer-use.exe turn-ended (Codex notify hook)
```

Evidence for each hop:

- The launcher validates `CUA_REPL_NODE_REPL_PATH` and `CUA_REPL_ENABLED_SURFACES` (`browser`, `computer`, or both), maps surfaces to trusted services (`browser` to `@oai/browser-desktop/service`, `sky` to `@oai/sky/service`) unless `NODE_REPL_TRUSTED_SERVICES` is already set, reads `instructions/banner.js` into `NODE_REPL_JS_BANNER`, builds tool descriptions into `NODE_REPL_TOOL_OVERRIDES`, adds its env vars to `NODE_REPL_UNTRUSTED_ENV_ALLOWLIST`, and spawns `node_repl.exe` with `stdio: "inherit"` (`OAI/cua-repl/dist/lib/js/oai_js_cua_repl/src/launch.js`, `OAI/cua-repl/README.md`).
- `node_repl.exe` is a Rust binary (rmcp-style type names, DWARF tables, `src/mcp_server/strict_auto_review.rs`). Its kernel-to-host message kinds include `exec_result`, `emit_image`, `emit_audio`, `elicit`, `authenticated_fetch`, `config_action`, `launch_services_action`, `suspend_timeout`, `resume_timeout`, `native_pipe_request`, `trusted_service_request`, `turn_ended_result`. Strings mention a "trusted Node process", "untrustedEnv", "No trusted RPC services are configured", and "The kernel transport itself writes JSONL over stdout/stderr" (`strings RT/node_repl.exe`).
- Inside the kernel, `sky` is a Proxy. If `nodeRepl.rpc` exists it sends `{type:"setup"}` to learn `target` and method names, then turns every method call into `{type:"execute", method, args}` (`OAI/sky/dist/project/cua/sky_js/src/sky.js`). The trusted side (`service.js`) holds the real client and strips raw bytes from screenshots before returning them.
- Windows transport (a): `WindowsHelperTransport` spawns the helper with `windowsHide`, writes `{"id","method","params","meta"}` lines, and parses three response shapes: `{id, ok:true, result}`, `{id, ok:false, error}`, and `{id, approvalRequest:{app, displayName, riskLevel, allowPersistentApproval}}`. Lines without an `id` are events. Exit code 130 means the user pressed Escape. Default timeout is 10 s, 15 s for `launch_app`, and a timeout kills the helper. Transports are shared and ref-counted per config (`OAI/sky/.../targets/windows/internal/helper_transport.js`, `computer_use_client.js`).
- Windows transport (b): `nodeRepl.nativePipe.createConnection(SKY_CUA_NATIVE_PIPE_DIRECTORY)`, frames are `u32 LE length + JSON`, outgoing frames capped at 8 MiB, incoming at 64 MiB, payload is JSON-RPC 2.0 `{method:"request", params:{codexTurnMetadata, method, params}}`. The server can call back with `requestComputerUseApproval`, which the client answers through `createElicitation`, pausing request timeouts while the user decides (`computer_use_client.js`).
- The installed plugin config sets `SKY_CUA_NATIVE_PIPE=1` and a pipe path, `NODE_REPL_NATIVE_PIPE_CONNECT_TIMEOUT_MS=1000`, `CODEX_CLI_PATH`, and only the `browser` surface (`PLG/unified-computer-use/26.930.31730/.mcp.json`). The desktop log shows the app itself listening: `[computer-use-native-pipe] computer-use native pipe startup ready pipePath=\\.\pipe\codex-computer-use-cb7d...` and `notify config ensure finished ... status=repaired` (`LOG` lines 136 to 137).
- macOS uses a different transport: a Unix socket `computeruse.sock` under the group container `2DC432GLL2.com.openai.sky.CUAService`, JSON-RPC with `apiVersion "CodexComputerUseIPC-5"`, request types like `ComputerUseIPCAppGetSkyshotRequest` and `ComputerUseIPCAppPerformActionRequest`, and a 120 s default timeout (`OAI/cua/dist/project/cua/sky_js/src/targets/mac/client.js`, `native-pipe.js`). The service ships as a signed `Codex Computer Use.app` with `SkyComputerUseService`, `CUALockScreenGuardian`, and an authorization plugin, in "normal" and "relaxed" variants (`OAI/sky/package.json`, `publishConfig.executableFiles`).
- Linux spawns `sky_linux_<arch> server` and sends `{id, command, input}` JSON lines (`OAI/cua/dist/project/cua/sky_js/src/targets/linux/sky_linux.js`, `sky_linux_transport.js`).

### Two Windows helpers

| | `codex-computer-use.exe` | `codex-computer-use-swift.exe` |
|---|---|---|
| Size, language | 1.5 MB, Rust, windows-rs 0.61.3, serde_json, toml | 56 MB, Swift on Windows, modules `ComputerUseWindows`, `ComputerUseCore`, swift-markdown |
| Protocol | window2 methods (below) | same plus `service_info`, `window_protocol_version`, "Window3", Appshot, `select_text`, capture-border access |
| Input | foreground only (`SendInput`, activation) | `foreground` and `background` delivery modes (`experimentalBackgroundInput`) |
| Evidence | `strings OAI/sky/bin/windows/codex-computer-use.exe` | `strings OAI/sky/bin/windows/swift/x64/codex-computer-use-swift.exe` |

The two copies of the Rust helper under `@oai/cua` and `@oai/sky` are the same build; only Authenticode timestamps differ. The desktop log resolves `component=cua-helper` (Rust) and `component=cua-swift-helper` (Swift, with `coreGateEnabledAtStartup=false`) (`LOG` lines 9, 121). Standalone `@oai/sky` without the pipe always spawns the Rust helper (`computer_use_client.js`, function resolving `bin/windows/codex-computer-use.exe`). Which helper serves the desktop app's pipe is unverified.

The browser accessibility formatter `OAI/browser-desktop/scripts/browser-accessibility.wasm.br` decompresses to a Swift WASM module containing the same `ComputerUseCore` types (`AccessibilityTreePresentation`, `Removed element IDs: `, the "Pay special attention to the content selected by the user" note). OpenAI shares one tree model, renderer, and differ across macOS, the Windows Swift helper, and the browser.

## 2. Tool surface, and why a JS REPL

### MCP tools

- `js` with `code` (and `title`, `timeout_ms` from node_repl). Default exec timeout is 30 s (`strings RT/node_repl.exe`: "The default timeout is 30000 ms").
- `js_reset`: discards bindings; the next `js` call re-runs the banner. It does not close apps or tabs (`OAI/cua-repl/instructions/reset.md`).
- `turn_ended`: hidden, enabled for host hooks only. Codex plugin hooks call it on `Stop`, `Interrupt`, and `SubagentStop` with `session_id` and `turn_id` (`OAI/cua-repl/plugin/.codex-plugin/plugin.json`, `PLG/unified-computer-use/.../plugin.json`).
- `js_add_node_module_dir` exists in node_repl and showed up in the bridge's tool list (`BRIDGE/e2e-out/20261008-153057/transcript.jsonl`), but it is not in `enabled_tools` for Codex.
- Client-side config: `output_token_limit: 25000` for `js`, `startup_timeout_sec: 120`, and `omit_tools_from: ["code_mode", "deferred"]`, which opts the server out of Codex's own code-mode wrapping and deferred tool loading (`OAI/cua-repl/plugin/.mcp.template.json`).

The tool description is assembled from per-OS Markdown: a short description, one entry point per enabled surface, and output rules (`OAI/cua-repl/instructions/windows/*.md`, `instructions.js`). It tells the model that its first call must be exactly one entry-point call and nothing else. The full API docs arrive in that first tool result (see section 7).

### Why code mode (inferred from their docs and design)

1. Round trips are the cost. The docs say "Minimize model and tool round trips" and "Batch deterministic actions and the resulting `getAXState()` into one call" (`OAI/cua/docs/tinysky-alt-core-cua-repl.md`).
2. Output shaping. Every observation and inventory call auto-emits, `{ emit: false }` suppresses it, and `nodeRepl.write` lets the model print only the fields it wants. In the bridge e2e run, the model filtered `listApps()` down to one entry with `.filter(...)` (`BRIDGE/e2e-out/.../transcript.jsonl`).
3. Persistent handles. `app`, `tab`, and `browser` objects live across calls; the model never re-serializes window handles.
4. One surface for everything: native apps, browser tabs, Playwright locators for repetitive web tasks, and MCP App tabs.
5. Training. The README's training section imports `TinySkyMatrices` from `qstar.common.tools.unified_tool.variants.cua_cbv10` and says "TinySky variants use `cua_repl`" (`OAI/cua-repl/README.md`). The API is an RL environment as well as a product.
6. Security boundary. The model's code runs in an untrusted kernel with an env allowlist; native access, approvals, and policy live in the trusted process.

### The `cua` API (from `OAI/cua/docs/tinysky-alt-core-cua-repl.md`)

Top level:

- `getState(opts?) -> State` (apps, browsers with tabs, inventory errors). `initialize` is an alias.
- `getApp(target: string | { windowId: number }) -> App`. A string works only on macOS; Windows and Linux require `{ windowId }` (`create_tinysky_alt.js`). It auto-emits the full AX tree.
- `listApps(opts?)`, `listWindows?(opts?)` (Windows and Linux), `computer.launch_app?({ app })`, `computer.target`.
- `getBrowser({ id?, extensionInstanceId?, url? })`, `createBrowserTab(browserId, url?, { visible?, sessionName? })`, `getTab(id | { mention } | { url }, { browser? })`, `listBrowsers`, `listTabs`.
- `rewriteDocumentation()`: re-emits core and browser docs after context compaction (`create_bootstrap_emitter.js`).

Shared `Target` methods (App and Tab):

- `getAXState({ emit?, disableDiffing? }) -> string`
- `getScreenshot({ emit? }) -> Uint8Array`
- `getAXStateAndScreenshot(opts?) -> { state, screenshot? }`
- `click(index | [x, y], { mouseButton?, clickCount? })`
- `drag([x, y], [x, y])`
- `scroll(index | [x, y], direction, pages | { pixels })`
- `selectText(index, text, { prefix?, suffix?, selectionType? })`
- `setValue(index, value)`
- `performSecondaryAction(index, action)`

App adds `paste(text, { format })`, `pressKey(key)`, `typeText(text)`. Tab versions take an element index first (or `null` for current focus) and add `goto`, `back`, `forward`, `reload`, `close`, `markDeliverable`, `markHandoff`.

Platform gaps the model must remember: Windows `scroll` needs a point plus `{ pixels }`; `selectText` throws on Windows and Linux; `setValue` throws on Linux; Windows and Linux `paste` is plain text typed through native input; Windows screenshots reject `emit: false` (`bind_windows_app.js`, `bind_linux_app.js`, `bind_mac_app.js`).

### Lower-level `sky` APIs

There are three generations, each documented for direct use from node_repl:

- "window" (macOS, app-addressed): `get_app_state({ app, disableDiff })`, `click`, `paste`, `select_text`, and others (`OAI/sky/docs/sky-window-api.md`).
- "window2" (Windows, window-addressed): `list_apps`, `list_windows`, `get_window({ id, app? })`, `launch_app`, `get_window_state({ window, include_screenshot = true, include_text = false })`, `click({ window, element_index? | x, y, screenshotId? })`, `press_key`, `type_text`, `scroll({ window, x, y, scrollX, scrollY, screenshotId? })`, `set_value`, `drag`, `perform_secondary_action`, `activate_window` (`PLG/computer-use/26.930.31730/docs/api.md`, `OAI/sky/docs/skills/oai_sky_lib/windows/SKILL.md`). The Rust helper's wire methods also include `click_element`, `scroll_element`, `diagnostic_state`, `close`, `end_turn`, and audio recording.
- "full desktop" (Linux): adds `get_screenshot`, `move`, `move_relative`, `drag` along a path, `drag_handle` with start, move_to, and end, `key_down`, `key_up`, `clipboard_read`, `clipboard_write`, a `query` filter on `get_window_state`, and input bound to a window without activation (`OAI/sky/docs/sky-full-desktop-api.md`).

## 3. Observation format

### Text tree

Line format, reconstructed from the Linux JS formatter and helper strings: `<tabs><id> <role> (<states>) <label>, Description: ..., Value: ..., Secondary Actions: a, b`.

- Roles are normalized. The Rust helper maps UIA control types to plain names such as `button`, `text field`, `list item`, `tab item`, `tree item`, `menu item`, `split button`, `data grid`, `document`. The Linux formatter turns generic containers into `container`, static text into `text`, and drops `menu item` to an empty role (`strings` on the Rust helper; `OAI/cua/dist/project/cua/sky_js/src/targets/linux/accessibility_tree.js`).
- States are a short list: `focused`, `selected`, `selectable`, `expanded`, `collapsed`, `partially expanded`, `checked` or `unchecked`, `disabled`, and `settable` (with `settable, string` and `settable, float` on Windows).
- Default actions (press, click, do-default) are hidden. Only other actions show as "Secondary Actions", and `performSecondaryAction` must use one of those names.
- Long text (over 100 characters or multi-line) is sorted after short labels on a line. Newlines and tabs inside text are escaped.

Extra fields come after the tree: "The focused UI element is ...", selected text and selected elements, and document text in fenced blocks, plus a fixed note telling the model the user may be referring to selected content (`bind_windows_app.js`; Rust and Swift strings). macOS also prepends `<app_specific_instructions>` the first time an app is read in a session (`OAI/cua/dist/project/cua/sky_js/src/targets/mac/window_result.js`).

### Pruning (Linux JS, the only readable implementation)

`accessibility_tree.js` does the following:

- Drops nodes with no text, no children, not an image, and nothing interactive.
- Collapses a generic container with one child into that child, and flattens nested containers of the same role.
- Removes static text children whose text already appears in the parent's label.
- Merges runs of adjacent text leaves into one `text` node.
- Treats a node as interactive if it has non-default actions, interactive states (focusable, editable, checkable, and so on), or an interactive role.

The Rust helper has `child_limit`, `max_depth`, and cycle detection, plus a `(truncated: ...` marker. The Swift core has `TreeTransformationEngine`, spreadsheet trimming ("Remove unused rows and columns"), and a truncation footer that reports how many elements remain and tells the model to call `get_window_state` with `include_text=true, include_screenshot=false` to get the next page. The exact limits are unverified.

### Element ids and staleness

- On Linux, ids are compact decimals assigned per window. A native id keeps the same compact id across reads, so unchanged elements keep their index. A stale id throws "Unknown element ID ... refresh get_window_state()" (`element_ids.js`).
- The Windows helpers validate before acting. Rust strings include "no longer matches the cached runtime ID" and "no longer belongs to the cached target process"; the Swift helper says "accessibility element changed; call get_window_state before retrying". Every error names the recovery call.

### Diffs, caching, revisions

- macOS (`disableDiff`) and browser tabs return diffs by default: added and changed lines plus "Removed element IDs: ...". The Swift core has `AccessibilityDifferenceLineBudgetExceeded`, which I read as a fallback to the full tree when the diff gets too long (inferred from the type name). The docs say Windows and Linux "always return full accessibility state" (`tinysky-alt-core-cua-repl.md`).
- The Rust helper keeps an accessibility monitor thread that uses `SetWinEventHook`, a "window-opened readiness" signal, and UIA cache requests. Its `cacheDiagnostics` include `snapshotRevision`, `accessibilityRevision`, `accessibilitySnapshotCount`, `captureCachedSessionCount`, and `lastCaptureInvalidationReason`. Both the AX snapshot and the WGC capture session are cached per window and invalidated by events.

### Screenshots

- Capture goes through Windows.Graphics.Capture `CreateForWindow` (and `CreateForMonitor` for some cases), with `IsBorderRequired` and cursor capture turned off. Frames go through `SoftwareBitmap` and `BitmapEncoder` to JPEG with an `ImageQuality` property, then out as `data:image/jpeg;base64` (Rust and Swift strings). The skill says this "works even if they are occluded" (`OAI/sky/docs/skills/oai_sky_lib/windows/SKILL.md`). The user's skill notes that AX-less apps such as Calculator come back as screen crops that include occluding windows (`/home/aadi/.claude/skills/windows-computer-use/SKILL.md`).
- `get_window_state` can return several regions (`id`, `zIndex`, `originX`, `originY`, `width`, `height` in logical pixels) for popups and menus. `cua` throws on more than one region (`one_screenshot.js`).
- Images are emitted through `nodeRepl.emitImage`, or through `codex.emitImage` with `detail: "original"` (`computer_use_client_base.js`). node_repl tags images `codex/imageDetail: original`. Downscaling limits are unverified.
- Coordinate actions carry the `screenshotId` of the last screenshot. The JS binding clears it on any AX-only observation, which is why index clicks can fail with "coordinate input geometry is unavailable" until you take a screenshot (`bind_windows_app.js`, Rust strings, user skill).

### Keeping output small

- Client-side cap of 25,000 tokens per `js` result (`.mcp.json`).
- `emit: false` on every observation and discovery call, and docs emitted once per session (`create_bootstrap_emitter.js`).
- Guidance: if `getAXState()` reports no change, do not repeat it without an action in between. Prefer AX over screenshots, and request both only when needed.
- Linux `query` returns only matching nodes and their ancestors.

## 4. Speed

- Batching: multiple actions plus one `getAXState()` per `js` call. Entry points (`getApp`, `getTab`, `createBrowserTab`) auto-emit state, which saves a round trip.
- Settling happens inside the runtime. Docs: "waits about 1 second, with additional delays of up to 5 seconds if the app has a loading indicator or other signs of state changes" (`OAI/sky/docs/skills/oai_sky_lib/windows/SKILL.md`), and the model is told not to call `setTimeout`. Linux uses an `ActionSettler` that pushes a deadline `post_action_sleep_ms` (default 100 ms) after each action and makes the next action or observation wait for it (`action_settler.js`, `click.js`, `get_window_state.js`). The Windows settle algorithm is unverified; the Swift helper uses `SendMessageTimeoutW` to settle background keyboard and dialog input.
- Long-lived helper: spawned once and shared by ref count (`computer_use_client.js`). AX and capture sessions are cached with event-driven invalidation (section 3).
- Diffs on macOS and browser, AX text by default, and "stop once the result is visible".
- Bounded latency: per-request `x-oai-cua-request-budget-ms` meta, "computer-use request budget exhausted", 10 s and 15 s helper timeouts, 1 s pipe connect timeout. The Swift helper caps queues at 64 requests, 1 MiB per input line, and 16 MiB of stdout.
- Observed: in the bridge e2e run (Opus via Claude Code), the Calculator task took 5 turns, 15.9 s wall time, and 11.2 s of API time (`BRIDGE/e2e-out/20261008-153057/transcript.jsonl`). No per-action timings were found on disk.
- The "ultra" or "fast" modes I grepped for do not exist in these files. Speed comes from the design above, not from a mode switch.

## 5. Background operation and input injection

### Rust helper (window2, default for standalone sky)

- It activates the target: the docs say "Windows input activates the selected window" (`tinysky-alt-core-cua-repl.md`). Imports include `SetForegroundWindow`, `AttachThreadInput`, `SwitchToThisWindow`, `BringWindowToTop`, and `keybd_event` (a common trick to win foreground rights), plus `SendInput` and `SetCursorPos`. So it takes focus and moves the real cursor.
- It hides that. A child process `codex-computer-use.exe --system-cursor-manager` suppresses the system cursor by swapping in blank cursors (`CreateCursor`, `SetSystemCursor`) and restores the user's cursor scheme on exit. A Windows.UI.Composition overlay draws a fake cursor that moves along curved path segments with rotation, scale, press, and blur effects. A display overlay shows a status pill, a pulsing border, and shimmer text, and is excluded from capture. Strings come from `C:\Users\Aadi\.codex\computer-use\config.json` (`"usingComputer":"ChatGPT is using your computer","escToCancel":"Esc to cancel"`, accent color, locale). Mutex `Local\CodexComputerUseCursorOverlaySingleton`.
- Guards: a `WH_MOUSE_LL` hook and an input monitor produce "user input was detected in this window; call get_window_state before continuing". Window bounds are checked before coordinate input. A window with higher integrity gets "Accessibility is limited because the target window has higher Windows integrity". The lock screen is detected through `OpenInputDesktop`, Winlogon, and `LockApp.exe`.
- UI Automation goes through COM with cache requests and an event cache request. Strings show Scroll, ExpandCollapse, and Value or RangeValue usage for element actions.
- App discovery reads Start Menu programs (user and machine), WindowsApps execution aliases, and the registry. Ids look like AUMIDs (`Microsoft.WindowsCalculator_8wekyb3d8bbwe!App`), known-folder paths (`{6D809377-...}\...exe`), or `process:<path>` (transcript). The list filters shell windows such as "Program Manager", "Taskbar", and "MSCTFIME UI".

### Swift helper (Window3)

- Input delivery modes `foreground` and `background`. Window3 does not auto-activate: "Window3 requires activate_window to bring a window to the foreground" and "Window3 input changed foreground focus; use activate_window explicitly".
- Background input uses window messages (`WindowMessageInput`, `WindowMessageTextInputEvent`, `PostMessageW`, `SendMessageCallbackW` with acknowledgement tokens, `Get/SetKeyboardState` to fake modifier state). It checks that the target is owned by the selected app and restores the previous foreground window ("SetForegroundWindow(restore background input foreground)").
- Special paths: Explorer navigation through `IWebBrowser2.Navigate2`, GoBack, and GoForward, local directories only. Paste into Word, Excel, and PowerPoint goes through the Office object model (`AccessibleObjectFromWindow(Office NativeOM)`) with document and selection identity checks. Browser-owned native dialogs get identity guards. Chromium render widgets are special-cased ("HTML paste to an inactive Chromium page is not supported without activating its window").
- UIA coverage: `IUIAutomation2`, cache requests, tree walkers, Invoke, Value, RangeValue, Toggle, ExpandCollapse, SelectionItem, Selection, Scroll, Text and TextRange (for `select_text`), and Window patterns, plus focus, structure, and property event handlers.
- Cross-session arbitration uses a named mutex `Local\OpenAI.CodexComputerUse.Default.*`: "another Computer Use session stopped while controlling this window".
- Hard blocks: `WINDOWS_ELEVATED_TARGET_BLOCKED`, `WINDOWS_ELEVATION_PROMPT_BLOCKED` (Consent.exe), `WINDOWS_SECURE_DESKTOP_BLOCKED`. "Computer Use will not bypass User Account Control."
- Appshot: a hotkey (including a Windows+Copilot key fast path) that captures a window and hands it to Codex with an animated transition.

### Other platforms

- Linux sends input bound to the window "without activating that window or moving the desktop pointer" (`tinysky-alt-core-cua-repl.md`, `sky-full-desktop-api.md`).
- macOS launches apps "in the background if needed" and addresses them by bundle id (`OAI/sky/docs/skills/oai_sky_lib/macos/SKILL.md`). Its native internals are not on this machine.

## 6. Safety and approval model

- Per-app approval. The helper answers a request with `approvalRequest` instead of a result. The JS client calls `nodeRepl.createElicitation` with the message "Allow Codex to use <displayName>?" and `_meta` fields `codex_approval_kind: "mcp_tool_call"`, `connector_id: "computer-use"`, `persist: ["session","always"]` (or session only), `riskLevel` low or high, and `tool_params: { app }`. On accept it retries with `x-oai-cua-approved-app` in the request meta. Audio capture has its own high-risk prompt (`helper_transport.js`; macOS equivalent in `targets/mac/computer-use-policy.js`).
- The server does not remember approvals; it relies on the client to auto-answer later prompts. The user's bridge had to add a proxy that remembers accepted apps per session (`BRIDGE/codex-cu-mcp`, `ApprovalProxy`).
- Policy (Rust strings): "Computer Use is disabled by policy", "not allowed on this app by policy", allow and deny lists by `aumids` and `exes`, `defaultAppAccess`, packaged-app signature and identity checks, and `ComputerUseAllowForbiddenTargets`. It reads config through `codex app-server` (`config/read`, `configRequirements/read`, `getAuthStatus`) and checks browser URLs (Edge, Chrome, Brave, Opera, IE, Firefox) against a site-status service over WinHTTP. If a URL is disallowed or cannot be determined, the turn ends with a message telling the model to stop. macOS policy decisions are `allowed`, `denied` (organization), or `forbidden` (safety) (`computer-use-policy.js`).
- Esc to cancel. A low-level keyboard hook ends the turn. The helper exits with 130 or returns a fixed message telling the model to stop and send a final message. The JS writes a marker under `<CODEX_HOME>/cache/computer-use/interrupts/<conversation>/<turn>` and rejects further requests in that turn (`helper_transport.js`).
- Turn end. Hooks call `turn_ended`, and the helper registers itself as Codex's `notify` command (`codex-computer-use.exe turn-ended`, chaining any previous notify through `--previous-notify`) and signals `Local\CodexComputerUseTurnEnded-*`. The client also sends `end_turn` whenever turn metadata changes (`/mnt/c/Users/Aadi/.codex/config.toml` line 9, `helper_transport.js`, Rust strings).
- node_repl has its own gates: a "Run JavaScript" approval elicitation and a "strict auto-review" of submitted code with a byte limit, controlled by `NODE_REPL_FORCE_STRICT_AUTO_REVIEW` and turn metadata `node_repl_auto_review_required`. It also has denied paths and network isolation when Codex's sandbox is available. Exact behavior is unverified. The bridge found that with `CODEX_CLI_PATH` set, the kernel launches inside Codex's Windows sandbox and fails outside the app (`CreateProcessWithLogonW 1056`) (`BRIDGE/codex-cu-mcp`).
- Telemetry: Statsig events such as `CodexComputerUseMcpToolCalled` and approval requested or resolved, plus Sentry and OTel in node_repl (`targets/mac/computer-use-telemetry.js`, node_repl strings).

## 7. Model-facing guidance (summary)

Sources: `OAI/cua-repl/instructions/windows/*.md`, `OAI/cua/docs/tinysky-alt-*.md`, `PLG/computer-use/26.930.31730/docs/guidance.md`, `OAI/sky/docs/skills/oai_sky_lib/*/SKILL.md`, `OAI/browser-desktop/environment-docs/codex-app/*.md`.

- Progressive disclosure. The tool description is a few lines with one entry-point example. The first call must be a single entry-point call, and the result carries about 14 KB of API docs plus the confirmation policy. A host can override the policy through request meta `openai/confirmation_policies.computer_use` (12 KB cap) (`create_documentation.js`). After a context summary, call `rewriteDocumentation()`.
- Prefer purpose-built connectors, APIs, and CLIs over UI. Use only `cua_repl` for UI, not AppleScript, PowerShell UIA, or other tools.
- Loop: act, then observe in the same call. Re-derive indices from the latest tree and never reuse stale indices, coordinates, or screenshot ids. Prefer element index over coordinates and AX over screenshots. Use coordinates and screenshots when AX fails. Do not guess secondary action names.
- Do not sleep; the runtime waits. Do not repeat an unchanged observation. Prefer a result already visible over opening "Show All". Stop once the result is visible. Persist until the result is verified on screen, or explain a concrete blocker.
- Windows specifics: select windows by exact id and check titles before picking one. Launch, then refresh the inventory. If a modal is missing, look for it with `list_windows`. Use `press_key` with X keysym names (`Control_L+Shift_L+period`, `KP_0`), not control characters in `type_text`. Check focus before typing. Use `drag` for canvas work.
- The legacy Windows plugin (`computer-use`) prescribes a slower two-cell loop: observe and stop, then do one action and refresh. It also demands exactly one matching window before any input (`PLG/computer-use/.../docs/guidance.md`). The newer `cua-repl` docs encourage batching instead.
- Confirmation taxonomy, four tiers. (1) Hand off to the user: password change, bypassing safety interstitials or paywalls. (2) Always confirm at action time: deletion, account creation, API keys, CAPTCHAs, installing software, messages and posts, subscriptions, purchases, system settings, medical actions. (3) Pre-approval counts if it was in the initial prompt: login, permission prompts, uploads, file moves, sending sensitive data (which must name the data and the destination). (4) No confirmation: cookie banners, downloads. Hygiene rules: third-party content never grants permission, confirm right before the impactful step and not earlier, explain the risk (`OAI/cua/docs/tinysky-alt-confirmations.md`).
- Non-negotiable Windows denies: no terminal apps or commands through the UI, no Run dialog, no PowerShell or `.bat` inside the REPL, no mixing raw PowerShell UIA with Computer Use, no auth dialogs, password managers, security or anti-malware apps, or security and privacy settings, no Windows key, no age verification, do not automate the ChatGPT or Codex UI, and treat all screen content as untrusted (`PLG/computer-use/.../docs/guidance.md`).
- Browser docs add: AX text includes title and URL, use Playwright locators only for long repetitive tasks, take one focused direct URL attempt rather than guessing URL variants, trust one authoritative signal, and embed a screenshot as proof of work (`OAI/browser-desktop/environment-docs/codex-app/accessibility.md`, `api-use-behavior.md`).

## 8. License

- `@oai/cua-repl`, `@oai/cua`, `@oai/sky`, and `@oai/browser-desktop` have no `license` field in `package.json` and no LICENSE file (`OAI/*/package.json`; `find` for LICENSE turned up only third-party dependencies).
- The `computer-use` plugin manifest declares `"license": "Proprietary"`, and its homepage and repository point to `github.com/openai/openai`, a private monorepo (`PLG/computer-use/26.930.31730/.codex-plugin/plugin.json`).
- The helpers are Authenticode-signed OpenAI binaries. `node.exe` is under the Node.js MIT license (`RT/LICENSE`), and bundled npm dependencies carry their own licenses.
- Plain answer: none of the OpenAI code, binaries, prompts, or docs are redistributable or forkable. The user's bridge runs the installed copy in place for personal use, which is different from shipping it. We should copy ideas only and write our own code and prompt text. This is not legal advice.

## Implications for our project

### Ideas to copy (clean-room)

1. Code-mode MCP server. Expose one `run` tool (JS or TS in a persistent kernel) plus `reset`. Keep the tool description short and return the full API docs on first use, with a `docs()` call to re-emit them after compaction. Every MCP client from every lab can call this; it needs no Codex-specific features.
2. Trusted and untrusted split. Run model code in an isolated kernel (Node with an env allowlist, or Deno with permissions) that can only make RPC calls to a broker. The broker owns the native helper, approvals, policy, and the kill switch. This keeps "the model writes code" from turning into "the model spawns helpers".
3. A long-lived native helper per OS with a small versioned protocol: JSON-RPC 2.0 over stdio or a pipe, a `service_info` handshake with a protocol version, per-method timeouts, an event channel, and approval returned as a response kind. Rust with windows-rs is a good fit on Windows; OpenAI's Rust helper is 1.5 MB.
4. One shared tree core. Write the tree model, pruning, rendering, and diffing once, ideally in Rust compiled both natively and to WASM for browser tabs, the way OpenAI shares `ComputerUseCore` across macOS, Windows, and the browser.
5. Observation format. Use compact indexed lines, a single role vocabulary across OSes, a short state list, hidden default actions, and listed secondary actions. Put focused, selected, and document text in separate fields. Keep ids stable per window across reads, diff by default with "removed ids" and a full-tree fallback over a line budget, support a `query` filter, and page large trees with a footer that names the exact call to get more.
6. Screenshot discipline. Capture per window so occlusion does not matter (WGC, ScreenCaptureKit, PipeWire), encode JPEG, use window-relative logical coordinates, bind coordinate actions to a screenshot id, and reject input when the window moved or the user touched it.
7. Settling in the runtime: a short base delay, then event-driven quiet detection (UIA or AX events, WinEvent hooks, loading indicators) capped at about 5 s. The prompt should tell the model never to sleep.
8. Errors written for the model. Every failure should name the recovery step ("call get_window_state before continuing"). OpenAI does this consistently, and it is cheap accuracy.
9. Element actions through UIA patterns first (Invoke, Value, Toggle, ExpandCollapse, SelectionItem, Scroll, TextRange), with `SendInput` as the fallback. Pattern calls mostly work without focus, which gets us part of background operation early.
10. Safety baseline: per-app approval through MCP elicitation with session and always options; refusal of lock screen, UAC, secure desktop, and elevated targets; a default deny list (terminals, Run dialog, password managers, security settings); a physical Esc kill switch through a low-level hook; turn-scoped state; and a visible indicator that is excluded from capture.

### Things to do differently or avoid

- Remember approvals on the server, per session, with a persisted allowlist file for "always". Do not depend on the client to auto-answer repeat elicitations; the user's bridge had to patch exactly this. Provide a non-interactive path (config allowlist) for clients without elicitation support.
- Unify the API across OSes. In the e2e run the model's first call, `getApp("Calculator")`, failed because Windows needs `{ windowId }` (transcript). Different scroll units and methods that throw on some OSes cost turns. Accept a name, a window id, or a query everywhere, and expose capability flags instead of throwing.
- Make image emission idempotent. In the e2e run the screenshot appeared twice because the model wrapped an auto-emitted screenshot in `emitImage`.
- Skip the two-cell observe-then-act rule from the legacy Windows plugin. Batching is the speed lever.
- Do not steal focus by default. Start with UIA patterns plus foreground `SendInput` that restores the previous foreground window, and treat message-based background input as a later, per-app-class feature. The Swift helper shows how many edge cases that involves: Chromium, Office, native dialogs, Explorer.
- Avoid continuously animating overlays. OpenAI's overlay runs repeating border pulse and shimmer animations. A static border and pill gives the same signal without constant repaints.
- Do not hard-wire host-specific metadata (`x-codex-turn-metadata`, `codex_approval_kind`). Define our own turn and session ids, with an explicit `end_turn` tool and an idle timeout, because most MCP clients have no Stop hooks.
- No third-party telemetry by default.
- Do not require a running desktop app. The helper should start on demand from the MCP server, as standalone sky does.

### Accuracy gap for non-OpenAI models

OpenAI co-trains on this API, so GPT models start with a strong prior and other models do not. To compensate:

- Make the API guessable. Mirror Playwright-style names and argument order where it fits.
- Put two or three worked examples in the first-call docs.
- Expose an optional classic tool mode (`observe`, `click`, `type`, and so on) for open-weight models that write weaker code.
- Build an eval set early (Calculator, Notepad, Explorer, Settings, a browser form, an Office paste) that saves transcripts and screenshots as artifacts, like the user's `e2e.sh`.

## Open questions

1. Which helper (Rust or Swift) serves the desktop app's `codex-computer-use-*` pipe, and what gates Window3 and background input (`coreGateEnabledAtStartup=false`, `experimentalBackgroundInput`)?
2. The screenshot size policy: maximum dimensions, downscaling, and JPEG quality value. Strings show a `BitmapTransform` and `ImageQuality` but no numbers.
3. The exact Windows settle logic, and whether the Swift helper diffs Windows trees by default.
4. Why the Rust helper returned "Accessibility state unavailable" for Calculator (a UWP app hosted by ApplicationFrameHost). Is that fixed in the Swift helper?
5. What node_repl's "strict auto-review" does to submitted JS, and when the "Run JavaScript" approval appears.
6. Per-action latency. The only timing on disk is the bridge e2e total (5 turns, 15.9 s). A clean benchmark of helper round trips needs a live run, which this task did not allow.
7. macOS internals (the Swift service, diffing, background launch) are only visible here through the JS client. Confirming them needs a Mac install.
