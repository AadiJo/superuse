//! Input locks shared by every driver in the session, so agents running their
//! own drivers side by side don't interleave input.
//!
//! - [`Lock::Foreground`] covers an action that uses the real cursor or the
//!   foreground window, from activation through input to the foreground
//!   restore. Only one agent at a time may hold the user's pointer and focus.
//! - [`Lock::window`] covers every input action on one top-level window,
//!   background or foreground, so two agents' keys don't interleave and one
//!   agent's held modifiers (the attached Ctrl+S hold) don't reach the other's.
//!
//! Who takes them: `tools::impl_`'s input-tool wrapper takes the window lock
//! for each call, then the foreground lock when the call asks for foreground
//! or desktop delivery. Background actuators that still touch the shared
//! pointer or foreground (pen injection, the MSAA SendInput click) take the
//! foreground lock themselves; they run only for background calls, so the
//! two never nest. Order is always window, then foreground.
//!
//! A wait longer than [`WAIT`] gives up with [`InputBusy`], which tools turn
//! into an `input_busy` refusal. No input is sent then.
//!
//! Each lock is a named Win32 mutex in the session's `Local\` namespace. A
//! mutex rather than a semaphore because Windows abandons a mutex whose owner
//! dies: the next waiter gets `WAIT_ABANDONED` and owns it, so a crashed
//! driver can't wedge the others, where a semaphore count would stay taken.
//! Mutex ownership belongs to a thread, and a tool call is an async task that
//! moves between threads, so every held lock gets its own thread that waits
//! for the mutex, owns it, and releases it when the [`InputLock`] drops.

use std::time::Duration;

use superuse_core::protocol::ToolResult;
use tokio::sync::oneshot;
use windows::core::PCWSTR;
use windows::Win32::Foundation::{CloseHandle, HWND, WAIT_ABANDONED, WAIT_OBJECT_0, WAIT_TIMEOUT};
use windows::Win32::System::Threading::{CreateMutexW, ReleaseMutex, WaitForSingleObject};
use windows::Win32::UI::WindowsAndMessaging::{GetAncestor, GA_ROOT};

/// How long an action waits for another agent's lock before it is refused:
/// longer than any single input action takes, short enough that the model
/// hears back and retries instead of stalling.
pub const WAIT: Duration = Duration::from_secs(5);

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Lock {
    Foreground,
    /// A top-level window, by HWND. Build it with [`Lock::window`].
    Window(u64),
}

impl Lock {
    /// The lock for `hwnd`'s top-level window, so a child HWND and its
    /// top-level share one lock.
    pub fn window(hwnd: u64) -> Self {
        let root = unsafe { GetAncestor(HWND(hwnd as *mut _), GA_ROOT) };
        Self::Window(if root.0.is_null() {
            hwnd
        } else {
            root.0 as u64
        })
    }

    fn mutex_name(self) -> Vec<u16> {
        let name = match self {
            Self::Foreground => r"Local\superuse-input-foreground".to_owned(),
            Self::Window(hwnd) => format!(r"Local\superuse-input-window-{hwnd:x}"),
        };
        name.encode_utf16().chain(std::iter::once(0)).collect()
    }
}

/// Another driver held `lock` for longer than `waited`.
#[derive(Debug)]
pub struct InputBusy {
    pub lock: Lock,
    pub waited: Duration,
}

impl std::fmt::Display for InputBusy {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        let ms = self.waited.as_millis();
        match self.lock {
            Lock::Foreground => write!(
                f,
                "input_busy: another agent is using the real cursor and foreground window \
                 (its Superuse driver held the foreground lock for over {ms} ms). No input \
                 was sent. Retry this action."
            ),
            Lock::Window(hwnd) => write!(
                f,
                "input_busy: another agent is sending input to window {hwnd} (its Superuse \
                 driver held that window's lock for over {ms} ms). No input was sent. Retry \
                 this action."
            ),
        }
    }
}

impl std::error::Error for InputBusy {}

impl InputBusy {
    /// The `input_busy` refusal a tool returns.
    pub fn refusal(&self) -> ToolResult {
        let (lock, window_id) = match self.lock {
            Lock::Foreground => ("foreground", None),
            Lock::Window(hwnd) => ("window", Some(hwnd)),
        };
        ToolResult::error(self.to_string()).with_structured(serde_json::json!({
            "code": "input_busy",
            "effect": "refused",
            "lock": lock,
            "window_id": window_id,
            "waited_ms": self.waited.as_millis() as u64,
        }))
    }

    /// The refusal inside an actuator's error, if that's why it failed.
    pub fn refusal_in(error: &anyhow::Error) -> Option<ToolResult> {
        error.downcast_ref::<Self>().map(Self::refusal)
    }
}

/// A held lock. Dropping it releases the mutex.
pub struct InputLock {
    // Dropping the sender wakes the owning thread, which releases the mutex.
    _release: oneshot::Sender<()>,
}

enum Waited {
    Owned,
    Busy,
    /// The mutex couldn't be created or waited on. The action goes ahead
    /// unlocked rather than failing every input; see `hold`.
    Unlocked,
}

impl InputLock {
    /// Wait up to `wait` for `lock`, from async code.
    pub async fn acquire(lock: Lock, wait: Duration) -> Result<Self, InputBusy> {
        let (waited, release) = spawn_owner(lock, wait);
        Self::finish(lock, wait, waited.await.ok(), release)
    }

    /// Wait up to `wait` for `lock`, from a blocking thread.
    pub fn acquire_blocking(lock: Lock, wait: Duration) -> Result<Self, InputBusy> {
        let (waited, release) = spawn_owner(lock, wait);
        Self::finish(lock, wait, waited.blocking_recv().ok(), release)
    }

    fn finish(
        lock: Lock,
        wait: Duration,
        waited: Option<Waited>,
        release: oneshot::Sender<()>,
    ) -> Result<Self, InputBusy> {
        match waited {
            Some(Waited::Busy) => Err(InputBusy { lock, waited: wait }),
            Some(Waited::Owned | Waited::Unlocked) | None => Ok(Self { _release: release }),
        }
    }
}

/// The locks one input action needs, in lock order: `window`'s, then the
/// foreground lock when `foreground`. Held until the returned value drops.
pub async fn for_action(
    window: Option<u64>,
    foreground: bool,
) -> Result<Vec<InputLock>, InputBusy> {
    let mut held = Vec::with_capacity(2);
    if let Some(hwnd) = window {
        held.push(InputLock::acquire(Lock::window(hwnd), WAIT).await?);
    }
    if foreground {
        held.push(InputLock::acquire(Lock::Foreground, WAIT).await?);
    }
    Ok(held)
}

fn spawn_owner(lock: Lock, wait: Duration) -> (oneshot::Receiver<Waited>, oneshot::Sender<()>) {
    let (waited_tx, waited_rx) = oneshot::channel();
    let (release_tx, release_rx) = oneshot::channel();
    let name = lock.mutex_name();
    let spawned = std::thread::Builder::new()
        .name("superuse-input-lock".into())
        .spawn(move || hold(&name, wait, waited_tx, release_rx));
    if let Err(error) = spawned {
        // The sender went down with the closure, so the caller sees `None`
        // and goes ahead unlocked.
        tracing::warn!(target: "input_lock", "could not start the lock thread: {error}");
    }
    (waited_rx, release_tx)
}

/// The owning thread: wait for the mutex, report, hold it until the
/// [`InputLock`] drops, release it.
fn hold(
    name: &[u16],
    wait: Duration,
    waited: oneshot::Sender<Waited>,
    release: oneshot::Receiver<()>,
) {
    // A mutex an elevated driver created can refuse a non-elevated one access.
    // Refusing all input over that would be worse than the race the lock
    // prevents, so the action goes ahead unlocked.
    let mutex = match unsafe { CreateMutexW(None, false, PCWSTR(name.as_ptr())) } {
        Ok(mutex) => mutex,
        Err(error) => {
            tracing::warn!(target: "input_lock", "input lock unavailable, acting unlocked: {error}");
            let _ = waited.send(Waited::Unlocked);
            return;
        }
    };
    let millis = u32::try_from(wait.as_millis()).unwrap_or(u32::MAX - 1);
    let status = unsafe { WaitForSingleObject(mutex, millis) };
    // WAIT_ABANDONED: a driver died holding the lock. The wait still made this
    // thread the owner, and the dead driver's input can't still be running.
    if status == WAIT_OBJECT_0 || status == WAIT_ABANDONED {
        // A caller that gave up meanwhile has dropped its receiver: release now.
        if waited.send(Waited::Owned).is_ok() {
            let _ = release.blocking_recv();
        }
        let _ = unsafe { ReleaseMutex(mutex) };
    } else if status == WAIT_TIMEOUT {
        let _ = waited.send(Waited::Busy);
    } else {
        tracing::warn!(target: "input_lock", "input lock wait failed ({status:?}), acting unlocked");
        let _ = waited.send(Waited::Unlocked);
    }
    let _ = unsafe { CloseHandle(mutex) };
}
