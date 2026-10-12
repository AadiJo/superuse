// TestPad: a tiny WinForms text editor used by the benchmark instead of
// Windows Notepad, whose restored session contains the user's own tabs.
// It has standard Win32 controls, a real menu, the real Windows Save As
// dialog (SaveFileDialog) and a modal Replace dialog.
//
// Built as its own TestPad.exe (see tasks.build_testpad) because Codex's
// computer use hides terminal hosts such as powershell.exe, so a script-hosted
// window would be invisible to one of the stacks under test.
//
//   TestPad.exe [C:\path\file.txt]
// Written for the C# 5 compiler that ships with Windows PowerShell 5.1.
using System;
using System.Drawing;
using System.IO;
using System.Text;
using System.Windows.Forms;

public class TestPad : Form
{
    readonly TextBox text = new TextBox();
    string path = "";
    bool dirty;

    [STAThread]
    public static void Main(string[] args)
    {
        Application.EnableVisualStyles();
        Application.Run(new TestPad(args.Length > 0 ? args[0] : ""));
    }

    TestPad(string file)
    {
        Size = new Size(900, 650);
        StartPosition = FormStartPosition.CenterScreen;
        text.Multiline = true; text.ScrollBars = ScrollBars.Both; text.WordWrap = false;
        text.Dock = DockStyle.Fill; text.Font = new Font("Consolas", 12);
        text.AccessibleName = "Text editor";

        var menu = new MenuStrip();
        var fileMenu = new ToolStripMenuItem("&File");
        var save = new ToolStripMenuItem("&Save", null, (s, e) => { if (path != "") SaveTo(path); else SaveAs(); });
        save.ShortcutKeys = Keys.Control | Keys.S;
        var saveAs = new ToolStripMenuItem("Save &As...", null, (s, e) => SaveAs());
        saveAs.ShortcutKeys = Keys.Control | Keys.Shift | Keys.S;
        fileMenu.DropDownItems.AddRange(new ToolStripItem[] { save, saveAs });
        var editMenu = new ToolStripMenuItem("&Edit");
        var replace = new ToolStripMenuItem("&Replace...", null, (s, e) => ShowReplace());
        replace.ShortcutKeys = Keys.Control | Keys.H;
        editMenu.DropDownItems.Add(replace);
        menu.Items.AddRange(new ToolStripItem[] { fileMenu, editMenu });

        if (file != "" && File.Exists(file)) { path = file; text.Text = File.ReadAllText(file); }
        text.TextChanged += (s, e) => { dirty = true; UpdateTitle(); };
        Controls.Add(text); Controls.Add(menu); MainMenuStrip = menu;
        if (file != "") path = file;
        UpdateTitle();
    }

    void UpdateTitle()
    {
        string name = path != "" ? Path.GetFileName(path) : "Untitled";
        Text = (dirty ? "*" : "") + name + " - TestPad";
    }

    void SaveTo(string p)
    {
        File.WriteAllText(p, text.Text, new UTF8Encoding(false));
        path = p; dirty = false; UpdateTitle();
    }

    void SaveAs()
    {
        using (var d = new SaveFileDialog())
        {
            d.Filter = "Text files (*.txt)|*.txt|All files (*.*)|*.*";
            if (d.ShowDialog(this) == DialogResult.OK) SaveTo(d.FileName);
        }
    }

    void ShowReplace()
    {
        using (var f = new Form())
        {
            f.Text = "Replace"; f.Size = new Size(420, 190); f.FormBorderStyle = FormBorderStyle.FixedDialog;
            f.StartPosition = FormStartPosition.CenterParent; f.MinimizeBox = false; f.MaximizeBox = false;
            var l1 = new Label { Text = "Find what:", Location = new Point(12, 18), AutoSize = true };
            var find = new TextBox { Location = new Point(110, 15), Width = 280, AccessibleName = "Find what" };
            var l2 = new Label { Text = "Replace with:", Location = new Point(12, 52), AutoSize = true };
            var repl = new TextBox { Location = new Point(110, 49), Width = 280, AccessibleName = "Replace with" };
            var all = new Button { Text = "Replace All", Location = new Point(110, 95), Width = 120 };
            all.Click += (s, e) => { if (find.Text != "") text.Text = text.Text.Replace(find.Text, repl.Text); f.Close(); };
            var cancel = new Button { Text = "Cancel", Location = new Point(240, 95), Width = 120 };
            cancel.Click += (s, e) => f.Close();
            f.Controls.AddRange(new Control[] { l1, find, l2, repl, all, cancel });
            f.AcceptButton = all; f.CancelButton = cancel;
            f.ShowDialog(this);
        }
    }
}
