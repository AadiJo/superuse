// End-to-end check that agents running side by side get different cursor colors.
//
//   SUPERUSE_DRIVER=tools/out/superuse-driver.exe node bench/cursor-colors.ts [--baseline <exe>]
//
// Sends input to the shared desktop, so run it under `flock /tmp/superuse-desktop.lock` on an idle
// desktop, with no other driver from this build running (it refuses to start if one holds a slot). It opens three MenuPads (bench/apps), raises them without activating them, and only
// clicks inside them.
// - three: three drivers start at once and each clicks its own MenuPad at the same moment. One
//   capture shows all three cursors; each must have a different palette color.
// - freed: the driver holding the lowest of those slots exits. A fourth driver starts and must get
//   that slot back (its overlay title and its color).
// - single: one driver alone draws the original Cua blue. With --baseline (for example the release
//   build of origin/main), the same click with that exe goes beside it in one PNG.
// Writes bench/out/cursor-colors/<time>.json and the PNGs beside it.

import { copyFileSync, existsSync, mkdirSync, statSync, writeFileSync } from "node:fs";
import path from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import { McpClient, textOf } from "./mcp-client.ts";
import { start } from "./tasks.ts";
import { listWindows, ps, timestamp, WIN_TEMP, WSL_TEMP, type Win } from "./win.ts";

const HERE = import.meta.dirname;
const EXE = process.env.SUPERUSE_DRIVER ?? path.join(HERE, "..", "plugin/driver/superuse-driver.exe");
const baselineAt = process.argv.indexOf("--baseline");
const BASELINE = baselineAt > 0 ? process.argv[baselineAt + 1] : undefined;
const OUT = path.join(HERE, "out", "cursor-colors");
const STAMP = timestamp();
const ENV = { DO_NOT_TRACK: "1", WSLENV: "DO_NOT_TRACK" };
const SESSION = "superuse"; // as the plugin's calls carry

// driver/crates/cursor-overlay/src/theme.rs CURSOR_FILLS, by slot.
const FILLS = [[94, 192, 232], [244, 178, 66], [221, 113, 236], [96, 218, 174], [232, 82, 98], [178, 132, 255], [184, 220, 54], [247, 132, 170]] as const;
const OVERLAY_CLASS = "Cua.AgentCursorOverlay";

type Rect = readonly [x: number, y: number, w: number, h: number];
type Rgb = readonly [number, number, number];

/** The palette slot nearest to a color read off the screen, and how far off it was. */
function nearestSlot(rgb: Rgb): { slot: number; distance: number } {
  const dist = (f: Rgb) => Math.hypot(rgb[0] - f[0], rgb[1] - f[1], rgb[2] - f[2]);
  const slot = FILLS.reduce((best, f, i) => (dist(f) < dist(FILLS[best]) ? i : best), 0);
  return { slot, distance: Math.round(dist(FILLS[slot])) };
}

// Captures, the cursor's color off a before/after pair, fill pixel counts and a side-by-side image.
const SHOTS_PS = String.raw`
Add-Type -ReferencedAssemblies System.Drawing -TypeDefinition @"
using System; using System.Drawing; using System.Drawing.Imaging; using System.Collections.Generic; using System.Runtime.InteropServices;
public static class SuperuseColors {
  [DllImport("user32.dll")] static extern IntPtr SetThreadDpiAwarenessContext(IntPtr c);
  [DllImport("user32.dll")] static extern bool SetWindowPos(IntPtr h, IntPtr after, int x, int y, int w, int ht, uint f);
  // Put a window this script opened in front of the ordinary windows without activating it:
  // topmost and back (SWP_NOACTIVATE | SWP_NOSIZE | SWP_NOMOVE).
  public static void Raise(long hwnd) {
    SetWindowPos(new IntPtr(hwnd), new IntPtr(-1), 0, 0, 0, 0, 0x13);
    SetWindowPos(new IntPtr(hwnd), new IntPtr(-2), 0, 0, 0, 0, 0x13);
  }
  public static void Capture(int x, int y, int w, int h, string path) {
    SetThreadDpiAwarenessContext(new IntPtr(-4));
    using (var bmp = new Bitmap(w, h, PixelFormat.Format32bppArgb)) {
      using (var g = Graphics.FromImage(bmp)) g.CopyFromScreen(x, y, 0, 0, bmp.Size);
      bmp.Save(path, ImageFormat.Png);
    }
  }
  // "R,G,B" of the most common strongly coloured pixel inside (sx, sy, sw, sh) that changed
  // between the two captures, or "" (as bench/apps/CursorShots.cs CursorColor).
  public static string Color(string basePath, string path, int sx, int sy, int sw, int sh) {
    using (var a = new Bitmap(basePath)) using (var b = new Bitmap(path)) {
      var buckets = new Dictionary<int, int[]>();
      for (int y = Math.Max(0, sy); y < Math.Min(b.Height, sy + sh); y++)
      for (int x = Math.Max(0, sx); x < Math.Min(b.Width, sx + sw); x++) {
        Color c = b.GetPixel(x, y), o = a.GetPixel(x, y);
        int hi = Math.Max(c.R, Math.Max(c.G, c.B)), lo = Math.Min(c.R, Math.Min(c.G, c.B));
        int moved = Math.Max(Math.Abs(c.R - o.R), Math.Max(Math.Abs(c.G - o.G), Math.Abs(c.B - o.B)));
        if (hi - lo < 60 || moved < 40) continue;
        int key = (c.R >> 4) << 8 | (c.G >> 4) << 4 | (c.B >> 4);
        int[] s; if (!buckets.TryGetValue(key, out s)) buckets[key] = s = new int[4];
        s[0]++; s[1] += c.R; s[2] += c.G; s[3] += c.B;
      }
      int[] best = null;
      foreach (var s in buckets.Values) if (best == null || s[0] > best[0]) best = s;
      return best == null ? "" : (best[1] / best[0]) + "," + (best[2] / best[0]) + "," + (best[3] / best[0]);
    }
  }
  // Pixels within tol of (r, g, b): the size of the arrow's fill.
  public static int Count(string path, int r, int g, int bl, int tol) {
    int n = 0;
    using (var bmp = new Bitmap(path))
      for (int y = 0; y < bmp.Height; y++) for (int x = 0; x < bmp.Width; x++) {
        Color c = bmp.GetPixel(x, y);
        if (Math.Abs(c.R - r) <= tol && Math.Abs(c.G - g) <= tol && Math.Abs(c.B - bl) <= tol) n++;
      }
    return n;
  }
  // The images side by side on black, each under its label.
  public static void Join(string[] paths, string[] labels, string outPath) {
    var imgs = new List<Bitmap>(); foreach (var p in paths) imgs.Add(new Bitmap(p));
    int w = 0, h = 0; foreach (var i in imgs) { w += i.Width + 16; h = Math.Max(h, i.Height); }
    using (var bmp = new Bitmap(w, h + 40)) using (var g = Graphics.FromImage(bmp)) using (var f = new Font("Segoe UI", 14)) {
      g.Clear(System.Drawing.Color.Black);
      int x = 0;
      for (int k = 0; k < imgs.Count; k++) {
        g.DrawString(labels[k], f, Brushes.White, x + 4, 6);
        g.DrawImage(imgs[k], x, 40, imgs[k].Width, imgs[k].Height);
        x += imgs[k].Width + 16;
      }
      bmp.Save(outPath, ImageFormat.Png);
    }
    foreach (var i in imgs) i.Dispose();
  }
}
"@
`;

const shot = (script: string) => ps(`${SHOTS_PS}${script}`, 120_000).then((out) => out.trim().split("\n").at(-1)?.trim() ?? "");
const win = (name: string) => `${WIN_TEMP}\\cursor-colors-${name}.png`;

/** Capture `area` as `name`, keeping a copy in OUT. */
async function capture(area: Rect, name: string): Promise<void> {
  await shot(`[SuperuseColors]::Capture(${area.join(",")}, '${win(name)}')`);
  copyFileSync(path.join(WSL_TEMP, `cursor-colors-${name}.png`), path.join(OUT, `${STAMP}-${name}.png`));
}

/** The cursor color just below and right of `at` (screen pixels), from captures `before` and `after` of `area`. */
async function colorAt(area: Rect, before: string, after: string, at: readonly [number, number]): Promise<Rgb | null> {
  const out = await shot(`[SuperuseColors]::Color('${win(before)}', '${win(after)}', ${at[0] - area[0]}, ${at[1] - area[1]}, 28, 28)`);
  const m = /^(\d+),(\d+),(\d+)$/.exec(out);
  return m ? [Number(m[1]), Number(m[2]), Number(m[3])] : null;
}

const MENUPAD_SRC = path.join(HERE, "apps", "MenuPad.cs");

/** Build MenuPad like bench/acceptance.ts does and open one titled `title` at logical (x, y). */
async function openMenupad(x: number, y: number, title: string): Promise<Win> {
  const exe = path.join(WSL_TEMP, "MenuPad.exe");
  if (!existsSync(exe) || statSync(exe).mtimeMs < statSync(MENUPAD_SRC).mtimeMs) {
    mkdirSync(WSL_TEMP, { recursive: true });
    copyFileSync(MENUPAD_SRC, path.join(WSL_TEMP, "MenuPad.cs"));
    await ps(`Remove-Item '${WIN_TEMP}\\MenuPad.exe' -ErrorAction SilentlyContinue
Add-Type -TypeDefinition (Get-Content -Raw '${WIN_TEMP}\\MenuPad.cs') -OutputAssembly '${WIN_TEMP}\\MenuPad.exe' -OutputType WindowsApplication -ReferencedAssemblies System.Windows.Forms,System.Drawing`, 120_000);
  }
  await start(`${WIN_TEMP}\\MenuPad.exe`, "--at", String(x), String(y), "--title", title);
  for (let end = Date.now() + 10_000; Date.now() < end; await sleep(300)) {
    const found = (await listWindows(true)).find((w) => w.proc === "MenuPad" && w.title === title);
    if (found) return found;
  }
  throw new Error(`MenuPad ${title} did not open`);
}

/** Every driver overlay on the desktop, by slot from its title (`...<cursor id>.slot<N>`). Builds
 *  before slots have no `.slot<N>` suffix and read as null. */
async function overlaySlots(): Promise<{ pid: number; slot: number | null; title: string }[]> {
  return (await listWindows(true)).filter((w) => w.cls === OVERLAY_CLASS).map((w) => {
    const m = /\.slot(\d+)$/.exec(w.title);
    return { pid: w.pid, slot: m ? Number(m[1]) : null, title: w.title };
  });
}

/** One driver over MCP stdio that clicks inside one MenuPad. */
class Agent {
  readonly name: string;
  readonly client: McpClient;
  readonly pad: Win;
  bounds: Rect = [0, 0, 0, 0];

  constructor(name: string, client: McpClient, pad: Win) {
    this.name = name;
    this.client = client;
    this.pad = pad;
  }

  static async start(name: string, exe: string, pad: Win): Promise<Agent> {
    const agent = new Agent(name, await McpClient.start([exe, "mcp"], { env: ENV }), pad);
    const { result } = await agent.client.call("list_windows", { pid: pad.pid });
    const w = result.structuredContent?.windows?.find((w) => w.window_id === pad.hwnd);
    const b = w?.bounds ?? w;
    if (b?.x == null || b.y == null || b.width == null || b.height == null) throw new Error(`${name}: ${pad.title} not in list_windows`);
    agent.bounds = [b.x, b.y, b.width, b.height];
    // A pixel click maps through the window's latest screenshot.
    await agent.client.call("get_window_state", { pid: pad.pid, window_id: pad.hwnd, include_screenshot: true, session: SESSION });
    return agent;
  }

  /** Where this agent clicks, in screen pixels: the middle of its MenuPad's text box. */
  get point(): readonly [number, number] {
    const [x, y, w, h] = this.bounds;
    return [x + Math.floor(w / 2), y + Math.floor(h / 2) + 20];
  }

  /** A pixel click at `point`, retried while the driver reports itself busy. Returns the result text. */
  async click(): Promise<string> {
    // Screenshot pixels map to screen as frame origin + 1; MenuPad's screenshot isn't downscaled.
    const args = { pid: this.pad.pid, window_id: this.pad.hwnd, x: this.point[0] - this.bounds[0] - 1, y: this.point[1] - this.bounds[1] - 1, session: SESSION };
    let res = await this.client.call("click", args);
    for (let i = 0; i < 4 && res.result.isError && textOf(res.result).includes("busy"); i++) {
      await sleep(700);
      res = await this.client.call("click", args);
    }
    return `${res.result.isError ? "ERROR " : ""}${textOf(res.result).slice(0, 200)}`;
  }
}

/** The screen rect around `agents`' click points, with room for the arrow and badge. */
function around(points: (readonly [number, number])[]): Rect {
  const xs = points.map((p) => p[0]), ys = points.map((p) => p[1]);
  const x = Math.min(...xs) - 120, y = Math.min(...ys) - 120;
  return [x, y, Math.max(...xs) + 360 - x, Math.max(...ys) + 240 - y];
}

/** Click with every agent at once, capturing `area` before and after, and read each cursor's color. */
async function clickAll(agents: Agent[], name: string): Promise<{ agent: string; click: string; rgb: Rgb | null; slot: number | null; distance: number | null }[]> {
  const area = around(agents.map((a) => a.point));
  await capture(area, `${name}-0`);
  const clicks = await Promise.all(agents.map((a) => a.click()));
  await sleep(1200);
  await capture(area, name);
  return Promise.all(agents.map(async (a, i) => {
    const rgb = await colorAt(area, `${name}-0`, name, a.point);
    const near = rgb ? nearestSlot(rgb) : null;
    return { agent: a.name, click: clicks[i], rgb, slot: near?.slot ?? null, distance: near?.distance ?? null };
  }));
}

/** One driver alone clicks `pad`; returns its color, fill size and a crop around the cursor. */
async function single(exe: string, pad: Win, name: string) {
  const agent = await Agent.start(name, exe, pad);
  try {
    const [res] = await clickAll([agent], name);
    const [px, py] = agent.point;
    const crop: Rect = [px - 60, py - 60, 240, 200];
    await capture(crop, `${name}-crop`);
    const fill = res.rgb ? Number(await shot(`[SuperuseColors]::Count('${win(`${name}-crop`)}', ${res.rgb.join(",")}, 12)`)) : 0;
    return { ...res, fill_pixels: fill, overlays: await overlaySlots() };
  } finally {
    await agent.client.close();
  }
}

mkdirSync(OUT, { recursive: true });
const pads: Win[] = [];
const agents: Agent[] = [];
const result: Record<string, unknown> = { exe: EXE, baseline: BASELINE ?? null, stamp: STAMP };
try {
  // Slots are machine-wide, so another driver from this build (e.g. the user's own session) would
  // shift every expected slot. Refuse to run rather than report a false failure.
  const foreign = (await overlaySlots()).filter((o) => o.slot !== null);
  if (foreign.length) throw new Error(`other drivers already hold cursor slots: ${JSON.stringify(foreign)}. Close those sessions first.`);
  for (const [i, x] of [40, 580, 1120].entries()) pads.push(await openMenupad(x, 120, `MenuPad-color-${i + 1}`));
  // Other windows on a shared desktop can cover a MenuPad, and the overlay hides a cursor there.
  await shot(pads.map((p) => `[SuperuseColors]::Raise(${p.hwnd})`).join("; "));

  // three: start together, so the slot claim is raced, then click together.
  agents.push(...(await Promise.all(pads.map((pad, i) => Agent.start(`agent-${i + 1}`, EXE, pad)))));
  const three = await clickAll(agents, "three");
  const threeSlots = three.map((r) => r.slot);
  const overlaysThree = await overlaySlots();
  // The same moment, cropped around each cursor and joined: the picture for a reviewer.
  const crops = agents.map((a) => `three-${a.name}`);
  for (const [i, a] of agents.entries()) await capture([a.point[0] - 60, a.point[1] - 60, 240, 200], crops[i]);
  await shot(`[SuperuseColors]::Join(@(${crops.map((c) => `'${win(c)}'`).join(",")}), @(${three.map((r) => `'${r.agent}: slot ${r.slot}'`).join(",")}), '${win("three-compare")}')`);
  copyFileSync(path.join(WSL_TEMP, "cursor-colors-three-compare.png"), path.join(OUT, `${STAMP}-three-compare.png`));
  result.three = { cursors: three, overlays: overlaysThree, pictures: [`${STAMP}-three.png`, `${STAMP}-three-compare.png`] };
  const threeOk = three.every((r) => r.rgb && r.distance !== null && r.distance <= 40) && new Set(threeSlots).size === 3;

  // freed: the driver on the lowest slot exits; the next driver must take that slot.
  const lowest = three.reduce((best, r, i) => ((r.slot ?? 99) < (three[best].slot ?? 99) ? i : best), 0);
  const freedSlot = three[lowest].slot;
  await agents[lowest].client.close();
  await sleep(500);
  const overlaysAfterExit = await overlaySlots();
  agents[lowest] = await Agent.start(`agent-${lowest + 1}-next`, EXE, pads[lowest]);
  const [next] = await clickAll([agents[lowest]], "freed");
  const overlaysFreed = await overlaySlots();
  result.freed = { exited: three[lowest].agent, freed_slot: freedSlot, overlays_after_exit: overlaysAfterExit, next, overlays: overlaysFreed };
  const freedOk = next.slot === freedSlot && overlaysFreed.filter((o) => o.slot === freedSlot).length === 1
    && !overlaysAfterExit.some((o) => o.slot === freedSlot);

  for (const a of agents.splice(0)) await a.client.close();
  await sleep(500);

  // single: one driver alone keeps the default Cua blue (slot 0).
  const alone = await single(EXE, pads[0], "single");
  result.single = alone;
  const singleOk = alone.slot === 0 && alone.distance !== null && alone.distance <= 40;
  const pictures = [`single-crop`];
  const labels = ["this build, alone"];
  if (BASELINE) {
    await sleep(500);
    result.baseline_single = await single(BASELINE, pads[0], "baseline");
    pictures.unshift("baseline-crop");
    labels.unshift("baseline, alone");
  }
  await shot(`[SuperuseColors]::Join(@(${pictures.map((p) => `'${win(p)}'`).join(",")}), @(${labels.map((l) => `'${l}'`).join(",")}), '${win("single-compare")}')`);
  copyFileSync(path.join(WSL_TEMP, "cursor-colors-single-compare.png"), path.join(OUT, `${STAMP}-single-compare.png`));

  result.checks = { three_distinct: threeOk, freed_slot_reused: freedOk, single_is_default_blue: singleOk };
  result.passed = threeOk && freedOk && singleOk;
} catch (e) {
  result.passed = false;
  result.exception = String(e).slice(0, 800);
} finally {
  for (const a of agents) await a.client.close().catch(() => {});
  if (pads.length) await ps(`Stop-Process -Id ${[...new Set(pads.map((p) => p.pid))].join(",")} -Force -ErrorAction SilentlyContinue`);
}
const out = path.join(OUT, `${STAMP}.json`);
writeFileSync(out, JSON.stringify(result, null, 1));
console.log(JSON.stringify(result, null, 1));
console.log("written:", out);
process.exit(result.passed ? 0 : 1);
