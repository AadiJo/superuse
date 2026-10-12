"""Aggregate a benchmark batch into a Markdown report.

    python3 report.py matrix1        # writes out/matrix1/report.md and prints it

All numbers come from each run's metrics.json. Medians are used for times and
tokens because a single stuck run would otherwise dominate a small sample.
"""
from __future__ import annotations

import json
import statistics
import sys
from collections import defaultdict
from pathlib import Path

OUT = Path(__file__).resolve().parent / "out"


def med(xs: list[float]) -> float | None:
    xs = [x for x in xs if x is not None]
    return round(statistics.median(xs), 1) if xs else None


def load(batch: str) -> list[dict]:
    return [json.loads(p.read_text()) for p in sorted((OUT / batch).glob("*/*/metrics.json"))]


def report(batch: str) -> str:
    runs = load(batch)
    by_arm: dict[str, list[dict]] = defaultdict(list)
    for r in runs:
        by_arm[r["arm"]].append(r)
    arms = sorted(by_arm)
    lines = [f"# Benchmark batch `{batch}`", "", f"{len(runs)} runs. Times in seconds, medians across runs.", "",
             "| Arm | Pass | Hit time cap | Wall | Startup | Model time | Tool time | Tool calls | Turns | Input tok (k) | Output tok | Cost $ | Cursor moved | Focus changed |",
             "| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |"]
    for a in arms:
        rs = by_arm[a]
        passed = sum(r["passed"] for r in rs)
        cost = [r["cost_usd"] for r in rs if r["cost_usd"] is not None]
        moved = sum(1 for r in rs if (r["disturbance"].get("cursor_max_displacement_px") or 0) > 0)
        focus = sum(1 for r in rs if (r["disturbance"].get("foreground_changes") or 0) > 0)
        itok = med([r["input_tokens"] / 1000 if r["input_tokens"] else None for r in rs])
        capped = sum(1 for r in rs if r["timed_out"])
        lines.append(f"| {a} | {passed}/{len(rs)} | {capped} | {med([r['wall_s'] for r in rs])} | {med([r['first_tool_s'] for r in rs])} | "
                     f"{med([r['model_time_s'] for r in rs])} | {med([r['tool_time_s'] for r in rs])} | "
                     f"{med([r['tool_calls'] for r in rs])} | {med([r['turns'] for r in rs])} | {itok} | "
                     f"{med([r['output_tokens'] for r in rs])} | {round(statistics.mean(cost), 2) if cost else 'n/a'} | "
                     f"{moved}/{len(rs)} | {focus}/{len(rs)} |")
    tasks = sorted({r["task"] for r in runs})
    lines += ["", "## Per task: passes and median wall time", "", "| Task | " + " | ".join(arms) + " |",
              "| --- |" + " --- |" * len(arms)]
    for t in tasks:
        cells = []
        for a in arms:
            rs = [r for r in by_arm[a] if r["task"] == t]
            cells.append(f"{sum(r['passed'] for r in rs)}/{len(rs)}, {med([r['wall_s'] for r in rs])}s" if rs else "")
        lines.append(f"| {t} | " + " | ".join(cells) + " |")
    fails = [r for r in runs if not r["passed"]]
    if fails:
        lines += ["", "## Failures", ""]
        lines += [f"- {r['arm']} / {r['task']} r{r['rep']}: {r['check_detail'][:160]}"
                  f"{' (timeout)' if r['timed_out'] else ''}{' error: ' + r['error'][:120] if r['error'] else ''}" for r in fails]
    return "\n".join(lines) + "\n"


if __name__ == "__main__":
    batch = sys.argv[1]
    text = report(batch)
    (OUT / batch / "report.md").write_text(text)
    print(text)
