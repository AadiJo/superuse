# Cua Driver fork

Our local fork of [Cua Driver](https://github.com/trycua/cua/tree/main/libs/cua-driver) (MIT), the native Windows layer under the plugin. Nothing here goes upstream.

- `UPSTREAM`: the upstream repo and pinned commit.
- `patches/`: our changes as one patch per commit, applied in order on top of that commit.
- `build.sh`: clones upstream into `tools/src/cua` (gitignored) if needed, applies the patches on branch `bcu`, cross-builds from WSL and installs `plugin/driver/cua-driver.exe`.
- `export-patches.sh`: writes new commits on `bcu` back to `patches/`.
- `acceptance.py`: live checks against real apps. `python3 fork/acceptance.py [saveas] [closedmenu] [replace] [edge] [edge_alert] [calc] [explorer] [win32menu]`. Each run writes `fork/acceptance-runs/acceptance-<time>.json` with every tool call, its time, and the cursor and foreground samples. `BCU_CUA_DRIVER` picks the exe under test.
- `apps/MenuPad.cs`: a small app with a real Win32 menu bar for the `win32menu` check. `acceptance.py` builds it into `%TEMP%\bcu`.

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
