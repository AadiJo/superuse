"""Time one benchmark task in the Codex desktop app, by hand. Called by bench/codex_app_wizard.sh.

    python3 bench/codex_app.py run <task> <rep> <label>

Sets the task up exactly as run.py does, copies the same prompt to the Windows clipboard, then
times from the Enter you press as you send it to the Enter you press when Codex finishes. The
cursor/foreground sampler runs in between. The task's own checker decides pass or fail, and the
result lands in bench/out/codex-app/<label>/<task>-r<rep>/metrics.json, the same shape run.py
writes, so `python3 bench/report.py codex-app` puts it beside the other arms.
"""
from __future__ import annotations

import base64
import json
import sys
import time
from dataclasses import asdict
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
import run as R  # noqa: E402
import tasks as T  # noqa: E402
import win  # noqa: E402


def copy_to_clipboard(text: str) -> None:
    b64 = base64.b64encode(text.encode("utf-8")).decode()
    win.ps(f"Set-Clipboard -Value ([Text.Encoding]::UTF8.GetString([Convert]::FromBase64String('{b64}')))")


def ask_yes(question: str) -> bool:
    return input(f"  ? {question} [y/N] ").strip().lower().startswith("y")


def run_task(task_id: str, rep: int, label: str) -> int:
    task = T.TASKS[task_id]
    run_dir = R.OUT / "codex-app" / label / f"{task_id}-r{rep}"
    if (run_dir / "metrics.json").exists() and not ask_yes(f"{task_id} r{rep} already recorded for {label}. Redo it?"):
        return 0
    run_dir.mkdir(parents=True, exist_ok=True)
    win.close_strays()
    before = win.list_windows()
    print("  • setting up the task...")
    task.setup()
    copy_to_clipboard(R.PREAMBLE + task.prompt)
    sampler = win.Sampler()
    sampler.start()  # before you send, so the run's first moments are sampled and timed
    print("  • the prompt is on your clipboard. Paste it into a new Codex thread.")
    input("  Press Enter at the moment you send it... ")
    t0 = time.time()
    input("  Press Enter when Codex has finished (its final message is shown)... ")
    wall = round(time.time() - t0, 1)
    sampler.stop()
    m = R.Metrics(label, task_id, rep, wall_s=wall, model_id=label)
    m.disturbance = sampler.summary(since=t0)
    time.sleep(1)
    chk = task.check("")
    m.passed, m.check_detail = chk.passed, chk.detail
    manual = {"approval_prompt_shown": ask_yes("Did Codex show an app approval prompt during this run?"),
              "gave_up_or_asked_for_help": ask_yes("Did Codex stop to ask you something or give up?")}
    task.teardown()
    closed = win.close_new_windows(before)
    (run_dir / "metrics.json").write_text(json.dumps(asdict(m), indent=2))
    (run_dir / "manual.json").write_text(json.dumps(manual, indent=2))
    (run_dir / "windows-closed.txt").write_text("\n".join(closed))
    d = m.disturbance
    print(f"  {'PASS' if m.passed else 'FAIL'}  {wall}s  cursor moved {d.get('cursor_max_displacement_px')} px, "
          f"focus changed {d.get('foreground_changes')}x  ({m.check_detail[:80]})")
    return 0


if __name__ == "__main__":
    if len(sys.argv) != 5 or sys.argv[1] != "run" or sys.argv[2] not in T.TASKS:
        sys.exit(f"usage: codex_app.py run <task> <rep> <label>   tasks: {', '.join(T.TASKS)}")
    sys.exit(run_task(sys.argv[2], int(sys.argv[3]), sys.argv[4]))
