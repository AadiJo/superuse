// MenuPad: a window with a real Win32 menu bar (HMENU), for fork/acceptance.py.
// WinForms' legacy MainMenu is a genuine HMENU and its items run on WM_COMMAND,
// unlike TestPad's MenuStrip, which UIA sees as a drawn ToolStrip.
using System;
using System.Windows.Forms;

public class MenuPad : Form {
    [STAThread]
    public static void Main() {
        Application.EnableVisualStyles();
        Application.Run(new MenuPad());
    }

    TextBox text = new TextBox { Multiline = true, Dock = DockStyle.Fill, AccessibleName = "Text editor" };

    public MenuPad() {
        Text = "MenuPad";
        Width = 520; Height = 360;
        var file = new MenuItem("&File");
        file.MenuItems.Add(new MenuItem("Save &As...", (s, e) => {
            using (var dlg = new SaveFileDialog { Title = "Save As" }) dlg.ShowDialog(this);
        }, Shortcut.CtrlShiftS));
        var disabled = new MenuItem("&Disabled item") { Enabled = false };
        file.MenuItems.Add(disabled);
        var edit = new MenuItem("&Edit");
        edit.MenuItems.Add(new MenuItem("&Stamp", (s, e) => text.AppendText("stamped")));
        Menu = new MainMenu(new[] { file, edit });
        Controls.Add(text);
    }
}
