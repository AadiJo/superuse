// End-to-end check that agents running side by side get told apart on screen: two plugin servers
// (plugin/server/run.sh, each with its own driver and agent cursor) start at once, each clicks in
// its own fixture window, and a screen capture shows both cursors with their labels.
//
//   flock /tmp/superuse-desktop.lock node bench/agent-labels.ts
//
// Both servers get the same clientInfo, as two sessions of one client would, so the labels differ
// only by what the server adds per process. A third server initializes and stays idle; it must hold
// no number. Sends input to two MenuPad windows it opens and closes
// itself. Writes bench/out/agent-labels-<time>/ with labels.png (both cursors, just after the
// clicks), later frames as the badges fade, and result.json with the labels each server should show.

import { execFileSync } from "node:child_process";
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, readlinkSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import { McpClient, textOf } from "./mcp-client.ts";
import { start } from "./tasks.ts";
import { listWindows, ps, timestamp, WIN_TEMP, WSL_TEMP, type Win } from "./win.ts";

const REPO = path.dirname(import.meta.dirname);
const OUT = path.join(REPO, "bench", "out", `agent-labels-${timestamp()}`);
const FRAMES = 8;
const FRAME_MS = 250;

/** Build bench/apps/MenuPad.cs into %TEMP%\superuse\MenuPad.exe if it's stale, start one at (x, y)
 *  with `title`, and return its window. */
async function openMenupad(x: number, y: number, title: string): Promise<Win> {
  const src = path.join(REPO, "bench", "apps", "MenuPad.cs");
  const exe = path.join(WSL_TEMP, "MenuPad.exe");
  if (!existsSync(exe) || statSync(exe).mtimeMs < statSync(src).mtimeMs) {
    mkdirSync(WSL_TEMP, { recursive: true });
    copyFileSync(src, path.join(WSL_TEMP, "MenuPad.cs"));
    await ps(`Remove-Item '${WIN_TEMP}\\MenuPad.exe' -ErrorAction SilentlyContinue
Add-Type -TypeDefinition (Get-Content -Raw '${WIN_TEMP}\\MenuPad.cs') -OutputAssembly '${WIN_TEMP}\\MenuPad.exe' -OutputType WindowsApplication -ReferencedAssemblies System.Windows.Forms,System.Drawing`, 120_000);
  }
  await start(`${WIN_TEMP}\\MenuPad.exe`, "--topmost", "--at", String(x), String(y), "--title", title);
  for (let i = 0; i < 40; i++) {
    const found = (await listWindows(true)).find((w) => w.proc === "MenuPad" && w.title === title);
    if (found) return found;
    await sleep(250);
  }
  throw new Error(`MenuPad window ${title} never showed`);
}

/** Capture the screen around both windows: wait for `go` to exist, then take FRAMES frames,
 *  FRAME_MS apart, into `dir`. Writes `ready` once compiled, so input can wait for it. */
function captureFrames(hwnds: number[], dir: string): Promise<string> {
  return ps(`Add-Type -ReferencedAssemblies System.Drawing -TypeDefinition @"
using System; using System.Drawing; using System.Drawing.Imaging; using System.Runtime.InteropServices;
public static class LabelShots {
  [DllImport("user32.dll")] static extern IntPtr SetThreadDpiAwarenessContext(IntPtr c);
  [StructLayout(LayoutKind.Sequential)] public struct RECT { public int L, T, R, B; }
  [DllImport("dwmapi.dll")] static extern int DwmGetWindowAttribute(IntPtr h, int attr, out RECT r, int size);
  // The windows' visible frames only (DWMWA_EXTENDED_FRAME_BOUNDS), so no other window gets in the shot.
  public static int[] Area(long[] hwnds) {
    SetThreadDpiAwarenessContext(new IntPtr(-4));
    int l = int.MaxValue, t = int.MaxValue, r = int.MinValue, b = int.MinValue;
    foreach (var h in hwnds) { RECT w; DwmGetWindowAttribute(new IntPtr(h), 9, out w, 16); l = Math.Min(l, w.L); t = Math.Min(t, w.T); r = Math.Max(r, w.R); b = Math.Max(b, w.B); }
    return new[] { l, t, r - l, b - t };
  }
  public static void Capture(int[] a, string path) {
    SetThreadDpiAwarenessContext(new IntPtr(-4));
    using (var bmp = new Bitmap(a[2], a[3], PixelFormat.Format32bppArgb)) {
      using (var g = Graphics.FromImage(bmp)) g.CopyFromScreen(a[0], a[1], 0, 0, bmp.Size);
      bmp.Save(path, ImageFormat.Png);
    }
  }
}
"@
$area = [LabelShots]::Area([long[]]@(${hwnds.join(",")}))
New-Item -ItemType File '${dir}\\ready' -Force | Out-Null
$deadline = (Get-Date).AddSeconds(60)
while (-not (Test-Path '${dir}\\go') -and (Get-Date) -lt $deadline) { Start-Sleep -Milliseconds 25 }
for ($i = 0; $i -lt ${FRAMES}; $i++) {
  [LabelShots]::Capture($area, "${dir}\\frame-$i.png")
  Start-Sleep -Milliseconds ${FRAME_MS}
}
$area -join ","`, 120_000);
}

const policy = path.join(mkdtempSync(path.join(tmpdir(), "superuse-labels-")), "policy.json");
writeFileSync(policy, JSON.stringify({ allow: ["MenuPad"], foreground: "deny" }));
const env = { SUPERUSE_POLICY: policy, SUPERUSE_AUDIT: "off", SUPERUSE_AGENT: undefined };
const server = [path.join(REPO, "plugin", "server", "run.sh")];

const titles = ["Agent-A", "Agent-B"];
const windows: Win[] = [];
try {
  // MenuPad's frame is a little narrower than its 520 logical pixels, so B overlaps A a bit and the
  // capture holds nothing between them.
  windows.push(await openMenupad(160, 160, titles[0]), await openMenupad(655, 160, titles[1]));
  // Both servers start together, as two sessions of the same client would.
  const clients = await Promise.all(titles.map(() => McpClient.start(server, { env, elicit: "unsupported" })));
  // A third session that initializes but never touches the desktop, so it must not hold a number.
  const idle = await McpClient.start(server, { env, elicit: "unsupported" });
  try {
    const js = async (c: McpClient, code: string) => {
      const { result } = await c.call("js", { code }, 60_000);
      const text = textOf(result);
      if (result.isError) throw new Error(text);
      return text;
    };
    // Bind each window first, so the drivers are up (and their numbers claimed) before the timed part.
    await Promise.all(clients.map((c, i) => js(c, `globalThis.w = await desktop.window({title: "${titles[i]}"}); globalThis.ed = await w.find("Text editor"); return w.title`)));

    // run.sh execs Node, so each server is a child of this process. Its label ends in the number
    // of the slot socket it listens on (plugin/server/agent-label.ts), found through /proc.
    const pids = execFileSync("ps", ["--ppid", String(process.pid), "-o", "pid=,args="], { encoding: "utf8" })
      .split("\n").filter((l) => l.includes("main.ts")).map((l) => l.trim().split(/\s+/)[0]);
    const slotOf = new Map(readFileSync("/proc/net/unix", "utf8").split("\n").flatMap((l) => {
      const m = l.match(/ (\d+) @superuse-agent-\d+-(\d+)$/); // inode, then the socket name
      return m ? [[m[1], m[2]] as const] : [];
    }));
    const numbers = pids.flatMap((pid) => readdirSync(`/proc/${pid}/fd`)
      .map((fd) => { try { return readlinkSync(`/proc/${pid}/fd/${fd}`); } catch { return ""; } })
      .map((link) => slotOf.get(link.match(/^socket:\[(\d+)\]$/)?.[1] ?? "")).find(Boolean) ?? []);
    // Three servers, two of them active: exactly two numbers, and they differ.
    if (pids.length !== 3 || numbers.length !== 2 || numbers[0] === numbers[1]) {
      throw new Error(`expected 3 servers holding 2 distinct numbers, got ${pids.length} servers holding ${JSON.stringify(numbers)}`);
    }
    const expected = numbers.map((n) => `superuse-bench ${n}`);

    const dirWsl = path.join(WSL_TEMP, `agent-labels-${process.pid}`);
    const dirWin = `${WIN_TEMP}\\agent-labels-${process.pid}`;
    mkdirSync(dirWsl, { recursive: true });
    const capture = captureFrames(windows.map((w) => w.hwnd), dirWin);
    while (!existsSync(path.join(dirWsl, "ready"))) await sleep(50);
    // The badge shows for two seconds from the moment a cursor appears, so both click together
    // and the capture starts as soon as both clicks are done.
    await Promise.all(clients.map((c) => js(c, `await w.click(ed); return "clicked"`)));
    writeFileSync(path.join(dirWsl, "go"), "");
    const area = (await capture).trim();
    // Each server acted on its own window: type into it and read the text back.
    const typed = await Promise.all(clients.map((c, i) =>
      js(c, `await w.setValue(ed, "typed by ${titles[i]}"); return (await w.state({query: "typed by"})).split("\\n").filter((l) => l.includes("typed by")).join(" | ")`)));

    mkdirSync(OUT, { recursive: true });
    for (let i = 0; i < FRAMES; i++) {
      const frame = path.join(dirWsl, `frame-${i}.png`);
      if (existsSync(frame)) copyFileSync(frame, path.join(OUT, i === 0 ? "labels.png" : `frame-${i}.png`));
    }
    const result = { expected_labels: expected, area, typed, frames_ms_apart: FRAME_MS, labels_png: path.join(OUT, "labels.png") };
    writeFileSync(path.join(OUT, "result.json"), JSON.stringify(result, null, 2));
    console.log(JSON.stringify(result, null, 2));
  } finally {
    await Promise.all([...clients, idle].map((c) => c.close()));
  }
} finally {
  // Only the windows this run opened: other sessions may be using MenuPad on this desktop.
  if (windows.length) await ps(`Stop-Process -Id ${windows.map((w) => w.pid).join(",")} -Force -ErrorAction SilentlyContinue`);
}
