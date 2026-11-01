// End-to-end check that superuse's driver client recovers when the driver ends its session, through the
// real Driver class (plugin/server/driver.ts) and the real superuse-driver.exe.
//
//   node bench/session-check.ts          ends the session with end_session, then calls again
//   node bench/session-check.ts --idle   waits out the driver's own 5-minute idle timeout instead
//
// The driver ends a named session after 5 idle minutes and refuses every later call on it until it
// is started again. end_session leaves the same tombstone, so the quick run takes the same path.
// Read-only on the desktop: it only lists windows. Writes bench/out/session-check-<time>.json with
// each check and the driver calls the client made, from its trace.

import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { timestamp } from "./win.ts";

const REPO = path.dirname(import.meta.dirname);
const EXE = process.env.SUPERUSE_DRIVER ?? path.join(REPO, "plugin/driver/superuse-driver.exe");
const IDLE = process.argv.includes("--idle");
const IDLE_WAIT_MS = 5 * 60_000 + 20_000; // the driver's DEFAULT_SESSION_IDLE_TTL, plus its sweep

// driver.ts reads SUPERUSE_TRACE when it loads, so set it before the import.
const tracePath = path.join(mkdtempSync(path.join(tmpdir(), "superuse-session-")), "trace.jsonl");
process.env.SUPERUSE_TRACE = tracePath;
const { Driver } = await import("../plugin/server/driver.ts");

type Result = { case: string; ok: boolean; detail: string };
const results: Result[] = [];
function check(name: string, ok: boolean, detail: string) {
  results.push({ case: name, ok, detail: detail.slice(0, 400) });
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}: ${detail.slice(0, 160)}`);
}

type Call = { driver: string; ok: boolean };
const callsSince = (n: number): Call[] =>
  readFileSync(tracePath, "utf8").trim().split("\n").map((l) => JSON.parse(l) as Partial<Call>)
    .filter((e): e is Call => typeof e.driver === "string").slice(n).map(({ driver, ok }) => ({ driver, ok }));

const driver = new Driver(EXE, "fast");
const listWindows = () => driver.call("list_windows", { on_screen_only: true });

let r = await listWindows();
check("driver answers before the session ends", !r.isError && (r.data.windows?.length ?? 0) > 0, r.text.slice(0, 120));
const before = callsSince(0).length;

if (IDLE) {
  console.log(`waiting ${IDLE_WAIT_MS / 1000}s for the idle timeout`);
  await new Promise((done) => setTimeout(done, IDLE_WAIT_MS));
} else {
  const end = await driver.call("end_session", {});
  check("end_session ends the session", !end.isError, end.text.slice(0, 160));
}

r = await listWindows();
check("the next call succeeds", !r.isError && (r.data.windows?.length ?? 0) > 0, r.text.slice(0, 160));
const calls = callsSince(before + (IDLE ? 0 : 1));
const seq = calls.map((c) => `${c.driver}:${c.ok ? "ok" : "refused"}`).join(" > ");
check("it was refused once, then the session restarted and the call ran again",
  seq === "list_windows:refused > start_session:ok > set_agent_cursor_motion:ok > list_windows:ok", seq);

const recovered = callsSince(0).length;
r = await listWindows();
const after = callsSince(recovered).map((c) => `${c.driver}:${c.ok ? "ok" : "refused"}`).join(" > ");
check("later calls go straight through", !r.isError && after === "list_windows:ok", after);

const out = path.join(REPO, "bench", "out", `session-check-${timestamp()}.json`);
mkdirSync(path.dirname(out), { recursive: true });
writeFileSync(out, JSON.stringify({ mode: IDLE ? "idle" : "end_session", exe: EXE, results, calls: callsSince(0) }, null, 2));
const failed = results.filter((x) => !x.ok);
console.log(`${results.length - failed.length}/${results.length} passed; ${out}`);
process.exit(failed.length ? 1 : 0); // the driver process would keep Node alive
