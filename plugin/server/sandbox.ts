// The `js` tool's runtime: model code runs in a QuickJS context (WebAssembly), with no access to
// Node, the filesystem, the network or processes. Its only capability is the `desktop` API built by
// prelude.js, which calls back into the host through one function. The context persists across
// js calls (top-level let/const become globals, like a REPL) until reset().

import fs from "node:fs";
import { getQuickJS, type QuickJSContext, type QuickJSDeferredPromise, type QuickJSRuntime, type QuickJSWASMModule } from "quickjs-emscripten";
import { sleep } from "./driver.ts";

const PRELUDE = fs.readFileSync(new URL("./prelude.js", import.meta.url), "utf8");
// Per js call, not counting time the user spends on a prompt. SUPERUSE_CALL_TIMEOUT_MS overrides (tests).
const CALL_TIMEOUT_MS = Number(process.env.SUPERUSE_CALL_TIMEOUT_MS) || 90_000;
const CPU_SLICE_MS = 5_000; // longest stretch of synchronous model code (an infinite loop) before interrupting
const MEMORY_LIMIT = 256 * 1024 * 1024;

export type Dispatch = (method: string, args: unknown[]) => Promise<unknown>;

/** What the prelude's __superuse_run reports for one js call. */
export type RunResult = { value: string | null; hasValue: boolean; error: string | null; errors: string[]; logs: string[] };

export class Sandbox {
  private runtime!: QuickJSRuntime;
  private ctx!: QuickJSContext;
  private generation = 0; // bumped on reset, so late host replies don't touch a disposed context
  private deadline = 0;
  // Host calls still in flight. reset() must dispose them first: QuickJS refuses to free a runtime
  // that still has live handles, and that would take the whole server down.
  private readonly inFlight = new Set<QuickJSDeferredPromise>();
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
    if (this.ctx) {
      for (const d of this.inFlight) d.dispose();
      this.inFlight.clear();
      this.ctx.dispose();
      this.runtime.dispose();
    }
    const gen = ++this.generation;
    const runtime = this.qjs.newRuntime();
    runtime.setMemoryLimit(MEMORY_LIMIT);
    runtime.setInterruptHandler(() => Date.now() > this.deadline);
    const ctx = runtime.newContext();
    const host = ctx.newFunction("__superuse_host", (methodH, argsH) => {
      const method = ctx.getString(methodH);
      const args: unknown = JSON.parse(ctx.getString(argsH));
      const deferred = ctx.newPromise();
      this.inFlight.add(deferred);
      Promise.resolve()
        .then(() => this.dispatch(method, Array.isArray(args) ? args : []))
        .then(
          (v) => { if (gen === this.generation) { const h = ctx.newString(JSON.stringify(v ?? null)); deferred.resolve(h); h.dispose(); } },
          (e) => { if (gen === this.generation) { const h = ctx.newError(e instanceof Error ? e.message : String(e)); deferred.reject(h); h.dispose(); } });
      deferred.settled.then(() => { this.inFlight.delete(deferred); if (gen === this.generation) this.pump(); });
      return deferred.handle;
    });
    ctx.setProp(ctx.global, "__superuse_host", host);
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
    if (r.error) r.error.dispose(); // the failing job's promise rejects inside the context, where __superuse_run sees it
  }

  async run(code: string): Promise<RunResult> {
    const ctx = this.ctx;
    this.deadline = Date.now() + CPU_SLICE_MS;
    const evaluated = ctx.evalCode(`__superuse_run(async () => {\n${hoistTopLevel(code)}\n})`, "js");
    const gen = this.generation;
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
      // The abandoned run may still settle later; free its result handle when it does.
      native.then((late) => { if (gen === this.generation) (late.error ?? late.value).dispose(); }, () => {});
      const reset = ctx.getProp(ctx.global, "__superuse_reset_queue");
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

/** Make top-level declarations survive into the next js call, like a REPL. The code runs inside an
 *  async function, so at brace depth 0:
 *    `let|const|var name =`  ->  `name =` (an assignment to the context's global object)
 *    `class Name`            ->  `Name = class Name`
 *    `function name(...)`    ->  kept (so it's still hoisted), plus `globalThis.name = name;` at the top
 *  Skips strings, template literals and comments; destructuring declarations are left alone. */
export function hoistTopLevel(code: string): string {
  let out = "", depth = 0, i = 0;
  const functions: string[] = [];
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
      const rest = code.slice(i);
      const m = /^(let|const|var)\s+([A-Za-z_$][\w$]*)\s*=(?!=)/.exec(rest);
      if (m) { out += `${m[2]} =`; i += m[0].length; continue; }
      // Declarations start a statement; `x = function f() {}` and `new class C {}` are expressions.
      const prev = out.trimEnd().slice(-1);
      const statementStart = prev === "" || prev === ";" || prev === "}";
      const cls = statementStart ? /^class\s+([A-Za-z_$][\w$]*)/.exec(rest) : null;
      if (cls) { out += `${cls[1]} = class ${cls[1]}`; i += cls[0].length; continue; }
      const fn = statementStart ? /^(?:async\s+)?function\s*\*?\s*([A-Za-z_$][\w$]*)\s*\(/.exec(rest) : null;
      if (fn) functions.push(fn[1]);
    }
    out += c; i++;
  }
  return functions.map((f) => `globalThis.${f} = ${f};`).join(" ") + (functions.length ? "\n" : "") + out;
}
