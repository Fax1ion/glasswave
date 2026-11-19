// Glasswave.exe
//
// Opens Glasswave in its own window. This small program:
//   - adds Glasswave to the Start menu the first time it runs, so Windows search finds it
//   - builds the window and the file helper from launcher\shell.cs and launcher\helper.cs, only
//     when they have changed (the result is kept in %LOCALAPPDATA%\Glasswave\build)
//   - starts the file helper inside itself and opens the window
//   - rebuilds itself when launcher\Glasswave.cs (this file) changes
//
// "Install Glasswave.bat" builds it on this computer with the C# compiler that is part of
// Windows, so nothing is downloaded. Written for that compiler (C# 5, .NET Framework 4.5+).

using System;
using System.CodeDom.Compiler;
using System.Collections.Generic;
using System.Diagnostics;
using System.Drawing;
using System.Globalization;
using System.IO;
using System.Reflection;
using System.Runtime.InteropServices;
using System.Runtime.InteropServices.ComTypes;
using System.Security.Cryptography;
using System.Text;
using System.Threading;
using System.Windows.Forms;
using Microsoft.CSharp;

// What Windows shows for this program (Task Manager, file properties).
[assembly: AssemblyTitle("Glasswave")]
[assembly: AssemblyDescription("Glasswave music player")]
[assembly: AssemblyProduct("Glasswave")]
[assembly: AssemblyVersion("1.0.0.0")]
[assembly: AssemblyFileVersion("1.0.0.0")]

namespace GlasswaveApp
{
    internal static class Program
    {
        internal const int Port = 8765;
        internal const string AppId = "Glasswave.Player";      // the same as the window uses, so the taskbar matches it to the Start menu entry
        internal static string root, here, sdk, logFile, exePath;

        [STAThread]
        private static int Main(string[] args)
        {
            exePath = Path.GetFullPath(Assembly.GetExecutingAssembly().Location);
            root = Path.GetDirectoryName(exePath);
            here = Path.Combine(root, "launcher");
            sdk = Path.Combine(here, "webview2");
            logFile = Path.Combine(here, "standalone.log");

            if (args.Length > 0 && args[0] == "--add-to-start-menu")
            {
                // Used by "Install Glasswave.bat".
                return StartMenu.Ensure(true) ? 0 : 1;
            }

            TrimLog();
            Log("---- start (Glasswave.exe). Windows " + Native.RealVersion() + (Native.Manifested() ? "" : " (Glasswave.exe is missing its Windows 10/11 note; it rebuilds itself)") + ", .NET " + Environment.Version + ", 64-bit process: " + Environment.Is64BitProcess);
            try { string old = Path.Combine(root, "Glasswave.old.exe"); if (File.Exists(old)) File.Delete(old); } catch { }

            // Only one Glasswave window at a time (the same rule as "Start Glasswave (own window)").
            bool first;
            Mutex mutex = new Mutex(true, "Glasswave.Standalone.Window", out first);
            if (!first)
            {
                Log("Already open; bringing that window forward.");
                Native.BringForward();
                return 0;
            }
            try { return Run(); }
            finally
            {
                try { mutex.ReleaseMutex(); } catch { }
                GC.KeepAlive(mutex);
            }
        }

        private static int Run()
        {
            Native.Prepare();
            AppDomain.CurrentDomain.AssemblyResolve += Resolve;
            Application.EnableVisualStyles();
            Application.SetCompatibleTextRenderingDefault(false);
            Splash splash = null;
            try
            {
                // ---- Microsoft's WebView2 helper files ---------------------------------------
                string core = Path.Combine(sdk, "Microsoft.Web.WebView2.Core.dll");
                string forms = Path.Combine(sdk, "Microsoft.Web.WebView2.WinForms.dll");
                if (!File.Exists(core) || !File.Exists(forms) || !File.Exists(Path.Combine(sdk, "WebView2Loader.dll")))
                {
                    Fail("Some of Glasswave's files are missing from launcher\\webview2.\n\nOpen \"Start Glasswave (own window)\" once to fetch them again, then try Glasswave.exe again.");
                    return 1;
                }
                Assembly coreAsm = Assembly.LoadFrom(core);
                Assembly.LoadFrom(forms);
                Environment.SetEnvironmentVariable("PATH", sdk + ";" + Environment.GetEnvironmentVariable("PATH"));
                Type env = coreAsm.GetType("Microsoft.Web.WebView2.Core.CoreWebView2Environment", true);
                try { env.GetMethod("SetLoaderDllFolderPath", new Type[] { typeof(string) }).Invoke(null, new object[] { sdk }); }
                catch (Exception ex) { Log("SetLoaderDllFolderPath not used: " + Inner(ex).Message); }
                try { Log("WebView2 runtime found: " + env.GetMethod("GetAvailableBrowserVersionString", new Type[] { typeof(string) }).Invoke(null, new object[] { null })); }
                catch (Exception ex)
                {
                    Exception why = Inner(ex);
                    if (why.GetType().Name.Contains("RuntimeNotFound"))
                    {
                        Fail("Windows is missing the Microsoft Edge WebView2 Runtime. Install it from https://developer.microsoft.com/microsoft-edge/webview2/ and try again.");
                        return 1;
                    }
                    Log("Could not read the WebView2 runtime version (carrying on): " + why.Message);
                }

                // ---- the window and the file helper -----------------------------------------
                Assembly app = AppCode.Load(core, forms, ref splash);
                if (splash != null) { splash.Close(); splash.Dispose(); splash = null; }
                if (app == null)
                {
                    Fail("Glasswave's window code could not be built.");
                    return 1;
                }
                Type helper = app.GetType("Glasswave.Helper", true);
                string status = (string)helper.GetMethod("Start").Invoke(null, new object[] { Port, root, logFile });
                if (status == "busy")
                {
                    Fail("Another program on this computer is using the address Glasswave needs (127.0.0.1:" + Port + "). Close that program and try again.");
                    return 1;
                }

                string dataDir = Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.LocalApplicationData), "Glasswave", "Standalone");
                Directory.CreateDirectory(dataDir);

                // Once the window is up: the Start menu entry, and rebuilding this program if its code changed.
                Thread chores = new Thread(Chores);
                chores.IsBackground = true;
                chores.SetApartmentState(ApartmentState.STA);
                chores.Start();

                Type shell = app.GetType("Glasswave.Shell", true);
                shell.GetMethod("Start").Invoke(null, new object[] { "http://127.0.0.1:" + Port + "/", dataDir, Path.Combine(root, "app", "icon.ico"), logFile });
                Log("Window closed normally.");
                try { helper.GetMethod("Stop").Invoke(null, null); } catch { }
                return 0;
            }
            catch (Exception ex)
            {
                Exception why = Inner(ex);
                Log("ERROR: " + why);
                if (splash != null) { try { splash.Close(); } catch { } }
                Fail("Glasswave could not start: " + why.Message);
                return 1;
            }
        }

        private static void Chores()
        {
            try { Thread.Sleep(4000); } catch { }
            try { StartMenu.Ensure(false); } catch (Exception ex) { Log("Start menu entry: " + ex.Message); }
            try { SelfUpdate.Check(); } catch (Exception ex) { Log("Updating Glasswave.exe failed: " + ex.Message); }
        }

        // WebView2's files live in launcher\webview2, and the built window code in the build folder.
        private static Assembly Resolve(object sender, ResolveEventArgs args)
        {
            try
            {
                string name = new AssemblyName(args.Name).Name;
                foreach (string folder in new string[] { sdk, AppCode.CacheFolder })
                {
                    string path = Path.Combine(folder, name + ".dll");
                    if (File.Exists(path)) return Assembly.LoadFrom(path);
                }
            }
            catch { }
            return null;
        }

        internal static Exception Inner(Exception ex)
        {
            while (ex is TargetInvocationException && ex.InnerException != null) ex = ex.InnerException;
            return ex;
        }

        internal static void Log(string text)
        {
            try { File.AppendAllText(logFile, DateTime.Now.ToString("yyyy-MM-dd HH:mm:ss", CultureInfo.InvariantCulture) + "  " + text + Environment.NewLine); }
            catch { }
        }

        private static void TrimLog()
        {
            try { if (File.Exists(logFile) && new FileInfo(logFile).Length > 300000) File.Delete(logFile); } catch { }
        }

        internal static void Fail(string text)
        {
            Log("STOPPED: " + text);
            try
            {
                MessageBox.Show(text + "\n\nDetails were saved to:\n" + logFile + "\n\n\"Start Glasswave (own window)\" and \"Start Glasswave\" still work.",
                    "Glasswave", MessageBoxButtons.OK, MessageBoxIcon.Warning);
            }
            catch { }
        }
    }

    // ---- building the window code (only after it changes) -------------------------------------
    internal static class AppCode
    {
        internal static string CacheFolder
        {
            get { return Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.LocalApplicationData), "Glasswave", "build"); }
        }

        private static readonly string[] Libraries = { "System.dll", "System.Core.dll", "System.Drawing.dll", "System.Windows.Forms.dll", "System.Net.Http.dll" };

        // shell.cs is the window. If it will not build, the earlier version (shell-fallback.cs) is
        // used instead, so the player still opens.
        internal static Assembly Load(string core, string forms, ref Splash splash)
        {
            string[][] choices = { new string[] { "helper.cs", "shell.cs" }, new string[] { "helper.cs", "shell-fallback.cs" } };
            Directory.CreateDirectory(CacheFolder);
            foreach (string[] names in choices)
            {
                List<string> files = new List<string>();
                foreach (string name in names) files.Add(Path.Combine(Program.here, name));
                if (!files.TrueForAll(File.Exists)) continue;
                string key = Key(files, core, forms);
                string dll = Path.Combine(CacheFolder, "app-" + key + ".dll");
                if (File.Exists(dll))
                {
                    Assembly kept = TryLoad(dll);
                    if (kept != null) { Program.Log("Window code ready (" + names[1] + ")."); return kept; }
                    try { File.Delete(dll); } catch { }
                }
                if (splash == null) splash = Splash.Open("Updating Glasswave...");
                string problem = Build(files, dll, core, forms);
                if (problem == null)
                {
                    Assembly built = TryLoad(dll);
                    if (built != null)
                    {
                        Program.Log("Window code compiled (" + names[1] + ").");
                        Tidy(dll);
                        return built;
                    }
                    problem = "it built but could not be loaded";
                }
                Program.Log("Window code in " + names[1] + " did not build: " + problem);
            }
            return null;
        }

        private static Assembly TryLoad(string dll)
        {
            try
            {
                Assembly a = Assembly.LoadFrom(dll);
                a.GetType("Glasswave.Shell", true);
                a.GetType("Glasswave.Helper", true);
                return a;
            }
            catch (Exception ex) { Program.Log("Could not load " + Path.GetFileName(dll) + ": " + Program.Inner(ex).Message); return null; }
        }

        // A fingerprint of everything the built code depends on.
        private static string Key(List<string> files, string core, string forms)
        {
            using (SHA256 sha = SHA256.Create())
            using (MemoryStream all = new MemoryStream())
            {
                byte[] head = Encoding.UTF8.GetBytes("glasswave-build-1|" + Environment.Version + "|" + Fingerprint(core) + "|" + Fingerprint(forms) + "|");
                all.Write(head, 0, head.Length);
                foreach (string f in files)
                {
                    byte[] name = Encoding.UTF8.GetBytes(Path.GetFileName(f) + "\0");
                    byte[] body = File.ReadAllBytes(f);
                    all.Write(name, 0, name.Length);
                    all.Write(body, 0, body.Length);
                    all.WriteByte(0);
                }
                byte[] hash = sha.ComputeHash(all.ToArray());
                StringBuilder sb = new StringBuilder();
                for (int i = 0; i < 12; i++) sb.Append(hash[i].ToString("x2"));
                return sb.ToString();
            }
        }

        private static string Fingerprint(string file)
        {
            FileInfo f = new FileInfo(file);
            return f.Length + "@" + f.LastWriteTimeUtc.Ticks;
        }

        // Gives null when it built, or what went wrong.
        private static string Build(List<string> files, string dll, string core, string forms)
        {
            string temp = Path.Combine(CacheFolder, "app-" + Guid.NewGuid().ToString("N") + ".tmp.dll");
            List<string> refs = new List<string>(Libraries);
            refs.Add(core);
            refs.Add(forms);
            string problem = Compiler.Run(files.ToArray(), temp, refs.ToArray(), false, null);
            if (problem != null) { try { File.Delete(temp); } catch { } return problem; }
            try
            {
                if (File.Exists(dll)) File.Delete(temp);
                else File.Move(temp, dll);
            }
            catch (Exception ex) { return ex.Message; }
            return null;
        }

        // Older builds are no longer needed.
        private static void Tidy(string keep)
        {
            try
            {
                foreach (string f in Directory.GetFiles(CacheFolder, "app-*.dll"))
                {
                    if (string.Equals(f, keep, StringComparison.OrdinalIgnoreCase)) continue;
                    if (File.GetLastWriteTimeUtc(f) < DateTime.UtcNow.AddDays(-2) || f.EndsWith(".tmp.dll", StringComparison.OrdinalIgnoreCase))
                    {
                        try { File.Delete(f); } catch { }
                    }
                }
            }
            catch { }
        }
    }

    // The C# compiler that is part of Windows (.NET Framework).
    internal static class Compiler
    {
        internal static string Run(string[] files, string output, string[] refs, bool program, string icon)
        {
            if (!program) return RunOnce(files, output, refs, false, null, null);
            string manifest = Path.Combine(Program.here, "Glasswave.manifest");
            string problem = RunOnce(files, output, refs, true, icon, File.Exists(manifest) ? manifest : null);
            if (problem == null) return null;
            Program.Log("Building with the icon and Windows note failed; trying a plain build:" + problem);
            return RunOnce(files, output, refs, true, null, null);
        }

        private static string RunOnce(string[] files, string output, string[] refs, bool program, string icon, string manifest)
        {
            using (CSharpCodeProvider provider = new CSharpCodeProvider())
            {
                CompilerParameters p = new CompilerParameters(refs, output);
                p.GenerateExecutable = program;
                p.GenerateInMemory = false;
                p.IncludeDebugInformation = false;
                p.TreatWarningsAsErrors = false;
                string options = "/optimize+ /platform:anycpu";
                if (program) options += " /target:winexe";
                if (!string.IsNullOrEmpty(icon) && File.Exists(icon)) options += " /win32icon:\"" + icon + "\"";
                if (!string.IsNullOrEmpty(manifest)) options += " /win32manifest:\"" + manifest + "\"";
                p.CompilerOptions = options;
                CompilerResults result = provider.CompileAssemblyFromFile(p, files);
                try { p.TempFiles.Delete(); } catch { }
                if (!result.Errors.HasErrors && File.Exists(output)) return null;
                StringBuilder sb = new StringBuilder();
                int shown = 0;
                foreach (CompilerError e in result.Errors)
                {
                    if (e.IsWarning) continue;
                    if (shown++ >= 12) break;
                    sb.Append("\n   ").Append(Path.GetFileName(e.FileName)).Append('(').Append(e.Line).Append("): ").Append(e.ErrorNumber).Append(' ').Append(e.ErrorText);
                }
                return shown == 0 ? "no output was made" : sb.ToString();
            }
        }
    }

    // ---- keeping Glasswave.exe itself up to date ----------------------------------------------
    // When launcher\Glasswave.cs is newer than this program, a new Glasswave.exe is built next to it.
    // A running program can be renamed but not overwritten, so this one becomes Glasswave.old.exe
    // (removed on the next start) and the new one takes its name.
    internal static class SelfUpdate
    {
        internal static void Check()
        {
            string source = Path.Combine(Program.here, "Glasswave.cs");
            if (!File.Exists(source)) return;
            DateTime changed = File.GetLastWriteTimeUtc(source);
            bool newer = changed > File.GetLastWriteTimeUtc(Program.exePath).AddMinutes(1);
            bool unnoted = !Native.Manifested() && File.Exists(Path.Combine(Program.here, "Glasswave.manifest"));
            if (!newer && !unnoted) return;
            string attempt = changed.Ticks + (newer ? "" : "|note");
            string tried = Path.Combine(Program.here, "Glasswave.cs.tried");
            if (File.Exists(tried) && File.ReadAllText(tried).Trim() == attempt) return;

            Program.Log(newer ? "Glasswave.cs changed; building a new Glasswave.exe." : "Building Glasswave.exe again with its Windows 10/11 note.");
            string next = Path.Combine(Program.root, "Glasswave.next.exe");
            string old = Path.Combine(Program.root, "Glasswave.old.exe");
            try { if (File.Exists(next)) File.Delete(next); } catch { }
            string problem = Compiler.Run(new string[] { source }, next, new string[] { "System.dll", "System.Core.dll", "System.Drawing.dll", "System.Windows.Forms.dll" },
                                          true, Path.Combine(Program.root, "app", "icon.ico"));
            if (problem != null)
            {
                Program.Log("The new Glasswave.exe did not build:" + problem);
                try { File.WriteAllText(tried, attempt); } catch { }
                try { File.Delete(next); } catch { }
                return;
            }
            try { if (File.Exists(old)) File.Delete(old); } catch { }
            File.Move(Program.exePath, old);
            try { File.Move(next, Program.exePath); }
            catch { File.Move(old, Program.exePath); throw; }
            // Remember this attempt, so a build that still lacks the note is not repeated on every start.
            try { File.WriteAllText(tried, attempt); } catch { }
            Program.Log("Glasswave.exe updated; the new version opens next time.");
        }
    }

    // ---- the "Starting..." card shown while the window code is being built -------------------
    internal sealed class Splash : Form
    {
        internal static Splash Open(string text)
        {
            try
            {
                Splash s = new Splash(text);
                s.Show();
                Application.DoEvents();
                return s;
            }
            catch { return null; }
        }

        private Splash(string text)
        {
            Text = "Glasswave";
            FormBorderStyle = FormBorderStyle.None;
            StartPosition = FormStartPosition.CenterScreen;
            Size = new Size(360, 110);
            BackColor = Color.FromArgb(14, 17, 30);
            ShowInTaskbar = false;
            TopMost = true;
            Label label = new Label();
            label.Text = text;
            label.Dock = DockStyle.Fill;
            label.TextAlign = ContentAlignment.MiddleCenter;
            label.ForeColor = Color.FromArgb(225, 230, 245);
            label.Font = new Font("Segoe UI", 12f);
            Controls.Add(label);
        }
    }

    // ---- small bits of Windows ----------------------------------------------------------------
    internal static class Native
    {
        [DllImport("user32.dll")] private static extern bool SetProcessDPIAware();
        [DllImport("user32.dll")] private static extern bool SetProcessDpiAwarenessContext(IntPtr value);
        [DllImport("shell32.dll", CharSet = CharSet.Unicode)] private static extern int SetCurrentProcessExplicitAppUserModelID(string id);
        private delegate bool WindowVisitor(IntPtr hwnd, IntPtr data);
        [DllImport("user32.dll")] private static extern bool EnumWindows(WindowVisitor visit, IntPtr data);
        [DllImport("user32.dll", CharSet = CharSet.Unicode)] private static extern int GetWindowText(IntPtr hwnd, StringBuilder text, int max);
        [DllImport("user32.dll")] private static extern bool IsWindowVisible(IntPtr hwnd);
        [DllImport("user32.dll")] private static extern bool IsIconic(IntPtr hwnd);
        [DllImport("user32.dll")] private static extern bool ShowWindow(IntPtr hwnd, int show);
        [DllImport("user32.dll")] private static extern bool SetForegroundWindow(IntPtr hwnd);
        [DllImport("user32.dll")] private static extern uint GetWindowThreadProcessId(IntPtr hwnd, out uint pid);
        [DllImport("ntdll.dll")] private static extern int RtlGetVersion(ref OsVersionInfo info);

        [StructLayout(LayoutKind.Sequential, CharSet = CharSet.Unicode)]
        private struct OsVersionInfo
        {
            public int Size, Major, Minor, Build, Platform;
            [MarshalAs(UnmanagedType.ByValTStr, SizeConst = 128)] public string Service;
        }

        // The Windows version as it really is (programs without the note are told an older one).
        internal static Version RealVersion()
        {
            try
            {
                OsVersionInfo v = new OsVersionInfo();
                v.Size = Marshal.SizeOf(typeof(OsVersionInfo));
                if (RtlGetVersion(ref v) == 0) return new Version(v.Major, v.Minor, v.Build);
            }
            catch { }
            return Environment.OSVersion.Version;
        }

        // Does this program carry its "made for Windows 10/11" note? Without it, Windows reports an older version.
        internal static bool Manifested()
        {
            Version real = RealVersion();
            return real.Major < 10 || Environment.OSVersion.Version.Major >= 10;
        }

        internal static void Prepare()
        {
            try { SetCurrentProcessExplicitAppUserModelID(Program.AppId); } catch { }
            // Sharp text on high-resolution screens.
            try { if (!SetProcessDpiAwarenessContext(new IntPtr(-4))) SetProcessDPIAware(); }
            catch { try { SetProcessDPIAware(); } catch { } }
        }

        // Glasswave is already open: show that window instead of opening a second one.
        internal static void BringForward()
        {
            IntPtr found = IntPtr.Zero;
            WindowVisitor visit = delegate(IntPtr hwnd, IntPtr data)
            {
                if (!IsWindowVisible(hwnd)) return true;
                StringBuilder sb = new StringBuilder(512);
                GetWindowText(hwnd, sb, sb.Capacity);
                string title = sb.ToString();
                if (title != "Glasswave" && !title.EndsWith(" - Glasswave", StringComparison.Ordinal)) return true;
                uint pid;
                GetWindowThreadProcessId(hwnd, out pid);
                try
                {
                    string name = Process.GetProcessById((int)pid).ProcessName.ToLowerInvariant();
                    if (name != "glasswave" && name != "powershell") return true;
                }
                catch { return true; }
                found = hwnd;
                return false;
            };
            try
            {
                EnumWindows(visit, IntPtr.Zero);
                if (found != IntPtr.Zero)
                {
                    if (IsIconic(found)) ShowWindow(found, 9);
                    SetForegroundWindow(found);
                }
            }
            catch { }
            GC.KeepAlive(visit);
        }
    }

    // ---- the Start menu entry (this is what Windows search finds) -------------------------------
    internal static class StartMenu
    {
        [ComImport, Guid("00021401-0000-0000-C000-000000000046")]
        private class ShellLinkObject { }

        [ComImport, InterfaceType(ComInterfaceType.InterfaceIsIUnknown), Guid("000214F9-0000-0000-C000-000000000046")]
        private interface IShellLinkW
        {
            void GetPath([Out, MarshalAs(UnmanagedType.LPWStr)] StringBuilder file, int max, IntPtr findData, uint flags);
            void GetIDList(out IntPtr idList);
            void SetIDList(IntPtr idList);
            void GetDescription([Out, MarshalAs(UnmanagedType.LPWStr)] StringBuilder name, int max);
            void SetDescription([MarshalAs(UnmanagedType.LPWStr)] string name);
            void GetWorkingDirectory([Out, MarshalAs(UnmanagedType.LPWStr)] StringBuilder dir, int max);
            void SetWorkingDirectory([MarshalAs(UnmanagedType.LPWStr)] string dir);
            void GetArguments([Out, MarshalAs(UnmanagedType.LPWStr)] StringBuilder args, int max);
            void SetArguments([MarshalAs(UnmanagedType.LPWStr)] string args);
            void GetHotkey(out short hotkey);
            void SetHotkey(short hotkey);
            void GetShowCmd(out int show);
            void SetShowCmd(int show);
            void GetIconLocation([Out, MarshalAs(UnmanagedType.LPWStr)] StringBuilder path, int max, out int index);
            void SetIconLocation([MarshalAs(UnmanagedType.LPWStr)] string path, int index);
            void SetRelativePath([MarshalAs(UnmanagedType.LPWStr)] string path, uint reserved);
            void Resolve(IntPtr hwnd, uint flags);
            void SetPath([MarshalAs(UnmanagedType.LPWStr)] string file);
        }

        [ComImport, InterfaceType(ComInterfaceType.InterfaceIsIUnknown), Guid("886D8EEB-8CF2-4446-8D02-CDBA1DBDCF99")]
        private interface IPropertyStore
        {
            [PreserveSig] int GetCount(out uint count);
            [PreserveSig] int GetAt(uint index, out PropertyKey key);
            [PreserveSig] int GetValue(ref PropertyKey key, out PropVariant value);
            [PreserveSig] int SetValue(ref PropertyKey key, ref PropVariant value);
            [PreserveSig] int Commit();
        }

        [StructLayout(LayoutKind.Sequential, Pack = 4)]
        private struct PropertyKey
        {
            public Guid Format;
            public uint Id;
        }

        [StructLayout(LayoutKind.Explicit)]
        private struct PropVariant
        {
            [FieldOffset(0)] public ushort Type;
            [FieldOffset(8)] public IntPtr Pointer;
            [FieldOffset(16)] public IntPtr Spare;     // a full PROPVARIANT is 24 bytes on 64-bit Windows
        }

        internal static string LinkPath
        {
            get { return Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.Programs), "Glasswave.lnk"); }
        }

        // Makes sure the Start menu has a "Glasswave" entry that opens this program.
        internal static bool Ensure(bool always)
        {
            string link = LinkPath;
            try
            {
                if (!always && File.Exists(link) && string.Equals(TargetOf(link), Program.exePath, StringComparison.OrdinalIgnoreCase)) return true;
                Create(link);
                Program.Log("Start menu entry " + (always ? "written" : "added") + ": " + link);
                return true;
            }
            catch (Exception ex)
            {
                Program.Log("Could not add the Start menu entry: " + ex.Message);
                return false;
            }
        }

        private static string TargetOf(string link)
        {
            object o = new ShellLinkObject();
            try
            {
                ((IPersistFile)o).Load(link, 0);
                StringBuilder sb = new StringBuilder(1024);
                ((IShellLinkW)o).GetPath(sb, sb.Capacity, IntPtr.Zero, 0);
                return Path.GetFullPath(sb.ToString());
            }
            catch { return ""; }
            finally { Marshal.ReleaseComObject(o); }
        }

        private static void Create(string link)
        {
            object o = new ShellLinkObject();
            try
            {
                IShellLinkW sl = (IShellLinkW)o;
                sl.SetPath(Program.exePath);
                sl.SetArguments("");
                sl.SetWorkingDirectory(Program.root);
                string icon = Path.Combine(Program.root, "app", "icon.ico");
                sl.SetIconLocation(File.Exists(icon) ? icon : Program.exePath, 0);
                sl.SetDescription("Glasswave music player");

                // The same app ID as the window, so pinning the open window to the taskbar pins this entry.
                IPropertyStore store = (IPropertyStore)o;
                PropertyKey key = new PropertyKey();
                key.Format = new Guid("9F4C2855-9F79-4B39-A8D0-E1D42DE1D5F3");
                key.Id = 5;
                PropVariant value = new PropVariant();
                value.Type = 31;                                   // text
                value.Pointer = Marshal.StringToCoTaskMemUni(Program.AppId);
                try
                {
                    Marshal.ThrowExceptionForHR(store.SetValue(ref key, ref value));
                    Marshal.ThrowExceptionForHR(store.Commit());
                }
                finally { Marshal.FreeCoTaskMem(value.Pointer); }

                Directory.CreateDirectory(Path.GetDirectoryName(link));
                ((IPersistFile)o).Save(link, true);
            }
            finally { Marshal.ReleaseComObject(o); }
        }
    }
}
