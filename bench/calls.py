"""Print each tool call of a run with its duration, code and a result snippet."""
import json, sys
d = sys.argv[1]; w = int(sys.argv[2]) if len(sys.argv) > 2 else 200
t0 = None; pend = {}
for line in open(f"{d}/transcript.jsonl"):
    ts, raw = line.split("\t", 1); ts = float(ts); t0 = t0 or ts; ev = json.loads(raw)
    if ev.get("type") == "assistant":
        for b in ev["message"]["content"]:
            if b.get("type") == "tool_use": pend[b["id"]] = (ts, json.dumps(b["input"].get("code", b["input"])))
    elif ev.get("type") == "user":
        for b in ev["message"]["content"]:
            if isinstance(b, dict) and b.get("type") == "tool_result" and b["tool_use_id"] in pend:
                s, code = pend.pop(b["tool_use_id"])
                c = b.get("content"); txt = " ".join(p.get("text", "") for p in c if isinstance(p, dict)) if isinstance(c, list) else str(c)
                print(f"{s-t0:6.1f}s +{ts-s:5.1f}s {code[:w]}\n{'':15}-> {txt[:w]!r}")
