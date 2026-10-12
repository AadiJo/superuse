// bcu: Windows computer use for Claude, as an MCP server with one sandboxed code-mode tool.
//
//   node plugin/server/main.ts          (Node 24+; TypeScript runs through type stripping)
//
// Tools: `js` runs model-written JavaScript against the `cua` API (sandbox.ts, desktop.ts);
// `js_reset` clears its variables. Approvals for apps and foreground input are asked through MCP
// elicitation when the client supports it (policy.ts). research/08-experiments.md explains the
// design; the plugin README covers setup.
//
// Env: BCU_CUA_DRIVER  path to cua-driver.exe (default: ../driver/cua-driver.exe)
//      BCU_CURSOR      "fast" (default: visible agent cursor, short glide), "animated" or "off"
//      BCU_APPS, BCU_FOREGROUND, BCU_POLICY  see policy.ts;  BCU_AUDIT  action log path or "off"

import { createInterface } from "node:readline";
import { fileURLToPath } from "node:url";
import path from "node:path";
import { Driver, type CursorMode } from "./driver.ts";
import { Desktop } from "./desktop.ts";
import { Policy, type Ask } from "./policy.ts";
import { Sandbox } from "./sandbox.ts";

const VERSION = "0.3.0";
const TEXT_LIMIT = 20_000;
const here = path.dirname(fileURLToPath(import.meta.url));
const DRIVER = process.env.BCU_CUA_DRIVER ?? path.join(here, "..", "driver", "cua-driver.exe");
const CURSOR = (process.env.BCU_CURSOR ?? "fast") as CursorMode;

const API = `Control Windows apps with JavaScript. The code runs in an async function with a persistent \`cua\` object; top-level let/const persist between calls. Return a value or call log(...) to see output.

cua.windows(filter?)            -> approved windows as {id, pid, app, title}; other apps as {app, approved: false}
cua.window("TestPad" | {pid,id,title,app}) -> Window  (binding an app that isn't approved asks the user)
cua.open("Calculator" | "C:\\\\path\\\\app.exe") -> Window  (launch in the background)

w.state({query?, diff?, max?, screenshot?}) -> string  accessibility tree; rows tagged [N] are actionable; query "a|b" matches either
w.find("Save", role?)                        -> N | null  best match by element name (exact first); role like "Button"
w.click(N | [x, y], {double?, right?})       element N from the latest state(), or pixels in the latest screenshot; a list item is selected, {double: true} opens it
w.setValue(N, "text")                        set a text box value directly (fastest way to enter text)
w.select(N, "Pro")                           choose an option in combo box N (verified)
w.type("text", N?)                           type at the focus, or into element N
w.key("enter" | "ctrl+s" | "alt+f4")         keys go to this window
w.drag([x1, y1], [x2, y2])                   pixels in the latest screenshot
w.menu("File > Save As...")                  invoke a menu item by its labels (background; some apps need {foreground: true})
w.waitFor("text", ms?)                       wait until text shows up in the tree; returns matching rows
w.screenshot()                               attach an image of the window

Input goes to the target window in the background: the user's mouse and focus are not touched.
If an action is refused in the background, click/type/key/drag/menu accept {foreground: true}, which briefly takes focus and the real cursor; the user may be asked first. Use it only when setValue/select can't do the job.
Don't sleep: state(), find() and waitFor() already wait for the UI to settle after actions.
Element numbers come from the most recent state() of that window; call state() again after the UI changes.
If an action opens a dialog, the result notes the new window; bind it with cua.window({pid: w.pid, title: "..."}).
Terminals, password managers and security prompts are off limits. Never type secrets you see on screen into other apps.

Work in few calls: batch several actions and the verifying read into one call. Example:
  const w = await cua.window("TestPad");
  const ed = await w.find("Text editor");
  await w.setValue(ed, "alpha\\r\\nbeta"); await w.key("ctrl+s");
  return (await w.state({query: "Text editor"})).split("\\n")[0];  // header shows the title; a leading * means unsaved`;

const TOOLS = [
  { name: "js", description: API, inputSchema: { type: "object", properties: { code: { type: "string", description: "JavaScript to run" } }, required: ["code"] } },
  { name: "js_reset", description: "Reset the JavaScript context (clears variables).", inputSchema: { type: "object", properties: {} } },
];

const INSTRUCTIONS = "Windows desktop computer use through one `js` tool. Use it for GUI-only tasks in native apps (no CLI or API). Batch actions and checks into few calls; input runs in the background without taking the user's mouse.";

// --- JSON-RPC over stdio, in both directions (we send elicitation requests to the client) ---

type Message = { jsonrpc?: string; id?: number | string; method?: string; params?: Record<string, unknown>; result?: unknown; error?: unknown };
const send = (msg: object) => process.stdout.write(JSON.stringify(msg) + "\n");
const outstanding = new Map<string, (m: Message) => void>(); // our requests to the client, by id
let nextOwnId = 1;
let clientCanElicit = false;
let userWaitMs = 0; // finished prompts
let promptOpenSince: number | null = null; // a prompt the user is looking at right now
/** Time spent on approval prompts, including one still open: the js timeout doesn't count it. */
const userWait = () => userWaitMs + (promptOpenSince === null ? 0 : Date.now() - promptOpenSince);

function requestClient(method: string, params: object): Promise<Message> {
  const id = `bcu-${nextOwnId++}`;
  send({ jsonrpc: "2.0", id, method, params });
  return new Promise((resolve) => outstanding.set(id, resolve));
}

/** Ask the user through MCP elicitation. One boolean field lets them remember the answer. */
const ask: Ask = async (message, rememberLabel) => {
  if (!clientCanElicit) return "unsupported";
  const started = Date.now();
  promptOpenSince = started;
  try {
    const reply = await requestClient("elicitation/create", {
      message,
      requestedSchema: { type: "object", properties: { remember: { type: "boolean", title: rememberLabel, default: false } } },
    });
    const result = (reply.result ?? {}) as { action?: string; content?: { remember?: boolean } };
    if (reply.error || result.action !== "accept") return "no";
    return result.content?.remember ? "always" : "once";
  } finally {
    promptOpenSince = null;
    userWaitMs += Date.now() - started;
  }
};

const policy = new Policy(ask);
const desktop = new Desktop(new Driver(DRIVER, CURSOR), policy);
const sandbox = await Sandbox.create((method, args) => desktop.dispatch(method, args), userWait);
process.on("unhandledRejection", () => {}); // every API promise is tracked by the sandbox; nothing should land here

/** One js call at a time: the sandbox's queue and logs belong to the call that's running. */
let runTail: Promise<unknown> = Promise.resolve();

async function runJs(code: string) {
  desktop.beginRun();
  const r = await sandbox.run(code);
  const out = desktop.out;
  const parts = [...r.logs];
  if (r.hasValue && r.value !== null) parts.push(r.value);
  let error = r.error;
  if (error) parts.push(`Error: ${error}`);
  const unseen = [...new Set(r.errors)].filter((e) => !error?.includes(e));
  parts.push(...unseen.map((e) => `Error (in a call that wasn't awaited): ${e}`));
  error ??= unseen[0] ?? null;
  parts.push(...[...out.notes].map((n) => `note: ${n}`));
  let text = parts.join("\n") || (out.images.length ? `(${out.images.length} image attached)` : "(no output: return a value or call log())");
  if (text.length > TEXT_LIMIT) text = `${text.slice(0, TEXT_LIMIT)}\n[truncated ${text.length - TEXT_LIMIT} chars; use state({query}) to narrow]`;
  return {
    content: [{ type: "text", text }, ...out.images.map((i) => ({ type: "image", data: i.data, mimeType: i.mimeType }))],
    isError: !!error,
  };
}

async function handle(msg: Message) {
  const reply = (result: object) => send({ jsonrpc: "2.0", id: msg.id, result });
  switch (msg.method) {
    case "initialize": {
      const caps = (msg.params?.capabilities ?? {}) as { elicitation?: unknown };
      clientCanElicit = !!caps.elicitation;
      const version = typeof msg.params?.protocolVersion === "string" ? msg.params.protocolVersion : "2025-06-18";
      return reply({ protocolVersion: version, capabilities: { tools: {} }, serverInfo: { name: "bcu", version: VERSION }, instructions: INSTRUCTIONS });
    }
    case "tools/list":
      return reply({ tools: TOOLS });
    case "tools/call": {
      const name = msg.params?.name;
      const args = (msg.params?.arguments ?? {}) as { code?: unknown };
      if (name === "js_reset") {
        runTail = runTail.then(() => sandbox.reset());
        await runTail;
        return reply({ content: [{ type: "text", text: "context reset" }] });
      }
      if (name !== "js") return send({ jsonrpc: "2.0", id: msg.id, error: { code: -32602, message: `unknown tool ${String(name)}` } });
      const run = runTail.then(() => runJs(typeof args.code === "string" ? args.code : ""));
      runTail = run.catch(() => {});
      return reply(await run);
    }
    case "ping":
      return reply({});
    default:
      return send({ jsonrpc: "2.0", id: msg.id, error: { code: -32601, message: `unknown method ${msg.method}` } });
  }
}

createInterface({ input: process.stdin }).on("line", (line) => {
  let msg: Message;
  try { msg = JSON.parse(line) as Message; } catch { return; }
  if (msg.method === undefined && msg.id !== undefined) { // a reply to one of our requests
    const done = outstanding.get(String(msg.id));
    outstanding.delete(String(msg.id));
    done?.(msg);
    return;
  }
  if (msg.id === undefined) return; // notifications
  handle(msg).catch((e) => send({ jsonrpc: "2.0", id: msg.id, error: { code: -32603, message: e instanceof Error ? e.message : String(e) } }));
});
