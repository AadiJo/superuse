// Checks that run the real server through its launcher, the way a client does.
//
// The server starts with PATH=/usr/bin:/bin, like a client launched from a GUI, so it only works if
// the launcher finds the recorded Node. Inherited SUPERUSE_APPS/SUPERUSE_FOREGROUND/SUPERUSE_BROWSERS/SUPERUSE_DRIVER
// are removed, so a variable in this shell can't hide a problem the registered clients would hit.
//
// checkServer: handshake, version, QuickJS and the driver's window list (read-only).
// verifyApp: --verify only. Opens a TestPad built for this run, has the server type into it and
//   save, then reads the file back. Only that TestPad is pre-approved, for that server process.
// verifyBrowser: --verify with browsers on. Opens its own tab on a page served from here, clicks
//   its button and checks both the page and the server saw the click, then closes the tab.

import { randomUUID } from "node:crypto";
import fs from "node:fs";
import http from "node:http";
import type { AddressInfo } from "node:net";
import path from "node:path";
import { McpClient, textOf } from "../../bench/mcp-client.ts";
import { ps } from "../../bench/win.ts";
import { browsersByHint } from "./access.ts";
import { LAUNCHER, REPO, VERSION, run, windowsDir, type Check } from "./lib.ts";

const serverEnv = (extra: Record<string, string> = {}) =>
  ({ PATH: "/usr/bin:/bin", SUPERUSE_AUDIT: "off", SUPERUSE_APPS: undefined, SUPERUSE_FOREGROUND: undefined, SUPERUSE_BROWSERS: undefined, SUPERUSE_DRIVER: undefined, ...extra });

async function js(c: McpClient, code: string, timeoutMs = 60_000) {
  const { result } = await c.call("js", { code }, timeoutMs);
  return { text: textOf(result), error: !!result.isError };
}

const message = (e: unknown) => (e instanceof Error ? e.message : String(e));

/** `driver` tests another exe (a release candidate) instead of plugin/driver's. */
export async function checkServer(driver?: string): Promise<Check> {
  const id = "server";
  try {
    await using c = await McpClient.start([LAUNCHER], { env: serverEnv(driver ? { SUPERUSE_DRIVER: driver } : {}), elicit: "unsupported" });
    if (c.serverInfo.version !== VERSION) return { id, status: "fail", code: "SERVER_VERSION", summary: `the launcher ran server ${c.serverInfo.version}, expected ${VERSION}` };
    const tools = (await c.request("tools/list", {}, 30_000)) as { tools?: Array<{ name: string }> };
    if (!tools.tools?.some((t) => t.name === "js")) return { id, status: "fail", code: "SERVER_NO_TOOL", summary: "the server doesn't list the js tool" };
    const r = await js(c, "return (await cua.windows()).length", 30_000);
    if (r.error || !/^\d+$/.test(r.text)) return { id, status: "fail", code: "SERVER_CALL_FAILED", summary: "cua.windows() failed through the server", evidence: [r.text] };
    return { id, status: "ok", code: "SERVER_VERIFIED", summary: `launcher, MCP handshake, QuickJS and driver work (${r.text} windows listed)`, evidence: [`server ${VERSION} via ${LAUNCHER} with PATH=/usr/bin:/bin`] };
  } catch (e) {
    return { id, status: "fail", code: "SERVER_START_FAILED", summary: "the server didn't start through its launcher", evidence: [message(e)], next: "Run scripts/install.sh; it records the Node the launcher needs." };
  }
}

/** PowerShell single-quoted string. */
const q = (s: string) => `'${s.replaceAll("'", "''")}'`;

/** Build TestPad into a fresh %TEMP% folder, open notes.txt ("before") in it, and run `use`. Then
 *  close that TestPad, and only it, and delete the folder. */
export async function withTestPad<T>(use: (t: { pid: number; file: string }) => Promise<T>): Promise<T> {
  const temp = windowsDir("TEMP");
  if (!temp) throw new Error("couldn't read %TEMP% through WSL interop");
  const dir = fs.mkdtempSync(path.join(temp, "superuse-setup-"));
  const win = run("wslpath", ["-w", dir]).stdout.trim();
  let pid = 0;
  try {
    fs.copyFileSync(path.join(REPO, "bench", "apps", "TestPad.cs"), path.join(dir, "TestPad.cs"));
    fs.writeFileSync(path.join(dir, "notes.txt"), "before");
    const built = await ps(`Add-Type -TypeDefinition (Get-Content -Raw ${q(`${win}\\TestPad.cs`)}) -OutputAssembly ${q(`${win}\\TestPad.exe`)} -OutputType WindowsApplication -ReferencedAssemblies System.Windows.Forms,System.Drawing`, 120_000);
    if (!fs.existsSync(path.join(dir, "TestPad.exe"))) throw new Error(`couldn't compile the TestPad fixture: ${built.slice(-400)}`);
    pid = Number((await ps(`(Start-Process -PassThru ${q(`${win}\\TestPad.exe`)} -ArgumentList ${q(`"${win}\\notes.txt"`)}).Id`)).trim());
    return await use({ pid, file: path.join(dir, "notes.txt") });
  } finally {
    if (pid) await ps(`Stop-Process -Id ${pid} -Force -ErrorAction SilentlyContinue`);
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

export async function verifyApp(): Promise<Check> {
  const id = "verify:app";
  const expected = `superuse setup check ${randomUUID().slice(0, 8)}`;
  try {
    return await withTestPad(async ({ pid, file }): Promise<Check> => {
      await using c = await McpClient.start([LAUNCHER], { env: serverEnv({ SUPERUSE_APPS: "TestPad" }), elicit: "unsupported" });
      const r = await js(c, `let w;
for (let i = 0; i < 40 && !w; i++) { try { w = await cua.window({ pid: ${pid} }) } catch { await cua.sleep(250) } }
if (!w) throw new Error("TestPad never showed a window");
await w.setValue(await w.find("Text editor"), ${JSON.stringify(expected)});
await w.key("ctrl+s");
for (let i = 0; i < 20; i++) {
  const title = (await w.state({ query: "Text editor" })).split("\\n")[0];
  if (!title.includes("*")) return title;
  await cua.sleep(250);
}
throw new Error("TestPad still shows unsaved changes");`);
      const saved = fs.readFileSync(file, "utf8");
      if (r.error || saved !== expected) return { id, status: "fail", code: "VERIFY_APP_FAILED", summary: "the server didn't type into TestPad and save it", evidence: [`server: ${r.text.slice(0, 300)}`, `file: ${JSON.stringify(saved.slice(0, 80))}`] };
      return { id, status: "ok", code: "VERIFY_APP", summary: "typed into a test app in the background, saved it, and the file has the exact text" };
    });
  } catch (e) {
    return { id, status: "fail", code: "VERIFY_APP_FAILED", summary: "the TestPad exercise failed", evidence: [message(e)] };
  }
}

export async function verifyBrowser(): Promise<Check> {
  const id = "browser";
  const nonce = randomUUID().slice(0, 8);
  let clicked = false;
  const page = `<!doctype html><title>superuse check ${nonce}</title><p id="s">waiting ${nonce}</p>
<button onclick="fetch('/clicked?n=${nonce}').then(() => { document.getElementById('s').textContent = 'clicked ${nonce}' })">superuse check</button>`;
  const server = http.createServer((req, res) => {
    if (req.url === `/clicked?n=${nonce}`) clicked = true;
    res.setHeader("content-type", "text/html").end(page);
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const url = `http://localhost:${(server.address() as AddressInfo).port}/`;
  try {
    await using c = await McpClient.start([LAUNCHER], { env: serverEnv(), elicit: "unsupported" });
    // One window per browser, in hint order; the first that attaches runs the exercise.
    const order = browsersByHint();
    const r = await js(c, `const order = ${JSON.stringify(order)};
const rows = (await cua.windows()).filter((r) => r.id !== undefined);
const tried = [];
for (const app of order) {
  const row = rows.find((r) => r.app.toLowerCase() === app.toLowerCase());
  if (!row) continue;
  const w = await cua.window({ pid: row.pid, id: row.id });
  let p;
  try { p = await (await w.page()).newTab(${JSON.stringify(url)}); } catch (e) { tried.push(app + ": " + e.message); continue; }
  try {
    await p.waitFor("waiting ${nonce}", 15000);
    const ref = (await p.read({ query: "superuse check" })).match(/\\[([^\\]]+)\\] button "superuse check"/)?.[1];
    if (!ref) throw new Error("the test page's button isn't in the page read");
    await p.click(ref);
    await p.waitFor("clicked ${nonce}", 10000);
    return "CLICKED in " + app;
  } finally { await p.close() }
}
if (!tried.length) return "NO_APPROVED_BROWSER";
throw new Error("no browser attached. " + tried.join("; "));`, 120_000);
    if (r.text === "NO_APPROVED_BROWSER") {
      return { id, status: "action", code: "BROWSER_NOT_APPROVED", summary: "browsers: attach, but no approved Chromium browser window is open", next: "Open the browser, and approve it (add it to \"allow\" in the policy file, with the user's say-so). Then rerun scripts/doctor.sh --verify." };
    }
    if (r.error || !r.text.startsWith("CLICKED") || !clicked) {
      return { id, status: "fail", code: "BROWSER_VERIFY_FAILED", summary: "couldn't drive a test tab in the browser", evidence: [r.text.slice(0, 400), `page saw the click: ${clicked}`], next: "Turn on chrome://inspect/#remote-debugging in the browser, then rerun scripts/doctor.sh --verify. Running clients need a new session to pick up a browsers change." };
    }
    return { id, status: "ok", code: "BROWSER_VERIFIED", summary: `opened, clicked and closed an own tab ${r.text.slice(8)}` };
  } catch (e) {
    return { id, status: "fail", code: "BROWSER_VERIFY_FAILED", summary: "the browser exercise failed", evidence: [message(e)] };
  } finally {
    server.close();
  }
}
