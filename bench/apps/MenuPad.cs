// MenuPad: a window with a real Win32 menu bar (HMENU), for bench/acceptance.ts.
// WinForms' legacy MainMenu is a genuine HMENU and its items run on WM_COMMAND,
// unlike TestPad's MenuStrip, which UIA sees as a drawn ToolStrip.
//
//   MenuPad.exe [--bypos] [--topmost] [--at X Y] [--title TEXT] [--log-clicks]
//
// --bypos gives the menu bar the MNS_NOTIFYBYPOS style. Windows then reports a
// pick as WM_MENUCOMMAND (item position, menu handle) instead of WM_COMMAND, and
// MenuPad acts on WM_MENUCOMMAND only, like a native app with that style.
// --topmost, --at and --title place a second MenuPad over the first for the
// foreground hit-test checks. --log-clicks appends "click " to the text on
// every mouse press in the text box, so a check can see where a click landed.
using System;
using System.Drawing;
using System.Runtime.InteropServices;
using System.Windows.Forms;

public class MenuPad : Form {
    [STAThread]
    public static void Main(string[] args) {
        Application.EnableVisualStyles();
        Application.Run(new MenuPad(args));
    }

    [StructLayout(LayoutKind.Sequential)]
    struct MENUINFO {
        public int cbSize;
        public uint fMask;
        public uint dwStyle;
        public uint cyMax;
        public IntPtr hbrBack;
        public uint dwContextHelpID;
        public UIntPtr dwMenuData;
    }

    [DllImport("user32.dll")] static extern IntPtr GetMenu(IntPtr hwnd);
    [DllImport("user32.dll")] static extern bool SetMenuInfo(IntPtr menu, ref MENUINFO info);
    const uint MIM_STYLE = 0x10, MNS_NOTIFYBYPOS = 0x08000000;
    const int WM_COMMAND = 0x0111, WM_MENUCOMMAND = 0x0126;

    TextBox text = new TextBox { Multiline = true, Dock = DockStyle.Fill, AccessibleName = "Text editor" };
    bool byPosition, topMost;

    public MenuPad(string[] args) {
        Text = "MenuPad";
        Width = 520; Height = 360;
        for (int i = 0; i < args.Length; i++) {
            if (args[i] == "--bypos") byPosition = true;
            else if (args[i] == "--topmost") topMost = true;
            else if (args[i] == "--title" && i + 1 < args.Length) Text = args[++i];
            else if (args[i] == "--log-clicks") text.MouseDown += (s, e) => text.AppendText("click ");
            else if (args[i] == "--at" && i + 2 < args.Length) {
                StartPosition = FormStartPosition.Manual;
                Location = new Point(int.Parse(args[i + 1]), int.Parse(args[i + 2]));
                i += 2;
            }
        }
        var file = new MenuItem("&File");
        file.MenuItems.Add(new MenuItem("Save &As...", (s, e) => {
            using (var dlg = new SaveFileDialog { Title = "Save As" }) dlg.ShowDialog(this);
        }, Shortcut.CtrlShiftS));
        var disabled = new MenuItem("&Disabled item") { Enabled = false };
        file.MenuItems.Add(disabled);
        var edit = new MenuItem("&Edit");
        edit.MenuItems.Add(new MenuItem("&Clear", (s, e) => text.Clear()));
        edit.MenuItems.Add(new MenuItem("-"));
        edit.MenuItems.Add(new MenuItem("&Stamp", (s, e) => text.AppendText("stamped")));
        Menu = new MainMenu(new[] { file, edit });
        Controls.Add(text);
    }

    // TopMost set before the window exists didn't stick when started in the background; set it once shown.
    protected override void OnShown(EventArgs e) {
        base.OnShown(e);
        if (topMost) TopMost = true;
    }

    protected override void OnLoad(EventArgs e) {
        base.OnLoad(e);
        if (byPosition) {
            var info = new MENUINFO { cbSize = Marshal.SizeOf(typeof(MENUINFO)), fMask = MIM_STYLE, dwStyle = MNS_NOTIFYBYPOS };
            SetMenuInfo(GetMenu(Handle), ref info);
        }
    }

    protected override void WndProc(ref Message m) {
        if (byPosition && m.Msg == WM_MENUCOMMAND) {
            // wParam: the item's position in its menu (separators count); lParam: that menu.
            foreach (MenuItem top in Menu.MenuItems) {
                if (top.Handle == m.LParam) {
                    text.AppendText("via-WM_MENUCOMMAND ");
                    top.MenuItems[m.WParam.ToInt32()].PerformClick();
                }
            }
            return;
        }
        // A menu's WM_COMMAND has a zero lParam and a zero high word.
        if (byPosition && m.Msg == WM_COMMAND && m.LParam == IntPtr.Zero && (m.WParam.ToInt64() >> 16) == 0) return;
        base.WndProc(ref m);
    }
}
