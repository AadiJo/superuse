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
import { openFormPage } from "./tasks.ts";
import { killBenchEdge, listWindows, timestamp } from "./win.ts";

const REPO = path.dirname(import.meta.dirname);
const SERVER = [path.join(REPO, "plugin/server/run.sh")];

type Result = { case: string; ok: boolean; detail: string };
const results: Result[] = [];

function check(name: string, ok: boolean, detail: string) {
  results.push({ case: name, ok, detail: detail.slice(0, 2000) });
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}: ${detail.slice(0, 160)}`);
}

const policy = path.join(mkdtempSync(path.join(tmpdir(), "bcu-")), "policy.json");
writeFileSync(policy, JSON.stringify({ allow: ["msedge"], foreground: "deny" }));

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

const CASES: Record<string, () => Promise<void>> = {
  // Chromium builds a page's accessibility tree only after the first UIA client connects. In a
  // browser or Electron app launched without --force-renderer-accessibility, the first read used
  // to return the browser's own chrome (20 rows) and no page; a read 0.1 s later had all of it.
  async cold_chromium() {
    const fields = Array.from({ length: 40 }, (_, i) => `<label>Field ${i} <input></label>`).join("");
    const hwnd = await edgePage("Cold page", `<!doctype html><title>Cold page</title><form>${fields}</form>`, false);
    await using c = await McpClient.start(SERVER, { env: { BCU_POLICY: policy, BCU_AUDIT: "off" }, elicit: "unsupported" });
    const r = await js(c, `return await (await cua.window({id: ${hwnd}})).state({max: 1000})`);
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
