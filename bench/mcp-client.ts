// Minimal stdio MCP client, used to probe computer-use servers and time raw tool calls.
//
//   await using c = await McpClient.start(["./cua-driver.exe", "mcp"], { env });
//   const { result, ms } = await c.call("list_windows", {});
//
// Speaks the 2025-06-18 `initialize` flow, which every server here supports. Server-initiated
// elicitations (per-app approvals) are answered with the `elicit` option, so headless probes never hang.

import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { createInterface } from "node:readline";

export type Args = Record<string, unknown>;
export type ContentBlock = { type: string; text?: string; data?: string; mimeType?: string };
export type Bounds = { x: number; y: number; width: number; height: number };

/** structuredContent fields the bench and fork scripts read from cua-driver. Each tool fills a subset. */
export type Structured = Partial<{
  snapshot_id: string;
  tree_markdown: string;
  code: string;
  refusal: { code?: string; message?: string };
  error: { code?: string };
  hit_pid: number;
  pid: number;
  windows: Array<{ window_id: number; bounds?: Bounds } & Partial<Bounds>>;
  // get_browser_state and the browser_* tools
  target_id: string;
  binding_quality: string;
  tabs: Array<{ tab_id: string; url?: string }>;
  tab_id: string;
  refs: Array<{ ref: string; role?: string; name?: string }>;
  outline: string;
  value: string;
  closed: boolean;
}>;

export type ToolResult = { content?: ContentBlock[]; structuredContent?: Structured; isError?: boolean };

/** How to answer elicitations. "always" accepts and ticks the prompt's remember box. "unsupported"
 *  doesn't advertise the capability and declines any that arrive. */
export type ElicitMode = "accept" | "always" | "decline" | "unsupported";

/** `env` adds to this process's environment; an undefined value removes that variable. */
export type McpOptions = { env?: Record<string, string | undefined>; cwd?: string; elicit?: ElicitMode };

export type Message = {
  jsonrpc?: string;
  id?: number | string;
  method?: string;
  params?: unknown;
  result?: unknown;
  error?: unknown;
};

type Pending = { method: string; resolve: (result: unknown) => void; reject: (e: Error) => void };

export class McpClient {
  /** Elicitation requests the server sent, in order. */
  readonly elicitations: Message[] = [];
  /** The server's name and version from its initialize reply. */
  serverInfo: { name?: string; version?: string } = {};
  private readonly stderr: string[] = [];
  private readonly pending = new Map<number, Pending>();
  private readonly exited: Promise<void>;
  private readonly proc: ChildProcessWithoutNullStreams;
  private readonly elicit: ElicitMode;
  private nextId = 1;

  private constructor(proc: ChildProcessWithoutNullStreams, elicit: ElicitMode) {
    this.proc = proc;
    this.elicit = elicit;
    createInterface({ input: proc.stdout }).on("line", (line) => this.onLine(line));
    createInterface({ input: proc.stderr }).on("line", (line) => this.stderr.push(line.trimEnd()));
    const fail = (why: string) => {
      for (const p of this.pending.values()) p.reject(new Error(`${p.method}: ${why}; stderr tail: ${this.stderrTail()}`));
      this.pending.clear();
    };
    // "close" comes after stdout is drained, so a reply sent just before exiting still lands.
    proc.on("error", (e) => fail(e.message));
    proc.on("close", () => fail("the server exited"));
    this.exited = new Promise((resolve) => proc.on("exit", () => resolve()));
  }

  /** Spawn the server and run the initialize handshake. */
  static async start(argv: string[], opts: McpOptions = {}): Promise<McpClient> {
    const [command, ...args] = argv;
    const proc = spawn(command, args, { env: { ...process.env, ...opts.env }, cwd: opts.cwd });
    const c = new McpClient(proc, opts.elicit ?? "accept");
    try {
      const init = await c.request("initialize", {
        protocolVersion: "2025-06-18",
        capabilities: c.elicit === "unsupported" ? {} : { elicitation: {} },
        clientInfo: { name: "bcu-bench", version: "0.1" },
      }) as { serverInfo?: McpClient["serverInfo"] };
      c.serverInfo = init.serverInfo ?? {};
    } catch (e) {
      await c.close();
      throw e;
    }
    c.send({ jsonrpc: "2.0", method: "notifications/initialized" });
    return c;
  }

  /** Send a request and wait for its result; a JSON-RPC error or no reply in time throws. */
  async request(method: string, params: object, timeoutMs = 120_000): Promise<unknown> {
    const id = this.nextId++;
    const { promise, resolve, reject } = Promise.withResolvers<unknown>();
    this.pending.set(id, { method, resolve, reject });
    const timer = setTimeout(() => reject(new Error(`timeout waiting for ${method}; stderr tail: ${this.stderrTail()}`)), timeoutMs);
    this.send({ jsonrpc: "2.0", id, method, params });
    try {
      return await promise;
    } finally {
      clearTimeout(timer);
      this.pending.delete(id);
    }
  }

  /** Call a tool; `ms` is the round trip as this client saw it. */
  async call(name: string, args: Args, timeoutMs = 120_000): Promise<{ result: ToolResult; ms: number }> {
    const t0 = performance.now();
    // The JSON-RPC boundary: tool results are whatever the server sent.
    const result = (await this.request("tools/call", { name, arguments: args }, timeoutMs)) as ToolResult;
    return { result, ms: performance.now() - t0 };
  }

  /** Close the server's stdin and wait for it to exit; kill it after 10 s. */
  async close(): Promise<void> {
    if (this.proc.exitCode !== null || this.proc.signalCode !== null) return;
    this.proc.stdin.end();
    const timer = setTimeout(() => this.proc.kill("SIGKILL"), 10_000);
    await this.exited;
    clearTimeout(timer);
  }

  [Symbol.asyncDispose](): Promise<void> {
    return this.close();
  }

  private send(msg: Message) {
    this.proc.stdin.write(JSON.stringify(msg) + "\n");
  }

  private stderrTail() {
    return JSON.stringify(this.stderr.slice(-5));
  }

  private onLine(line: string) {
    let msg: Message;
    try {
      msg = JSON.parse(line);
    } catch {
      return;
    }
    if (msg.method !== undefined && msg.id !== undefined) { // server -> client request
      if (msg.method !== "elicitation/create") {
        this.send({ jsonrpc: "2.0", id: msg.id, result: {} });
        return;
      }
      this.elicitations.push(msg);
      const content = this.elicit === "always" ? { remember: true } : this.elicit === "accept" ? { persist: "session" } : null;
      this.send({ jsonrpc: "2.0", id: msg.id, result: { action: content ? "accept" : "decline", content } });
      return;
    }
    const p = typeof msg.id === "number" ? this.pending.get(msg.id) : undefined;
    if (!p) return;
    if (msg.error !== undefined) p.reject(new Error(`${p.method}: ${JSON.stringify(msg.error)}`));
    else p.resolve(msg.result);
  }
}

/** Concatenate the text blocks of a tool result. */
export function textOf(result: ToolResult): string {
  return (result.content ?? []).filter((b) => b.type === "text").map((b) => b.text ?? "").join("\n");
}
