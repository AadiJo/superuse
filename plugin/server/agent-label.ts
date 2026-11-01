// The label the driver draws in the badge under this server's agent cursor, so a user watching
// several agents at once can tell them apart: the MCP client's name plus the lowest number no other
// running server holds, e.g. "Claude Code 1" and "Claude Code 2". SUPERUSE_AGENT replaces it.

import net from "node:net";
import os from "node:os";

// The badge is at most 188 px wide (BADGE_MAX_WIDTH in driver/crates/cursor-overlay/src/session_badge.rs)
// and ellipsizes what doesn't fit. Beside its action chip about 19 characters fit, so a derived label
// stays under that and the number at its end always shows.
const LABEL_CHARS = 18;
// Clients whose clientInfo carries no display `title`, by `name`.
const CLIENT_TITLES: Record<string, string> = { "codex-mcp-client": "Codex" };

/** Abstract socket that holds number `n` (Linux): only one live process can listen on it, and the
 *  kernel frees it when that process dies, however it dies. bench/agent-labels.ts reads these. */
const slotSocket = (n: number) => `\0superuse-agent-${os.userInfo().uid}-${n}`;

let held: net.Server | undefined; // the slot's listener, kept referenced for the life of this process
let number: Promise<number> | undefined;

/** Listen on the lowest free slot socket and keep it for the life of this process. */
async function claimNumber(): Promise<number> {
  for (let n = 1; ; n++) {
    const server = net.createServer();
    const ok = await new Promise<boolean>((resolve, reject) => {
      server.once("error", (e: NodeJS.ErrnoException) => (e.code === "EADDRINUSE" ? resolve(false) : reject(e)));
      server.listen(slotSocket(n), () => resolve(true));
    });
    if (ok) {
      server.unref(); // holding the number mustn't keep the server running
      held = server;
      return n;
    }
  }
}

/** The cursor label for the client that sent `initialize` (its display title, else its name).
 *  The number is claimed on the first call and kept for the life of this process. */
export async function agentLabel(client: { name?: unknown; title?: unknown } = {}): Promise<string> {
  const custom = process.env.SUPERUSE_AGENT?.trim();
  if (custom) return custom;
  const text = (v: unknown) => (typeof v === "string" ? v.trim() : "");
  const name = text(client.title) || CLIENT_TITLES[text(client.name)] || text(client.name) || "superuse";
  number ??= claimNumber().catch(() => process.pid); // no abstract sockets: the pid is distinct too
  const suffix = ` ${await number}`;
  return Array.from(name).slice(0, Math.max(1, LABEL_CHARS - suffix.length)).join("") + suffix;
}
