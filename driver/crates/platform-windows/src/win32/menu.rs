//! Win32 menu bars (`HMENU`) driven without opening them.
//!
//! A Win32 menu bar only opens for the active window, so walking it through
//! UIA means activating the target. Its items are plain data instead: find the
//! path by item text and post the notification clicking the item would send:
//! `WM_COMMAND` with the item id, or `WM_MENUCOMMAND` with its position and
//! menu when the menu bar has the `MNS_NOTIFYBYPOS` style. No activation, no
//! menu on screen, and a command that opens a modal dialog runs from the app's
//! own message loop.

use windows::Win32::Foundation::{HWND, LPARAM, WPARAM};
use windows::Win32::UI::WindowsAndMessaging::{
    GetMenu, GetMenuInfo, GetMenuItemCount, GetMenuItemInfoW, PostMessageW, HMENU, MENUINFO,
    MENUITEMINFOW, MFS_DISABLED, MFT_SEPARATOR, MIIM_FTYPE, MIIM_ID, MIIM_STATE, MIIM_STRING,
    MIIM_SUBMENU, MIM_STYLE, MNS_NOTIFYBYPOS, WM_COMMAND, WM_MENUCOMMAND,
};

/// Item text as UIA names it: `&` mnemonics removed (`&&` is a literal `&`),
/// the accelerator after a tab dropped.
fn display_text(raw: &str) -> String {
    let label = raw.split('\t').next().unwrap_or_default();
    let mut out = String::with_capacity(label.len());
    let mut chars = label.chars().peekable();
    while let Some(ch) = chars.next() {
        if ch == '&' {
            if chars.peek() == Some(&'&') {
                out.push('&');
                chars.next();
            }
            continue;
        }
        out.push(ch);
    }
    out.trim().to_owned()
}

struct Item {
    text: String,
    id: u32,
    /// Index in its menu, separators included (what `WM_MENUCOMMAND` sends).
    position: u32,
    submenu: HMENU,
    enabled: bool,
}

unsafe fn items(menu: HMENU) -> Vec<Item> {
    let count = GetMenuItemCount(menu);
    (0..count.max(0) as u32)
        .filter_map(|position| {
            let mut buf = [0u16; 256];
            let mut info = MENUITEMINFOW {
                cbSize: std::mem::size_of::<MENUITEMINFOW>() as u32,
                fMask: MIIM_STRING | MIIM_ID | MIIM_SUBMENU | MIIM_STATE | MIIM_FTYPE,
                dwTypeData: windows::core::PWSTR(buf.as_mut_ptr()),
                cch: buf.len() as u32,
                ..Default::default()
            };
            GetMenuItemInfoW(menu, position, true, &mut info).ok()?;
            if (info.fType & MFT_SEPARATOR).0 != 0 || info.cch == 0 {
                return None; // separators and owner-drawn items have no text
            }
            Some(Item {
                text: display_text(&String::from_utf16_lossy(&buf[..info.cch as usize])),
                id: info.wID,
                position,
                submenu: info.hSubMenu,
                enabled: (info.fState & MFS_DISABLED).0 == 0,
            })
        })
        .collect()
}

/// Why [`resolve_command`] found no command to post.
#[derive(Debug)]
pub enum MenuMiss {
    /// The window has no Win32 menu bar.
    NoMenuBar,
    /// The path does not resolve uniquely to an enabled command in the static
    /// menu, for example a submenu the app fills in only when it opens. Says
    /// which segment failed and why.
    Unresolved(String),
}

/// An enabled leaf item of a window's Win32 menu bar, as [`post_command`]
/// needs it.
#[derive(Clone, Copy, Debug)]
pub struct MenuCommand {
    id: u32,
    position: u32,
    /// The menu holding the item, as an integer so the value is `Send`.
    menu: isize,
}

/// The enabled leaf item at `path` in `hwnd`'s menu bar.
/// On a miss the caller walks the menu through UIA, which needs the window
/// active when it has a Win32 menu bar.
pub fn resolve_command(hwnd: u64, path: &[String]) -> Result<MenuCommand, MenuMiss> {
    let mut menu = unsafe { GetMenu(HWND(hwnd as *mut _)) };
    if menu.0.is_null() {
        return Err(MenuMiss::NoMenuBar);
    }
    let unresolved = |problem: String| Err(MenuMiss::Unresolved(problem));
    let mut parent = "the menu bar".to_owned();
    for (depth, segment) in path.iter().enumerate() {
        if menu.0.is_null() {
            return unresolved(format!("{parent} has no submenu"));
        }
        let items = unsafe { items(menu) };
        let mut matching = items.iter().filter(|item| item.text == *segment);
        let Some(item) = matching.next() else {
            let names: Vec<&str> = items.iter().map(|item| item.text.as_str()).collect();
            return unresolved(format!(
                "\"{segment}\" is not an item of {parent} (items: {})",
                names.join(", ")
            ));
        };
        if matching.next().is_some() {
            return unresolved(format!(
                "\"{segment}\" names more than one item of {parent}"
            ));
        }
        if !item.enabled {
            return unresolved(format!("\"{segment}\" is disabled"));
        }
        let last = depth + 1 == path.len();
        match (last, item.submenu.0.is_null()) {
            (true, true) => {
                return Ok(MenuCommand {
                    id: item.id,
                    position: item.position,
                    menu: menu.0 as isize,
                })
            }
            (true, false) => return unresolved(format!("\"{segment}\" opens a submenu")),
            (false, _) => {
                menu = item.submenu;
                parent = format!("\"{segment}\"");
            }
        }
    }
    unresolved("the path is empty".to_owned())
}

/// The notification [`post_command`] posted.
#[derive(Clone, Copy, Debug)]
pub enum MenuNotification {
    /// `WM_COMMAND` with the item id.
    Command(u32),
    /// `WM_MENUCOMMAND` with the item's position in its menu.
    ByPosition(u32),
}

impl MenuNotification {
    /// Short phrase for tool text, e.g. "WM_COMMAND (id 4)".
    pub fn describe(self) -> String {
        match self {
            Self::Command(id) => format!("WM_COMMAND (id {id})"),
            Self::ByPosition(position) => format!("WM_MENUCOMMAND (position {position})"),
        }
    }
}

/// Whether the menu bar has `MNS_NOTIFYBYPOS`: its owner then expects
/// `WM_MENUCOMMAND` (item position and menu) and may not handle
/// `WM_COMMAND`, whose item ids such menus often leave unset. The style is
/// set on the menu bar and applies to its whole menu.
fn notifies_by_position(bar: HMENU) -> bool {
    let mut info = MENUINFO {
        cbSize: std::mem::size_of::<MENUINFO>() as u32,
        fMask: MIM_STYLE,
        ..Default::default()
    };
    unsafe { GetMenuInfo(bar, &mut info) }.is_ok() && (info.dwStyle.0 & MNS_NOTIFYBYPOS.0) != 0
}

/// Post `command` to `hwnd` the way a click on the item would notify it.
pub fn post_command(hwnd: u64, command: MenuCommand) -> anyhow::Result<MenuNotification> {
    if let Some(message) = crate::input::post_message_blocked_by_uipi(hwnd) {
        anyhow::bail!(message);
    }
    let window = HWND(hwnd as *mut _);
    let (notification, message, wparam, lparam) =
        if notifies_by_position(unsafe { GetMenu(window) }) {
            (
                MenuNotification::ByPosition(command.position),
                WM_MENUCOMMAND,
                WPARAM(command.position as usize),
                LPARAM(command.menu),
            )
        } else {
            // wParam: high word 0 (sent by a menu), low word the item id.
            (
                MenuNotification::Command(command.id),
                WM_COMMAND,
                WPARAM(command.id as usize & 0xffff),
                LPARAM(0),
            )
        };
    unsafe { PostMessageW(window, message, wparam, lparam) }
        .map_err(|error| anyhow::anyhow!("PostMessage({}): {error}", notification.describe()))?;
    Ok(notification)
}
