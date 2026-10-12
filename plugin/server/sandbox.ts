// The `js` tool's runtime: model code runs in a QuickJS context (WebAssembly), with no access to
// Node, the filesystem, the network or processes. Its only capability is the `cua` API built by
// prelude.js, which calls back into the host through one function. The context persists across
// js calls (top-level let/const become globals, like a REPL) until reset().

import fs from "node:fs";
import { getQuickJS, type QuickJSContext, type QuickJSRuntime, type QuickJSWASMModule } from "quickjs-emscripten";
import { sleep } from "./driver.ts";

const PRELUDE = fs.readFileSync(new URL("./prelude.js", import.meta.url), "utf8");
const CALL_TIMEOUT_MS = 90_000; // per js call, not counting time the user spends on a prompt
const CPU_SLICE_MS = 5_000; // longest stretch of synchronous model code (an infinite loop) before interrupting
const MEMORY_LIMIT = 256 * 1024 * 1024;

export type Dispatch = (method: string, args: unknown[]) => Promise<unknown>;

/** What the prelude's __bcu_run reports for one js call. */
export type RunResult = { value: string | null; hasValue: boolean; error: string | null; errors: string[]; logs: string[] };

export class Sandbox {
  private runtime!: QuickJSRuntime;
  private ctx!: QuickJSContext;
  private generation = 0; // bumped on reset, so late host replies don't touch a disposed context
  private deadline = 0;
  private readonly qjs: QuickJSWASMModule;
  private readonly dispatch: Dispatch;
  private readonly userWaitMs: () => number;

  private constructor(qjs: QuickJSWASMModule, dispatch: Dispatch, userWaitMs: () => number) {
    this.qjs = qjs;
    this.dispatch = dispatch;
    this.userWaitMs = userWaitMs;
    this.reset();
  }

  /** `userWaitMs` returns the total time spent waiting on user prompts, which timeouts don't count. */
  static async create(dispatch: Dispatch, userWaitMs: () => number) {
    return new Sandbox(await getQuickJS(), dispatch, userWaitMs);
  }

  reset() {
    if (this.ctx) { this.ctx.dispose(); this.runtime.dispose(); }
    const gen = ++this.generation;
    const runtime = this.qjs.newRuntime();
    runtime.setMemoryLimit(MEMORY_LIMIT);
    runtime.setInterruptHandler(() => Date.now() > this.deadline);
    const ctx = runtime.newContext();
    const host = ctx.newFunction("__bcu_host", (methodH, argsH) => {
      const method = ctx.getString(methodH);
      const args: unknown = JSON.parse(ctx.getString(argsH));
      const deferred = ctx.newPromise();
      Promise.resolve()
        .then(() => this.dispatch(method, Array.isArray(args) ? args : []))
        .then(
          (v) => { if (gen === this.generation) { const h = ctx.newString(JSON.stringify(v ?? null)); deferred.resolve(h); h.dispose(); } },
          (e) => { if (gen === this.generation) { const h = ctx.newError(e instanceof Error ? e.message : String(e)); deferred.reject(h); h.dispose(); } });
      deferred.settled.then(() => { if (gen === this.generation) this.pump(); });
      return deferred.handle;
    });
    ctx.setProp(ctx.global, "__bcu_host", host);
    host.dispose();
    this.runtime = runtime;
    this.ctx = ctx;
    this.deadline = Date.now() + CPU_SLICE_MS;
    ctx.unwrapResult(ctx.evalCode(PRELUDE, "prelude.js")).dispose();
  }

  /** Run queued promise jobs, giving synchronous model code at most CPU_SLICE_MS. */
  private pump() {
    this.deadline = Date.now() + CPU_SLICE_MS;
    const r = this.runtime.executePendingJobs();
    if (r.error) r.error.dispose(); // the failing job's promise rejects inside the context, where __bcu_run sees it
  }

  async run(code: string): Promise<RunResult> {
    const ctx = this.ctx;
    this.deadline = Date.now() + CPU_SLICE_MS;
    const evaluated = ctx.evalCode(`__bcu_run(async () => {\n${hoistTopLevel(code)}\n})`, "js");
    if (evaluated.error) {
      const e = ctx.dump(evaluated.error) as { name?: string; message?: string } | string;
      evaluated.error.dispose();
      const msg = typeof e === "string" ? e : `${e.name ?? "Error"}: ${e.message ?? ""}`;
      return { value: null, hasValue: false, error: msg, errors: [], logs: [] };
    }
    const native = ctx.resolvePromise(evaluated.value);
    evaluated.value.dispose();
    this.pump();

    const started = Date.now(), waitedBefore = this.userWaitMs();
    let finished = false;
    const watchdog = (async () => {
      while (!finished) {
        await sleep(250);
        if (Date.now() - started - (this.userWaitMs() - waitedBefore) > CALL_TIMEOUT_MS) return null;
      }
      return null;
    })();
    const settled = await Promise.race([native, watchdog]);
    finished = true;
    if (!settled) {
      const reset = ctx.getProp(ctx.global, "__bcu_reset_queue");
      const r = ctx.callFunction(reset, ctx.undefined);
      (r.error ?? r.value).dispose();
      reset.dispose();
      return { value: null, hasValue: false, error: `timed out after ${CALL_TIMEOUT_MS / 1000}s; the API queue was cleared`, errors: [], logs: [] };
    }
    if (settled.error) {
      const e = ctx.dump(settled.error) as { message?: string } | string;
      settled.error.dispose();
      return { value: null, hasValue: false, error: typeof e === "string" ? e : (e.message ?? "unknown error"), errors: [], logs: [] };
    }
    const json = ctx.getString(settled.value);
    settled.value.dispose();
    return JSON.parse(json) as RunResult;
  }
}

/** Rewrite `let|const|var name =` at brace depth 0 into `name =`, so the binding lands on the
 *  context's global object and survives into the next js call. Skips strings, template literals
 *  and comments; destructuring declarations are left alone. */
export function hoistTopLevel(code: string): string {
  let out = "", depth = 0, i = 0;
  while (i < code.length) {
    const c = code[i], two = code.slice(i, i + 2);
    if (two === "//" || two === "/*") {
      const end = two === "//" ? code.indexOf("\n", i) : code.indexOf("*/", i + 2) + 2;
      const stop = end <= 0 || end === 1 ? code.length : end;
      out += code.slice(i, stop); i = stop; continue;
    }
    if (c === "'" || c === '"' || c === "`") {
      let j = i + 1;
      while (j < code.length && code[j] !== c) j += code[j] === "\\" ? 2 : 1;
      out += code.slice(i, j + 1); i = j + 1; continue;
    }
    if ("([{".includes(c)) depth++;
    else if (")]}".includes(c)) depth--;
    if (depth === 0 && /[A-Za-z_$]/.test(c) && !/[\w$.]/.test(code[i - 1] ?? "")) {
      const m = /^(let|const|var)\s+([A-Za-z_$][\w$]*)\s*=(?!=)/.exec(code.slice(i));
      if (m) { out += `${m[2]} =`; i += m[0].length; continue; }
    }
    out += c; i++;
  }
  return out;
}
