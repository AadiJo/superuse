//! Asynchronous activation for windows that run a classic Win32 message loop.
//!
//! WinForms, MFC, dialog-manager and plain Win32 UIA providers run a control's
//! click handler inside `InvokePattern.Invoke()`. When that handler opens a
//! modal dialog, Invoke does not return until the dialog closes, and the app's
//! provider stops answering meanwhile, so the new dialog's tree reads as empty.
//! `uia::invoke`'s deadline only frees the driver; the app stays stuck.
//!
//! For those windows the driver posts the click as window messages instead.
//! The handler then runs from the app's own message loop, like a real click,
//! and no UIA call is left outstanding inside the app:
//! - a real button window (Win32 `Button`, WinForms `BUTTON`): `BM_CLICK`;
//! - anything else (ToolStrip/MenuStrip items, owner-drawn controls, tabs,
//!   links): `WM_LBUTTONDOWN`/`WM_LBUTTONUP` at the element's centre, posted to
//!   the window that owns that point.
//!
//! UWP/WinUI/XAML, WPF and Chromium hosts keep UIA Invoke (with the deadline
//! backstop): they ignore posted mouse input or do not block inside Invoke.

use std::time::{Duration, Instant};

use windows::Win32::Foundation::{BOOL, HWND, LPARAM, RECT, TRUE, WPARAM};
use windows::Win32::System::Com::{
    CoCreateInstance, CoInitializeEx, CLSCTX_INPROC_SERVER, COINIT_MULTITHREADED,
};
use windows::Win32::UI::Accessibility::{
    CUIAutomation, ExpandCollapseState_LeafNode, IUIAutomation, IUIAutomationElement,
    IUIAutomationExpandCollapsePattern, UIA_ButtonControlTypeId, UIA_ExpandCollapsePatternId,
    UIA_HyperlinkControlTypeId, UIA_MenuItemControlTypeId, UIA_SplitButtonControlTypeId,
    UIA_TabItemControlTypeId, UIA_CONTROLTYPE_ID,
};
use windows::Win32::UI::WindowsAndMessaging::{
    EnumWindows, GetAncestor, GetWindowRect, GetWindowThreadProcessId, IsWindowVisible,
    PostMessageW, BM_CLICK, GA_ROOT,
};

use windows::core::Interface;

/// How [`post_activation`] delivered a click.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum PostedActivation {
    /// `BM_CLICK` posted to the button's own window.
    ButtonClick { hwnd: u64 },
    /// `WM_LBUTTONDOWN`/`UP` posted at screen (`x`, `y`) inside `hwnd`.
    MouseClick { hwnd: u64, x: i32, y: i32 },
}

impl PostedActivation {
    /// Short phrase for tool text, e.g. "posted BM_CLICK to button window 0x1a2b".
    pub(crate) fn describe(&self) -> String {
        match *self {
            Self::ButtonClick { hwnd } => format!("posted BM_CLICK to button window 0x{hwnd:x}"),
            Self::MouseClick { hwnd, x, y } => format!(
                "posted WM_LBUTTONDOWN/UP at screen ({x},{y}) to window 0x{hwnd:x}"
            ),
        }
    }
}

/// Window classes whose controls run on a classic Win32 message loop and
/// handle posted clicks: WinForms, dialogs, MFC and the standard controls.
fn is_classic_class(class: &str) -> bool {
    const PREFIXES: &[&str] = &["WindowsForms10.", "Afx", "#32770"];
    const CONTROLS: &[&str] = &[
        "Button",
        "Static",
        "Edit",
        "ComboBox",
        "ListBox",
        "SysLink",
        "SysTabControl32",
        "SysListView32",
        "SysTreeView32",
        "SysHeader32",
        "ToolbarWindow32",
        "ReBarWindow32",
        "msctls_statusbar32",
    ];
    PREFIXES.iter().any(|prefix| class.starts_with(prefix))
        || CONTROLS.iter().any(|name| class.eq_ignore_ascii_case(name))
}

/// Top-level hosts that must keep UIA Invoke even when a classic-looking
/// child window owns the element.
fn is_modern_host(root: u64) -> bool {
    crate::input::is_xaml_host_hwnd(root)
        || crate::input::is_chromium_target_window(root)
        || crate::input::delivery::is_wpf_target_window(root)
        || crate::input::delivery::is_winui3_target_window(root)
}

/// True when `hwnd` (the window that owns an element) runs a classic message
/// loop: its own class is a classic one and its top-level window is not a
/// UWP/WinUI/XAML, WPF or Chromium host.
pub(crate) fn is_classic_window(hwnd: u64) -> bool {
    if hwnd == 0 {
        return false;
    }
    let root = unsafe { GetAncestor(HWND(hwnd as *mut _), GA_ROOT) };
    let root = if root.0.is_null() { hwnd } else { root.0 as u64 };
    is_classic_class(&crate::input::delivery::read_class_name(hwnd)) && !is_modern_host(root)
}

fn is_activation_control(control_type: UIA_CONTROLTYPE_ID) -> bool {
    [
        UIA_ButtonControlTypeId,
        UIA_MenuItemControlTypeId,
        UIA_SplitButtonControlTypeId,
        UIA_HyperlinkControlTypeId,
        UIA_TabItemControlTypeId,
    ]
    .contains(&control_type)
}

/// A menu item that opens a submenu is expanded, not activated; only leaves
/// (and controls without ExpandCollapse) take the posted-click route.
unsafe fn is_submenu_parent(elem: &IUIAutomationElement) -> bool {
    elem.GetCurrentPattern(UIA_ExpandCollapsePatternId)
        .ok()
        .and_then(|pattern| pattern.cast::<IUIAutomationExpandCollapsePattern>().ok())
        .and_then(|pattern| pattern.CurrentExpandCollapseState().ok())
        .is_some_and(|state| state != ExpandCollapseState_LeafNode)
}

fn is_button_class(class: &str) -> bool {
    class.eq_ignore_ascii_case("Button")
        || class.to_ascii_lowercase().starts_with("windowsforms10.button.")
}

fn rect_contains(rect: &RECT, x: i32, y: i32) -> bool {
    x >= rect.left && x < rect.right && y >= rect.top && y < rect.bottom
}

/// Nearest window handle on `elem` or its UIA ancestors.
unsafe fn nearest_native_window(elem: &IUIAutomationElement) -> Option<HWND> {
    let uia: IUIAutomation = CoCreateInstance(&CUIAutomation, None, CLSCTX_INPROC_SERVER).ok()?;
    let walker = uia.RawViewWalker().ok()?;
    let mut current = elem.clone();
    for _ in 0..32 {
        if let Ok(hwnd) = current.CurrentNativeWindowHandle() {
            if !hwnd.0.is_null() {
                return Some(hwnd);
            }
        }
        current = walker.GetParentElement(&current).ok()?;
    }
    None
}

/// Topmost visible top-level window of `pid` whose rectangle contains the
/// point. Used when the element's nearest window does not cover its own
/// centre, e.g. a ToolStrip drop-down item whose UIA parent is the menu bar
/// while it is drawn in a separate popup window.
fn topmost_window_of_pid_at(pid: u32, x: i32, y: i32) -> Option<HWND> {
    struct Search {
        pid: u32,
        point: (i32, i32),
        found: Option<HWND>,
    }
    unsafe extern "system" fn visit(hwnd: HWND, lparam: LPARAM) -> BOOL {
        let search = &mut *(lparam.0 as *mut Search);
        let mut owner = 0_u32;
        GetWindowThreadProcessId(hwnd, Some(&mut owner));
        if owner == search.pid && IsWindowVisible(hwnd).as_bool() {
            let mut rect = RECT::default();
            if GetWindowRect(hwnd, &mut rect).is_ok()
                && rect_contains(&rect, search.point.0, search.point.1)
            {
                search.found = Some(hwnd);
                return BOOL(0);
            }
        }
        TRUE
    }
    let mut search = Search { pid, point: (x, y), found: None };
    unsafe {
        // EnumWindows walks top-level windows in z-order, topmost first.
        let _ = EnumWindows(Some(visit), LPARAM(&mut search as *mut Search as isize));
    }
    search.found
}

/// Decide whether `elem`'s activation should be posted as window messages:
/// it is an activation-type control (button, leaf menu item, link, tab) in a
/// window with a classic message loop. `point` overrides where a mouse click
/// lands (a pixel click's own coordinates); otherwise it is the element's
/// centre. Sends nothing; `None` means the caller keeps its UIA path.
pub(crate) unsafe fn activation_target(
    elem: &IUIAutomationElement,
    point: Option<(i32, i32)>,
) -> Option<PostedActivation> {
    // Callers run on tokio blocking workers that may never have joined COM;
    // there CoCreateInstance fails with CO_E_NOTINITIALIZED and the caller
    // silently took its fallback route. Fire and forget, never uninitialized
    // (the crate convention, see `uia::scroll`).
    let _ = CoInitializeEx(None, COINIT_MULTITHREADED);
    let control_type = elem.CurrentControlType().ok()?;
    if !is_activation_control(control_type) || is_submenu_parent(elem) {
        return None;
    }
    posted_click_target(elem, point)
}

/// Where a posted click on `elem` goes, for any control type (the menu walk
/// also opens submenus this way). `None` when the element's window is not
/// classic or the element has no on-screen rectangle, e.g. an item of a
/// closed drop-down.
pub(crate) unsafe fn posted_click_target(
    elem: &IUIAutomationElement,
    point: Option<(i32, i32)>,
) -> Option<PostedActivation> {
    // Join the MTA first, as in `activation_target`.
    let _ = CoInitializeEx(None, COINIT_MULTITHREADED);
    let owner = nearest_native_window(elem)?;
    if !is_classic_window(owner.0 as u64) {
        return None;
    }
    let own = elem.CurrentNativeWindowHandle().ok().filter(|h| !h.0.is_null());
    if let Some(button) =
        own.filter(|h| is_button_class(&crate::input::delivery::read_class_name(h.0 as u64)))
    {
        return Some(PostedActivation::ButtonClick { hwnd: button.0 as u64 });
    }
    let (x, y) = match point {
        Some(point) => point,
        None => {
            let rect = elem.CurrentBoundingRectangle().ok()?;
            if rect.right <= rect.left || rect.bottom <= rect.top {
                return None;
            }
            ((rect.left + rect.right) / 2, (rect.top + rect.bottom) / 2)
        }
    };
    let mut owner_rect = RECT::default();
    let target = if GetWindowRect(owner, &mut owner_rect).is_ok()
        && rect_contains(&owner_rect, x, y)
    {
        owner
    } else {
        let pid = elem.CurrentProcessId().ok()? as u32;
        let popup = topmost_window_of_pid_at(pid, x, y)?;
        if !is_classic_window(popup.0 as u64) {
            return None;
        }
        popup
    };
    Some(PostedActivation::MouseClick { hwnd: target.0 as u64, x, y })
}

impl PostedActivation {
    /// Post the click. `Err` means no message went out (for example UIPI),
    /// so the caller may still fall back to UIA.
    pub(crate) fn post(self) -> anyhow::Result<Self> {
        match self {
            Self::ButtonClick { hwnd } => {
                if let Some(message) = crate::input::post_message_blocked_by_uipi(hwnd) {
                    anyhow::bail!(message);
                }
                unsafe { PostMessageW(HWND(hwnd as *mut _), BM_CLICK, WPARAM(0), LPARAM(0)) }
                    .map_err(|error| anyhow::anyhow!("PostMessage(BM_CLICK): {error}"))?;
            }
            Self::MouseClick { hwnd, x, y } => {
                crate::input::post_left_click_screen_now(hwnd, x, y)?;
            }
        }
        Ok(self)
    }
}

/// A titled top-level window, as reported after an asynchronous activation.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct TitledWindow {
    pub window_id: u64,
    pub title: String,
}

/// What changed in a process's titled top-level windows.
#[derive(Clone, Debug, Default)]
pub struct WindowChanges {
    pub opened: Vec<TitledWindow>,
    pub closed: Vec<TitledWindow>,
}

impl WindowChanges {
    /// One sentence for tool text, empty when nothing changed.
    pub(crate) fn sentence(&self, pid: u32) -> String {
        let list = |windows: &[TitledWindow]| {
            windows
                .iter()
                .map(|w| format!("window_id {} \"{}\"", w.window_id, w.title))
                .collect::<Vec<_>>()
                .join(", ")
        };
        let mut parts = Vec::new();
        if !self.opened.is_empty() {
            parts.push(format!("New window(s) of pid {pid}: {}.", list(&self.opened)));
        }
        if !self.closed.is_empty() {
            parts.push(format!("Closed: {}.", list(&self.closed)));
        }
        if parts.is_empty() {
            format!(
                "No window of pid {pid} opened or closed within {} ms.",
                SETTLE.as_millis()
            )
        } else {
            parts.join(" ")
        }
    }

    pub(crate) fn json(&self) -> serde_json::Value {
        let rows = |windows: &[TitledWindow]| {
            windows
                .iter()
                .map(|w| serde_json::json!({ "window_id": w.window_id, "title": w.title }))
                .collect::<Vec<_>>()
        };
        serde_json::json!({ "opened": rows(&self.opened), "closed": rows(&self.closed) })
    }
}

/// How long a posted activation waits for a window to open or close.
pub(crate) const SETTLE: Duration = Duration::from_millis(400);

fn titled_windows(pid: u32) -> Vec<TitledWindow> {
    crate::win32::list_windows_via_win32(Some(pid))
        .into_iter()
        .map(|w| TitledWindow { window_id: w.hwnd, title: w.title })
        .collect()
}

/// Snapshot of `pid`'s titled windows, taken before an activation is posted.
/// [`WindowWatch::settle`] then reports what the activation opened or closed,
/// so the caller can name a new dialog without another tool call.
pub(crate) struct WindowWatch {
    pid: u32,
    before: Vec<TitledWindow>,
}

impl WindowWatch {
    pub(crate) fn start(pid: u32) -> Self {
        Self { pid, before: titled_windows(pid) }
    }

    /// Poll until a window of the pid opens or closes, at most [`SETTLE`].
    pub(crate) fn settle(&self) -> WindowChanges {
        let deadline = Instant::now() + SETTLE;
        loop {
            let now = titled_windows(self.pid);
            let changes = WindowChanges {
                opened: now
                    .iter()
                    .filter(|w| !self.before.iter().any(|b| b.window_id == w.window_id))
                    .cloned()
                    .collect(),
                closed: self
                    .before
                    .iter()
                    .filter(|b| !now.iter().any(|w| w.window_id == b.window_id))
                    .cloned()
                    .collect(),
            };
            if !changes.opened.is_empty() || !changes.closed.is_empty() || Instant::now() >= deadline
            {
                return changes;
            }
            std::thread::sleep(Duration::from_millis(15));
        }
    }
}
