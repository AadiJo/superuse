// End-to-end checks of the superuse MCP server's sandbox and policy, through the real server and driver.
//
//   node bench/server-check.ts      writes bench/out/server-check-<time>.json, exits 1 on any failure
//
// Read-only on the desktop: it lists windows and binds them, but never sends input, so it can run
// while something else is driving apps. Each case names the failure it guards against.

import { mkdirSync, mkdtempSync, readFileSync, unlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { McpClient, textOf, type ElicitMode } from "./mcp-client.ts";
import { timestamp } from "./win.ts";

const REPO = path.dirname(import.meta.dirname);
const SERVER = [path.join(REPO, "plugin/server/run.sh")]; // the launcher clients run, not main.ts directly

type Result = { case: string; ok: boolean; detail: string };
const results: Result[] = [];

function check(name: string, ok: boolean, detail: string) {
  results.push({ case: name, ok, detail: detail.slice(0, 400) });
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}: ${detail.slice(0, 160)}`);
}

/** A fresh server. "unsupported" leaves elicitation out of the client's capabilities. */
const server = (env: Record<string, string>, elicit: ElicitMode) => McpClient.start(SERVER, { env, elicit });

async function js(c: McpClient, code: string, timeoutMs = 60_000): Promise<{ text: string; error: boolean }> {
  const { result } = await c.call("js", { code }, timeoutMs);
  return { text: textOf(result), error: !!result.isError };
}

/** A row of desktop.windows(): approved apps carry an id and title, others only the app name. */
type WindowRow = { app?: string; approved?: boolean; id?: number; title?: string };

const policy = path.join(mkdtempSync(path.join(tmpdir(), "superuse-")), "policy.json"); // empty policy: nothing pre-approved
const base = { SUPERUSE_POLICY: policy, SUPERUSE_AUDIT: "off" };
let other: string | undefined; // an app on screen that isn't approved

{
  await using c = await server(base, "unsupported");
  let r = await js(c, "return [typeof process, typeof require, typeof fetch, typeof __superuse_host, (async()=>1)().constructor.constructor('return typeof process')()]");
  check("no Node capabilities in the sandbox", r.text === '["undefined","undefined","undefined","undefined","undefined"]', r.text);
  r = await js(c, 'try { return typeof log.constructor.constructor("return process")() } catch (e) { return "blocked" }');
  check("API functions don't lead to the host's Function", r.text === "blocked", r.text);
  r = await js(c, "desktop = null; log = null; return typeof desktop.window + ' ' + typeof log");
  check("desktop and log can't be overwritten", r.text === "function function", r.text);
  await js(c, "const answer = 41");
  r = await js(c, "return answer + 1");
  check("top-level const persists across calls", r.text === "42", r.text);
  r = await js(c, "const order = []; desktop.sleep(50).then(() => order.push('a')); desktop.sleep(1).then(() => order.push('b')); await desktop.sleep(1); return order");
  check("un-awaited calls run in written order", r.text === '["a","b"]', r.text);
  r = await js(c, "desktop.window('zz-no-such-app-zz'); return 'kept going'");
  check("un-awaited failure is reported, call continues", r.error && r.text.includes("kept going") && r.text.includes("wasn't awaited"), r.text);
  r = await js(c, "try { await desktop.window('zz-no-such-app-zz') } catch (e) { return 'caught' }");
  check("a caught API error doesn't fail the call", r.text === "caught" && !r.error, r.text);
  r = await js(c, "while (true) {}", 30_000);
  check("infinite loop is interrupted", r.error && r.text.includes("interrupted"), r.text);
  r = await js(c, "return 1 +");
  check("syntax error is reported", r.error && r.text.includes("SyntaxError"), r.text);
  r = await js(c, "return 'still alive'");
  check("server usable after loop and syntax error", r.text === "still alive", r.text);
  await js(c, "async function twice(x) { return 2 * x }\nclass Box { constructor(v) { this.v = v } }");
  r = await js(c, "return [await twice(21), new Box(7).v]");
  check("top-level functions and classes persist", r.text === "[42,7]", r.text);
  r = await js(c, 'return await desktop.open("C:\\\\Windows\\\\System32\\\\cmd.exe\\u0000C:\\\\testpad.exe")');
  check("launch name with a NUL is refused", r.error && r.text.includes("not a plain app name"), r.text);
  await c.call("js_reset", {});
  r = await js(c, "return typeof answer");
  check("js_reset clears variables", r.text === "undefined", r.text);

  r = await js(c, "return await desktop.windows()");
  const rows: WindowRow[] = r.text.startsWith("[") ? JSON.parse(r.text) : [];
  const leaked = rows.filter((w) => w.approved === false && ("title" in w || "id" in w));
  check("unapproved apps show no titles or ids", rows.length > 0 && !leaked.length, `${rows.length} rows, ${leaked.length} leaking`);
  const terminals = rows.filter((w) => String(w.app ?? "").toLowerCase().includes("terminal"));
  check("denied apps (terminals) are hidden", !terminals.length, `terminal rows: ${terminals.length}`);
  r = await js(c, "return await desktop.window('WindowsTerminal')");
  check("denied app can't be bound", r.error && r.text.includes("no window matches"), r.text);
  // The test subject is the first unapproved app that can still be bound: some (dwm, shell hosts)
  // show a window for a moment and are gone by the time the check binds them.
  r = { text: "no unapproved app on screen", error: true };
  for (const app of [...new Set(rows.filter((w) => w.approved === false).map((w) => w.app as string))]) {
    const attempt = await js(c, `return await desktop.window(${JSON.stringify(app)})`);
    if (attempt.text.includes("no window matches")) continue;
    other = app;
    r = attempt;
    break;
  }
  check("no elicitation: refusal says how to approve", r.error && r.text.includes("allow") && r.text.includes(policy), r.text);
  // Allowing every app with "*", written while the session runs, applies without a restart.
  writeFileSync(policy, JSON.stringify({ allow: ["*"], foreground: "allow" }));
  r = other ? await js(c, `const w = await desktop.window(${JSON.stringify(other)}); return w.app`) : { text: "", error: false };
  check('"*" in the policy file approves apps mid-session', !r.error && !!r.text, r.text);
  r = await js(c, "return await desktop.window('WindowsTerminal')");
  check('built-in blocks still apply under "*"', r.error && r.text.includes("no window matches"), r.text);
  unlinkSync(policy);
}

// Timeouts, with a 3 s limit: calls queued by the timed-out js call must not run afterwards, and
// js_reset right after a timeout (live host calls) must not crash the server.
{
  await using c = await server({ ...base, SUPERUSE_CALL_TIMEOUT_MS: "3000" }, "unsupported");
  let r = await js(c, "globalThis.ran = 0; for (let i = 0; i < 20; i++) desktop.sleep(300).then(() => ran++); await new Promise(() => {})");
  check("stuck js call times out", r.error && r.text.includes("timed out"), r.text);
  r = await js(c, "for (let i = 0; i < 5; i++) await desktop.sleep(300); return ran");
  check("calls queued by a timed-out call are cancelled", /^\d+$/.test(r.text) && Number(r.text) < 15, `ran=${r.text} of 20`);
  await js(c, "desktop.sleep(300); await new Promise(() => {})");
  await c.call("js_reset", {});
  r = await js(c, "return 'alive after reset'");
  check("js_reset after a timeout keeps the server alive", r.text === "alive after reset", r.text);
}

if (other) {
  const app = JSON.stringify(other);
  {
    await using c = await server(base, "decline");
    const r = await js(c, `return await desktop.window(${app})`);
    check("declined prompt refuses", r.error && r.text.includes("declined"), r.text);
    const asked = c.elicitations.length;
    await js(c, `try { await desktop.window(${app}) } catch (e) {}`);
    check("declined app isn't asked again", c.elicitations.length === asked && asked === 1, `prompts: ${c.elicitations.length}`);
  }
  {
    await using c = await server(base, "accept");
    let r = await js(c, `const w = await desktop.window(${app}); return [typeof w.state, w.app]`);
    check("accepted prompt binds the window", !r.error && r.text.includes('"function"'), r.text);
    check("prompt names the app", c.elicitations.length > 0 && JSON.stringify(c.elicitations[0]).includes(other), `prompts: ${c.elicitations.length}`);
    r = await js(c, `return (await desktop.windows()).filter(r => r.app === ${app}).map(r => 'title' in r)`);
    check("approved app now listed with titles", r.text.includes("true"), r.text);
  }
  {
    // A policy file that doesn't parse is the user's text: "always" approves for this session
    // and says why it wasn't saved, instead of replacing the file with defaults.
    const broken = '{ "allow": ["testpad",] }';
    writeFileSync(policy, broken);
    await using c = await server(base, "always");
    const r = await js(c, `return (await desktop.window(${app})).app`);
    check("malformed policy file isn't overwritten", readFileSync(policy, "utf8") === broken && r.text.includes("isn't valid JSON"), r.text);
    unlinkSync(policy);
  }
}

const out = path.join(REPO, "bench", "out", `server-check-${timestamp()}.json`);
mkdirSync(path.dirname(out), { recursive: true });
writeFileSync(out, JSON.stringify(results, null, 2));
const failed = results.filter((r) => !r.ok);
console.log(`${results.length - failed.length}/${results.length} passed; ${out}`);
process.exitCode = failed.length ? 1 : 0;
