// Runs inside the QuickJS sandbox before any model code. Model code sees `cua`, `log`, `console`
// and `setTimeout`. Its only way out of the sandbox is `host(method, argsJson)`, captured below and
// removed from the global object; the host validates every call (desktop.ts).
//
// API calls run one at a time in the order they were written, whether or not the model awaits
// them: `w.setValue(...); await w.menu(...)` must not race. A call's arguments may be promises
// (an un-awaited `w.find(...)`); they resolve inside the queue, just before the call runs.
(() => {
  const host = globalThis.__bcu_host;
  delete globalThis.__bcu_host;

  const METHODS = ["state", "find", "click", "setValue", "select", "type", "key", "drag", "menu", "screenshot", "waitFor"];
  const isThenable = (x) => !!x && typeof x.then === "function";
  const message = (e) => (e && typeof e.message === "string" ? e.message : String(e));
  const show = (v) => {
    if (typeof v === "string") return v;
    try { return JSON.stringify(v); } catch { return String(v); }
  };

  let tail = Promise.resolve();
  let pending = []; // every API call and log() started during the current js call
  let errors = []; // failures of API calls, reported even when nobody awaited them
  let logs = [];
  let nextHandle = 0;

  function call(method, args) {
    const run = tail.then(async () => {
      const resolved = await Promise.all(args.map((a) => (isThenable(a) ? a : Promise.resolve(a))));
      return JSON.parse(await host(method, JSON.stringify(resolved)));
    });
    tail = run.then(() => {}, () => {});
    pending.push(run.then(() => {}, (e) => { errors.push(message(e)); }));
    return run;
  }

  /** Resolve promises the model returned without awaiting, e.g. `return [cua.windows(), w.state()]`. */
  async function settle(v) {
    if (isThenable(v)) v = await v;
    if (Array.isArray(v)) return Promise.all(v);
    if (v && typeof v === "object" && Object.values(v).some(isThenable)) {
      const entries = await Promise.all(Object.entries(v).map(async ([k, x]) => [k, await x]));
      return Object.fromEntries(entries);
    }
    return v;
  }

  function methodsFor(handle) {
    const m = {};
    for (const name of METHODS) m[name] = (...a) => call(`w.${name}`, [handle, ...a]);
    return m;
  }

  /** `cua.window(...)` and `cua.open(...)` work with or without `await`: methods queue behind the
   *  binding, and awaiting yields the same methods plus {pid, id, app, title}. */
  function bindWindow(method, args) {
    const handle = ++nextHandle;
    const binding = call(method, [handle, ...args]);
    const methods = methodsFor(handle);
    const bound = (info) => Object.freeze({ ...info, ...methods, toJSON: () => info });
    return Object.freeze({ ...methods, then: (ok, err) => binding.then(bound).then(ok, err) });
  }

  const cua = Object.freeze({
    windows: (filter) => call("cua.windows", [filter]),
    window: (query) => bindWindow("cua.window", [query]),
    open: (name, opts) => bindWindow("cua.open", [name, opts]),
    sleep: (ms) => call("cua.sleep", [ms]),
  });

  function log(...args) {
    const slot = logs.push("") - 1;
    pending.push(Promise.all(args.map(settle)).then(
      (vals) => { logs[slot] = vals.map(show).join(" "); },
      (e) => { logs[slot] = `log() argument failed: ${message(e)}`; }));
  }

  const fixed = (name, value) => Object.defineProperty(globalThis, name, { value, writable: false, configurable: false });
  fixed("cua", cua);
  fixed("log", log);
  fixed("console", Object.freeze({ log, info: log, warn: log, error: log }));
  // Delays are capped host-side: reads already wait for the UI to settle.
  fixed("setTimeout", (fn, ms) => { call("cua.sleep", [ms]).then(() => fn()); });

  /** Called by the host once per js call with the model's code wrapped in an async function. */
  fixed("__bcu_run", async (fn) => {
    pending = []; errors = []; logs = [];
    let value, error = null;
    try { value = await settle(await fn()); } catch (e) { error = message(e); }
    for (let i = 0; i < 5 && pending.length; i++) { // un-awaited calls and logs finish first
      const batch = pending;
      pending = [];
      await Promise.all(batch);
    }
    return JSON.stringify({ value: value === undefined ? null : show(value), hasValue: value !== undefined, error, errors, logs });
  });

  /** After a timed-out call, let new calls run instead of queueing behind the stuck one. */
  fixed("__bcu_reset_queue", () => { tail = Promise.resolve(); });
})();
