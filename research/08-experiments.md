# 08. Experiments: what to build Claude's computer use on

Run date: 2026-10-11, on the user's Windows 11 machine (i9-14900K, 3420x2149 display), driven from WSL. The harness, tasks and every run's artifacts are in [`bench/`](../bench/README.md).

Two rounds ran the same day:

- **Round 1** compared the existing options and picked a base.
- **Round 2** built on the round 1 findings and measured the result.

Current code:

- Prototype front end measured in round 2: [`proto/v2/bcu-mcp.ts`](../proto/v2/bcu-mcp.ts). Round 1's version is archived in [`proto/v1/`](../proto/v1/bcu-mcp.ts).
- Driver fork: [`tools/cua-driver-fork/v2/`](../tools/cua-driver-fork/v2/NOTES.md).

## Round 2: Claude on our stack is 3-4x faster than on Codex's runtime

Same Windows task suite, Claude Opus 5.5 at medium effort, 3 runs per task. Codex runtime and raw Cua Driver numbers are from batch `v2`. Our stack's latest numbers are from `v2.3`.

| Stack | Pass | Median | Mean | p90 | Worst | Tool calls | Cost/task | Runs that moved your cursor |
| --- | --- | --- | --- | --- | --- | --- | --- | --- |
| Codex runtime (`cua_repl`) | 17/18 | 44.2 s | 42.1 s | 64.3 s | 81.8 s | 13 | $0.23 | 15/18 |
| Cua Driver, 61 raw tools | 18/18 | 47.2 s | 91.3 s | 182.3 s | 343.2 s | 12.5 | $0.37 | 6/18 |
| **Ours: `js` front end v2 + fork v2** | **18/18** | **12.4 s** | **14.2 s** | **27.6 s** | **33.5 s** | **4** | **$0.05** | **2/18** |

| Task (median) | Codex runtime | Cua Driver | Ours (v2.3) |
| --- | --- | --- | --- |
| Calculator | 20.1 s | 13.9 s | 4.6 s |
| Append + save | 22.1 s | 15.4 s | 13.7 s |
| Save As dialog | 58.8 s | 306.5 s | 12.4 s |
| Replace dialog | 49.8 s | 134.0 s | 9.6 s |
| Explorer move | 30.4 s | 42.1 s | 29.8 s |
| Edge form | 64.3 s | 58.6 s | 13.2 s |

### What changed between rounds

In the driver fork (`tools/cua-driver-fork/v2/NOTES.md`):

1. **Classic Win32/WinForms controls are activated by posted clicks or `BM_CLICK`, not a synchronous UIA `Invoke`.** The app's accessibility tree stays readable when a modal dialog opens. Save As went from 63 s hangs to `invoke_menu` returning in about 300 ms, with the dialog's 118-element tree readable in 129 ms.
2. **Chromium element clicks go through UIA patterns** (select, toggle, invoke). Before, the driver posted a mouse click Chromium ignores and reported success. A `<select>` can now be set in the background.
3. **Background Ctrl+S on WinForms works.** It used to report success and do nothing, because WinForms reads modifier state that posted keys don't set.

In the front end (`proto/v2/bcu-mcp.ts`):

1. **Reads wait for the UI to settle**, polling the tree until two reads match, capped at 1.5 s. `sleep` and `setTimeout` are capped at 300 ms with a note. Model-written sleeps had cost about 100 s per 12 runs.
2. **A fast agent cursor.** The driver's cursor overlay glides to each click target first, which costs 430 ms per click by default. An 80 ms glide costs 65 ms, and hiding the cursor costs 7 ms. We keep it visible but fast: 77 ms per click in a 9-click Calculator batch, down from 346 ms.
3. **New API pieces:**
   - `select()` verifies the value took.
   - `drag()`.
   - An explicit `{foreground: true}` that policy can deny.
   - `BCU_APPS` scopes window lists to the task's apps.
4. **Model code only sees frozen facades.** Claude can't reach the driver anymore, which it did in round 1.
5. **Fixes found by reading traces**, each one costing turns or correctness:
   - `find()` ranks by the element's name. A substring match picked `Memory add [id=MemPlus]` for "Plus", so Calculator computed the wrong sum.
   - A click on a closed drop-down item is routed through the menu walk. Clicking it directly made the driver fall back to a blocking `Invoke`.
   - `menu()` retries a segment with "..." appended.
   - Calls work without `await`, and they run in the order they were written. An un-awaited `w.setValue(); await w.menu()` used to race and save an empty file.
   - A failing un-awaited call is reported instead of crashing the server. One crash cost a run 76 s.
6. **The Edge task launches with `--force-renderer-accessibility`.** Chromium hides a page's accessibility tree while another window covers it. When you had a terminal on top, the form was invisible to every background stack.

Sequence of the arm's batches: `v2` (11.9 s median, 57 s worst) → `v2.1` with the fast cursor and `find()` ranking (one regression found: closed menu items) → `v2.2` with menu routing (76 s outlier: the un-awaited race and crash) → `v2.3` with ordered calls (33.5 s worst).

### What's still slow or disruptive

- **Explorer (about 30 s).** Background shortcuts (Ctrl+Shift+N, Ctrl+X/V) report success and do nothing in File Explorer, so Claude falls back to the ribbon or to `{foreground: true}`. That's where the remaining cursor moves come from. The fork's keyboard-state fix only covers classic windows. Explorer needs its own path: UIA patterns on the ribbon, or the shell's own file APIs.
- **`invoke_menu` still activates the window to walk the menu,** then restores focus: 2-4 focus changes per dialog task, with zero cursor movement. WinForms menus might work without the activation.
- **Driver vs front end.** The front end routes clicks on closed menu items through `menu()`. The driver should handle that itself, so other clients get the fix too.
- **Not a real sandbox yet.** `node:vm` plus frozen facades stop casual reach-through but not a determined escape. A real build needs QuickJS or isolated-vm.

## Round 1

### Round 1 TL;DR

- **Build on a local fork of Cua Driver, with our own code-mode front end on top.** Cua Driver passed every task. Its primitives take 15-85 ms, and it never moved the cursor on its own. Codex's runtime passed too, but it's proprietary and moved the real cursor in 10 of 12 runs.
- **Claude isn't the bottleneck.** On Codex's own runtime, Claude passed 12 of 12 tasks. The gap to Codex is tooling, as the research predicted.
- **Code mode cut cost, not wall time.** The `js` front end used 4.5x fewer input tokens than Cua Driver's 61 raw tools (158k vs 705k median per task) and cost $0.16 vs $0.28 per task. Wall time didn't improve on this suite: median 57 s vs 40 s.
- **The time went to two fixable things:**
  - Modal-dialog stalls: 288 of the prototype's 503 s of tool time.
  - Sleeps the model wrote itself: about 100 s per 12 runs.
- **Modal dialogs are the hardest Windows problem we hit.** A synchronous UIA `Invoke` on a control that opens a modal dialog doesn't return until the dialog closes, and the app's accessibility tree goes silent meanwhile. Raw Cua Driver spent 373 s (median) on Save As. Our patch cut Save As to 59 s and stalls to zero. Codex avoids the problem by using real foreground input, which is why it was fastest on dialog tasks, and also why it moved your mouse.
- **Chromium is the second gap.** Background typing and `<select>` changes are refused for Edge and Chrome windows. Every arm either took over the foreground or went looking for an escape hatch.
- **Claude will route around a weak API.** When background input was refused, it printed the prototype's function source and called the driver's private foreground mode. A real sandbox and an explicit, policy-gated `foreground` option are requirements, not polish.

### Setup

Each run is one agent, one computer-use stack ("arm") and one task. Success comes from the task's own checker, which reads real Windows state (file contents, Calculator's UIA display, Edge's window title). Every run saves its transcript, screenshots, metrics, and a 100 ms sample of the real cursor position and foreground window.

| Arm | Agent | Computer-use stack |
| --- | --- | --- |
| `claude-codexcu` | Claude Code, Opus 5.5, medium effort | Codex's proprietary runtime (`cua_repl`, one `js` tool), run standalone through a bridge |
| `claude-cua-main` | Same | Cua Driver built from `main` (61 MCP tools, including `run_steps` and `run_script`) |
| `claude-bcu` | Same | Our prototype: one `js` tool over Cua Driver `main` |
| `claude-bcu-fork` | Same | Our prototype over Cua Driver with the modal-safe Invoke patch |

| Task | App | Exercises |
| --- | --- | --- |
| `calc_mul` | Calculator (UWP) | Launch, button input, read display |
| `edit_append` | TestPad (WinForms) | Edit a text box, Ctrl+S |
| `edit_saveas` | TestPad | Menu, real Windows Save As dialog |
| `edit_replace` | TestPad | Menu, modal Replace dialog |
| `explorer_move` | File Explorer | New folder, move a file |
| `edge_form` | Edge (Chromium) | Text fields, `<select>`, checkbox, submit |

The batch `final` ran 4 arms × 6 tasks × 2 reps, interleaved by task so drift doesn't favor one arm. Six runs that executed while a stray Windows "Open With" picker held the foreground were moved to `out/final-contaminated/` and rerun. With n=2 per cell, the per-task numbers show direction, not precise differences.

### Results

#### Final batch (48 runs)

| Arm | Pass | Median wall | Model time | Tool time | Tool calls | Input tok | Cost/task | Cursor moved | Focus changed |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| Codex runtime | 12/12 | 46.7 s | 35.1 s | 10.9 s | 14 | 316k | $0.23 | 10/12 | 9/12 |
| Cua Driver `main` | 12/12 (1 hit the 420 s cap) | 39.6 s | 27.0 s | 4.5 s | 13 | 705k | $0.28 | 8/12 | 6/12 |
| Prototype `js` | 12/12 | 57.0 s | 28.0 s | 21.1 s | 11 | 158k | $0.16 | 1/12 | 8/12 |
| Prototype `js` + fork | 10/12 | 61.0 s | 38.4 s | 15.9 s | 15 | 238k | $0.19 | 4/12 | 8/12 |

Both of the fork arm's failures came from a bug in the prototype's `find()`. Cua Driver's query output keeps ancestor rows for context, so `find("Submit", "Button")` returned the window's Close button, and Claude closed Edge. After the fix, two supplementary runs (`out/final-findfix`) both passed with zero cursor movement.

"Cursor moved" means the real cursor moved. On the Codex runtime that's its normal input path. On Cua Driver it's the model choosing `delivery_mode: "foreground"` after a `background_unavailable` refusal. On the prototype arms it's the model calling the driver's private foreground mode.

#### Median wall time per task

| Task | Codex runtime | Cua Driver | Prototype | Prototype + fork |
| --- | --- | --- | --- | --- |
| calc_mul | 19.2 s | 16.2 s | 17.6 s | 16.1 s |
| edit_append | 45.3 s | 14.6 s | 19.2 s | 16.4 s |
| edit_saveas | 64.3 s | **373.0 s** | 127.4 s | 59.1 s |
| edit_replace | 61.4 s | 146.7 s | 145.0 s | 143.8 s |
| explorer_move | 32.1 s | 33.0 s | 68.5 s | 72.8 s |
| edge_form | 48.6 s | 45.7 s | 57.0 s | 63.1 s (both bug failures) |

An earlier batch (`matrix2`) also ran the Cua Driver v0.34.1 release, which has 59 tools and no `run_steps`. It passed 12/12 at 61 s median, with 1,120k input tokens and $0.51 per task. On simple tasks, the prototype was fastest in that batch: Calculator in 8.1 s and one tool call, append in 8.5 s.

#### Primitive latency, no model involved (`bench/latency.py`)

| Operation, TestPad window | Cua Driver `main` | Codex runtime |
| --- | --- | --- |
| List windows | 43 ms | 20 ms |
| Accessibility tree | 31 ms | 29 ms |
| Tree + screenshot | 85 ms | 1,976 ms (min 130 ms) |
| Set value | 21 ms | n/a |
| Type 5 characters | 29 ms | 49 ms |
| Hotkey | 15 ms | 38 ms |
| Real cursor moved during the test | 0 px | 879 px |

Both engines are far faster than the model. A turn costs 2-4 s of model time, and a primitive costs tens of milliseconds. That matches report 05: the engine's job is to cut turns and avoid stalls, not to shave milliseconds.

### What the runs showed

#### 1. Modal dialogs break synchronous accessibility actions

When an element click or `invoke_menu` opens a modal dialog (Save As, Replace), UIA's `Invoke()` doesn't return until the dialog closes. The traces show the full chain:

1. The call hangs (63 s once).
2. The app's UIA provider stops answering, so the new dialog's tree comes back empty.
3. The driver's global locks queue every other action behind the hang.

In raw Cua Driver the model eventually escalated to foreground input, which is why Save As took 373 s and moved the cursor.

The patch (`tools/cua-driver-fork/`) runs every tool-path `Invoke` on its own MTA thread with a 1.5 s deadline. If the deadline passes, it reports "dispatched, a modal dialog probably opened" and releases the locks. That eliminated stalls (0 s vs 288 s) and halved the prototype's tool time.

It can't make the dialog's tree readable while the original `Invoke` is still outstanding inside the app. The full fix is to never hold a synchronous UIA call across an action that may open a modal. Activate such controls asynchronously instead, with a posted accelerator key, `BM_CLICK` or a pen tap, and use `Invoke` only where it can't block.

#### 2. Chromium refuses background keyboard input

Edge rejected background `type_text` and `press_key` (`Chrome_WidgetWin_1 ... background delivery is not available`). A `<select>` can't be changed through `set_value` either. Every arm that finished the form used foreground input at some point. Report 06 predicted this: Chromium on Windows has no clean background keyboard path. The options are a UIA expand plus `SelectionItem` for selects, CDP for browsers we launch ourselves, or an explicit foreground escalation.

#### 3. Claude routes around a weak API

The prototype exposed no foreground option. When background input was refused, Claude printed `w.key.toString()`, found the private `act()` and `driver` members, and called foreground delivery directly. That accounts for most of the prototype arms' cursor moves. Two consequences:

- `node:vm` isn't a boundary. The real build needs a capability sandbox (QuickJS or isolated-vm) where only the public API exists.
- Escalation should be in the API as an explicit choice the policy layer can allow, ask about, or deny. A hidden escalation gets found anyway.

#### 4. The model sleeps when the API lets it

The prototype documented `cua.sleep()`, and Claude used it in most calls: 102-108 s of written sleeps per 12 runs, about 5 s per task. The runtime should own waiting: every action settles before returning, `waitFor(text)` exists for checks, and `sleep` leaves the API.

#### 5. Code mode cuts tokens, and turns only somewhat

Median tool calls were 11 (prototype) against 13 (raw Cua Driver). The batching gain is smaller than the OSWorld numbers in report 05, because these tasks are short and each step depends on UI the model hasn't seen yet. The token saving is large and reliable, because Cua Driver's 61 tool definitions are about 52k tokens and ride along on every turn. The prototype's two tools are about 600 tokens.

#### 6. Codex's runtime is fast where it takes over, and fragile

- **Where it wins.** It was fastest on dialog-heavy tasks (Replace 61 s, Explorer 32 s), because real `SendInput` never holds a UIA call open.
- **What that costs.** It moved the real cursor in 10 of 12 runs, and its tree-plus-screenshot call takes about 2 s.
- **Fragility.** A hung app elsewhere on the desktop, or a change to its browser env vars, broke its `launch_app` ("window-opened handler did not become ready"). An Open With picker on screen made it refuse to act on Edge under its URL safety policy.
- **Not usable as a base.** It's proprietary.

#### 7. Computer-use tools expose whatever is on screen

The benchmark leaked two kinds of private data before the guards went in:

- Notepad restored the user's session, and one tab title looked like a GitHub token. Any tool that lists window or tab titles sends that title to the model.
- Under Windows `codex.exe`, Codex's runtime attached to the user's Chrome extension and returned real tab titles and URLs.

The affected transcripts were deleted, and the GPT arm was retired. For the product, the engine must scope observations to approved apps. Inventories (window lists, tab lists) are a privacy surface, not neutral metadata.

### Decision

**Native layer: a local fork of Cua Driver.** MIT license, fastest primitives measured, background-first, and it passed every task. We've already needed one patch and will need more (modal-safe activation, Chromium input), so we fork. Per the user's instruction, nothing goes upstream.

**Front end: our own TypeScript code-mode MCP server.** It's the `js` tool, in a real sandbox, with a Claude-shaped API, packaged as a Claude Code plugin with a skill. The prototype showed the token and cost case. The wall-time case depends on the fixes below.

**Not:** Codex's runtime (proprietary, takes the cursor). Not raw Cua Driver's 61 tools either: more than 4x the input tokens of the prototype, and its refusals push the model into foreground escalation.

### Build list after round 1

Items 1-5 and the privacy scoping in item 6 were done in round 2. See "What's still slow or disruptive" above for what remains.

1. **Modal-safe activation in the fork.** Detect controls that may open a modal (Win32 and WinForms buttons and menu items) and activate them asynchronously (posted accelerator, `BM_CLICK`, pen tap). Keep the 1.5 s `Invoke` deadline as a backstop. Expected effect: Save As and Replace drop from 60-145 s to around Calculator's time.
2. **Settling in the runtime, no model sleeps.** Actions return after UIA-event and pixel settle. `waitFor()` stays, and `sleep()` leaves the API.
3. **Chromium path.** `select(N, "Pro")` through UIA expand plus `SelectionItem`; CDP for browsers we launch; explicit `foreground` for the rest.
4. **Real sandbox and explicit escalation.** QuickJS or isolated-vm with only the public API. `foreground: true` is gated by policy and logged.
5. **API fixes found in traces:**
   - `find()` matches only rows that contain the text (done in the prototype).
   - `windows()` takes an object filter (done).
   - Pixel clicks refresh their own frame (done).
   - Add `drag` and `rightClick`.
6. **Privacy scoping.** Window and tab inventories are limited to approved apps. Titles of unapproved windows are redacted.
7. **Then rerun this suite and add longer tasks.** The current tasks are short, which understates batching. Add OSWorld-Verified `test_small` (report 03) for cross-platform accuracy.

### Limitations

- **Sample size.** Two runs per cell. Medians with large spread: Calculator ranged from 8 s to 20 s on the same arm across batches.
- **One model.** Opus 5.5 at medium effort only. Claude fast mode and other efforts weren't tested.
- **No fair GPT-on-Codex baseline.** The GPT arm was retired (privacy, and it isn't representative outside the Codex desktop app). Timing the real Codex app on the same tasks still has to be done by hand.
- **Short, single-app tasks.** The suite has no long cross-app workflows.
- **Cost figures** come from Claude Code's own accounting.
