//! Planned agent-cursor trajectories.
//!
//! The motion math lives in the `cursor-motion` crate, the single source of
//! truth shared with the `@trycua/cursor-motion` web package. This module adapts the
//! driver's [`MotionConfig`] to it.

use crate::motion::MotionConfig;
pub use cursor_motion::ease;
pub use cursor_motion::path::{bow_path, cua_path, natural_side, ArcShape, Path};
pub use cursor_motion::plan::*;
pub use cursor_motion::rng::{hash_string, Rng};
pub use cursor_motion::{wrap_angle, Pt};

/// Plan one move for `motion.style`.
pub fn plan_move(motion: &MotionConfig, req: &MoveRequest) -> Trajectory {
    cursor_motion::plan_move(&motion.params(), req)
}
