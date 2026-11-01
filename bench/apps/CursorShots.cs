// Screen captures for bench/acceptance.ts's cursor checks, compiled into %TEMP%\bcu\CursorShots.dll.
//
// The agent cursor's colour changes from run to run, so CursorColor reads it off the screen first:
// the most common strongly coloured pixel that changed between two captures around a click. Series
// then counts pixels of that colour inside rects, frame after frame. Window chrome is grey or
// white, so a count above zero is the cursor showing there. Every call is per-monitor DPI aware,
// like the driver, so all coordinates are physical screen pixels.

using System;
using System.Collections.Generic;
using System.Drawing;
using System.Drawing.Imaging;
using System.IO;
using System.Runtime.InteropServices;
using System.Text;
using System.Threading;

public static class CursorShots {
    [DllImport("user32.dll")] static extern IntPtr SetThreadDpiAwarenessContext(IntPtr c);
    [DllImport("user32.dll")] static extern bool SetWindowPos(IntPtr h, IntPtr after, int x, int y, int w, int ht, uint f);
    [DllImport("user32.dll")] static extern bool ShowWindow(IntPtr h, int cmd);
    [DllImport("user32.dll")] static extern IntPtr GetForegroundWindow();
    [StructLayout(LayoutKind.Sequential)] struct POINT { public int X, Y; }
    [DllImport("user32.dll")] static extern IntPtr WindowFromPoint(POINT p);
    [DllImport("user32.dll")] static extern IntPtr GetAncestor(IntPtr h, uint flags);

    /// Top-level window a user would hit at screen (x, y). Click-through windows, like the cursor
    /// overlay, don't count, so this is the window the pixel belongs to.
    static long TopAt(int x, int y) {
        var p = new POINT { X = x, Y = y };
        return GetAncestor(WindowFromPoint(p), 2).ToInt64(); // GA_ROOT
    }

    static void Aware() { SetThreadDpiAwarenessContext(new IntPtr(-4)); }

    static Bitmap Grab(int x, int y, int w, int h) {
        var bmp = new Bitmap(w, h, PixelFormat.Format32bppArgb);
        using (var g = Graphics.FromImage(bmp)) g.CopyFromScreen(x, y, 0, 0, bmp.Size);
        return bmp;
    }

    /// BGRA bytes of a bitmap, row-major, 4 per pixel.
    static byte[] Pixels(Bitmap bmp) {
        var data = bmp.LockBits(new Rectangle(0, 0, bmp.Width, bmp.Height), ImageLockMode.ReadOnly, PixelFormat.Format32bppArgb);
        var bytes = new byte[data.Stride * bmp.Height];
        Marshal.Copy(data.Scan0, bytes, 0, bytes.Length);
        bmp.UnlockBits(data);
        return bytes;
    }

    public static long Foreground() { return GetForegroundWindow().ToInt64(); }

    /// Maximize a window, as a user making an app full screen would (it also activates it).
    public static void Maximize(long hwnd) { ShowWindow(new IntPtr(hwnd), 3); } // SW_MAXIMIZE

    /// Capture a screen rect to `path`.
    public static void Capture(int x, int y, int w, int h, string path) {
        Aware();
        using (var bmp = Grab(x, y, w, h)) bmp.Save(path, ImageFormat.Png);
    }

    /// "R,G,B" of the most common strongly coloured pixel in `path` that differs from `basePath`
    /// (both captures of the same rect), looking only inside the sub-rect x, y, w, h; "" when
    /// nothing like that changed there.
    public static string CursorColor(string basePath, string path, int sx, int sy, int sw, int sh) {
        using (var a = new Bitmap(basePath)) using (var b = new Bitmap(path)) {
            byte[] pa = Pixels(a), pb = Pixels(b);
            var buckets = new Dictionary<int, int[]>(); // quantized colour -> count, R, G, B sums
            for (int y = Math.Max(0, sy); y < Math.Min(b.Height, sy + sh); y++)
            for (int x = Math.Max(0, sx); x < Math.Min(b.Width, sx + sw); x++) {
                int i = (y * b.Width + x) * 4;
                int r = pb[i + 2], g = pb[i + 1], bl = pb[i];
                int hi = Math.Max(r, Math.Max(g, bl)), lo = Math.Min(r, Math.Min(g, bl));
                int moved = Math.Max(Math.Abs(r - pa[i + 2]), Math.Max(Math.Abs(g - pa[i + 1]), Math.Abs(bl - pa[i])));
                if (hi - lo < 60 || moved < 40) continue;
                int key = (r >> 4) << 8 | (g >> 4) << 4 | (bl >> 4);
                int[] s;
                if (!buckets.TryGetValue(key, out s)) buckets[key] = s = new int[4];
                s[0]++; s[1] += r; s[2] += g; s[3] += bl;
            }
            int[] best = null;
            foreach (var s in buckets.Values) if (best == null || s[0] > best[0]) best = s;
            return best == null ? "" : (best[1] / best[0]) + "," + (best[2] / best[0]) + "," + (best[3] / best[0]);
        }
    }

    /// "x,y" of the top-most pixel within `tol` of `rgb` in the image at `path`, or "". For the
    /// arrow's fill that's its tip; the session badge sits below the arrow.
    public static string Top(string path, int[] rgb, int tol) {
        using (var bmp = new Bitmap(path)) {
            byte[] px = Pixels(bmp);
            for (int y = 0; y < bmp.Height; y++)
                for (int x = 0; x < bmp.Width; x++) {
                    int o = (y * bmp.Width + x) * 4;
                    if (Math.Abs(px[o + 2] - rgb[0]) <= tol && Math.Abs(px[o + 1] - rgb[1]) <= tol && Math.Abs(px[o] - rgb[2]) <= tol) return x + "," + y;
                }
            return "";
        }
    }

    /// Optionally move window `hwnd` to `place` (x, y, w, h) at the front of the ordinary windows,
    /// or maximize it when `maximize`; then take `frames` captures of the screen rect `area`, one
    /// every `everyMs`. Each frame counts pixels within `tol` of `rgb` inside each of `rects`
    /// (x, y, w, h, flattened) where the window on top is `owners[i]`, so another app that pops up
    /// meanwhile can't count. The first frame is taken right after the move; `startedPath` is
    /// written as it's taken, so a caller can act while the series runs. Frames with a count, and
    /// the first and last, are saved as `<prefix>-<n>.png`. Returns "<unix ms> c1,c2,..." per frame.
    public static string Series(long hwnd, int[] place, bool maximize, int[] area, int frames, int everyMs,
                                int[] rgb, int tol, int[] rects, long[] owners, string prefix, string startedPath) {
        Aware();
        var h = new IntPtr(hwnd);
        if (maximize) ShowWindow(h, 3); // SW_MAXIMIZE
        else if (place.Length == 4) {
            SetWindowPos(h, new IntPtr(-1), place[0], place[1], place[2], place[3], 0x10); // HWND_TOPMOST, SWP_NOACTIVATE
            SetWindowPos(h, new IntPtr(-2), 0, 0, 0, 0, 0x13);                             // HWND_NOTOPMOST, + NOSIZE | NOMOVE
        }
        var outp = new StringBuilder();
        for (int f = 0; f < frames; f++) {
            long t = DateTimeOffset.UtcNow.ToUnixTimeMilliseconds();
            using (var bmp = Grab(area[0], area[1], area[2], area[3])) {
                if (f == 0 && startedPath != "") File.WriteAllText(startedPath, t.ToString());
                byte[] px = Pixels(bmp);
                int stride = area[2] * 4;
                var counts = new int[rects.Length / 4];
                var owner = new Dictionary<long, long>(); // 8x8 block -> window on top, per frame
                for (int i = 0; i < counts.Length; i++) {
                    int rx = rects[4 * i] - area[0], ry = rects[4 * i + 1] - area[1];
                    int x0 = Math.Max(0, rx), x1 = Math.Min(area[2], rx + rects[4 * i + 2]);
                    int y0 = Math.Max(0, ry), y1 = Math.Min(area[3], ry + rects[4 * i + 3]);
                    for (int y = y0; y < y1; y++)
                        for (int x = x0; x < x1; x++) {
                            int o = y * stride + x * 4;
                            if (Math.Abs(px[o + 2] - rgb[0]) > tol || Math.Abs(px[o + 1] - rgb[1]) > tol || Math.Abs(px[o] - rgb[2]) > tol) continue;
                            int sx = area[0] + x, sy = area[1] + y;
                            long block = ((long)(sx >> 3) << 32) | (uint)(sy >> 3), top;
                            if (!owner.TryGetValue(block, out top)) owner[block] = top = TopAt(sx, sy);
                            if (top == owners[i]) counts[i]++;
                        }
                }
                bool any = false;
                foreach (int c in counts) any |= c > 0;
                if (any || f == 0 || f == frames - 1) bmp.Save(prefix + "-" + f + ".png", ImageFormat.Png);
                outp.Append(t).Append(' ').Append(string.Join(",", counts)).Append('\n');
            }
            if (f + 1 < frames) Thread.Sleep(everyMs);
        }
        return outp.ToString();
    }
}
