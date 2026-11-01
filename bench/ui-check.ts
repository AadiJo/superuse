// End-to-end checks of the window API (w.*) on fixture windows, through the real plugin server and
// driver.
//
//   node bench/ui-check.ts [case ...]   writes bench/out/ui-check-<time>.json, exits 1 on any failure
//
// Unlike server-check.ts it opens windows (the benchmark's throwaway Edge) and sends input to them,
// so run it on an idle desktop. Each case names the failure it guards against.

import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import { McpClient, textOf } from "./mcp-client.ts";
import { editAppendSetup, openFormPage } from "./tasks.ts";
import { killBenchEdge, killTestPad, listWindows, timestamp } from "./win.ts";

const REPO = path.dirname(import.meta.dirname);
const SERVER = [path.join(REPO, "plugin/server/run.sh")];

type Result = { case: string; ok: boolean; detail: string };
const results: Result[] = [];

function check(name: string, ok: boolean, detail: string) {
  results.push({ case: name, ok, detail: detail.slice(0, 2000) });
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}: ${detail.slice(0, 160)}`);
}

const policy = path.join(mkdtempSync(path.join(tmpdir(), "superuse-")), "policy.json");
writeFileSync(policy, JSON.stringify({ allow: ["msedge", "TestPad"], foreground: "deny" }));

async function js(c: McpClient, code: string): Promise<{ text: string; error: boolean }> {
  const { result } = await c.call("js", { code }, 90_000);
  return { text: textOf(result), error: !!result.isError };
}

/** Open `html` in the throwaway Edge and return the hwnd of its window, found by `title`. */
async function edgePage(title: string, html: string, forceAccessibility = true): Promise<number> {
  await killBenchEdge(); // a running bench Edge would already have built the page's tree
  await openFormPage("ui_check", html, { forceAccessibility });
  for (let i = 0; i < 50; i++) {
    const w = (await listWindows(true)).find((x) => x.proc === "msedge" && x.title.startsWith(title));
    if (w) return w.hwnd;
    await sleep(200);
  }
  throw new Error(`no Edge window titled ${title}`);
}

/** A form whose buttons change the tree above and inside it. The title reports each field. */
const SHIFTING_FORM = `<!doctype html><title>Shift form</title><form><div id="top"></div>
<label id="name-row">Name <input id="name"></label><label id="email-row">Email <input id="email"></label>
<button type="button" onclick="addNote()">Add note</button>
<button type="button" onclick="document.getElementById('email-row').remove()">Remove email</button></form><script>
function addNote() { const l = document.createElement('label'); l.innerHTML = 'Note <input id="note">'; document.getElementById('top').appendChild(l); }
const v = id => document.getElementById(id)?.value ?? '-';
setInterval(() => document.title = 'Shift form name=' + v('name') + '|email=' + v('email') + '|note=' + v('note'), 100);
</script>`;

/** The title of the bench Edge window showing SHIFTING_FORM, a moment after the last input. */
async function formTitle(): Promise<string> {
  await sleep(400);
  return (await listWindows(true)).find((w) => w.proc === "msedge" && w.title.startsWith("Shift form"))?.title ?? "";
}

const server = () => McpClient.start(SERVER, { env: { SUPERUSE_POLICY: policy, SUPERUSE_AUDIT: "off" }, elicit: "unsupported" });

const CASES: Record<string, () => Promise<void>> = {
  // The driver numbers rows anew in each snapshot. A number read before the tree grew used to land
  // on whatever row took its place: setValue(Email) wrote into Name once a field appeared above.
  async shifted_tree() {
    const hwnd = await edgePage("Shift form", SHIFTING_FORM);
    await using c = await server();
    const r = await js(c, `const w = await desktop.window({id: ${hwnd}});
const email = await w.find("Email", "Edit");
await w.click(await w.find("Add note", "Button"));
await w.state();
await w.setValue(email, "x@example.com");
return email;`);
    const title = await formTitle();
    check("a number keeps its element after the tree changes", !r.error && title.includes("email=x@example.com|"), `${r.text} | ${title}`);
  },
  // A number whose element left the window must be refused, not sent to whatever has that number now.
  async removed_element() {
    const hwnd = await edgePage("Shift form", SHIFTING_FORM);
    await using c = await server();
    const r = await js(c, `const w = await desktop.window({id: ${hwnd}});
const email = await w.find("Email", "Edit");
await w.click(await w.find("Remove email", "Button"));
await w.state();
await w.setValue(email, "x@example.com");`);
    const title = await formTitle();
    check("a number whose element is gone is refused", r.error && /no longer/.test(r.text) && !title.includes("x@example.com"), `${r.text} | ${title}`);
  },
  // Models rebind the window in each js call. Numbers kept from an earlier call must still work.
  async rebound_window() {
    const hwnd = await edgePage("Shift form", SHIFTING_FORM);
    await using c = await server();
    await js(c, `globalThis.name = await (await desktop.window({id: ${hwnd}})).find("Name", "Edit")`);
    const r = await js(c, `await (await desktop.window({id: ${hwnd}})).setValue(name, "Ada")`);
    const title = await formTitle();
    check("numbers survive rebinding the window", !r.error && title.includes("name=Ada|"), `${r.text} | ${title}`);
  },
  // TestPad's editor value spans lines ("first line\r\nsecond line..."). A row the renumbering
  // didn't recognize kept the driver's [0] while 0 went to another row, so setValue(editor) hit File.
  async multiline_value() {
    await killTestPad();
    await editAppendSetup();
    await using c = await server();
    const r = await js(c, `const w = await desktop.window("TestPad");
const ed = await w.find("Text editor", "Edit");
await w.setValue(ed, "replaced");
return await w.state({query: "Text editor"});`);
    await killTestPad();
    check("a row whose value spans lines keeps its number", !r.error && r.text.includes('value="replaced"'), r.text);
  },
  // A diff read lists what changed under the numbers the model already has.
  async diff_read() {
    const hwnd = await edgePage("Shift form", SHIFTING_FORM);
    await using c = await server();
    const r = await js(c, `const w = await desktop.window({id: ${hwnd}});
const before = await w.state();
await w.click(await w.find("Add note", "Button"));
return [before, await w.state({diff: true})];`);
    const [before, diff] = r.text.startsWith("[") ? JSON.parse(r.text) as string[] : ["", ""];
    const email = before.match(/\[(\d+)\] Edit "Email"/)?.[1];
    check("a diff read adds the new row and keeps old numbers", !r.error && /^\+ .*Edit "Note"/m.test(diff) && !!email && !new RegExp(`Edit "Email"`).test(diff) && before.includes(`[${email}] Edit "Email"`), diff);
  },
  // The driver searches up to 5,000 elements for a query, against 250 for a plain read. Reading the
  // whole tree to number it must keep that reach: find() of a field past element 250 found nothing.
  async deep_query() {
    const buttons = Array.from({ length: 400 }, (_, i) => `<button type="button">Filler ${i}</button>`).join("");
    const hwnd = await edgePage("Deep form", `<!doctype html><title>Deep form</title><form>${buttons}<label>Needle <input id="needle"></label></form>`);
    await using c = await server();
    const r = await js(c, `const w = await desktop.window({id: ${hwnd}});
const n = await w.find("Needle", "Edit");
const t0 = Date.now();
await w.setValue(n, "found");
const rows = await w.state({query: "Needle"});
return {n, rows, ms: Date.now() - t0};`);
    check("find() and query reads reach past the plain read's 250 elements", !r.error && r.text.includes('value=\\"found\\"'), r.text);
  },
  // Chromium builds a page's accessibility tree only after the first UIA client connects. In a
  // browser or Electron app launched without --force-renderer-accessibility, the first read used
  // to return the browser's own chrome (20 rows) and no page; a read 0.1 s later had all of it.
  async cold_chromium() {
    const fields = Array.from({ length: 40 }, (_, i) => `<label>Field ${i} <input></label>`).join("");
    const hwnd = await edgePage("Cold page", `<!doctype html><title>Cold page</title><form>${fields}</form>`, false);
    await using c = await server();
    const r = await js(c, `return await (await desktop.window({id: ${hwnd}})).state({max: 1000})`);
    check("a window's first read shows a page Chromium hadn't built yet", !r.error && r.text.includes('Edit "Field 39"'), r.text);
  },
};

const picked = process.argv.slice(2);
for (const name of picked.length ? picked : Object.keys(CASES)) {
  const run = CASES[name];
  if (!run) throw new Error(`unknown case ${name}; cases: ${Object.keys(CASES).join(", ")}`);
  try {
    await run();
  } catch (e) {
    check(name, false, `threw: ${e instanceof Error ? e.message : String(e)}`);
  }
}
await killBenchEdge();

const out = path.join(REPO, "bench", "out", `ui-check-${timestamp()}.json`);
mkdirSync(path.dirname(out), { recursive: true });
writeFileSync(out, JSON.stringify(results, null, 2));
const failed = results.filter((r) => !r.ok);
console.log(`${results.length - failed.length}/${results.length} passed; ${out}`);
process.exitCode = failed.length ? 1 : 0;
