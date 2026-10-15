# Cua Driver fork

Our local fork of [Cua Driver](https://github.com/trycua/cua/tree/main/libs/cua-driver) (MIT), the native Windows layer under the plugin. Nothing here goes upstream.

- `UPSTREAM`: the upstream repo and pinned commit.
- `patches/`: our changes as one patch per commit, applied in order on top of that commit.
- `build.sh`: clones upstream into `tools/src/cua` (gitignored) if needed, applies the patches on branch `bcu`, cross-builds from WSL and installs `plugin/driver/cua-driver.exe`. `build.sh --clean` builds from a fresh clone in `tools/clean` instead, for releases and `scripts/install.sh --build`.
- `release.json`: the published driver build installs download (written by `scripts/release-driver.ts`).
- `export-patches.sh`: writes new commits on `bcu` back to `patches/`.
- `acceptance.ts`: live checks against real apps. `node fork/acceptance.ts [saveas] [closedmenu] [replace] [edge] [edge_alert] [calc] [explorer] [win32menu] [helium] ...`. Each run writes `fork/acceptance-runs/acceptance-<time>.json` with every tool call, its time, and the cursor and foreground samples. `BCU_CUA_DRIVER` picks the exe under test.
- `apps/MenuPad.cs`: a small app with a real Win32 menu bar for the `win32menu` check. `acceptance.ts` builds it into `%TEMP%\bcu`.

The sections below describe fork v2, the state after round 2 of the experiments (`research/08-experiments.md`). "Fork v3" at the end covers round 3.

## What changed

### 1. Classic windows get posted clicks instead of UIA Invoke

WinForms, dialog-manager, MFC and plain Win32 providers run a control's click handler inside `InvokePattern.Invoke()`. If the handler opens a modal dialog, Invoke doesn't return until the dialog closes and the app's UIA tree goes silent. The 1.5 s deadline from the first patch freed the driver but not the app.

Now, for an activation-type control (Button, leaf MenuItem, SplitButton, Hyperlink, TabItem) on a classic window, the driver posts the click and no UIA call stays open inside the app. The routing lives in `uia/activate.rs`:

- The element's own window is a `Button` (Win32 `Button` or WinForms `WindowsForms10.BUTTON.*`): `PostMessage(BM_CLICK)`.
- Otherwise: `WM_MOUSEMOVE`, `WM_LBUTTONDOWN`, `WM_LBUTTONUP` posted back to back at the element's centre, to the deepest child of the window that owns that point. That window is the nearest UIA ancestor with a `NativeWindowHandle` if its rect covers the point, else the pid's topmost visible top-level window there. The second case is needed for ToolStrip drop-down items: their UIA parent is the menu bar, but they're drawn in a separate popup.
- "Classic" means the owning window's class is `WindowsForms10.*`, `#32770`, `Afx*` or a standard control class (`Button`, `Edit`, `SysTabControl32`, `ToolbarWindow32`, ...), and its top-level window isn't a XAML/UWP, WinUI 3, WPF or Chromium host. Everything else keeps UIA Invoke with the deadline backstop.
- Menu items that open a submenu (ExpandCollapse state other than LeafNode) aren't touched.
- After posting, the driver polls the pid's titled top-level windows for up to 400 ms, returns as soon as one opens or closes, and puts them in the result text plus `structuredContent.windows` (`window_id` and title).

Wired into: `click` with `element_token` (background), `click` with `x,y` (the UIA hit-test winner is posted at the caller's pixel), and `invoke_menu` (final item only; it settles before handing foreground back so the open menu isn't dismissed with the click still queued).

The existing `post_click_screen` sleeps 35 ms + 50 ms for WebView hosts that grab foreground. That alone pushed `invoke_menu` over 500 ms, so `input/mouse.rs` gained `post_left_click_screen_now`, which uses the same child resolution and UIPI check without the sleeps.

### 2. Chromium element clicks go through UIA patterns

The old route posted a mouse click to Chromium, which drops posted mouse input, and a `<select>` popup is a separate window anyway. It always reported success.

- `click` with an `element_token` on a `Chrome_WidgetWin_*` window (background, single left click) now uses `uia/patterns.rs`. `action` `"invoke"`, `"toggle"` or `"select"` pins that pattern. Without one, the role picks the order: list/tree/tab items and radios select, checkboxes toggle, combo boxes expand, everything else invokes. Calls run inside the existing `fg_bypass` foreground shield, and Invoke keeps the deadline backstop.
- Selecting a `<select>` option leaves Chromium's popup open, which made the next Expand fail. After a Select on a ListItem the driver collapses the owning ComboBox, like a real click would.
- No matching pattern: the existing structured `background_unavailable` error. No more posted-click success on Chromium element tokens.
- `set_value` on a combo box without a native Win32 window: the ValuePattern write must read back within 250 ms. If it doesn't, the driver expands the combo, waits for its options, runs `SelectionItem.Select` on the option whose name matches (exact, then case-insensitive), collapses it and reads the value back. No such option gives `option_not_found` with the option list.
- `alert()` doesn't block Chromium's Invoke: it returned in 10-21 ms and the alert showed up in the tree right away.

### 3. Background Ctrl+S on WinForms (found during check 2)

`hotkey` posted `WM_KEYDOWN(VK_CONTROL)` + `S` and reported success, but WinForms shortcuts and `TranslateAccelerator` read modifiers through `GetKeyState`, which posted messages never change. So Ctrl+S silently arrived as a bare S. For classic windows, `hotkey` now attaches to the target thread's input, sets the shared keyboard state to hold the modifiers, posts the key, waits 120 ms, then restores the state and detaches (`post_key_with_modifier_state` in `input/keyboard.rs`, the same technique as AutoHotkey's ControlSend). No foreground change, and no system-wide key state.

## Results (final run, `acceptance-20261011-162419.json`)

| Check | Result | Timings |
| --- | --- | --- |
| 1. TestPad Save As | pass. File holds alpha/beta, title `saved.txt - TestPad` | `invoke_menu` 296 ms (reports the new "Save As" window). Dialog `get_window_state` 129 ms, 118 elements. `set_value` file name 410 ms. Save click (BM_CLICK) 528 ms, mostly waiting for the dialog to close |
| 2. TestPad Replace + Ctrl+S | pass. Text replaced, file saved | `invoke_menu` 342 ms. Dialog state 61 ms, 6 elements. `set_value` 7 / 4 ms. Replace All (BM_CLICK) 56 ms. `hotkey` 503 ms |
| 3. Edge form | pass. Title `SUBMITTED name=Ada Lovelace\|email=ada@example.com\|plan=pro\|agree=yes` | `set_value` name 9 ms, email 289 ms. Plan via `set_value` 297-663 ms (value write never takes, option route used). Expand 18 ms. Option `action:"select"` 322 ms, plain option click 364 ms. Checkbox toggle 418 ms. Submit invoke 294 ms |
| 3b. Edge `alert()` | Invoke doesn't block | 10 ms, alert in tree |
| 4. Calculator 12 × 12 | pass. `Display is 144` | clicks 9, 7, 438, 472, 316, 430 ms |
| 5. Cursor | 0 px displacement in every check | Foreground: 0 changes for Edge and Calculator. 2 per TestPad check, from `invoke_menu`'s own activate-and-restore, and restored each time |

Before the no-sleep posted click, `invoke_menu` Save As took 561 ms. It has been 296-448 ms since.

## Limits and open questions

- `invoke_menu` still activates the target window for the menu walk and restores foreground afterwards. That's existing behaviour, and it's where the 2 foreground changes come from. WinForms menus might work without it, but I didn't test that.
- MSDN warns that `BM_CLICK` can fail when the dialog isn't active. It worked on the common Save As dialog and the WinForms Replace dialog, both opened by a background app. Other dialogs weren't tested. If one fails, the next step is posting `WM_COMMAND(BN_CLICKED)` to the parent for plain `Button` controls.
- The pixel `click(x, y)` path with posted activation compiles but wasn't exercised live.
- Chromium pixel clicks (`x, y`, no token) still use the old posted click. Only element tokens changed.
- The Chromium UIA routes were tested with the bench's flags, which disable occlusion tracking. Upstream notes that Chromium's Invoke can return S_OK without a DOM event while the window is fully occluded. Not tested.
- The Ctrl+S modifier state is held for a fixed 120 ms. A UI thread that's busy longer than that would see a bare key.
- Many clicks take 300-470 ms, including UWP Calculator clicks on the unchanged Invoke path, while the first one or two take under 10 ms. I didn't trace it. The overlay glide is my guess.
- The window watch only reports titled, visible top-level windows that appear within 400 ms. A slower dialog shows as "none opened", and the agent has to call `list_windows`.

## Fork v3

Round 3 fixes the three leftovers in `research/08-experiments.md` ("What's still slow or disruptive"). One commit each on `bcu`, patches 0003 to 0005. The binary is `tools/cua-driver-fork/v3/cua-driver.exe`, also installed as `plugin/driver/cua-driver.exe` (sha256 `6aba269e...`).

### 1. Explorer shortcuts land in the background (patch 0003)

v2's attached keyboard state only ran for classic window classes. Explorer's top-level window is `CabinetWClass`, so Ctrl+Shift+N reached the file view as a plain posted N, which Explorer treats as type-ahead, and the tool reported success.

- `hotkey` and `press_key` now share `post_key_background` in `input/keyboard.rs`. It posts to the window that has keyboard focus on the target's UI thread (`GetGUIThreadInfo`). In Explorer that's the file view's `DirectUIHWND`, or the inline rename `Edit` after Ctrl+Shift+N or F2. Explorer's thread keeps that focus window while it sits in the background.
- With modifiers it holds them in that thread's key state, as v2 did. The hold now lasts until `WM_NULL` round trips (`SendMessageTimeout`) show the key down was handled, so a busy thread doesn't see a bare key. v2's 120 ms stays as a floor.
- It returns `background_unavailable` with a cause, not a false success, when focus is inside an XAML island (Explorer's address bar, search box or command bar report `InputSiteWindowClass`), when UIPI blocks the post, when the thread can't be attached, or when the thread doesn't get back to its message loop within 2 s.
- `click` with `action: "select"` or `"toggle"` pins that UIA pattern on every window, not only Chromium. Without it a click on an Explorer file ran Invoke first, and Invoke opens the file.

Checked by hand in Explorer, all in the background with 0 px and 0 foreground changes: Ctrl+Shift+N, typing the name plus Enter, F2 rename, Ctrl+X, Ctrl+V. The XAML command bar also works through UIA (Cut by Invoke; New expanded, then Folder invoked), so it's a fallback when focus sits in the XAML parts.

### 2. `invoke_menu` without activation (patch 0004)

A 15 ms foreground trace showed where the changes came from. Besides v2's own activate and restore, the UIA Invoke on WinForms' "File" header handed TestPad foreground rights. A TestPad window took foreground 80 ms into the call and the Save As dialog took it after that. A posted click on the MenuStrip opened the same drop-down with no foreground change.

`invoke_menu` now goes through `run_menu_path` (`tools/impl_.rs`), which picks a route per window:

| Menu | Route | Activation |
| --- | --- | --- |
| Win32 menu bar (`GetMenu` is non-null) | `win32/menu.rs` finds the path in the HMENU by item text, with mnemonics and accelerator text stripped the way UIA names them, and posts the item's `WM_COMMAND`. The menu never opens. | none |
| Other menus of classic windows (WinForms MenuStrip) | Every hop is a posted click (`uia::menu_walks_in_background`). The next hop waits up to 1 s for its item to get a rectangle, because WinForms keeps closed items in the tree. | none |
| WPF, XAML/UWP, and Win32 menu items that are missing or disabled in the static HMENU (apps can fill those in on `WM_INITMENUPOPUP`) | The old UIA walk | activate, walk, restore |

The action record now reports `Background` delivery when the window wasn't activated, and `structuredContent.windows` lists the windows the command opened or closed. Nothing in the suite had a Win32 menu bar, so `apps/MenuPad.cs` (WinForms' legacy `MainMenu`, a real HMENU) and the `win32menu` check cover that route.

### 3. Clicking items of closed drop-downs (patch 0005)

`click` on a MenuItem token whose drop-down isn't shown (WinForms reports an empty rectangle) now builds the item's menu path from its UIA parent chain and walks it with posted clicks, like `invoke_menu`. The path follows the same naming rule as `invoke_menu`'s matcher (enabled MenuItem ancestors, plus Menu and MenuBar ancestors that expose a pattern), so both resolve the same item. This applies where the menu walk runs in the background: classic windows without a Win32 menu bar. Win32 menu bars don't keep closed items in the tree. Other hosts keep UIA Invoke, which doesn't need the menu open.

Before, with v2 (`acceptance-20261011-220803.json`): the click blocked for 1511 ms, came back "Dispatched", and the Save As dialog's tree read as empty. After: 358 ms and a dialog with 118 elements.

### Results (`acceptance-runs/acceptance-20261011-220657.json`)

| Check | Result | Timings | Cursor | Foreground changes |
| --- | --- | --- | --- | --- |
| saveas | pass. File holds alpha/beta, title `saved.txt - TestPad` | `invoke_menu` 388 ms, dialog state 253 ms (118 elements), Save click 554 ms | 0 px | 0 (v2: 2) |
| closedmenu (new) | pass | click on the closed "Save As..." item 358 ms, dialog state 266 ms (118 elements) | 0 px | 0 |
| replace | pass. Text replaced, file saved | `invoke_menu` 103 ms, dialog state 78 ms, Replace All 66 ms, Ctrl+S 549 ms | 0 px | 0 (v2: 2) |
| win32menu (new) | pass. Stamp ran, Save As opened | Edit > Stamp 426 ms (400 ms of that is the window watch when nothing opens), File > Save As... 175 ms, dialog 117 elements | 0 px | 0 |
| explorer (new) | pass. `archive/a.bcu` and `b.bcu` on disk | Ctrl+Shift+N 155 ms, type name 84, Enter 22, select a.bcu 496, Ctrl+X 706, open archive 414, Ctrl+V 613. 2.5 s of tool time in total | 0 px | 0 |
| edge | pass | same routes as v2 | 0 px | 0 |
| edge_alert | pass | Invoke 10 ms | 0 px | 0 |
| calc | pass. `Display is 144` | clicks 10 to 533 ms | 0 px | 2, restored |

`invoke_menu` for Save As ranged from 299 to 476 ms over the round, depending on how fast the common dialog appears. Calculator's 2 changes come from `launch_app` re-activating the Calculator process left running by earlier checks (same pid every run). v2 shows the same 2 today (`acceptance-20261011-220723.json`; v3 reruns are `...220714` and `...220732`). The v2 report's 0 was a run where Calculator wasn't already running.

Explorer's Ctrl+X and Ctrl+V take 600 to 700 ms because the hold waits for Explorer's UI thread, which is busy right after a selection change or a navigation. Repeated Ctrl+C in the same window took 130 to 150 ms.

### What the front end can change

- Drop the closed-menu workaround (menu path from tree indentation, then `menu()`) for WinForms-style menus. A plain click on the MenuItem token now does it in the driver. On non-classic hosts (WPF and the like) the driver still uses UIA Invoke for such items, so keep the workaround there only if it was needed.
- Explorer: use `hotkey`, `press_key` and `type_text` in the background, and `click` with `action: "select"` to select a file without opening it. A `background_unavailable` whose cause mentions an XAML island means focus is in the address bar or search box. Selecting a file in the list moves focus back, or the command bar buttons work, before escalating to foreground.
- `invoke_menu` no longer needs a foreground policy gate for classic and Win32-menu apps.

### Limits

- UIA `SetFocus` on Explorer's XAML parts, for example `press_key` with the address bar's element_token, activates Explorer. That's the existing element-focus path, unchanged here.
- A Win32 menu item that is disabled or missing in the static HMENU takes the activate-and-walk route, since the app may only fill it in when the menu opens.
- If a posted menu walk fails partway (a segment never shows), the drop-down it opened stays open in the background app.
- The posted menu walk was tested on WinForms MenuStrip only. Other classic owner-drawn menus without a Win32 menu bar weren't tried.
- When a target's UI thread doesn't get back to its message loop within 2 s of a shortcut, the call returns `background_unavailable`, but the key may still arrive later without its modifiers.

## Fork v4: review fixes

An external review of v3 (GPT-6.1 Sol) reported eight findings. I treated each one as a hypothesis, read the code path end to end, and fixed the real ones in the driver function that owns the decision. One commit per fix on `bcu`, patches 0006 to 0012. The binary is `tools/cua-driver-fork/v4/cua-driver.exe`, also installed as `plugin/driver/cua-driver.exe` (sha256 `d2206fc4...`).

### 1. Window ownership before input (patch 0006): partly real

The review said keyboard tools and pixel `click`/`drag` trust `window_id` without checking its owner. That part was wrong. `ExactPidWindowTargetGuard` (`tools/impl_.rs`) already refuses an explicit `(pid, window_id)` pair whose HWND belongs to another process, for every input tool (`window_target_mismatch`, or `window_target_not_found` for a dead handle). v3 refuses all four mismatched calls in the new `ownership` check.

The real gap was token-only calls. A call with just an `element_token` used the HWND recorded in the token's snapshot, and nothing checked it. If that window closed, the input went to a dead handle, or to whatever app got the reused HWND. The guard now resolves the token's pid and window from the snapshot store and runs the same check. With v3 the `ownership` check's token call reached the input path and failed after 504 ms with "Invalid window handle". With v4 it's refused in 3 ms as `window_target_not_found`.

### 2. Pixel clicks hitting another app (patch 0007)

(a) Background pixel click: not real. `try_invoke_in_window_at_point` runs `FindAll` on the target HWND's own UIA subtree, so the hit test can't return another window's element. Posted clicks go to an HWND, never by coordinate, and `deepest_child` stays inside the target (`IsChild`). The coordinate injector already refuses a covered point (`target_visible_at_point`). In the `fgpoint` check, a background click at a point covered by another always-on-top window posted to the target with 0 foreground changes.

(b) Foreground pixel click and drag: real. `SendInput` goes to whatever window is under the point. A point outside the target window, or under another app's always-on-top window, clicked that window. The two SendInput functions in `input/mouse.rs` now own the check, so every foreground click, double/right click, px-focus of the keyboard tools and window drag inherits it:

- Before activating or raising the target: refuse when the point is outside the target's top-level rectangle (and not over one of its windows), or when another app's always-on-top window covers it and the target isn't always-on-top itself. Activation can't change either case, so these refusals don't touch foreground.
- After the raise: the top-level window under the point must be the target's own or another top-level window of its UI thread (an open menu, drop-down or dialog). Child windows of other processes inside the target, like a WebView2 renderer, count as the target. This check polls for up to 250 ms, because `SetForegroundWindow` on another thread's window raises it only when that thread handles the activation. Without the poll, a point that activation uncovers was refused.
- The driver's own cursor overlay sits on the point during a click. `WindowFromPoint` can return it, so for our own windows the check looks again, skipping transparent windows.
- The refusal is `target_not_at_point`. No input is sent and the cursor isn't moved. Desktop-scope drags keep screen semantics through a separate entry point (`send_desktop_drag_synthesized`).

`fgpoint` check: click and drag left of the target refused in 5 ms (the point was over Explorer's desktop window). A foreground click under the always-on-top window refused in 10 ms with that window's pid, 0 foreground changes. A foreground click at a point another window covered until activation landed. Before the pre-activation topmost check, that covered refusal cost a 270 ms activation of the target (measured at 10 ms sampling) before the driver restored foreground.

### 3. `invoke_menu` activation is opt-in (patch 0008): real

`run_menu_path` activated the window for every menu it couldn't walk with posted messages: WPF, XAML, and Win32 menu items missing or disabled in the static HMENU. A mistyped path is "missing", so a typo activated the window before failing. `invoke_menu` now takes `delivery_mode` like the input tools:

- `background` (default): Win32 menu bars get the item's notification and classic menus get posted clicks, as in v3. Anything that needs the window active returns `background_unavailable` before touching foreground. For a Win32 menu bar the cause names the segment that didn't resolve and lists the items there ("\"Stomp\" is not an item of \"Edit\" (items: Clear, Stamp)").
- `foreground`: v3's activate, walk, restore.
- A window that's already foreground is walked through UIA in either mode, since nothing needs activating.

The schema comes from the portable contract plus `delivery_mode`, so the registry still refuses unknown arguments. The action record now reports the requested delivery. `win32/menu.rs::resolve_command` returns why it missed instead of `None`. `menubg` check: the disabled item and the typo both return `background_unavailable` in 2 to 8 ms with 0 foreground changes. The same calls on v3 activated MenuPad twice and returned "menu path segment 1 was not found". With `foreground` the disabled item activates, fails as `menu_path_unavailable`, and restores (2 changes).

### 4. COM on blocking workers (patch 0009): real but latent

`activation_target`, `posted_click_target`, `closed_menu_item_path`, `pattern_click`, `select_combo_option` and `set_value_verified` call `CoCreateInstance` and run on tokio blocking workers that may never have joined COM. It works today because `walk_tree` leaves the process MTA alive (fire-and-forget `CoInitializeEx`) and a snapshot always comes first. A first call on a fresh worker before any walk would fail with `CO_E_NOTINITIALIZED`, and the modal-safe posted route would silently fall back to UIA Invoke. Each of those entry points now joins the MTA first, fire and forget, the convention `walk_tree` and `uia::scroll` use. `ComInit` (which uninitializes on drop) isn't right here, because callers hold interfaces past the call. I didn't reproduce the failure live; the regression checks pass.

### 5. Foreground shield after an Invoke deadline (patch 0010): real

`run_with_uwp_bypass` disables a Chromium or XAML host so it can't take foreground, and re-enabled it when `invoke_with_deadline` returned `Dispatched` at 1.5 s, with the Invoke still running. A provider that self-activates when it finally runs the action could steal foreground. Now the shield in effect is kept in a thread-local, and a dispatched Invoke takes it over: the Invoke thread lowers it when Invoke returns, or a timer does after 10 s. The tool call doesn't wait. A guard only re-enables a window it disabled itself, so a guard armed while a dispatched one still holds the window can't leave it disabled. Not exercised live: Chromium's Invoke returns at once (`edge_alert` 9 to 15 ms) and I have no XAML fixture that blocks for 1.5 s.

### 6. Keyboard state around the attached hold (patch 0011): partly real

The suggested fix, capturing the state before attaching, doesn't work. `GetKeyboardState` returns the calling thread's state, and before attaching that's the driver thread's own. `AttachThreadInput` resets the shared key state (documented), so the target's prior state can't be captured from another thread at all. The cleanup already ran on every path, timeouts included. What was wrong: it wrote the whole 256-byte array back, undoing any key that changed during the hold (real input to a foreground target), and wrote zeros if the state couldn't be read. Cleanup now puts back only the modifier bytes it set, and skips the restore if the state was never read. `replace` (Ctrl+S on WinForms) and `explorer` (Ctrl+Shift+N, Ctrl+X, Ctrl+V) pass. A physically held key wasn't tested.

### 7. `WM_NULL` as proof the key was handled: real, documented

A thread waiting in its own outgoing `SendMessage`, a COM call or `MsgWaitForMultipleObjects` answers sent messages while its posted ones stay queued, so the round trips can finish before the key is read. No API shows another thread's posted queue (`GetQueueStatus` is the caller's own). A sound barrier needs a `WH_GETMESSAGE` hook in a DLL loaded into the target process, which is far more than this needs. The round trips and v2's 120 ms floor stay, and the comment in `post_key_with_modifier_state` now states the limit.

### 8. `MNS_NOTIFYBYPOS` menus (patch 0012): real

The Win32 menu route always posted `WM_COMMAND`. A menu bar with `MNS_NOTIFYBYPOS` notifies its owner with `WM_MENUCOMMAND` (item position, menu handle), and such apps may not handle `WM_COMMAND` at all. The route now reads the menu bar's style with `GetMenuInfo` (the style is a menu-bar property) and posts the notification the app expects. The result names which one it sent. `apps/MenuPad.cs --bypos` sets the style and acts on `WM_MENUCOMMAND` only, like a native app with it. v3: "posted its WM_COMMAND", success, and the editor stayed empty. v4: "posted its WM_MENUCOMMAND (position 2)", editor reads `via-WM_MENUCOMMAND stamped`.

### Acceptance

New checks: `win32menu_bypos`, `menubg`, `ownership`, `fgpoint`. MenuPad gained `--bypos`, `--topmost`, `--at X Y` and `--title`. Every check's sampler summary now carries `foreground_sequence`, the foreground windows in order. `closedmenu` and `win32menu` accept foreground changes only among the app's own windows (`no_foreground_steal`). When the app under test launches into the foreground, its own Save As dialog takes foreground and hands it back. That's what an earlier "2 foreground changes" in `saveas` and `win32menu` turned out to be (`[TestPad, Save As, TestPad]`), not the driver.

Final run, `acceptance-runs/acceptance-20261012-001403.json` (v3 on the new checks: `acceptance-20261011-234207.json`):

| Check | Result | Timings | Cursor | Foreground changes |
| --- | --- | --- | --- | --- |
| saveas | pass | `invoke_menu` 245 ms, Save click 558 ms, dialog 118 elements | 0 px | 2, TestPad and its own dialog |
| closedmenu | pass | 514 ms | 0 px | 0 |
| replace | pass | `invoke_menu` 104 ms, Ctrl+S 542 ms | 0 px | 0 |
| win32menu | pass | Stamp 418 ms, Save As 158 ms | 0 px | 2, MenuPad and its own dialog |
| win32menu_bypos (new) | pass | 421 ms, `WM_MENUCOMMAND (position 2)` | 0 px | 0 |
| menubg (new) | pass | refusals 8 and 2 ms, Stamp 418 ms | 0 px | 0 (foreground phase: 2, restored) |
| ownership (new) | pass | refusals 3 to 8 ms | 0 px | 0 |
| fgpoint (new) | pass | outside 5 ms, covered 10 ms, uncovered click 822 ms | 0 px | 0 in the refusal phases |
| explorer | pass | 2.4 s of tool time | 0 px | 0 |
| edge | pass | same routes as v3 | 0 px | 0 |
| edge_alert | pass | Invoke 15 ms | 0 px | 0 |
| calc | pass, `Display is 144` | clicks 11 to 520 ms | 0 px | 2, from `launch_app` as in v3 |

### What the front end must handle

- `invoke_menu` accepts `delivery_mode` (`"background"`, the default, or `"foreground"`). In background it never activates the window. Menus that need activation return `isError` with `structuredContent.code: "background_unavailable"`, `cause`, `target_class` and `escalation.recommended: "foreground"`: WPF, XAML and other non-classic hosts, plus Win32 menu-bar paths that are missing or disabled in the static menu, typos included. Retrying with `"foreground"` activates, walks and restores, so it belongs behind the same policy gate as foreground input. v3 rejects `delivery_mode` as an unknown argument.
- `target_not_at_point` (new code, `effect: "refused"`, with `window_id`, `x`, `y`, `hit_window_id`, `hit_pid`) from foreground `click`, `double_click`, `right_click`, `drag`, and the x/y focus click of `press_key`, `hotkey` and `type_text`. No input was sent. Pick a point inside the target that nothing covers, or use an element token.
- `window_target_mismatch` and `window_target_not_found` now also come back for token-only calls whose snapshot window has closed or changed owner. Take a fresh `get_window_state`.
- Win32 menu results may say `WM_MENUCOMMAND (position N)` instead of `WM_COMMAND (id N)`.

### Limits

- The ownership and hit tests run just before input, so a window that closes or moves in the microseconds between them still races.
- A dispatched Invoke keeps a Chromium or XAML window disabled until Invoke returns, up to 10 s, and the user can't click that window meanwhile.
- After `AttachThreadInput` the target's earlier key state is gone. A key the user physically holds on a foreground target can read as up until its next key event.
- A posted key can still lose its modifiers on a thread that answers sent messages while its posted queue waits (finding 7). The 120 ms floor covers the common case.
- When the target is itself always-on-top and another always-on-top window covers the point, only activation can tell whether the target ends up above it, so a refusal there follows an activation the driver then undoes.
- Foreground `scroll` (a SendInput wheel at the cursor) isn't hit-tested. A wheel can't click, but it can scroll whatever covers the point.

## Fork v5: browser route for Helium

Round 5 makes the driver's DevTools route (`browser_*` tools) usable on the user's real Helium (Chromium 155, `chrome.exe` under `%LOCALAPPDATA%\imput\Helium`), attached with `cua-driver mcp --grant existing-profile`. One commit per item on `bcu`, patches 0014 to 0019. The binary is `tools/cua-driver-fork/v5/cua-driver.exe`, also installed as `plugin/driver/cua-driver.exe` (sha256 `c4b5e429...`).

### 1. Speed (patch 0014)

Timestamps around each step showed where the 2.2 to 2.6 s went. A user-owned browser action is re-proved three times: `authorize_attested_resource` and `validate_attested_resource` at dispatch, then the tool's own `revalidate_for_mutation`. Each proof re-read the browser's command line twice (once to classify, once to find the profile's `DevToolsActivePort`) through a `powershell.exe` running `Get-CimInstance`, 360 to 520 ms per spawn. Everything else in a proof cost under 15 ms: the Toolhelp process list 9 to 10 ms, the TCP owner table 0.5 ms, `Target.getTargets` plus window lookups 2 ms.

The command line now comes from `NtQueryInformationProcess(ProcessCommandLineInformation)`, the same string WMI reports, in microseconds. PowerShell stays as the fallback for a process that can't be opened. Classification takes the exe name from the process (`QueryFullProcessImageNameW`, with an exit-code check so an exited pid still reads as gone) and falls back to Toolhelp. No cache was needed, so nothing can go stale on pid reuse, and every check (fingerprint, native window owner, endpoint port owner, grant generation, window correlation) still runs on every proof. A proof now takes about 3 ms.

| | before (9f80bc8) | after |
| --- | --- | --- |
| revalidation, each | ~800 ms | ~3 ms |
| `browser_type` | 2.7 s | 12 to 26 ms; `replace:true` 110 to 150 ms |
| `browser_click` | 2.8 s | 44 to 67 ms |
| `browser_navigate` | 2.2 s | 14 to 95 ms |
| snapshot (`semantic_v2`) | 0.8 s | 8 to 50 ms |
| bind | ~1.2 s | 7 to 14 ms |
| `browser_prepare` | | ~500 ms, mostly Helium's consent prompt |

The `replace` cost is a deliberate 100 ms settle inside `enter_focus_emulation`. The agent cursor matters in the selected tab: the driver awaits its glide before a click or type, so with the default motion `browser_type` took 220 to 520 ms and `browser_click` 490 ms there (17 and 45 ms with the cursor off). Background tabs report `visibilityState: hidden`, get no cursor, and run at the numbers above. `set_agent_cursor_motion` controls the glide.

### 2. `replace:true` on email and number inputs (patch 0015)

`setSelectionRange` throws on `type=email` and `type=number`, which have no selection API. The `select()` fallback worked, but the check after it read `selectionStart`, which is `null` for those types, and refused with "not a text input". For those types the driver now calls `select()` and proves it from the focused control's selection string, which Helium reports as the full value. Text, search, url, tel, password, untyped inputs, textareas and contenteditables were already fine.

### 3. Background tabs (patch 0016)

- `browser_open_tab {session, target_id, url}` opens a tab with CDP `Target.createTarget {url, background: true}`. Chrome's handler adds it as `NEW_BACKGROUND_TAB`, window shown inactive, no focus, in the profile's most recently active window, since CDP has no window parameter. The tool checks `Browser.getWindowForTarget` for the new tab. Outside the bound window, it closes the tab again and refuses `browser_wrong_target_refused` with `detail.closed`. Otherwise it adds the tab to the binding and returns `{status, target_id, tab_id, url, active: false}`. Only http, https and about URLs.
- `browser_close_tab {session, target_id, tab_id}` closes only tabs the same session opened (a per-session set of `(pid, CDP target id)` in the store, dropped when the session ends) and returns `{status, target_id, tab_id, closed: true}`. Any other tab is refused `browser_action_unavailable`, including the user's.
- Both go through the `browser_bound_input` adapter like the other page mutations, so bounded manifests check the new tab's origin. `revalidate_for_mutation` was split so a window-level action re-proves the same chain without a tab (`revalidate_binding`). The existing-profile CDP policy now admits `Target.createTarget` and `Target.closeTarget`.

### 4. Keys (patch 0017)

`browser_press_key {session, target_id, tab_id, key, modifiers?, ref?}` sends one trusted `Input.dispatchKeyEvent` press under focus emulation. Keys: Enter, Tab, Escape, Backspace, Delete, Insert, Home, End, PageUp, PageDown, the four arrows, Space, F1 to F24, or one character. Aliases include esc, return, up, down. Modifiers: alt, ctrl, meta, shift. Text is dropped while Ctrl, Alt or Meta is held, so `a` + `ctrl` is select-all. With `ref` that element is focused first; without it the key goes to the page's focused element. Result: `{status, target_id, tab_id, key, modifiers, ref, frame}`. On the test page, Ctrl+A selected 0-12 of 12 characters in Name, Tab moved focus to Email, and Escape arrived.

### 5. Native `<select>` (patch 0018)

A closed select's options have no layout box, so a trusted click can't reach them. `browser_select {session, target_id, tab_id, ref, option?}` takes the select's ref with `option` as a value or visible label (exact value, then whitespace-normalized label, then case-insensitive), or an option's ref with `option` omitted. It sets the option and fires `input` and `change`, Playwright's `selectOption` route, with `DOM.resolveNode` and `Runtime.callFunctionOn` only, so no `Runtime.enable` and nothing outside the existing-profile policy. The events are untrusted (`isTrusted: false`), and the result says so: `{status, route: "dom_event", events_trusted: false, value, label, index, changed, ref, frame}`. Refs of selects and their options now declare a `select` action, and `browser_click` on an option of a closed select refuses `browser_action_unavailable` pointing at `browser_select`, not `browser_ref_stale`. A site that checks `isTrusted` on select changes needs the UIA route.

### 6. Product name (patch 0019)

A `chrome.exe` whose image path isn't under `\Google\Chrome` (Chrome, Beta, Dev, SxS) is now classified Chromium, so Helium reads "Attached to the approved existing Chromium profile". The Chromium setup descriptor drives the same `chrome://inspect` page and labels and also accepts the Chrome page title, and the profile lookup already prefers the install's own `User Data`. When the image path can't be read, the old classification stands.

### Results (`acceptance-runs/acceptance-20261012-135315.json`)

`helium` check: binds the Helium window on top of the z-order, opens its own background tab on a page it serves itself, fills Name (type, then replace), Email (type, then replace), Notes, Plan (`browser_select`), the checkbox and Submit, presses Ctrl+A, Tab and Escape, checks a second driver process can't close the tab, closes it, and checks the tab strips and prompts.

| Measure | Result |
| --- | --- |
| Result | pass. `Submitted: name=Ada Lovelace\|email=ada@example.com\|plan=pro\|agree=yes\|notes=typed in a contenteditable` |
| Actions | open_tab 16, type 12 to 26, type replace 110 to 137, click 44, closed-option click refused in 9, select 11, press_key 15 (136 with a ref), navigate 95, close_tab 17 ms |
| Snapshots | 8 to 50 ms |
| Cursor | 0 px |
| Foreground | 0 changes from open_tab to close_tab. Prepare: 2 (Helium's "Allow remote debugging?" prompt pops up and the driver accepts it), restored |
| User's view | selected tab and window title unchanged; tab count back to its start value |
| Leftovers | no test tab, no `Inspect with` tab, no remote-debugging prompt |

### What the front end must handle

- New tools: `browser_open_tab`, `browser_close_tab`, `browser_press_key`, `browser_select`, with the arguments and results above. All need an explicit `session` and a target from `get_browser_state`, like the other `browser_*` tools.
- Prefer `browser_open_tab` over navigating the user's tab, and close the tab when done. It works best in the window the user activated last (top of the z-order), which is also the only window `browser_prepare` succeeds on (see limits).
- Choose a select option with `browser_select`, not by clicking an option ref. Use `browser_press_key` for Enter, Tab, Escape, arrows and shortcuts. `browser_type` with `replace:true` now works on every text-entry input.
- Use one driver session per browser. See limits.

### Limits

- Helium anchors its remote-debugging prompt to the window the user activated last, and the driver's consent handler only looks inside the window being prepared. Preparing any other Helium window waits 4 s, refuses `browser_wrong_target_refused` ("no exact Chromium remote-debugging consent prompt appeared"), and leaves the prompt open (verified: the prompt's owner was the other window). Accepting the prompt where Helium puts it would widen the consent automation, so I left it. Dismiss a stale prompt with `WM_CLOSE`, which denies.
- Two sessions of one driver attached to the same browser share one pooled socket (`CdpPool` keys by WebSocket URL, one generation per entry). Ending the second session dropped the socket the first one used; the first session's next call reconnected and refused "the browser reconnected and invalidated this target". This predates v5. A second driver process has its own socket and is unaffected.
- `browser_open_tab`'s other-window refusal (close the tab again and refuse) wasn't exercised live. It needs the user to activate another window between bind and open, and the only bindable window is the last-active one.
- `browser_select` events are untrusted. `browser_press_key` sends no separate modifier key events, only the modifier bits on the key itself.
- `cargo test -p cua-driver-core --lib`: 955 pass. Two `history::tests` cases (no browser code) failed once each under the parallel run and pass alone. The SDK and CLI crate tests need the Linux X11 libraries, which aren't installed here, so I updated their tool lists without running them.

## Fork v6: lost keystrokes and hidden checkbox state

Round 4 (`research/08-experiments.md`) looked for turns the model wasted because of the driver. Two causes came from here. One commit each on `bcu`, patches 0020 and 0021, on top of fork v5's browser route.

### 1. Keys reach a UWP app after it loses the foreground (patch 0020)

Background typing into Calculator worked in 11 of 12 fork v2 runs and failed in all 6 fork v4 runs that tried it. Every failure had 2 or more foreground changes in the bench's samples, and every success had none. `launch_app` restores the user's foreground when a packaged app takes it at launch, which is correct, but the restore deactivates the app. A fresh Calculator's two threads (ApplicationFrameHost's frame thread and CalculatorApp's) both report its `Windows.UI.Core.CoreWindow` as their focus window. Once it has been active and lost the foreground, both report none. `focused_descendant` then found nothing, so `type_text`, `press_key` and `hotkey` posted to the `ApplicationFrameWindow`, which drops keyboard messages, and the tools reported success. The display stayed at 0, and the model spent two more turns clicking buttons instead.

`keyboard_target()` in `input/keyboard.rs` now owns the choice for all four posting paths: the focused descendant, else the frame's CoreWindow child, else the window itself. The CoreWindow takes posted `WM_CHAR` without focus. Repro (`bring_to_front` Calculator, `bring_to_front` the previous window, `type_text "12*12="`): v4 shows `Display is 0`, the fix shows `Display is 144` in 2 of 2, and still 2 of 2 without the activation.

### 2. Toggle and selection state in tree rows (patch 0021)

The walker cached `ToggleState` and `SelectionItem.IsSelected` for every node but `format_node_line` never printed them, so a checkbox row read the same ticked or not. In v4 the model took screenshots to check the Edge form's checkbox. Rows with a `toggle` action now carry `checked` or `unchecked`, and selected items carry `selected`:

    - [22] CheckBox "I agree to the terms" [checked id=agree actions=[toggle,set_value]]

### Acceptance

`acceptance-20261012-135055.json` (all 12 checks) and `acceptance-20261012-135220.json` (`replace`, `edge` twice). Every check passed, with 0 px of cursor movement. In the first run `replace` and `edge` failed in the harness, not the driver. `replace` was a port bug: JavaScript's `.` doesn't match the `\r` that a multi-line value leaves on a row, so the TestPad editor row didn't parse. The row regex now has the `s` flag. `edge` found no option rows 300 ms after `expand`, then passed twice on the rerun. Another session ran its own acceptance check on the same desktop two minutes before, which may have interfered. The `edge` check's checkbox row now reads `[checked id=agree ...]`.

After rebasing onto fork v5 (patches 0013 to 0019), `acceptance-20261012-151206.json` ran the same 12 checks on the combined driver: all pass, 0 px of cursor movement. The `helium` check wasn't run here, because it attaches to the user's own Helium. The Calculator repro also passes on the combined driver, 2 of 2.

### Limits

- The CoreWindow fallback only applies to `ApplicationFrameWindow` frames. A WinUI 3 or XAML-island app that loses focus the same way still gets its keys posted to the top-level window.
- `selected` shows up on whichever list item, tab or radio button is selected, so trees with many selected items get a little longer.

## Fork v7: a minimized Helium

The user's Helium windows were both minimized when the Helium checks ran, and three things broke. The plugin listed only on-screen windows, so `cua.window("Helium")` found nothing (fixed in `plugin/server/desktop.ts`, which now lists minimized windows too). Attaching restored the minimized window, because Chromium shows its "Allow remote debugging?" prompt that way. And the page came back bound read-only. Three commits on `bcu`, patches 0022 to 0024. `fork/export-patches.sh` now writes unnumbered subjects (`[PATCH]`), so adding a commit adds a file instead of rewriting every patch's `[PATCH n/m]`.

### 1. Bind by restored bounds (patch 0022)

Binding is exact only when the native window's bounds match the CDP window's. A minimized window's `GetWindowRect` is parked at (-32000, -32000), while `Browser.getWindowBounds` reports the restored bounds. `cdp_comparable_window_bounds` now uses `GetWindowPlacement`'s `rcNormalPosition` for a minimized window, shifted from workspace to screen coordinates by its monitor's work-area offset (the same conversion Chromium does).

### 2. Read the prompt again after a contradictory read (patch 0023)

One headless Claude run failed with "the native Chromium consent prompt focus contradicted the structural cancel button": the matcher's layout and focus checks disagreed on one read, and any failed read ended the attempt. I couldn't reproduce it in 18 later attaches, so the cause is a guess (a read taken while Chromium was restoring the window). The handler now keeps reading until its deadline. Allow is still only invoked on a single read whose layout and focus agree.

### 3. Undo what the prompt does to the desktop (patch 0024)

Preparation now reads the desktop before it connects (`BrowserPlatform::desktop_state`) and restores it afterwards, whether or not the attach worked (`restore_desktop_state`). It minimizes the window again with `SW_SHOWMINNOACTIVE`, and if the browser still holds the foreground, it hands the foreground back to the window that had it. Attaching to the browser's input queue alone was refused every time. The driver's existing fallback, one `VK_NONAME` key press (the same one `launch_app` uses), is what works. Repro with TestPad in the foreground and Helium minimized: before, the foreground went TestPad, Helium, prompt, Helium and stayed there. After, it went back to TestPad 10 ms after the prompt closed, and Helium was minimized again.

The prompt fix exposed another bug. When an attempt fails, its prompt stays open, but nothing can use it anymore, and once the window is minimized again it's hidden. Every later attempt saw two prompts and refused ("multiple bound native Chromium consent prompts"), so one failure blocked Helium until someone closed it. Eight hidden prompts had piled up before I found it. Failed attempts now call `deny_open_consent_prompts`: it reads the prompt titles from the browser window's UIA tree and closes (`WM_CLOSE`, which Chromium treats as Cancel) the top-level windows the browser window owns in the same process with exactly that title, then waits up to 1 s for them to go. The deny has to run in `prepare.rs`'s failure branches, not in the consent handler: the outer 4 s bound in `claim_with_optional_consent` drops the handler before its own 4 s deadline. Two sessions attaching at the same moment still both fail, because two prompts are ambiguous, but they leave 0 prompts, and the next attach works (1.4 s).

### Results

- `bench/helium-check.ts` with both Helium windows minimized: direct run PASS (`helium-check-20261012-163518.json`), 17 to 250 ms per action after a 1.2 s bind, and the headless Claude run PASS in 21.7 s. Both had 0 px of cursor movement, the foreground restored, Helium still minimized, and 0 prompts left. The direct run now fails unless the foreground and cursor end where they started.
- `fork/acceptance.ts helium` on the final driver: 2 passes (`acceptance-20261012-163854.json`, `-164011.json`), 0 foreground changes. The two runs before them (`-163628`, `-163807`) refused at `browser_prepare` after 13 s, a few minutes after the collision tests, and the check hid the message. It now records a refusal's message (`refusal_message`), which is the driver's own text. The cause is still unknown.
- `bench/server-check.ts`: 27/27. `cargo test -p cua-driver-core --lib browser::`: 189 pass. The Windows `browser_consent_ui` (17) and `browser_platform` (45) unit tests pass, cross-built and run through WSL interop.

### Limits

- The bounds conversion was only verified with the taskbar at the bottom, where workspace and screen coordinates are the same.
- The foreground hand-back presses `VK_NONAME` once. It has no meaning to applications, but it is global input.
- Two attaches at the same moment both fail (see above). The plugin's sessions don't retry on their own.
