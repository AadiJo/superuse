// End-to-end check of "browsers": "tab", through the real plugin server and driver, on the user's
// own open browser.
//
//   node bench/tab-scope.ts [--title Helium]
//
// One session under "attach" opens a background tab on a page served from here. That tab stands in
// for a tab of the user's: a second session, under "tab", didn't open it and it isn't selected. The
// "tab" session must not list it, find it by title, or name it in an error, while it still reaches
// the selected tab and a tab of its own. Both test tabs are closed at the end.
//
// Only tab counts and the test pages' own titles are read, never the user's tabs. Each session
// attaches to the browser, so its "Allow remote debugging?" prompt shows once per session. Writes
// bench/out/tab-scope-<time>.json.

import { once } from "node:events";
import { mkdirSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import path from "node:path";
import { parseArgs } from "node:util";
import { McpClient, textOf } from "./mcp-client.ts";
import { timestamp } from "./win.ts";

const REPO = path.dirname(import.meta.dirname);
const OUT = path.join(REPO, "bench", "out");
const PORT = 8766;
const OTHER = "Superuse other tab";
const OWN = "Superuse own tab";

const { values: flags } = parseArgs({ options: { title: { type: "string", default: "Helium" } } });

/** /other and /own each serve a page with that title. */
const pages = createServer((req, res) => {
  const title = req.url?.startsWith("/other") ? OTHER : OWN;
  res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
  res.end(`<!doctype html><title>${title}</title><h1>${title}</h1>`);
});

type Result = { case: string; ok: boolean; detail: string };
const results: Result[] = [];
function check(name: string, ok: boolean, detail: string) {
  results.push({ case: name, ok, detail: detail.slice(0, 400) });
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}: ${detail.slice(0, 200)}`);
}

const session = (browsers: "tab" | "attach") =>
  McpClient.start(["node", path.join(REPO, "plugin/server/main.ts")], { env: { SUPERUSE_AUDIT: "off", SUPERUSE_BROWSERS: browsers, SUPERUSE_APPS: "chrome" } });

async function js(c: McpClient, code: string): Promise<{ text: string; error: boolean }> {
  const { result } = await c.call("js", { code: `const w = await desktop.window({app: "chrome", title: ${JSON.stringify(flags.title)}});\n${code}` }, 120_000);
  return { text: textOf(result), error: !!result.isError };
}

/** Titles of the test pages among `p.tabs()`, and how many tabs it lists in all. */
const TABS = `const tabs = await (await w.page()).tabs(); return JSON.stringify({count: tabs.length, test: tabs.map((t) => t.title).filter((t) => t.startsWith("Superuse "))})`;
type Tabs = { count: number; test: string[] };
const tabsOf = (r: { text: string; error: boolean }): Tabs => (r.error ? { count: -1, test: [r.text] } : JSON.parse(r.text) as Tabs);

process.chdir(REPO);
mkdirSync(OUT, { recursive: true });
pages.listen(PORT, "127.0.0.1");
await once(pages, "listening");
const url = (name: string) => `http://127.0.0.1:${PORT}/${name}`;
let all: Tabs | undefined;
let scoped: Tabs | undefined;
try {
  await using attach = await session("attach");
  let r = await js(attach, `globalThis.other = await (await w.page()).newTab(${JSON.stringify(url("other"))}); await other.waitFor(${JSON.stringify(OTHER)}, 15000); return "opened"`);
  check("an attach session opens the stand-in tab", !r.error, r.text);
  all = tabsOf(await js(attach, TABS));
  check("attach lists every tab", all.count >= 2 && all.test.includes(OTHER), `${all.count} tab(s), test tabs: ${JSON.stringify(all.test)}`);
  r = await js(attach, `return (await w.page(${JSON.stringify(OTHER)})).title`);
  check("attach finds the stand-in tab by title", !r.error && r.text.includes(OTHER), r.text);

  {
    await using tab = await session("tab");
    scoped = tabsOf(await js(tab, TABS));
    check("tab lists only the selected tab", scoped.count === 1 && scoped.test.length === 0, `${scoped.count} tab(s) of ${all.count}, test tabs: ${JSON.stringify(scoped.test)}`);
    r = await js(tab, `try { await w.page(${JSON.stringify(OTHER)}); return "BOUND" } catch (e) { return e.message }`);
    check("tab can't find the stand-in tab by title", /no tab you can reach matches/.test(r.text), r.text);
    check("the refusal lists no tab titles", !/Tabs:/.test(r.text), r.text);
    r = await js(tab, `return (await w.page()).title === undefined ? "no page" : "bound"`);
    check("tab still binds the selected tab", !r.error && r.text.includes("bound"), r.text);
    r = await js(tab, `globalThis.own = await (await w.page()).newTab(${JSON.stringify(url("own"))}); await own.waitFor(${JSON.stringify(OWN)}, 15000); return "opened"`);
    check("tab opens its own tab", !r.error, r.text);
    const withOwn = tabsOf(await js(tab, TABS));
    check("tab lists its own tab, and still not the stand-in", withOwn.count === 2 && withOwn.test.join() === OWN, `${withOwn.count} tab(s), test tabs: ${JSON.stringify(withOwn.test)}`);
    r = await js(tab, `return (await (await w.page(${JSON.stringify(OWN)})).read()).split("\\n")[0]`);
    check("tab finds its own tab by title", !r.error && r.text.includes(OWN), r.text);
    r = await js(tab, `await own.close(); return (await (await w.page()).tabs()).length`);
    check("closing its own tab leaves the selected tab", !r.error && r.text.trim() === "1", r.text);
  }

  r = await js(attach, `await other.close(); return "closed"`);
  check("the stand-in tab is closed", !r.error, r.text);
} finally {
  pages.close();
  pages.closeAllConnections();
}

const out = path.join(OUT, `tab-scope-${timestamp()}.json`);
writeFileSync(out, JSON.stringify({ all, scoped, results }, null, 2));
console.log(out);
process.exitCode = results.every((r) => r.ok) ? 0 : 1;
