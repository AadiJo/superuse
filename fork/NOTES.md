# Cua Driver fork

Our local fork of [Cua Driver](https://github.com/trycua/cua/tree/main/libs/cua-driver) (MIT), the native Windows layer under the plugin. Nothing here goes upstream.

- `UPSTREAM`: the upstream repo and pinned commit.
- `patches/`: our changes as one patch per commit, applied in order on top of that commit.
- `build.sh`: clones upstream into `tools/src/cua` (gitignored) if needed, applies the patches on branch `bcu`, cross-builds from WSL and installs `plugin/driver/cua-driver.exe`.
- `export-patches.sh`: writes new commits on `bcu` back to `patches/`.
- `acceptance.py`: live checks against real apps. `python3 fork/acceptance.py [saveas] [replace] [edge] [edge_alert] [calc]`. Each run writes `fork/acceptance-runs/acceptance-<time>.json` with every tool call, its time, and the cursor and foreground samples. `BCU_CUA_DRIVER` picks the exe under test.

The sections below describe fork v2, the state after round 2 of the experiments (`research/08-experiments.md`).

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
