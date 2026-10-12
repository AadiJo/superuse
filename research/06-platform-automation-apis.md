# 06. Platform automation APIs: the OS-level engine

Research date: 2026-10-11. Scope: accessibility trees, input injection and screen capture on Windows, macOS and Linux, how to run them fast and without disturbing the user, and which libraries to build on.

How this was gathered:

- Primary docs: Microsoft Learn, Apple developer docs (JSON API and SDK headers), freedesktop portal XML, at-spi2-core XML, Chromium and Electron source.
- Source reading of cua-driver-rs, terminator, xa11y, glass, xcap and scap (shallow clones in /tmp).
- Read-only inspection of the Codex Computer Use helpers installed on this machine (`@oai/sky` 0.7.5, PE import tables and strings only). Marked **[observed locally]**.
- A small read-only timing probe I ran on this Windows host (Windows 11 25H2, build 26200, i9-14900K, 3420x2149 primary display). Marked **[measured here]**.
- Anything I could not trace to a primary source is marked **[unverified]**.

## TL;DR

- **Windows trees: use the UIA COM client with cache requests, and treat cross-process calls as the cost to minimize.** Microsoft says each uncached property read is one cross-process call ([caching docs](https://learn.microsoft.com/en-us/windows/win32/winauto/uiauto-cachingforclients)). Real numbers are slow: glass measured 977 to 2,332 ms for a 1,500-node WPF or WinForms window even with caching ([glass PR #593](https://github.com/fixed-width/glass/pull/593)). The big untapped lever is UIA remote operations, which run a batch of UIA calls as bytecode inside the target process in one round trip ([CoreAutomationRemoteOperation](https://learn.microsoft.com/en-us/uwp/api/windows.ui.uiautomation.core.coreautomationremoteoperation)). Nobody in the open-source CU space uses it yet, as far as I found.
- **Chromium and Electron trees are lazy on every OS.** On Windows, Chromium turns on basic web accessibility only after a client reads properties in web content ([Chromium source](https://chromium.googlesource.com/chromium/src/+/main/content/browser/accessibility/browser_accessibility_state_impl.cc)), so the first walk is often empty and you must poll. Occluded Chromium windows can keep an empty web tree. On macOS use `AXManualAccessibility` for Electron and `AXEnhancedUserInterface` only for Chrome, because the latter breaks window resizing.
- **The best "no cursor, no focus steal" click on Windows is synthetic pen injection, not PostMessage.** cua-driver-rs uses `CreateSyntheticPointerDevice` + `InjectSyntheticPointerInput` (Windows 10 1809+) because PostMessage clicks are ignored by Chromium, WPF and GTK, while pen input goes through the system input queue without moving the mouse or needing foreground ([cua-driver inject.rs](https://github.com/trycua/cua/blob/main/libs/cua-driver/rust/crates/platform-windows/src/input/inject.rs)). The target must be visible at that point. Background keyboard input to Chromium on Windows still has no clean path.
- **Codex on Windows is less "background" than Codex on Mac** [observed locally]. The shipping Rust helper (`codex-computer-use.exe`, windows-rs 0.61) imports `SendInput`, `SetCursorPos`, `SetForegroundWindow`, `AttachThreadInput` and `SetSystemCursor`, and no `PostMessageW`. It hides the real cursor and draws an animated fake one with Windows.UI.Composition, captures with Windows.Graphics.Capture (per window and per monitor crop), encodes JPEG with WIC, uses UIA cache requests, and catches Esc with a `WH_KEYBOARD_LL` hook. A second, newer Swift-on-Windows build in the same package adds a real "background input" mode using PostMessage, `SetKeyboardState` and a per-window background cursor.
- **Per-window capture: Windows.Graphics.Capture (WGC) on Windows, ScreenCaptureKit on macOS, PipeWire via portal on Wayland.** WGC captures occluded windows but not minimized ones, and a warm session reads a frame in about 1 to 2 ms ([grabwin](https://github.com/semetronix/grabwin)). The yellow border can only be turned off on build 20348+, which is why Codex screenshots break on Windows 10 22H2 ([codex #25178](https://github.com/openai/codex/issues/25178)). PrintWindow took 40 to 53 ms per window here and returns black for DirectComposition apps. Encoding matters more than capture: a full 3420x2149 frame took 98 ms as PNG and 13 ms as JPEG q80 [measured here].
- **macOS has the fastest tree reads but the hardest background input.** AX costs about 2 to 3 Mach IPC calls per node with no subtree batching, yet still measured 210 ms per 1,500 nodes versus 732 ms on AT-SPI and about 1.5 s on UIA in glass's comparison ([glass #280](https://github.com/fixed-width/glass/issues/280)). Background clicks that Chromium accepts need the private SkyLight `SLEventPostToPid` plus a "focus without raise" trick borrowed from yabai ([cua blog](https://github.com/trycua/cua/blob/main/blog/inside-macos-window-internals.md)). `CGWindowListCreateImage` is obsoleted in the macOS 15 SDK, so capture must use ScreenCaptureKit.
- **Linux: X11 plus Xvfb is still the default headless stack, and Wayland is hard.** Anthropic's reference container, e2b Desktop and OSWorld guests all use X11 with xdotool or pyautogui. On Wayland, AT-SPI cannot report global coordinates and input goes through libei via the RemoteDesktop portal, which needs user consent ([portal XML](https://github.com/flatpak/xdg-desktop-portal/blob/main/data/org.freedesktop.portal.RemoteDesktop.xml)). AT-SPI does have a bulk `Cache.GetItems` call that clients should use.
- **Windows 11's agent platform does not give third parties a GUI automation API yet.** MCP on Windows (agent connectors in the On-device Registry) is for MCP servers, Agent Workspace is a preview used by Copilot Actions, and Microsoft Execution Containers went GA on 2026-10-07 with session isolation that starts "non-interactive" ([Windows dev blog](https://blogs.windows.com/windowsdeveloper/2026/06/02/windows-platform-security-for-ai-agents/)). Worth tracking, not worth building on today.
- **Build the core in Rust.** Nearly every serious 2026 CU engine I found (Codex's shipping Windows helper, cua-driver-rs, terminator, xa11y, glass, agent-desktop) is Rust on windows-rs, objc2 and zbus/atspi. The exception is OpenAI's Swift code, used for the Mac service and a newer Windows build, which suits a team porting existing Swift and doesn't apply to us. The strongest fork candidate is [trycua/cua](https://github.com/trycua/cua) `libs/cua-driver/rust` (MIT, all three OSes, MCP, background-first router). It is large (about 164k lines in the platform crates), so the alternative is a lean core that borrows its techniques.

## Windows

### UI Automation: which client API

Use the COM client (`IUIAutomation`, created via `CUIAutomation8`). Codex's Swift helper calls `CoCreateInstance(CUIAutomation8)` [observed locally], and cua-driver-rs, terminator and glass all use the COM client through windows-rs or the `uiautomation` crate. The newer client features only exist as COM interfaces: `IUIAutomation2` (timeouts, `AutoSetFocus`) and `IUIAutomation6` (event handler groups, `CoalesceEvents`, `ConnectionRecoveryBehavior`, Windows 10 1809+) ([IUIAutomation2](https://learn.microsoft.com/en-us/windows/win32/api/uiautomationclient/nn-uiautomationclient-iuiautomation2), [IUIAutomation6](https://learn.microsoft.com/en-us/windows/win32/api/uiautomationclient/nn-uiautomationclient-iuiautomation6)). The .NET `System.Windows.Automation` client exposes none of these. My probe below used it only because .NET Framework's `csc.exe` was the compiler available.

Threading rules from Microsoft ([threading docs](https://learn.microsoft.com/en-us/windows/win32/winauto/uiauto-threading)):

- Make UIA calls from a thread that owns no windows and is COM MTA (`COINIT_MULTITHREADED`). Calling from a UI thread "can lead to very slow performance, or even cause the application to stop responding."
- Add and remove event handlers from one non-UI MTA thread. Don't add or remove handlers from several threads at once.
- Elements marshaled to another thread can be invalidated when the creating apartment shuts down, so catch errors on marshaled elements.

Settings that matter for an agent ([AutoSetFocus](https://learn.microsoft.com/en-us/windows/win32/api/uiautomationclient/nf-uiautomationclient-iuiautomation2-get_autosetfocus), [ConnectionTimeout](https://learn.microsoft.com/en-us/windows/win32/api/uiautomationclient/nf-uiautomationclient-iuiautomation2-get_connectiontimeout), [TransactionTimeout](https://learn.microsoft.com/en-us/windows/win32/api/uiautomationclient/nf-uiautomationclient-iuiautomation2-get_transactiontimeout)):

- `AutoSetFocus` defaults to TRUE: "most UI Automation methods that perform an action on an element, such as Invoke and SetValue, set focus to the element before performing the action." Set it to FALSE for background operation.
- `ConnectionTimeout` defaults to 2 seconds and `TransactionTimeout` to 20 seconds. A hung app can stall a snapshot for 20 s unless you lower it and enforce a wall-clock budget yourself.

### Caching, FindAll and tree walks

What Microsoft documents ([caching](https://learn.microsoft.com/en-us/windows/win32/winauto/uiauto-cachingforclients)):

- Reading `CurrentName` and friends "requires a cross-process call for each property being retrieved." Caching ("bulk fetching") retrieves all requested properties for all requested elements "with a single method call."
- Build a cache request with `CreateCacheRequest`, `AddProperty`, `AddPattern`. Caching a pattern does not cache its properties; add them separately.
- `TreeScope` is relative to the element being retrieved, not the element you call Find on. To include the root itself you must add `TreeScope_Element`.
- `TreeFilter` defaults to the control view.
- `AutomationElementMode_None` returns cache-only references. You can't call pattern methods on them. The UIA-v2 AutoHotkey wiki reports this is usually 1.5 to 2 times faster [unverified, secondary].
- Refresh with `BuildUpdatedCache`, or subscribe to events with a cache request so the event source arrives pre-cached.

What people measured:

| Source | Setup | Uncached | Cached | Notes |
| --- | --- | ---: | ---: | --- |
| [glass #280](https://github.com/fixed-width/glass/issues/280) | 1,500 flat siblings, about 7 properties per node | 2,330 ms | 1,524 ms | Subtree cache request. Fetch 1,518 ms, local reads 6 ms. "The provider materializing 1500 nodes is the floor." |
| [glass PR #593](https://github.com/fixed-width/glass/pull/593) | WPF flat, 1,500-node cap | 1,338 ms | 977 ms | Element-scoped cache during traversal, median of 3 |
| same | WPF nested | 1,364 ms | 987 ms | |
| same | WinForms | 2,717 ms | 2,332 ms | Caching patterns too added only 1.11x |
| [measured here], .NET client | Taskbar, 19 nodes, 5 properties | 13.5 ms | 9.6 ms | `FindAll(Descendants)` |
| [measured here] | Win32 dialog (`#32770`), 67 nodes | 32.9 ms | 20.7 ms | about 0.3 to 0.5 ms per node |
| [measured here] | Windows Terminal, 26 nodes | 11.8 ms | 7.1 ms | |

So roughly 0.3 to 1.5 ms per node depending on the provider, with a floor of about 10 ms per call on this machine. A 3,000-node Electron app would cost seconds per full snapshot. That is why the main speed wins come from not taking full snapshots: scope to one window, cap nodes, prune offscreen subtrees, and invalidate incrementally from events.

Pitfalls found in sources:

- **Control view drops some elements.** `FindAllBuildCache` with the control view "silently drops fragment elements"; use a TrueCondition raw view to see them ([xa11y quirks](https://xa11y.dev/explanation/accessibility-quirks/)).
- **Cache requests ignore your node cap.** A subtree cache request fetches the whole subtree no matter what limit you walk with ([glass #280](https://github.com/fixed-width/glass/issues/280)).
- **Some providers hang on subtree caching.** LibreOffice's VCL/SAL provider hangs on subtree cache calls, so cua-driver falls back to MSAA through `oleacc.dll` for it ([cua Windows blog](https://github.com/trycua/cua/blob/main/blog/inside-windows-computer-use.md)).
- **UWP and WinUI apps under ApplicationFrameHost.** `ElementFromHandle` on the frame HWND can return only the frame. cua-driver walks from the desktop root and filters by process id instead ([cua Windows blog](https://github.com/trycua/cua/blob/main/blog/inside-windows-computer-use.md)). In my probe the `ApplicationFrameWindow` exposed only 13 nodes [measured here]. Codex's helper has a "no packaged app child window found" error string and special-cases `ApplicationFrameHost.exe` [observed locally]. This is a plausible cause of the "Calculator has no accessibility, falls back to screenshots" behavior the user saw, since Calculator itself has a full UIA tree [unverified as the cause].
- **Stale handles.** Every backend returns a fresh handle per query. Key elements on `GetRuntimeId` or a tree path ([xa11y quirks](https://xa11y.dev/explanation/accessibility-quirks/)). Codex keys on runtime IDs too ("no longer matches the cached runtime ID") [observed locally].
- **Settle time.** The UIA tree can take more than 100 ms to settle after structural changes ([xa11y quirks](https://xa11y.dev/explanation/accessibility-quirks/)).

### Remote operations: the unused speed lever

`Windows.UI.UIAutomation.Core.CoreAutomationRemoteOperation` lets a client send a small bytecode program to a VM inside the provider process, so "a series of cross-process calls" becomes "a single transition" ([API docs](https://learn.microsoft.com/en-us/uwp/api/windows.ui.uiautomation.core.coreautomationremoteoperation)). It needs build 20348+, and there is an instruction cap so an operation can't hog the target's UI thread. Microsoft ships C++/WinRT wrappers (`UiaOperationAbstraction`) that run the same logic either locally or remotely ([Microsoft-UI-UIAutomation](https://github.com/microsoft/Microsoft-UI-UIAutomation), MIT, active in 2026).

I found no open-source CU engine using it. This is the most promising way to beat the "1 ms per node" floor for things like "walk this subtree, prune offscreen nodes, return name/role/rect for visible actionable elements" in one round trip. It is unmeasured here, so it needs a prototype before we design around it.

### Events for change detection

- Handlers exist for focus, property change, structure change, notification, text edit and generic automation events. A `TreeScope_Descendants` handler is one handler at the subtree root, not one per element ([events docs](https://learn.microsoft.com/en-us/windows/win32/winauto/uiauto-eventsforclients)).
- Pass a cache request when subscribing so event sources arrive with properties filled in.
- Microsoft warns: "Do not assume that all possible events are raised by a UI Automation provider."
- `RemoveAllEventHandlers` removes every handler in the process, which breaks concurrent subscriptions ([xa11y quirks](https://xa11y.dev/explanation/accessibility-quirks/)).
- `IUIAutomation6::CoalesceEvents` filters duplicates, and event handler groups register many listeners in one call.
- WinEvents via `SetWinEventHook` are a cheaper out-of-context signal for "something changed in this window" and window creation. Codex's Rust helper imports it and has an "accessibility monitor" with window-opened readiness tracking [observed locally].

A reasonable design: use WinEvents and UIA structure-changed events only as invalidation signals, then re-fetch the affected subtree with a cache request. Don't try to maintain a mirror purely from events.

### Control patterns for semantic actions

Patterns let you act without coordinates or focus: `Invoke`, `Toggle`, `Value.SetValue`, `RangeValue.SetValue`, `ExpandCollapse`, `SelectionItem`, `Scroll`, `ScrollItem.ScrollIntoView`, `Text`, plus `LegacyIAccessible.DoDefaultAction` as an MSAA bridge. Codex's Swift helper calls `InvokePattern.Invoke`, `TogglePattern.Toggle`, `ValuePattern.SetValue`, `RangeValuePattern.SetValue`, `ScrollPattern.Scroll` and MSAA `accDoDefaultAction`; the Rust helper uses `ScrollPattern` and `ExpandCollapsePattern` [observed locally]. cua-driver tries these first and falls back to input only for canvases and custom-drawn areas ([cua Windows blog](https://github.com/trycua/cua/blob/main/blog/inside-windows-computer-use.md)).

Known quirks ([xa11y quirks](https://xa11y.dev/explanation/accessibility-quirks/)): WinForms `TrackBar` and `NumericUpDown` lack `RangeValuePattern`; Qt tab providers return `EVENT_E_ALL_SUBSCRIBERS_FAILED` even when the action worked; `SetFocus` fails on disabled elements; many WinForms rows report the default `Custom` control type.

### Chromium and Electron: forcing the tree on

How current Chromium decides, from source:

- `LegacyRenderWidgetHostHWND::OnGetObject` handles `WM_GETOBJECT`. A `UiaRootObjectId` request marks UIA as requested and returns the native UIA provider. An `OBJID_CLIENT` request returns the MSAA/IA2 root ([source](https://chromium.googlesource.com/chromium/src/+/main/content/browser/renderer_host/legacy_render_widget_host_win.cc)).
- Asking for the provider is not enough. Chromium enables `kNativeAPIs` when "minimal properties" are used and `kAXModeBasic` web accessibility only "when accessibility APIs have been used in content" ([browser_accessibility_state_impl.cc](https://chromium.googlesource.com/chromium/src/+/main/content/browser/accessibility/browser_accessibility_state_impl.cc), [ax_platform.cc](https://chromium.googlesource.com/chromium/src/+/main/ui/accessibility/platform/ax_platform.cc)). The old screen-reader "honeypot" signal now only counts if the client also reads names, because "it's been abused."
- Native UIA in Chromium is on by default since Chrome 138. Before that, UIA clients went through a Windows MSAA-to-UIA proxy ([Chrome blog, 2025-08-14](https://developer.chrome.com/blog/windows-uia-support-update)).
- `--force-renderer-accessibility=complete` forces it at launch. Chrome 117 broke the bare flag in UIA mode, so pass `=complete` ([Chromium docs](https://chromium.googlesource.com/chromium/src/+/main/docs/accessibility/overview.md), [issue 40072866](https://issues.chromium.org/issues/40072866)).
- Electron apps can call `app.setAccessibilitySupportEnabled(true)` after `ready`, which turns on `nativeAPIs`, `webContents`, `inlineTextBoxes` and `extendedProperties`. Electron warns it "can significantly affect the performance of your app" ([Electron app docs](https://github.com/electron/electron/blob/main/docs/api/app.md)).

What this means in practice:

- The first walk of a VS Code, Slack or Discord window may return 3 title-bar elements ([cua #1616](https://github.com/trycua/cua/issues/1616)). Read a property inside the web content, then poll until a Document element with named children appears.
- "Chromium's native occlusion tracking keeps a fully covered window's web tree empty" (contributor finding in [cua #1616](https://github.com/trycua/cua/issues/1616)) [unverified in source]. Report that as unavailable rather than raising the window.
- Turning accessibility on costs the target app CPU and memory. Do it only for windows the agent is actually working in. I deliberately did not probe Chromium windows on this machine for that reason.
- For real browsers, CDP is faster and more precise than UIA. cua-driver and agent-desktop both route browser content through CDP and keep native chrome on accessibility ([agent-desktop](https://github.com/lahfir/agent-desktop)).

### MSAA and IAccessible2 fallbacks

MSAA (`oleacc.dll`, `AccessibleObjectFromWindow`) is still useful where UIA proxies lose information or hang. cua-driver uses it for VCL/SAL apps because it keeps roles like `ROLE_SYSTEM_BUTTONDROPDOWN` ([cua Windows blog](https://github.com/trycua/cua/blob/main/blog/inside-windows-computer-use.md)). Chromium still serves MSAA/IA2 directly to clients like NVDA and JAWS ([Chrome blog](https://developer.chrome.com/blog/windows-uia-support-update)). Treat MSAA as a per-app fallback, not a second full backend.

### Input

`SendInput` ([docs](https://learn.microsoft.com/en-us/windows/win32/api/winuser/nf-winuser-sendinput)):

- Goes into the system input queue of the input desktop, serially, not interleaved with user input.
- "This function fails when it is blocked by UIPI. Note that neither GetLastError nor the return value will indicate the failure was caused by UIPI blocking."
- "This function does not reset the keyboard's current state." Physically held keys interfere, so check `GetAsyncKeyState`.
- Mouse input moves the real cursor and goes to whatever window is under it, so it needs the target on top and usually foreground.

`PostMessage` and `SendMessage`:

- Raymond Chen, 2005 and again in 2025: you can't reliably simulate keyboard input with PostMessage. Shift state is not updated (`GetKeyState` sees the real state), IMEs and dead keys are skipped, and posted messages bypass `WH_KEYBOARD` hooks because they come from the posted-message queue, not the input queue. His recommendation is UI Automation first, SendInput second ([2005](https://devblogs.microsoft.com/oldnewthing/20050530-11/?p=35513), [2025](https://devblogs.microsoft.com/oldnewthing/20250319-00/?p=110979)).
- Chromium, Electron, GTK and WPF content ignore posted `WM_*BUTTON` messages because their input arrives through the system input queue ([cua inject.rs](https://github.com/trycua/cua/blob/main/libs/cua-driver/rust/crates/platform-windows/src/input/inject.rs), [cua #1616](https://github.com/trycua/cua/issues/1616)).
- Still useful for classic Win32 controls: `BM_CLICK` on dialog buttons, `WM_SETTEXT`, `WM_PASTE`, combo box notifications. Codex's Swift helper uses `SendMessageTimeoutW` for "native dialog button", "CBN_EDITCHANGE" and paste [observed locally].

Synthetic pointer injection, the best background click I found:

- `CreateSyntheticPointerDevice(PT_PEN, ...)` + `InjectSyntheticPointerInput`, Windows 10 1809+ ([docs](https://learn.microsoft.com/en-us/windows/win32/api/winuser/nf-winuser-createsyntheticpointerdevice)).
- cua-driver's notes: it "delivers a click to whatever window sits under a screen point without SetForegroundWindow and without moving the user's mouse cursor." Pen input routes through the system input queue, so Chromium accepts it, and the OS promotes it to mouse messages for legacy Win32. Their reverse engineering says the kernel path gates on a per-process injection enable, "NOT on the target being foreground" ([inject.rs](https://github.com/trycua/cua/blob/main/libs/cua-driver/rust/crates/platform-windows/src/input/inject.rs)).
- Right click is a pen tap with the barrel button held. Middle click has no mapping. `InjectTouchInput` was unreliable for left clicks on Chromium.
- A tap on an inactive top-level window can still click-activate it. cua contains this by temporarily setting `WS_EX_NOACTIVATE` and restoring the user's foreground after.
- It is coordinate-routed, so it only reaches the topmost visible window at that point. If the target is covered, return an error rather than raising it.
- Open risks [unverified]: pen visual feedback, the touch keyboard or Ink workspace reacting, and apps that treat pen differently from mouse.

Foreground rules ([SetForegroundWindow](https://learn.microsoft.com/en-us/windows/win32/api/winuser/nf-winuser-setforegroundwindow)): a process can only take foreground if it is the foreground process, was started by it, received the last input event, or the foreground lock timeout has expired, among other conditions. "An application cannot force a window to the foreground while the user is working with another window." Both Codex helpers and cua-driver import `AttachThreadInput`, `SwitchToThisWindow` or `BringWindowToTop` to work around this [observed locally], and cua's latest release "drain[s] Windows foreground input before restoring focus" ([cua-driver-rs v0.33.1](https://github.com/trycua/cua/releases/tag/cua-driver-rs-v0.33.1)). Expect focus swaps to be fragile and visible.

UIPI and elevated windows ([UIA security overview](https://learn.microsoft.com/en-us/windows/win32/winauto/uiauto-securityoverview)):

- A normal-integrity process can't send input to, or fully read UIA from, an elevated window.
- `uiAccess="true"` lifts this, but the binary must be Authenticode-signed and installed in a secure location such as Program Files, and Microsoft says it is for assistive technology only. Nothing gets access to UI on the system integrity level, such as the UAC prompt.
- Codex refuses: "has administrator privileges, elevated Windows integrity, or UIAccess. Relaunch the app without elevated privileges. Computer Use will not bypass User Account Control" [observed locally]. cua-driver ships an optional `cua-driver-uia` worker crate for UIAccess.
- Recommendation: refuse elevated targets by default and tell the agent why. A signed UIAccess worker is a later, opt-in feature.

### Capture

Windows.Graphics.Capture (WGC):

- `IGraphicsCaptureItemInterop::CreateForWindow` (Windows 10 1903+) captures one window from DWM's composited frame, including when other windows cover it ([interop docs](https://learn.microsoft.com/en-us/windows/win32/api/windows.graphics.capture.interop/nf-windows-graphics-capture-interop-igraphicscaptureiteminterop-createforwindow), [cua Windows blog](https://github.com/trycua/cua/blob/main/blog/inside-windows-computer-use.md), [Cap PR #2301](https://github.com/CapSoftware/Cap/pull/2301)).
- Minimized windows produce no frames. Check `IsIconic` and always use a first-frame timeout. Projects use 250 ms to 1 s; Codex uses a 1,000 ms wait [observed locally, from a reverse-engineered trace in [codex #25178](https://github.com/openai/codex/issues/25178)].
- WGC may not fire `FrameArrived` for unchanged content on 24H2+ (review comment, [moq PR #4665](https://github.com/moq-dev/moq/pull/4665)) [unverified]. Keep a long-lived session per window and reuse the last frame.
- The yellow border: `IsBorderRequired` exists only on build 20348+. Packaged apps need the `graphicsCaptureWithoutBorder` capability and `RequestAccessAsync(Borderless)` ([docs](https://learn.microsoft.com/en-us/uwp/api/windows.graphics.capture.graphicscapturesession.isborderrequired)). Reports say unpackaged Win32 apps can set it to false without a prompt on Windows 11, which OBS relies on, but results vary [unverified, community reports]. Codex calls the setter unconditionally and fails every capture on Windows 10 22H2 ([codex #25178](https://github.com/openai/codex/issues/25178)). Feature-detect it.
- `IncludeSecondaryWindows` (Windows 11 24H2+) draws owned popups and tool windows that overlap the main window into the capture ([docs](https://learn.microsoft.com/en-us/uwp/api/windows.graphics.capture.graphicscapturesession.includesecondarywindows)). Without it, menus and dropdowns can be missing from window captures.
- Latency: a warm session read is about 1.1 to 1.3 ms for a 1249x1364 Edge window and about 2.7 to 4.6 ms at 2560x1440, with GPU-side cropping ([grabwin](https://github.com/semetronix/grabwin), MIT). Cold session start is unmeasured.
- Don't block inside the `FrameArrived` callback. Codex's synchronous `SoftwareBitmap.CreateCopyFromSurfaceAsync` wait in the callback appears to deadlock on Windows 10 ([codex #51245](https://github.com/openai/codex/issues/51245)).

Other capture paths:

- **PrintWindow with `PW_RENDERFULLCONTENT`**: works for occluded classic windows, blocks on the target app's paint, and returns black for DirectComposition, UWP and WinUI surfaces ([cua Windows blog](https://github.com/trycua/cua/blob/main/blog/inside-windows-computer-use.md)). I measured 39.5 to 53.3 ms per window on a 3420x2149 display [measured here]. cua-driver tries PrintWindow first and falls back to WGC on a black frame.
- **Screen BitBlt**: 49 ms for the full 3420x2149 primary display [measured here]. It shows whatever covers the target, which matches the user's note about Codex screenshots including overlapping windows. Codex's Swift helper has a "Windows Graphics Capture crop" path built on `CreateForMonitor` [observed locally].
- **DXGI Desktop Duplication**: monitor-level only, returns frames when content changes. 24H2 briefly fired spurious frames for `WDA_EXCLUDEFROMCAPTURE` overlays on some GPU and MPO setups, fixed in KB5046617 ([Win32CaptureSample #83](https://github.com/robmikh/Win32CaptureSample/issues/83)). Not useful for per-window agent screenshots.
- **Keep the overlay out of screenshots** with `SetWindowDisplayAffinity(WDA_EXCLUDEFROMCAPTURE)`, Windows 10 2004+ ([docs](https://learn.microsoft.com/en-us/windows/win32/api/winuser/nf-winuser-setwindowdisplayaffinity)). Codex does this ("exclude display overlay from capture") [observed locally].
- **GDI fails in Session 0 and disconnected RDP sessions.** `BitBlt` returns `ERROR_INVALID_HANDLE` there ([xa11y quirks](https://xa11y.dev/explanation/accessibility-quirks/)), and UIA and `EnumWindows` see no desktop. Both cua and Codex run a per-session daemon and talk to it over a named pipe for this reason.

Encoding [measured here], System.Drawing on the i9-14900K:

| Operation | Size | Time |
| --- | --- | ---: |
| PNG, full 3420x2149 frame | 2,103 KiB | 97.5 ms |
| JPEG q80, full frame | 467 KiB | 12.8 ms |
| Resize to 1280 wide, then JPEG q80 | 96 KiB | 20.1 ms |

grabwin reports PNG level 1 at 4.5 ms for a 1249x1364 browser window but 38 ms for a 2560x1440 game frame, and levels 2 to 9 are "30 to 100 times slower than level 1 for only 5 to 10 percent smaller files" ([grabwin](https://github.com/semetronix/grabwin)). Models resize images anyway, so downscale on the GPU or with SIMD, then send JPEG or WebP. Codex encodes JPEG through WIC `BitmapEncoder` with an `ImageQuality` property [observed locally].

### What Codex's Windows helper actually does

From PE import tables and strings of `@oai/sky` 0.7.5 on this machine [observed locally]. This is a read of symbols, not of code, so treat intent as inferred.

| Area | Rust helper `codex-computer-use.exe` (1.5 MB, windows-rs 0.61, cross-compiled from Linux) | Swift helper `codex-computer-use-swift.exe` (56 MB, Swift 6.3 for Windows) |
| --- | --- | --- |
| Transport | `NtCreateNamedPipeFile`; JS side is `NativePipeComputerUseClient`; checks caller signature with `WinVerifyTrust` and package identity with `VerifyApplicationUserModelId` | Named pipe APIs |
| Tree | UIA via COM, "create UIA cache request", "create UIA event cache request", runtime-ID keyed cache; skips `Default IME`, `MSCTFIME UI`, `Program Manager`, taskbar | `ElementFromHandleBuildCache`, `FindAllBuildCache`, control and raw view walkers, "Element Index" |
| Actions | `ScrollPattern`, `ExpandCollapsePattern` | Invoke, Toggle, Value, RangeValue, Scroll patterns, MSAA `accDoDefaultAction`, `IWebBrowser2.Navigate2` for background Explorer navigation |
| Input | `SendInput`, `SetCursorPos`, `keybd_event`, `SetForegroundWindow`, `AttachThreadInput`, `SwitchToThisWindow`; no `PostMessageW` | Adds `PostMessageW`, `SendMessageTimeoutW`, `SetKeyboardState`; strings for "background pointer", "background keyboard", "background drag", and "restore background input foreground" |
| Cursor | Hides the real cursor (`SetSystemCursor` with a blank cursor, separate `--system-cursor-manager` process that restores it), draws an animated agent cursor with Windows.UI.Composition | Per-window "background cursor" window ordered just above the target |
| Capture | WGC `CreateForWindow` and `CreateForMonitor`, `CreateFreeThreaded` frame pool, `IsCursorCaptureEnabled`, `IsBorderRequired`, JPEG via WIC | WGC window and "crop" paths, D3D11 keyed mutex |
| Overlay and stop | "Codex is using your computer / Esc to cancel" pill with shimmer animations, `SetWindowDisplayAffinity`, `WH_KEYBOARD_LL` and `WH_MOUSE_LL` hooks | Composition overlay, "Appshot" transitions |
| Policy | Refuses elevated targets, enforces per-app and browser-URL policy for msedge, chrome, brave, opera, firefox, dia | Same refusal text for elevated or UIAccess targets |

The JS client launches the Rust exe; I did not find what launches the Swift exe, so it may be a newer path in rollout [unverified]. Users report the Windows version takes over the shared cursor and shows a blue overlay ([codex #41323](https://github.com/openai/codex/issues/41323)), which fits the Rust helper's imports. Codex on macOS, by contrast, was announced as working "in the background without taking over your computer" ([OpenAI on X](https://x.com/OpenAI/status/2044827932145897652)).

### Windows 11 agent platform features (2025 to 2026)

| Feature | What it is | Usable by a third-party CU engine today? |
| --- | --- | --- |
| MCP on Windows, On-device Registry (ODR), agent connectors | Windows-managed registry of MCP servers, reached through a Windows MCP proxy. Built-in File Explorer and Settings connectors. `odr.exe mcp list/add` ([Learn](https://learn.microsoft.com/en-us/windows/ai/mcp/overview)) | Yes, as a distribution channel for our MCP server. Note that MCP bundles are not supported inside the agent session by default ([Learn](https://learn.microsoft.com/en-us/windows/ai/mcp/servers/mcp-mcpb)). Doesn't provide any GUI automation itself. |
| Agent Workspace | Separate Windows session with its own agent account and desktop, running in parallel with the user. Used by Copilot Actions. Private preview for Insiders, admin opt-in ([support article](https://support.microsoft.com/en-us/windows/ai/ai-features/experimental-agentic-features), last updated Dec 2025) | Not documented for third-party UI automation. Watch it. |
| Microsoft Execution Containers (MXC) | Policy-driven containment SDK (Rust, .NET, Node; MIT, [repo](https://github.com/microsoft/mxc)). Process isolation, session isolation, micro-VM, WSL containers. GA on Windows 11 on 2026-10-07 ([Windows blog](https://blogs.windows.com/windowsexperience/2026/10/07/building-windows-for-hybrid-intelligence/)) | Process isolation yes. Session isolation is for workloads that "need their own resources like a desktop to run automation," but the initial release supports "non-interactive sessions" only ([dev blog](https://blogs.windows.com/windowsdeveloper/2026/06/02/windows-platform-security-for-ai-agents/)). Codex already integrates MXC. |
| App Actions | Packaged apps register typed actions (JSON definitions, URI or COM `IActionProvider`) that Windows or other apps can surface ([Learn](https://learn.microsoft.com/en-us/windows/ai/app-actions/)) | Possibly as a semantic shortcut for apps that adopt it. Coverage is small, and whether arbitrary apps may invoke them without a limited-access grant is unclear [unverified]. |
| Copilot Vision, Copilot local actions | First-party Copilot features | No third-party API found. |
| Windows Sandbox CLI | `wsb start / list / exec / share / connect`, Windows 11 24H2+ ([Learn](https://learn.microsoft.com/en-us/windows/security/application-security/application-isolation/windows-sandbox/windows-sandbox-cli)) | Yes. A disposable full Windows desktop for risky tasks, scriptable from the host. |

## macOS

### AXUIElement tree reads

- No subtree bulk fetch exists. `AXUIElementCopyMultipleAttributeValues` batches attributes for one element only ([AXUIElement.h](https://github.com/phracker/MacOSX-SDKs/blob/master/MacOSX11.3.sdk/System/Library/Frameworks/ApplicationServices.framework/Versions/A/Frameworks/HIServices.framework/Versions/A/Headers/AXUIElement.h)). xa11y estimates 2 to 3 Mach IPC calls per node ([xa11y quirks](https://xa11y.dev/explanation/accessibility-quirks/)).
- Even so, glass measured 210 ms for 1,500 nodes on macOS AX, the fastest of the three platforms ([glass #280](https://github.com/fixed-width/glass/issues/280)). Hardware not stated.
- `AXUIElementSetMessagingTimeout` on the system-wide element sets a global timeout, or set it per element ([Apple docs](https://developer.apple.com/documentation/applicationservices/1459345-axuielementsetmessagingtimeout)). Use a short timeout so one hung app doesn't stall a snapshot.
- Without the Accessibility permission, queries return an empty tree, not an error ([xa11y quirks](https://xa11y.dev/explanation/accessibility-quirks/)).
- Roles are open-ended strings; there is no toggle action, so `AXPress` toggles checkboxes; coordinates are in points, not pixels.
- Wrap AX and CF calls so an `NSException` can't unwind through `extern "C"` and abort the process ([xa11y quirks](https://xa11y.dev/explanation/accessibility-quirks/)).

### AXObserver notifications

- `AXObserverCreate` plus `AXObserverAddNotification`, delivered on a CFRunLoop. The element in the callback is valid only during the callback, and many notifications such as `AXCreated` and `AXLayoutChanged` only reach element-level observers ([xa11y quirks](https://xa11y.dev/explanation/accessibility-quirks/)).
- cua found that the public `AXObserverAddNotification` isn't "remote-aware," so Blink pauses AX tree updates for occluded, hidden or off-Space windows. They call the private `_AXObserverAddNotificationAndCheckRemote`, the extra symbol Accessibility Inspector touches ([cua macOS blog](https://github.com/trycua/cua/blob/main/blog/inside-macos-window-internals.md)) [private API].
- SwiftUI windows on another Space lose accessibility detail on macOS 14+ ([cua-driver limits](https://cua.ai/docs/reference/cua-driver/limits)).

### Chromium and Electron on macOS

- Chromium turns on full accessibility when a client sets `AXEnhancedUserInterface` on the app. That flag makes AppKit animate every `AXPosition`/`AXSize` write over about 200 ms, which breaks window managers, and some tools leave it on for the app's lifetime ([Mozilla bug 1664992](https://bugzilla.mozilla.org/show_bug.cgi?id=1664992), [Hammerspoon2 #269](https://github.com/cmsj/Hammerspoon2/issues/269)).
- Electron supports `AXManualAccessibility`, which has no window side effect ([Electron accessibility docs](https://github.com/electron/electron/blob/main/docs/tutorial/accessibility.md)). Chrome itself reports it unsupported, so an open cua PR limits `AXEnhancedUserInterface` to Chromium-family and Electron bundles ([cua PR #4640](https://github.com/trycua/cua/pull/4640), open as of 2026-10-11).
- Electron reports `AXManualAccessibility` as false unless the app enabled it itself, so don't read it as "tree exists" ([agent-desktop #238](https://github.com/lahfir/agent-desktop/issues/238)).
- The tree builds asynchronously. Poll until an `AXWebArea` has children.

### Input

- `CGEventPost` goes through the HID stream, so the real cursor moves and the frontmost app gets the event.
- `CGEvent.postToPid` (macOS 10.11+) targets one process without moving the cursor. Keyboard works: "Keystrokes scoped to a specific pid land in that app's event queue and nowhere else" ([cua macOS blog](https://github.com/trycua/cua/blob/main/blog/inside-macos-window-internals.md)). Set modifier flags yourself with `CGEventSetFlags`, because the WindowServer's keyboard state isn't tracked ([MaaFramework #1550](https://github.com/MaaXYZ/MaaFramework/issues/1550)). IMEs only compose in the frontmost app.
- Mouse via `postToPid` is mostly ignored. Clicks land in AppKit apps only with window-number fields and a window-local location set, and Chromium drops them unless they carry a specific subtype, click state and window-local stamp ([cua macOS blog](https://github.com/trycua/cua/blob/main/blog/inside-macos-window-internals.md), [agent-desktop PR #227](https://github.com/lahfir/agent-desktop/pull/227)).
- What works for Chromium: the private SkyLight export `SLEventPostToPid`, plus yabai's "focus without raise" (two `SLPSPostEventRecordTo` calls) so the target is AppKit-active without changing z-order or Space. A decoy click at (-1, -1) satisfies Chromium's user-activation gate. Right clicks on Chromium web content still become left clicks ([cua macOS blog](https://github.com/trycua/cua/blob/main/blog/inside-macos-window-internals.md)) [private API].
- An Electron PR opened 2026-09-27, still unmerged, patches `acceptsFirstMouse` so clicks posted to an inactive Electron app aren't swallowed ([electron #54493](https://github.com/electron/electron/pull/54493)). Even if it lands, apps on older Electron won't have it for years.
- Canvas apps such as Blender, Unity and games need real HID events, so cua briefly activates them and the cursor warps.
- Element-indexed AX actions (`AXPress`, setting `AXValue`) work on hidden and occluded targets and should be the default.

### Capture

- ScreenCaptureKit: `SCContentFilter(desktopIndependentWindow:)` (macOS 12.3+) captures one window regardless of what covers it. `SCScreenshotManager.captureImage(contentFilter:configuration:)` (macOS 14+) does one-shot capture ([Apple docs](https://developer.apple.com/documentation/screencapturekit/scscreenshotmanager)).
- `CGWindowListCreateImage` is deprecated in macOS 14 and fails to compile against the macOS 15 SDK: "obsoleted in macOS 15.0 - Please use ScreenCaptureKit instead" ([JUCE #1414](https://github.com/juce-framework/JUCE/issues/1414), [Chromium tracking bug](https://issues.chromium.org/issues/40273487)). `CGWindowListCopyWindowInfo` is still fine for window lists.
- Calling the async screenshot API on every mouse move lags ([Apple forums](https://developer.apple.com/forums/thread/740493)). For repeated captures keep an `SCStream` per window and grab the latest frame.

### Permissions (TCC)

- Two grants: Accessibility (AX reads and all input) and Screen Recording (pixels). Without Screen Recording you still get the tree but no image ([cua-driver limits](https://cua.ai/docs/reference/cua-driver/limits)).
- macOS 15 re-prompts monthly for screen recording apps, including ScreenCaptureKit users ([9to5Mac](https://9to5mac.com/2024/08/14/macos-sequoia-screen-recording-prompt-monthly/)). The `com.apple.developer.persistent-content-capture` entitlement that avoids it is a managed capability intended for VNC-style apps ([Apple forums](https://developer.apple.com/forums/thread/761641)). MDM can set `forceBypassScreenCaptureAlert` ([Michael Tsai](https://mjtsai.com/blog/2024/08/08/sequoia-screen-recording-prompts-and-the-persistent-content-capture-entitlement/)). I found no primary source on macOS 26 changing this.
- TCC binds grants to the resolved signed binary. Grants don't follow venv symlinks or `cargo run` wrappers, and unsigned test binaries lose them on rebuild ([xa11y quirks](https://xa11y.dev/explanation/accessibility-quirks/)). Ship a signed, stable helper app bundle. Codex's own grant confusion between ChatGPT and `com.openai.sky.CUAService` shows how easy this is to get wrong ([codex #46776](https://github.com/openai/codex/issues/46776)).

### How Codex (ex-Sky) works on the Mac

- OpenAI acquired Software Applications Inc., makers of Sky, on 2025-10-23 ([OpenAI](https://openai.com/index/openai-acquires-software-applications-incorporated/)). Mac computer use shipped in the Codex app on 2026-04-16, "with its own cursor," running "in the background without taking over your computer" ([OpenAI on X](https://x.com/OpenAI/status/2044827932145897652)).
- The package on this machine lists `SkyComputerUseService`, `SkyComputerUseClient`, `CUALockScreenGuardian` and an authorization plugin under `bin/mac` [observed locally, package.json only, Mac binaries not present].
- Third-party analysis says the service uses ScreenCaptureKit, the AX tree and SkyLight private event APIs ([codex-cua-tea notes](https://github.com/vtomnet/codex-cua-tea/blob/main/SkyComputerUseService.md), [cua macOS blog](https://github.com/trycua/cua/blob/main/blog/inside-macos-window-internals.md)) [unverified by OpenAI].

## Linux

### AT-SPI2 over D-Bus

- Every `GetChildren` or property read is a D-Bus round trip, roughly 6 to 10 per node ([xa11y quirks](https://xa11y.dev/explanation/accessibility-quirks/)). glass measured 732 ms for 1,500 nodes ([glass #280](https://github.com/fixed-width/glass/issues/280)).
- The bulk path is `org.a11y.atspi.Cache.GetItems`. at-spi2-core says ATs "should try to do a bulk query of all the objects in a new window with the GetItems method, and then update them dynamically from the AddAccessible and RemoveAccessible signals." Version 2 adds a `Ready` signal ([Cache.xml](https://gitlab.gnome.org/GNOME/at-spi2-core/-/blob/main/xml/Cache.xml)). xa11y notes the cached fields are only partial, so names, states and extents still need follow-up calls.
- The accessibility bus must be on: `org.a11y.Status.IsEnabled` defaults to false in headless sessions, and `at-spi-bus-launcher` and `at-spi2-registryd` must run ([xa11y quirks](https://xa11y.dev/explanation/accessibility-quirks/)).
- Chromium and Electron on Linux show only an application-to-frame skeleton until enabled. xa11y counted VS Code 1 vs 140 nodes and Chrome 1 vs 210 with `--force-renderer-accessibility`. A cua issue reports Chromium also turns on when a client calls `GetAttributes` or `GetRelationSet` on its objects, if the bus was up before the app started ([cua #4768](https://github.com/trycua/cua/issues/4768)).
- Action names differ per toolkit: GTK `click`, Qt `Press`, Chromium `doDefault`. Chromium exposes no `EditableText`, so text entry needs keyboard synthesis.
- The longer-term direction is a push-based model, inspired by Chromium's internal architecture, where providers push trees and updates instead of being polled per call ([at-spi2-core new protocol](https://gnome.pages.gitlab.gnome.org/at-spi2-core/devel-docs/new-protocol.html)). GNOME's Wayland-native "Newton" prototype worked in 2024 ([GNOME a11y blog](https://blogs.gnome.org/a11y/2024/06/18/update-on-newton-the-wayland-native-accessibility-project/)); its current status is unclear [unverified].

### X11 input and capture

- XTest (`xdotool`, `x11rb` with the `xtest` feature) injects real input. It moves the shared pointer and goes to the focused or pointed window.
- `XSendEvent` targets a window but marks events as synthetic, and many toolkits ignore them [unverified in a primary source]. cua-driver uses AT-SPI plus `XSendEvent` for background input on X11 ([deepwiki summary](https://deepwiki.com/trycua/cua/6-agent-intelligence-system)).
- Capture with `XGetImage`/XShm or the Composite extension for per-window pixels. cua's Linux crate enables `composite`, `shm`, `xtest` and `xinput` in x11rb [observed in source].

### Wayland

- No client can know its global position, so AT-SPI `GetExtents(SCREEN)` returns window-relative values or (0,0) for GTK4 ([at-spi2-core #14](https://gitlab.gnome.org/GNOME/at-spi2-core/-/work_items/14), [GNOME wiki](https://wiki.gnome.org/Projects(2f)GTK(2f)Accessibility.html)). Window origins must come from the compositor: KWin scripts, Hyprland IPC or plugins, GNOME Shell extensions. cua-driver ships a `kwin-target-helper`, a `hyprland-plugin` and a `wayland-helper` for this [observed in source].
- Input: the RemoteDesktop portal (version 2) creates a session, the user selects devices, then `ConnectToEIS` hands back a libei socket, or you use the `NotifyPointerMotionAbsolute`/`NotifyKeyboardKeycode` methods. `persist_mode` and `restore_token` let later sessions skip the dialog ([portal XML](https://github.com/flatpak/xdg-desktop-portal/blob/main/data/org.freedesktop.portal.RemoteDesktop.xml)). libei through the portal works on GNOME and KDE but not on wlroots compositors or headless setups ([xa11y quirks](https://xa11y.dev/explanation/accessibility-quirks/)).
- Capture: the ScreenCast portal gives a PipeWire stream, again with user consent. xcap and scap both use PipeWire on Wayland [observed in source].
- Background keystrokes into fields that aren't AT-SPI-editable return `background_unavailable` in cua-driver on Sway, GNOME and KDE. Their workarounds are AT-SPI text, element actions, foreground mode, or running the app under XWayland ([cua-driver limits](https://cua.ai/docs/reference/cua-driver/limits)).
- GNOME 49 removed X11 sessions, so these limits now apply to every GNOME desktop.

### Headless setups used by benchmarks and sandboxes

| Stack | Display | Input | Capture | Tree |
| --- | --- | --- | --- | --- |
| Anthropic computer-use demo ([Dockerfile](https://github.com/anthropics/claude-quickstarts/blob/main/computer-use-demo/Dockerfile), [computer.py](https://github.com/anthropics/claude-quickstarts/blob/main/computer-use-demo/computer_use_demo/tools/computer.py)) | Xvfb, mutter, tint2, x11vnc, noVNC | xdotool, typing chunked at 12 ms per key | gnome-screenshot or scrot, then ImageMagick resize to XGA or WXGA; 2 s screenshot delay | none |
| e2b Desktop ([repo](https://github.com/e2b-dev/desktop), [template docs](https://e2b.dev/docs/template/examples/desktop)) | Xvfb, XFCE, x11vnc, noVNC | xdotool | scrot | none |
| OSWorld ([server](https://github.com/xlang-ai/OSWorld/blob/main/desktop_env/server/main.py)) | Full VMs via VMware, VirtualBox, Docker/KVM and cloud providers (AWS, Azure, GCP, e2b, Daytona and others) | pyautogui and xdotool inside the guest, behind a Flask server | pyautogui screenshot | pyatspi on Linux, pywinauto on Windows guests, ApplicationServices on macOS |

These are fine for evals and sandboxes. They say nothing about driving a user's real desktop, which is our main case.

## Background operation options

| Strategy | How | Speed | Fidelity | Disturbs the user? | Platforms | Notes |
| --- | --- | --- | --- | --- | --- | --- |
| Semantic accessibility actions | UIA patterns, `AXPress`/`AXValue`, AT-SPI `DoAction`/`SetCurrentValue` | Fast, one IPC call | High where providers are good; zero for canvases | No, if `AutoSetFocus` is false on Windows | All | Default route. Fails on custom-drawn UI and some providers lie |
| Per-window messages | `PostMessage`/`SendMessage`, X11 `XSendEvent` | Fast | Classic Win32 only; Chromium, WPF and GTK ignore clicks; keyboard state wrong | No | Windows, X11 | Good for `BM_CLICK`, `WM_SETTEXT`, `WM_PASTE` on classic controls |
| Synthetic pen or touch injection | `InjectSyntheticPointerInput` | Fast | High for clicks and drags, including Chromium; needs target visible at point | No cursor move, no foreground steal; possible click-activation | Windows 10 1809+ | Best Windows background click found. Keyboard not covered |
| Per-process event posting | `CGEventPostToPid`, private `SLEventPostToPid` + focus without raise | Fast | Keys good; clicks good with SkyLight; canvases fail | No | macOS | Private API risk on every macOS update |
| Foreground swap + real input | Raise target, `SendInput`/`CGEventPost`/XTest, restore focus | Fast but visible | Highest; same path a human uses | Yes, steals focus and cursor briefly | All | Codex's Windows Rust helper does this, hiding the real cursor and drawing a fake one |
| Virtual cursor overlay | Click-through layered window or composition visual, excluded from capture | n/a | Visual only | No | All | UX for trust and demos, not an input method |
| Separate desktop | `CreateDesktop` + `SetThreadDesktop` | Fast | Messages only cross within one desktop, and only the input desktop gets user input ([Learn](https://learn.microsoft.com/en-us/windows/win32/winstation/desktops)); WGC and SendInput behavior on non-input desktops [unverified] | No | Windows | Probably not worth it; too many apps assume one desktop |
| Separate session | Agent Workspace, MXC session isolation, RDP loopback | Medium | Full desktop | No | Windows | Agent Workspace and MXC sessions are not open for third-party GUI agents yet. RDP loopback on client SKUs is restricted [unverified] |
| Windows Sandbox | `wsb start/exec/connect` (24H2+) | Slow start, fast after | Clean Windows, not the user's apps or data | No | Windows Pro/Enterprise | Good for risky or throwaway tasks |
| VM | Hyper-V, QEMU/KVM, lume on Apple Silicon | Slow start | Full OS; not the user's environment | No | All | macOS guests are capped at 2 per Mac by license, enforced by Virtualization.framework ([lume FAQ](https://cua.ai/docs/lume/guide/getting-started/faq)) |
| Container + Xvfb | Docker with Xvfb, xdotool, VNC | Fast | Linux apps only | No | Linux (and WSL) | What e2b and Anthropic's demo use |

## Library comparison

Stars and last push are from the GitHub API on 2026-10-11.

| Library | Lang | Platforms | Covers | License | Activity | Notes |
| --- | --- | --- | --- | --- | --- | --- |
| [windows-rs](https://github.com/microsoft/windows-rs) | Rust | Windows | All Win32, COM and WinRT, including UIA and WGC | Apache-2.0 per GitHub; crates are published MIT or Apache-2.0 [unverified] | 12.8k stars, pushed 2026-10-10 | Used by Codex's helper (0.61), cua (0.58), xa11y (0.62) |
| [uiautomation](https://github.com/leexgone/uiautomation-rs) | Rust | Windows | Ergonomic UIA wrapper with cache requests, patterns, events | Apache-2.0 | 201 stars, 2026-09-04 | Used by terminator. Single maintainer |
| [Microsoft-UI-UIAutomation](https://github.com/microsoft/Microsoft-UI-UIAutomation) | C++/WinRT | Windows | Remote operations wrappers | MIT | 128 stars, 2026-09-21 | Only practical way into remote operations; needs an FFI shim from Rust |
| [windows-capture](https://github.com/NiiightmareXD/windows-capture) | Rust | Windows | WGC and DXGI capture | MIT | 514 stars, 2026-10-05 | Used by scap |
| [accessibility / accessibility-sys](https://github.com/eiz/accessibility) | Rust | macOS | AXUIElement bindings | Apache-2.0 | 91 stars, 2026-01-01 | Thin and slow-moving. cua uses objc2 and core-foundation directly |
| [objc2](https://github.com/madsmtm/objc2) family | Rust | macOS | AppKit, Foundation and other framework bindings | Permissive, varies per crate (GitHub reports NOASSERTION) | 1.1k stars, 2026-10-11 | Standard modern choice |
| [screencapturekit-rs](https://github.com/doom-fish/screencapturekit-rs) | Rust | macOS | ScreenCaptureKit, incl. SCScreenshotManager | Apache-2.0 | 242 stars, 2026-09-24 | Used by cua-driver |
| [atspi](https://github.com/odilia-app/atspi) | Rust | Linux | Pure-Rust AT-SPI2 on zbus | Apache-2.0 | 61 stars, 2026-07-27 | From the Odilia screen reader. Used by cua |
| [ashpd](https://github.com/bilelmoussaoui/ashpd) | Rust | Linux | XDG portals (ScreenCast, RemoteDesktop) | MIT | 377 stars, 2026-09-29 | |
| [reis](https://github.com/ids1024/reis) | Rust | Linux | libei/EIS protocol | MIT | 39 stars, 2026-08-19 | Used by cua for Wayland input |
| [xcap](https://github.com/nashaofu/xcap) | Rust | All | Screen and window capture | Apache-2.0 | 1.0k stars, 2026-08-25 | Windows: WGC with PrintWindow and BitBlt paths; macOS still references `CGWindowListCreateImage`; Wayland via PipeWire and libwayshot |
| [scap](https://github.com/CapSoftware/scap) | Rust | All | Streaming capture | MIT | 642 stars, 2025-08-05 | Still `0.1.0-beta.1`, no push in 14 months |
| [enigo](https://github.com/enigo-rs/enigo) | Rust | All | Synthetic keyboard and mouse | MIT | 1.8k stars, 2026-10-09 | Foreground input only. Fine for a fallback |
| [rdev](https://github.com/Narsil/rdev) | Rust | All | Global input listen and simulate | MIT | 748 stars, 2026-05-12 | Useful for the Esc kill switch hook |
| [AccessKit](https://github.com/AccessKit/accesskit) | Rust | All | Provider side, for apps exposing trees | BSD-3-Clause per GitHub | 1.5k stars, 2026-10-11 | Not a client library. Useful only if we ship our own UI |
| [nut.js](https://github.com/nut-tree/nut.js) | TS/Node | All | Input, screen, image matching | Source Apache-2.0; prebuilt packages paid | 2.9k stars, 2024-05-01 | Prebuilt packages moved to a paid registry in 2024 ([blog](https://nutjs.dev/blog/i-give-up)). Avoid |
| [pywinauto](https://github.com/pywinauto/pywinauto) | Python | Windows | UIA and Win32 backends | BSD-3 | 6.2k stars, 2026-10-11 | Good for prototyping, too slow and GIL-bound for the core |
| [Python-UIAutomation-for-Windows](https://github.com/yinkaisheng/Python-UIAutomation-for-Windows) | Python | Windows | UIA via comtypes | Apache-2.0 | 3.6k stars, 2026-06-02 | Same caveat |
| [pyautogui](https://github.com/asweigart/pyautogui) | Python | All | Foreground input and screenshots | BSD-3 | 12.7k stars, 2024-08-20 | Used by OSWorld. Unmaintained |
| [atomacos](https://github.com/daveenguyen/atomacos) | Python | macOS | AX | GPL-2.0 | archived | Don't use |
| pyatspi | Python | Linux | AT-SPI2 | LGPL [unverified] | GNOME project | Used by OSWorld |
| [FlaUI](https://github.com/FlaUI/FlaUI) | C# | Windows | UIA2 and UIA3 wrappers | MIT | 3.2k stars, 2026-08-13 | Best .NET option, Windows only |
| [robotgo](https://github.com/go-vgo/robotgo) | Go | All | Input, screen, bitmaps | Apache-2.0 | 10.9k stars, 2026-10-07 | No accessibility trees |
| [terminator](https://github.com/mediar-ai/terminator) | Rust | Windows only now | UIA engine, MCP agent, workflow recorder | MIT | 1.7k stars, last commit 2026-06-01 | README: "supports Windows only. macOS and Linux are not supported." Uses uiautomation crate with subtree cache |
| [cua-driver-rs](https://github.com/trycua/cua/tree/main/libs/cua-driver) | Rust | Windows, macOS, Linux | Full CU engine: trees, capture, background input router, overlay cursors, MCP, CLI, SDKs | MIT (optional perception extension is AGPL) | monorepo 29.4k stars, pushed 2026-10-11, v0.34.0 | Most complete open engine. About 164k lines in the platform crates |
| [xa11y](https://github.com/xa11y/xa11y) | Rust + Py/JS bindings | All | Playwright-style locators over UIA, AX, AT-SPI; input; screenshots | MIT | 80 stars, 2026-10-06, v0.15.2 | Small, clean, well-documented quirks list. Single maintainer |
| [glass](https://github.com/fixed-width/glass) | Rust | All plus Android and iOS sim | MCP server for agents testing apps they build | Apache-2.0 | 18 stars, 2026-10-11 | Good benchmarks and test discipline |
| [agent-desktop](https://github.com/lahfir/agent-desktop) | Rust | macOS focus | AX snapshots with refs, progressive skeleton traversal, C ABI | Apache-2.0 | 1.8k stars, 2026-10-06 | Claims 78 to 96 percent token reduction from shallow snapshots plus drill-down |

## Measured latencies

| Operation | Number | Source |
| --- | ---: | --- |
| UIA enumerate 12 top-level windows with cache | 32 to 66 ms | [measured here] |
| UIA subtree read, 19 to 67 nodes, 5 properties, cached | 7 to 21 ms | [measured here], .NET client |
| UIA 1,500 nodes, cached | 977 to 2,332 ms | [glass PR #593](https://github.com/fixed-width/glass/pull/593) |
| macOS AX 1,500 nodes | 210 ms | [glass #280](https://github.com/fixed-width/glass/issues/280) |
| AT-SPI 1,500 nodes | 732 ms | [glass #280](https://github.com/fixed-width/glass/issues/280) |
| WGC warm frame read, browser window about 1.7 MP | 1.1 to 1.3 ms | [grabwin](https://github.com/semetronix/grabwin) |
| WGC warm frame read, 2560x1440 | 2.7 to 4.6 ms | [grabwin](https://github.com/semetronix/grabwin) |
| WGC GPU to CPU copy | 0.8 to 1.8 ms | [winrt_demo](https://github.com/karwan5880/winrt_demo) [unverified, secondary] |
| PrintWindow `PW_RENDERFULLCONTENT`, one window | 39.5 to 53.3 ms | [measured here] |
| Screen BitBlt, 3420x2149 | 49 ms | [measured here] |
| PNG encode, 3420x2149 | 97.5 ms | [measured here] |
| JPEG q80 encode, 3420x2149 | 12.8 ms | [measured here] |
| Downscale to 1280 wide + JPEG q80 | 20.1 ms | [measured here] |
| Codex WGC first-frame wait | 1,000 ms timeout | [codex #25178](https://github.com/openai/codex/issues/25178) trace |
| Input injection round trip | not measured | Needs a probe that sends input, which I avoided on the user's live desktop |

The probe source is at `/tmp/uiabench/bench.cs` until /tmp is cleared. It used the .NET Framework UIA client, not the COM client, so treat those numbers as an upper bound for small trees.

## Implications for our project

### Recommended native-core architecture

1. **Rust core, one daemon per interactive user session.** The MCP server (stdio) can start anywhere and forwards to the daemon over a named pipe on Windows or a Unix socket elsewhere. Both Codex and cua-driver landed on this because Session 0, SSH and service contexts see no desktop. Verify the client's identity on the pipe, as Codex does with `WinVerifyTrust`.
2. **Platform crates behind one typed contract.** `platform-windows` on windows-rs, `platform-macos` on objc2 and core-foundation, `platform-linux` on atspi, zbus, x11rb, ashpd and reis. The contract has window list, window state (tree plus optional screenshot), element actions and coordinate actions, with explicit `delivery: background | foreground` like cua-driver.
3. **Snapshot model built for speed.**
   - Scope every snapshot to one window. Cap nodes and depth, and report truncation honestly.
   - Windows: one `FindAllBuildCache` or `BuildUpdatedCache` with only the properties we render, raw view where the control view drops fragments, `AutoSetFocus = false`, short connection and transaction timeouts with our own wall-clock budget.
   - Keep element indexes stable across snapshots by keying on runtime IDs (UIA), `(bus_name, path)` (AT-SPI) or tree paths (AX).
   - Invalidate from WinEvents, UIA structure events, AXObserver and AT-SPI signals, and re-fetch only dirty subtrees.
   - Offer a shallow "skeleton" mode with drill-down, which agent-desktop reports saves 78 to 96 percent of tokens.
4. **Chromium handling as a first-class path.** Detect Chromium and Electron windows by class, framework or bundle, read a web-content property to trigger activation, poll for the document with a deadline, and route real browsers through CDP when we launched them.
5. **Per-window capture with long-lived sessions.** WGC on Windows with feature-detected `IsBorderRequired` and `IncludeSecondaryWindows`, an `SCStream` or `SCScreenshotManager` per window on macOS, PipeWire on Wayland, XShm or Composite on X11. Fall back to PrintWindow, then to a screen crop that is clearly marked as possibly occluded. Downscale and encode JPEG or WebP off the capture thread.
6. **Action router, most semantic first.** Accessibility pattern, then background coordinate input (Windows pen injection, macOS per-pid or SkyLight, X11 `XSendEvent` or AT-SPI), then an explicit foreground escalation the agent must opt into. Return `background_unavailable` instead of silently stealing focus.
7. **Visible trust UI.** A click-through overlay with an agent cursor and a status pill, excluded from capture (`WDA_EXCLUDEFROMCAPTURE`, or SCK's excluded windows), plus an Esc kill switch on a low-level keyboard hook. Refuse elevated targets by default.
8. **Every action returns evidence.** Post-action state or a diff, so the agent can verify without another full screenshot.

### Fork or build

My view: start by forking or vendoring **cua-driver-rs**. It is MIT, already covers the three OSes with a background-first router, has the pen-injection and SkyLight work done, and speaks MCP. The costs are its size, its product scope (perception extension, history, recording) and a fast-moving upstream. If its contract feels too heavy after a week of benchmarking, the lean path is our own core using xa11y-style tree code plus windows-capture and screencapturekit-rs, copying cua's input techniques.

terminator is now Windows-only and its last commit was 2026-06-01, so it's a reference, not a base. Python and Node are fine for test harnesses but not for the core: per-call overhead and the GIL hurt exactly where we're already IPC-bound.

### Where the speed will come from, in order

1. Not taking full snapshots: window scope, node caps, skeleton views, event-driven invalidation.
2. One bulk fetch per snapshot (UIA cache request, AT-SPI `GetItems`).
3. UIA remote operations for hot paths like hit-testing and pruned walks, if a prototype shows a real gain.
4. Warm capture sessions and cheap encoding, which saves around 80 ms per screenshot versus PNG at 4K.
5. Semantic actions, which skip the screenshot-click-screenshot loop entirely.

## Open questions

- How much do UIA remote operations actually save on a large Electron or WinUI tree? Needs a prototype against VS Code and Settings.
- What is WGC's cold start to first frame per window, and how many concurrent capture sessions are cheap enough to keep warm?
- Does synthetic pen injection have side effects we'd regret: pen cursor feedback, the touch keyboard, Windows Ink, or apps that behave differently for pen?
- Is there any reliable background keyboard path for Chromium on Windows, short of CDP or focus swapping? Codex's Swift build seems to try `SetKeyboardState` plus posted messages; how well that works is unknown.
- Will Agent Workspace or MXC session isolation open interactive desktops to third-party agents, and on what timeline? That could make "run in a parallel session" the cleanest Windows answer.
- How stable are the macOS SkyLight private APIs across macOS 26.x, and do they risk notarization or Gatekeeper problems?
- Can a Wayland portal session be made unattended for agents, with `persist_mode` and restore tokens, on GNOME and KDE?
- Why does Chromium keep an occluded window's web tree empty, and can a UIA client keep it alive without raising the window?
- Is it legally fine to use what we learned from Codex's binaries? I only read import tables and strings, but the team should decide how much of that to rely on.
