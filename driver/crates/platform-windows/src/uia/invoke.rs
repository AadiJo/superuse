//! `InvokePattern.Invoke()` with a short wait instead of an unbounded one.
//!
//! Invoke is a synchronous cross-process call, and WinForms and classic Win32
//! providers run the control's click handler inside it. When that handler
//! opens a modal dialog, Invoke does not return until the dialog closes or UI
//! Automation's own transaction timeout fires (about a minute, measured), so
//! the tool call hung with it and then reported a failure for a click that
//! had landed.
//!
//! [`invoke_with_deadline`] runs Invoke on its own thread and waits at most
//! [`invoke_deadline`]. A late Invoke is [`InvokeOutcome::Dispatched`]: the
//! provider may still be running the action, so callers report it as sent and
//! must not try another pattern or input that could fire it twice. The thread
//! holds no gate or lock, so later UIA calls (including ones against the new
//! dialog) are not queued behind it. It exits once Invoke returns. A caller's
//! `fg_bypass` shield stays up until then (at most [`DISPATCHED_SHIELD_MAX`]
//! past the deadline), since the provider can still self-activate once it
//! gets to the action.

use std::sync::{mpsc, Arc, Mutex, OnceLock};
use std::time::Duration;

use super::fg_bypass::DisabledHwndGuard;

use windows::Win32::Foundation::E_FAIL;
use windows::Win32::UI::Accessibility::IUIAutomationInvokePattern;

const DEFAULT_DEADLINE: Duration = Duration::from_millis(1500);

/// How long a dispatched Invoke may keep the caller's foreground shield
/// after the deadline. The shielded window ignores the user's input while
/// disabled, so a provider stuck for longer (a modal loop, UIA's own
/// one-minute timeout) gets its window back.
const DISPATCHED_SHIELD_MAX: Duration = Duration::from_secs(10);

/// The caller's shield, handed to a dispatched Invoke's worker, which drops
/// it when Invoke returns. A timer drops it at [`DISPATCHED_SHIELD_MAX`].
#[derive(Default)]
struct DispatchedShield {
    invoke_returned: bool,
    shield: Option<DisabledHwndGuard>,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum InvokeOutcome {
    /// Invoke returned success within the deadline.
    Returned,
    /// Invoke had not returned at the deadline and is still running on its
    /// own thread, usually inside a modal dialog the control opened.
    Dispatched,
}

/// How long to wait for Invoke: `CUA_DRIVER_INVOKE_DEADLINE_MS`, else 1500 ms.
pub(crate) fn invoke_deadline() -> Duration {
    static DEADLINE: OnceLock<Duration> = OnceLock::new();
    *DEADLINE.get_or_init(|| {
        std::env::var("CUA_DRIVER_INVOKE_DEADLINE_MS")
            .ok()
            .and_then(|ms| ms.trim().parse::<u64>().ok())
            .filter(|&ms| ms > 0)
            .map_or(DEFAULT_DEADLINE, Duration::from_millis)
    })
}

/// Tool text for a [`InvokeOutcome::Dispatched`] Invoke on `target` in `pid`.
pub(crate) fn dispatched_message(target: &str, pid: u32) -> String {
    format!(
        "✅ Dispatched UIA Invoke on {target}. It did not return within {} ms, which usually \
         means the control opened a modal dialog. The effect is unverified. Call list_windows \
         for pid {pid} to find the new dialog, then get_window_state on it.",
        invoke_deadline().as_millis()
    )
}

/// Call `pattern.Invoke()` on a fresh MTA thread and wait at most
/// [`invoke_deadline`]. `Err` is a failure Invoke reported within the
/// deadline, so callers may still try another pattern; `Dispatched` must be
/// reported as delivered. When the caller runs this inside
/// `fg_bypass::run_with_uwp_bypass` and Invoke is still running at the
/// deadline, the shield moves to the Invoke thread and stays up until Invoke
/// returns, at most [`DISPATCHED_SHIELD_MAX`] later. The call itself does not
/// wait for that.
pub(crate) fn invoke_with_deadline(
    pattern: &IUIAutomationInvokePattern,
) -> windows::core::Result<InvokeOutcome> {
    // UIA client objects are already shared between this crate's MTA threads
    // (the snapshot cache hands element pointers across blocking-pool
    // threads). The worker joins the MTA too, so this AddRef'd pointer needs
    // no marshaling.
    struct MtaPattern(IUIAutomationInvokePattern);
    unsafe impl Send for MtaPattern {}

    let pattern = MtaPattern(pattern.clone());
    let (tx, rx) = mpsc::channel();
    let dispatched = Arc::new(Mutex::new(DispatchedShield::default()));
    let worker_dispatched = dispatched.clone();
    std::thread::Builder::new()
        .name("cua-uia-invoke".into())
        .spawn(move || {
            // Declared first so the pattern is released before CoUninitialize.
            let _com = super::windows_enum::ComInit::new();
            // Move the whole Send wrapper in; naming only its field would
            // capture the non-Send interface by itself.
            let pattern = pattern;
            let result = unsafe { pattern.0.Invoke() };
            // Lower the shield a late Invoke was handed (outside the lock).
            let shield = {
                let mut held = worker_dispatched.lock().unwrap();
                held.invoke_returned = true;
                held.shield.take()
            };
            drop(shield);
            if let Err(mpsc::SendError(late)) = tx.send(result) {
                tracing::info!(
                    target: "uia_invoke",
                    "dispatched UIA Invoke returned after the deadline: {late:?}"
                );
            }
        })
        .map_err(|e| {
            windows::core::Error::new(E_FAIL, format!("could not start a UIA Invoke thread: {e}"))
        })?;

    let deadline = invoke_deadline();
    match rx.recv_timeout(deadline) {
        Ok(result) => result.map(|()| InvokeOutcome::Returned),
        Err(mpsc::RecvTimeoutError::Timeout) => {
            tracing::info!(
                target: "uia_invoke",
                "UIA Invoke still running after {}ms; reporting it as dispatched",
                deadline.as_millis()
            );
            keep_shield_until_return(&dispatched);
            Ok(InvokeOutcome::Dispatched)
        }
        Err(mpsc::RecvTimeoutError::Disconnected) => Err(windows::core::Error::new(
            E_FAIL,
            "the UIA Invoke thread exited without a result",
        )),
    }
}

/// Hand the caller's active shield, if any, to the Invoke still running, and
/// start the timer that bounds it. If Invoke returned in the meantime the
/// shield is simply dropped here.
fn keep_shield_until_return(dispatched: &Arc<Mutex<DispatchedShield>>) {
    let Some(shield) = super::fg_bypass::take_active_shield() else {
        return;
    };
    {
        let mut held = dispatched.lock().unwrap();
        if held.invoke_returned {
            return;
        }
        held.shield = Some(shield);
    }
    let dispatched = dispatched.clone();
    let _ = std::thread::Builder::new()
        .name("cua-uia-shield".into())
        .spawn(move || {
            std::thread::sleep(DISPATCHED_SHIELD_MAX);
            let shield = dispatched.lock().unwrap().shield.take();
            drop(shield);
        });
}
