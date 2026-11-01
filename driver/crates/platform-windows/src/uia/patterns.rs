//! Element actions through UIA control patterns, for hosts that drop posted
//! mouse input.
//!
//! Chromium (Edge, Chrome, Electron) ignores posted `WM_LBUTTONDOWN`/`UP`, and a
//! `<select>` popup is a separate window that a posted click never reaches.
//! Chromium does implement the UIA patterns, so an element click goes through
//! the one that matches the element's role, and a `<select>` value is chosen
//! by expanding it and selecting the option.

use std::time::{Duration, Instant};

use windows::core::{Interface, BSTR};
use windows::Win32::System::Com::{
    CoCreateInstance, CoInitializeEx, CLSCTX_INPROC_SERVER, COINIT_MULTITHREADED,
};
use windows::Win32::UI::Accessibility::{
    CUIAutomation, ExpandCollapseState_Collapsed, ExpandCollapseState_Expanded, IUIAutomation,
    IUIAutomationElement, IUIAutomationExpandCollapsePattern, IUIAutomationInvokePattern,
    IUIAutomationSelectionItemPattern, IUIAutomationTogglePattern, IUIAutomationValuePattern,
    TreeScope_Descendants, UIA_CheckBoxControlTypeId, UIA_ComboBoxControlTypeId,
    UIA_ControlTypePropertyId, UIA_DataItemControlTypeId, UIA_ExpandCollapsePatternId,
    UIA_InvokePatternId, UIA_ListItemControlTypeId, UIA_RadioButtonControlTypeId,
    UIA_SelectionItemPatternId, UIA_TabItemControlTypeId, UIA_TogglePatternId,
    UIA_TreeItemControlTypeId, UIA_ValuePatternId, UIA_CONTROLTYPE_ID, UIA_PATTERN_ID,
};

use super::fg_bypass::run_with_uwp_bypass;
use super::invoke::{invoke_with_deadline, InvokeOutcome};

/// A UIA pattern action used as a click.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(crate) enum PatternAction {
    Invoke,
    Toggle,
    Select,
    Expand,
}

impl PatternAction {
    pub(crate) fn name(self) -> &'static str {
        match self {
            Self::Invoke => "InvokePattern.Invoke",
            Self::Toggle => "TogglePattern.Toggle",
            Self::Select => "SelectionItemPattern.Select",
            Self::Expand => "ExpandCollapsePattern.Expand",
        }
    }

    pub(crate) fn transport(self) -> cua_driver_core::action_record::ActionTransport {
        use cua_driver_core::action_record::ActionTransport;
        match self {
            Self::Invoke => ActionTransport::WindowsUiaInvoke,
            Self::Toggle => ActionTransport::WindowsUiaToggle,
            Self::Select => ActionTransport::WindowsUiaSelection,
            Self::Expand => ActionTransport::WindowsUiaExpandCollapse,
        }
    }

    fn pattern_id(self) -> UIA_PATTERN_ID {
        match self {
            Self::Invoke => UIA_InvokePatternId,
            Self::Toggle => UIA_TogglePatternId,
            Self::Select => UIA_SelectionItemPatternId,
            Self::Expand => UIA_ExpandCollapsePatternId,
        }
    }
}

/// Patterns to try for a click, in order. An explicit `action`
/// ("invoke" / "toggle" / "select") allows only that pattern; otherwise the
/// element's role picks the order: options, tabs and radios select,
/// checkboxes toggle, combo boxes expand, everything else invokes.
fn click_order(control_type: UIA_CONTROLTYPE_ID, action: Option<&str>) -> &'static [PatternAction] {
    use PatternAction::*;
    match action {
        Some("invoke") => return &[Invoke],
        Some("toggle") => return &[Toggle],
        Some("select") => return &[Select],
        _ => {}
    }
    if [
        UIA_ListItemControlTypeId,
        UIA_TreeItemControlTypeId,
        UIA_TabItemControlTypeId,
        UIA_RadioButtonControlTypeId,
        UIA_DataItemControlTypeId,
    ]
    .contains(&control_type)
    {
        &[Select, Invoke, Toggle, Expand]
    } else if control_type == UIA_CheckBoxControlTypeId {
        &[Toggle, Invoke, Select]
    } else if control_type == UIA_ComboBoxControlTypeId {
        &[Expand, Invoke]
    } else {
        &[Invoke, Toggle, Select, Expand]
    }
}

/// Run one pattern action on `elem`, shielded against the host stealing
/// foreground. `Ok(None)` means the element does not expose that pattern.
unsafe fn run_action(
    elem: &IUIAutomationElement,
    host_hwnd: isize,
    action: PatternAction,
) -> windows::core::Result<Option<InvokeOutcome>> {
    let Ok(pattern) = elem.GetCurrentPattern(action.pattern_id()) else {
        return Ok(None);
    };
    let returned = |r: windows::core::Result<()>| r.map(|()| Some(InvokeOutcome::Returned));
    match action {
        PatternAction::Invoke => match pattern.cast::<IUIAutomationInvokePattern>() {
            // The deadline is a backstop for a provider that blocks in Invoke.
            Ok(p) => run_with_uwp_bypass(host_hwnd, || invoke_with_deadline(&p)).map(Some),
            Err(_) => Ok(None),
        },
        PatternAction::Toggle => match pattern.cast::<IUIAutomationTogglePattern>() {
            Ok(p) => returned(run_with_uwp_bypass(host_hwnd, || p.Toggle())),
            Err(_) => Ok(None),
        },
        PatternAction::Select => match pattern.cast::<IUIAutomationSelectionItemPattern>() {
            Ok(p) => returned(run_with_uwp_bypass(host_hwnd, || p.Select())),
            Err(_) => Ok(None),
        },
        PatternAction::Expand => match pattern.cast::<IUIAutomationExpandCollapsePattern>() {
            Ok(p) => returned(run_with_uwp_bypass(host_hwnd, || p.Expand())),
            Err(_) => Ok(None),
        },
    }
}

/// Click `elem` through the first pattern in [`click_order`] it exposes.
/// `Ok(None)`: no applicable pattern, nothing was sent. `Err`: every exposed
/// pattern failed (the last error is returned).
pub(crate) unsafe fn pattern_click(
    elem: &IUIAutomationElement,
    host_hwnd: isize,
    action: Option<&str>,
) -> anyhow::Result<Option<(PatternAction, InvokeOutcome)>> {
    // Join the MTA first, as in `activate::activation_target`.
    let _ = CoInitializeEx(None, COINIT_MULTITHREADED);
    let control_type = elem.CurrentControlType().unwrap_or_default();
    let mut last_error = None;
    for &candidate in click_order(control_type, action) {
        match run_action(elem, host_hwnd, candidate) {
            Ok(Some(outcome)) => {
                if candidate == PatternAction::Select && control_type == UIA_ListItemControlTypeId {
                    collapse_owning_combo(elem, host_hwnd);
                }
                return Ok(Some((candidate, outcome)));
            }
            Ok(None) => {}
            Err(error) => {
                tracing::debug!(target: "click", "{} failed: {error}", candidate.name());
                last_error = Some(anyhow::anyhow!("{}: {error}", candidate.name()));
            }
        }
    }
    match last_error {
        Some(error) => Err(error),
        None => Ok(None),
    }
}

/// A user's click on an option closes its drop-down; `Select` does not, and
/// an open Chromium `<select>` popup then refuses the next Expand. Collapse
/// the nearest ComboBox ancestor if it is still expanded.
unsafe fn collapse_owning_combo(option: &IUIAutomationElement, host_hwnd: isize) {
    let Ok(uia) = CoCreateInstance::<_, IUIAutomation>(&CUIAutomation, None, CLSCTX_INPROC_SERVER)
    else {
        return;
    };
    let Ok(walker) = uia.ControlViewWalker() else {
        return;
    };
    let mut current = option.clone();
    for _ in 0..4 {
        let Ok(parent) = walker.GetParentElement(&current) else {
            return;
        };
        if parent.CurrentControlType().ok() == Some(UIA_ComboBoxControlTypeId) {
            if let Some(expander) = parent
                .GetCurrentPattern(UIA_ExpandCollapsePatternId)
                .ok()
                .and_then(|p| p.cast::<IUIAutomationExpandCollapsePattern>().ok())
            {
                if expander.CurrentExpandCollapseState().ok() == Some(ExpandCollapseState_Expanded) {
                    let _ = run_with_uwp_bypass(host_hwnd, || expander.Collapse());
                }
            }
            return;
        }
        current = parent;
    }
}

/// Current `ValuePattern` value, if the element has one.
pub(crate) unsafe fn current_value(elem: &IUIAutomationElement) -> Option<String> {
    let pattern = elem.GetCurrentPattern(UIA_ValuePatternId).ok()?;
    let value = pattern.cast::<IUIAutomationValuePattern>().ok()?;
    value.CurrentValue().ok().map(|v| v.to_string())
}

fn same_option(a: &str, b: &str) -> bool {
    a.trim().eq_ignore_ascii_case(b.trim())
}

/// Poll the element's value until it reads `want`, at most `within`.
pub(crate) unsafe fn wait_for_value(
    elem: &IUIAutomationElement,
    want: &str,
    within: Duration,
) -> Option<String> {
    let deadline = Instant::now() + within;
    loop {
        let value = current_value(elem);
        if value.as_deref().is_some_and(|v| same_option(v, want)) || Instant::now() >= deadline {
            return value;
        }
        std::thread::sleep(Duration::from_millis(25));
    }
}

/// Result of [`select_combo_option`].
pub(crate) enum ComboSelect {
    /// `option` was selected; `readback` is the combo's value afterwards.
    Selected { option: String, readback: Option<String> },
    /// No option matched; these are the option names seen.
    NoSuchOption { options: Vec<String> },
}

unsafe fn option_items(
    uia: &IUIAutomation,
    combo: &IUIAutomationElement,
) -> Vec<(String, IUIAutomationElement)> {
    let Ok(condition) = uia.CreatePropertyCondition(
        UIA_ControlTypePropertyId,
        &(UIA_ListItemControlTypeId.0).into(),
    ) else {
        return Vec::new();
    };
    let Ok(found) = combo.FindAll(TreeScope_Descendants, &condition) else {
        return Vec::new();
    };
    (0..found.Length().unwrap_or(0))
        .filter_map(|i| found.GetElement(i).ok())
        .filter_map(|item| Some((item.CurrentName().ok()?.to_string(), item)))
        .collect()
}

/// Select the option named `value` in a combo box that has no native Win32
/// window (a Chromium `<select>`, for example): expand it, wait for its
/// options, select the one whose name matches (case-insensitive), collapse
/// it if it is still open, and read the value back.
pub(crate) unsafe fn select_combo_option(
    combo: &IUIAutomationElement,
    host_hwnd: isize,
    value: &str,
) -> anyhow::Result<ComboSelect> {
    // Join the MTA first, as in `activate::activation_target`.
    let _ = CoInitializeEx(None, COINIT_MULTITHREADED);
    let uia: IUIAutomation = CoCreateInstance(&CUIAutomation, None, CLSCTX_INPROC_SERVER)?;
    let expander = combo
        .GetCurrentPattern(UIA_ExpandCollapsePatternId)
        .ok()
        .and_then(|p| p.cast::<IUIAutomationExpandCollapsePattern>().ok());
    if let Some(expander) = &expander {
        if expander.CurrentExpandCollapseState().ok() == Some(ExpandCollapseState_Collapsed) {
            run_with_uwp_bypass(host_hwnd, || expander.Expand())?;
        }
    }
    // Chromium publishes the options asynchronously after Expand.
    let deadline = Instant::now() + Duration::from_millis(800);
    let mut options = option_items(&uia, combo);
    while options.is_empty() && Instant::now() < deadline {
        std::thread::sleep(Duration::from_millis(25));
        options = option_items(&uia, combo);
    }
    let collapse = || {
        if let Some(expander) = &expander {
            if expander.CurrentExpandCollapseState().ok() == Some(ExpandCollapseState_Expanded) {
                let _ = run_with_uwp_bypass(host_hwnd, || expander.Collapse());
            }
        }
    };
    let Some((name, item)) = options
        .iter()
        .find(|(name, _)| name.trim() == value.trim())
        .or_else(|| options.iter().find(|(name, _)| same_option(name, value)))
    else {
        collapse();
        return Ok(ComboSelect::NoSuchOption {
            options: options.into_iter().map(|(name, _)| name).collect(),
        });
    };
    let selected = match run_action(item, host_hwnd, PatternAction::Select) {
        Ok(Some(_)) => Ok(()),
        Ok(None) => run_action(item, host_hwnd, PatternAction::Invoke).and_then(|done| {
            done.map(|_| ())
                .ok_or_else(|| windows::core::Error::new(windows::Win32::Foundation::E_FAIL, "option has neither SelectionItem nor Invoke"))
        }),
        Err(error) => Err(error),
    };
    if let Err(error) = selected {
        collapse();
        anyhow::bail!("selecting option '{name}': {error}");
    }
    let readback = wait_for_value(combo, name, Duration::from_millis(600));
    collapse();
    Ok(ComboSelect::Selected { option: name.clone(), readback })
}

/// Write `value` through ValuePattern and check that it reads back.
/// `None`: no ValuePattern. `Some(Err)`: SetValue failed.
/// `Some(Ok(verified))`: SetValue returned, and whether the value stuck.
pub(crate) unsafe fn set_value_verified(
    elem: &IUIAutomationElement,
    host_hwnd: isize,
    value: &str,
) -> Option<windows::core::Result<bool>> {
    // Join the MTA first, as in `activate::activation_target`.
    let _ = CoInitializeEx(None, COINIT_MULTITHREADED);
    let pattern = elem.GetCurrentPattern(UIA_ValuePatternId).ok()?;
    let vp = pattern.cast::<IUIAutomationValuePattern>().ok()?;
    if let Err(error) = run_with_uwp_bypass(host_hwnd, || vp.SetValue(&BSTR::from(value))) {
        return Some(Err(error));
    }
    let readback = wait_for_value(elem, value, Duration::from_millis(250));
    Some(Ok(readback.is_some_and(|v| same_option(&v, value))))
}
