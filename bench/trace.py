"""Print a compact trace of one run directory: tool calls, results, timings."""
import json, sys
from pathlib import Path
d = Path(sys.argv[1]); width = int(sys.argv[2]) if len(sys.argv) > 2 else 300
m = json.loads((d / "metrics.json").read_text())
print({k: m[k] for k in ["passed", "wall_s", "first_tool_s", "tool_calls", "turns", "images_seen", "tool_time_s", "model_time_s", "input_tokens", "cache_read_tokens", "output_tokens", "cost_usd", "disturbance"]})
t0 = None
for line in open(d / "transcript.jsonl"):
    ts, raw = line.split("\t", 1); ts = float(ts); t0 = t0 or ts
    ev = json.loads(raw)
    rel = f"{ts - t0:6.1f}"
    if ev.get("type") == "assistant":
        for b in ev["message"]["content"]:
            if b.get("type") == "tool_use": print(rel, "CALL", b["name"].replace("mcp__cu__", ""), json.dumps(b["input"])[:width])
            elif b.get("type") == "text": print(rel, "TEXT", b["text"][:150].replace("\n", " "))
    elif ev.get("type") == "user":
        for b in ev["message"]["content"]:
            if isinstance(b, dict) and b.get("type") == "tool_result":
                c = b.get("content")
                parts = c if isinstance(c, list) else [{"type": "text", "text": str(c)}]
                txt = " | ".join(p.get("text", "") for p in parts if p.get("type") == "text")
                imgs = sum(1 for p in parts if p.get("type") == "image")
                print(rel, "RSLT", f"[{len(txt)} chars, {imgs} img]", txt[:width].replace("\n", " "))
    elif ev.get("type") == "system" and ev.get("subtype") == "init":
        print(rel, "INIT", "tools:", len(ev.get("tools", [])))
