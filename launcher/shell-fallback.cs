// The previous version of Glasswave's window, kept as a spare. Glasswave.exe and standalone.ps1
// only use it if the newer shell.cs will not build on this computer, so the player still opens.
//
// Glasswave's own window, used by "Start Glasswave (own window)".
//
// It is a plain Windows window with no browser frame and no border of its own: no
// browser buttons, and the app draws the top bar itself. The app also asks this
// window to resize from its edges, to shrink into the mini player and to go full screen. Inside is WebView2, the Microsoft Edge engine that
// is part of Windows. standalone.ps1 compiles this file each time it starts, so it
// is written in the older style of C# that Windows' built-in compiler understands.

using System;
using System.Diagnostics;
using System.Drawing;
using System.IO;
using System.Reflection;
using System.Runtime.InteropServices;
using System.Windows.Forms;
using Microsoft.Web.WebView2.Core;
using Microsoft.Web.WebView2.WinForms;

namespace Glasswave
{
    public class ShellForm : Form
    {
        private const int WM_NCCALCSIZE = 0x0083;
        private const int WM_NCLBUTTONDOWN = 0x00A1;
        private const int WM_SYSCOMMAND = 0x0112;
        private const int SC_MAXIMIZE = 0xF030;
        private const int HTCAPTION = 2, HTLEFT = 10, HTRIGHT = 11, HTTOP = 12, HTTOPLEFT = 13,
                          HTTOPRIGHT = 14, HTBOTTOM = 15, HTBOTTOMLEFT = 16, HTBOTTOMRIGHT = 17;
        private const int NORMAL = 0, MINI = 1, FULL = 2;          // the three shapes the window can take

        [StructLayout(LayoutKind.Sequential)]
        private struct RECT { public int Left; public int Top; public int Right; public int Bottom; }

        [DllImport("user32.dll")] private static extern bool ReleaseCapture();
        [DllImport("user32.dll")] private static extern IntPtr SendMessage(IntPtr hWnd, int msg, IntPtr wParam, IntPtr lParam);
        [DllImport("user32.dll")] private static extern bool IsZoomed(IntPtr hWnd);
        [DllImport("dwmapi.dll")] private static extern int DwmSetWindowAttribute(IntPtr hwnd, int attribute, ref int value, int size);

        private readonly WebView2 view;
        private readonly string startUrl;
        private readonly string dataDir;
        private readonly string logPath;
        private readonly string placementFile;
        private readonly Size normalMinimum = new Size(780, 540);
        private int mode = NORMAL;
        private Rectangle normalBounds;
        private FormWindowState normalState = FormWindowState.Normal;
        private Rectangle miniBounds = Rectangle.Empty;
        private bool wasMaximised;
        private Rectangle startBounds;
        private bool started;                       // the window is up: from here on its place is saved as it changes
        private string savedPlace = "";
        private SoundWatcher sound;                 // listens to what the computer is playing, for the visualizer
        private Timer soundTimer;

        public ShellForm(string url, string dataFolder, string iconPath, string logFile)
        {
            startUrl = url;
            dataDir = dataFolder;
            logPath = logFile;
            placementFile = Path.Combine(dataFolder, "window.txt");

            Text = "Glasswave";
            AutoScaleMode = AutoScaleMode.None;
            BackColor = Color.FromArgb(8, 10, 18);
            MinimumSize = normalMinimum;
            StartPosition = FormStartPosition.Manual;
            try { if (File.Exists(iconPath)) Icon = new Icon(iconPath); } catch { }
            LoadPlacement();

            view = new WebView2();
            view.Dock = DockStyle.Fill;
            view.DefaultBackgroundColor = Color.FromArgb(8, 10, 18);
            Controls.Add(view);
        }

        private void Log(string text)
        {
            try { File.AppendAllText(logPath, DateTime.Now.ToString("yyyy-MM-dd HH:mm:ss") + "  " + text + Environment.NewLine); }
            catch { }
        }

        // ---- start-up ------------------------------------------------------------------------
        protected override void OnHandleCreated(EventArgs e)
        {
            base.OnHandleCreated(e);
            try { int on = 1; DwmSetWindowAttribute(Handle, 20, ref on, 4); } catch { }      // dark window shadow
            try { int none = unchecked((int)0xFFFFFFFE); DwmSetWindowAttribute(Handle, 34, ref none, 4); } catch { }   // Windows 11: no outline
        }

        protected override async void OnLoad(EventArgs e)
        {
            base.OnLoad(e);
            // Windows quietly trims a frameless window's height while it is being created,
            // so put the remembered size back now that the window exists.
            try { if (WindowState == FormWindowState.Normal && Bounds != startBounds) Bounds = startBounds; } catch { }
            started = true;
            try
            {
                CoreWebView2EnvironmentOptions options = new CoreWebView2EnvironmentOptions();
                options.AdditionalBrowserArguments = "--autoplay-policy=no-user-gesture-required";
                CoreWebView2Environment environment = await CoreWebView2Environment.CreateAsync(null, dataDir, options);
                await view.EnsureCoreWebView2Async(environment);

                CoreWebView2 core = view.CoreWebView2;
                core.Settings.IsStatusBarEnabled = false;
                core.Settings.AreDefaultContextMenusEnabled = false;       // the app has its own right-click menus
                core.Settings.IsZoomControlEnabled = false;
                // Lets the strip at the top of the app behave like a real title bar (drag, double-click, snap).
                TrySet(core.Settings, "IsNonClientRegionSupportEnabled", true);
                TrySet(core.Settings, "IsSwipeNavigationEnabled", false);
                core.WebMessageReceived += OnWebMessage;
                core.NewWindowRequested += OnNewWindow;
                core.DocumentTitleChanged += OnTitleChanged;
                core.ProcessFailed += OnProcessFailed;
                core.Navigate(startUrl);
                Log("Window ready. WebView2 runtime " + environment.BrowserVersionString);
            }
            catch (Exception ex)
            {
                Log("ERROR while starting the web view: " + ex);
                MessageBox.Show(this,
                    "Glasswave's own window could not start its web view.\n\n" + ex.Message +
                    "\n\nYou can still open Glasswave with \"Start Glasswave\".",
                    "Glasswave", MessageBoxButtons.OK, MessageBoxIcon.Warning);
                Close();
            }
        }

        private void TrySet(object target, string property, object value)
        {
            try
            {
                PropertyInfo info = target.GetType().GetProperty(property);
                if (info != null && info.CanWrite) info.SetValue(target, value, null);
                else Log(property + " is not offered by this WebView2 version.");
            }
            catch (Exception ex) { Log(property + " could not be set: " + ex.Message); }
        }

        // ---- messages from the app (its own window buttons, resizing, mini player, full screen) ------
        private void OnWebMessage(object sender, CoreWebView2WebMessageReceivedEventArgs e)
        {
            string message = null;
            try { message = e.TryGetWebMessageAsString(); } catch { }
            if (string.IsNullOrEmpty(message)) return;
            // Act after this call has returned, so the web view is never closed or moved from inside its own event.
            try { BeginInvoke(new Action<string>(Act), message); } catch { }
        }

        private void Act(string message)
        {
            try
            {
                if (message == "min") WindowState = FormWindowState.Minimized;
                else if (message == "max")
                {
                    if (mode == NORMAL) WindowState = (WindowState == FormWindowState.Maximized) ? FormWindowState.Normal : FormWindowState.Maximized;
                }
                else if (message == "close") Close();
                else if (message == "drag")
                {
                    if (mode != FULL)
                    {
                        ReleaseCapture();
                        SendMessage(Handle, WM_NCLBUTTONDOWN, (IntPtr)HTCAPTION, IntPtr.Zero);
                    }
                }
                else if (message == "hello")
                {
                    // The app asks which window it is in. This one can do everything.
                    Tell("host:2");
                    Tell(WindowState == FormWindowState.Maximized ? "win:max" : "win:normal");
                }
                else if (message.StartsWith("resize:")) StartResize(message.Substring(7));
                else if (message == "mode:normal") SetMode(NORMAL);
                else if (message == "mode:mini") SetMode(MINI);
                else if (message == "mode:full") SetMode(FULL);
                else if (message == "viz:1") StartSound();
                else if (message == "viz:0") StopSound();
            }
            catch (Exception ex) { Log("Message '" + message + "' failed: " + ex.Message); }
        }

        private void Tell(string text)
        {
            try { if (view != null && view.CoreWebView2 != null) view.CoreWebView2.PostWebMessageAsString(text); }
            catch { }
        }

        // The window has no border to grab. The app has unseen strips along its edges, and
        // tells this window when one of them is pressed.
        private void StartResize(string edge)
        {
            if (mode == FULL || WindowState != FormWindowState.Normal) return;
            int hit = 0;
            if (edge == "n") hit = HTTOP;
            else if (edge == "s") hit = HTBOTTOM;
            else if (edge == "w") hit = HTLEFT;
            else if (edge == "e") hit = HTRIGHT;
            else if (edge == "nw") hit = HTTOPLEFT;
            else if (edge == "ne") hit = HTTOPRIGHT;
            else if (edge == "sw") hit = HTBOTTOMLEFT;
            else if (edge == "se") hit = HTBOTTOMRIGHT;
            if (hit == 0) return;
            Point p = Cursor.Position;
            IntPtr spot = (IntPtr)((p.Y << 16) | (p.X & 0xFFFF));
            ReleaseCapture();
            SendMessage(Handle, WM_NCLBUTTONDOWN, (IntPtr)hit, spot);
        }

        // ---- normal window, mini player, full screen ------------------------------------------
        private float DpiFactor()
        {
            try { using (Graphics g = CreateGraphics()) { return Math.Max(1f, g.DpiX / 96f); } }
            catch { return 1f; }
        }

        private void SetMode(int next)
        {
            if (next == mode) return;
            if (mode == NORMAL)
            {
                normalState = (WindowState == FormWindowState.Maximized) ? FormWindowState.Maximized : FormWindowState.Normal;
                normalBounds = (WindowState == FormWindowState.Normal) ? Bounds : RestoreBounds;
            }
            else if (mode == MINI && WindowState == FormWindowState.Normal) miniBounds = Bounds;
            mode = next;
            try { int corners = (next == FULL) ? 1 : 0; DwmSetWindowAttribute(Handle, 33, ref corners, 4); } catch { }   // square corners only in full screen

            if (WindowState != FormWindowState.Normal) WindowState = FormWindowState.Normal;
            if (next == NORMAL)
            {
                TopMost = false;
                MinimumSize = normalMinimum;
                Bounds = normalBounds;
                if (normalState == FormWindowState.Maximized) WindowState = FormWindowState.Maximized;
            }
            else if (next == MINI)
            {
                float k = DpiFactor();
                MinimumSize = new Size((int)(280 * k), (int)(140 * k));
                Rectangle seen = miniBounds.IsEmpty ? Rectangle.Empty : Rectangle.Intersect(miniBounds, Screen.FromRectangle(miniBounds).WorkingArea);
                if (miniBounds.IsEmpty || seen.Width < 120 || seen.Height < 80)
                {
                    // First time: a small card in the bottom right corner of the screen.
                    Rectangle work = Screen.FromHandle(Handle).WorkingArea;
                    int w = (int)(430 * k), h = (int)(204 * k), gap = (int)(18 * k);
                    miniBounds = new Rectangle(work.Right - w - gap, work.Bottom - h - gap, w, h);
                }
                Bounds = miniBounds;
                TopMost = true;                                  // the mini player stays above other windows
            }
            else
            {
                MinimumSize = new Size(200, 120);
                Bounds = Screen.FromHandle(Handle).Bounds;       // the whole screen, taskbar included
                TopMost = true;
                Activate();
            }
            SavePlacement();
        }

        // ---- the sound the computer is playing, for the visualizer ---------------------------------
        private void StartSound()
        {
            try
            {
                if (sound == null) sound = new SoundWatcher();
                string problem = sound.Start();
                if (problem != null)
                {
                    Log("The visualizer cannot hear this computer's sound: " + problem);
                    Tell("viz:deaf");
                    return;
                }
                if (soundTimer == null)
                {
                    soundTimer = new Timer();
                    soundTimer.Interval = 33;
                    soundTimer.Tick += OnSoundTick;
                }
                soundTimer.Start();
            }
            catch (Exception ex) { Log("Visualizer sound failed to start: " + ex.Message); Tell("viz:deaf"); }
        }

        private void StopSound()
        {
            try { if (soundTimer != null) soundTimer.Stop(); } catch { }
            try { if (sound != null) sound.Stop(); } catch { }
        }

        private void OnSoundTick(object sender, EventArgs e)
        {
            try
            {
                if (sound == null) return;
                string bands = sound.Read();
                if (bands == null)
                {
                    // The sound device changed or went away: try once more with the new one.
                    sound.Stop();
                    string problem = sound.Start();
                    if (problem != null) { soundTimer.Stop(); Log("Visualizer sound stopped: " + problem); Tell("viz:deaf"); }
                    return;
                }
                Tell("fft:" + bands);
            }
            catch (Exception ex) { try { soundTimer.Stop(); } catch { } Log("Visualizer sound stopped: " + ex.Message); Tell("viz:deaf"); }
        }

        protected override void OnActivated(EventArgs e)
        {
            base.OnActivated(e);
            if (mode == FULL && !TopMost) TopMost = true;
        }

        protected override void OnDeactivate(EventArgs e)
        {
            base.OnDeactivate(e);
            // In full screen, switching to another program must not leave this window covering it.
            if (mode == FULL && TopMost) TopMost = false;
        }

        private void BackToMiniSize()
        {
            if (mode == MINI && WindowState == FormWindowState.Maximized) WindowState = FormWindowState.Normal;
        }

        private void OnNewWindow(object sender, CoreWebView2NewWindowRequestedEventArgs e)
        {
            try
            {
                string current = (view.Source != null) ? view.Source.ToString() : "";
                string target = e.Uri;
                // Links opened from inside the app (Open in Spotify, the developer dashboard) go to your normal browser.
                // Pop-ups during Spotify's own sign-in are left alone so signing in keeps working.
                if (current.StartsWith(startUrl, StringComparison.OrdinalIgnoreCase) && target != null &&
                    (target.StartsWith("http://", StringComparison.OrdinalIgnoreCase) || target.StartsWith("https://", StringComparison.OrdinalIgnoreCase)))
                {
                    e.Handled = true;
                    ProcessStartInfo info = new ProcessStartInfo(target);
                    info.UseShellExecute = true;
                    Process.Start(info);
                }
            }
            catch (Exception ex) { Log("Could not open a link: " + ex.Message); }
        }

        private void OnTitleChanged(object sender, object e)
        {
            try
            {
                string title = view.CoreWebView2.DocumentTitle;
                Text = (string.IsNullOrEmpty(title) || title == "Glasswave") ? "Glasswave" : title + " - Glasswave";
            }
            catch { }
        }

        private void OnProcessFailed(object sender, CoreWebView2ProcessFailedEventArgs e)
        {
            Log("A WebView2 process stopped: " + e.ProcessFailedKind);
            try
            {
                if (e.ProcessFailedKind == CoreWebView2ProcessFailedKind.RenderProcessExited ||
                    e.ProcessFailedKind == CoreWebView2ProcessFailedKind.RenderProcessUnresponsive)
                {
                    view.CoreWebView2.Reload();
                }
            }
            catch { }
        }

        // ---- a window without Windows' own title bar, that can still be resized and snapped -------
        protected override void WndProc(ref Message m)
        {
            if (m.Msg == WM_NCCALCSIZE)
            {
                // Give the whole window to the app, so Windows draws no title bar or frame.
                if (m.LParam != IntPtr.Zero && IsZoomed(m.HWnd))
                {
                    // Maximised: stay inside the screen's work area (not under the taskbar or past the edges).
                    Rectangle work = Screen.FromHandle(m.HWnd).WorkingArea;
                    RECT r = new RECT();
                    r.Left = work.Left; r.Top = work.Top; r.Right = work.Right; r.Bottom = work.Bottom;
                    Marshal.StructureToPtr(r, m.LParam, false);
                }
                m.Result = IntPtr.Zero;
                return;
            }
            if (m.Msg == WM_SYSCOMMAND && mode != NORMAL && ((m.WParam.ToInt64() & 0xFFF0) == SC_MAXIMIZE))
            {
                return;                                          // the mini player and full screen are not maximised
            }
            base.WndProc(ref m);
        }

        protected override void OnResize(EventArgs e)
        {
            base.OnResize(e);
            // The app hides its resize strips while the window is maximised.
            bool maximised = (WindowState == FormWindowState.Maximized);
            if (maximised != wasMaximised)
            {
                wasMaximised = maximised;
                Tell(maximised ? "win:max" : "win:normal");
                SavePlacement();
            }
            if (maximised && mode == MINI)
            {
                try { BeginInvoke(new Action(BackToMiniSize)); } catch { }
            }
        }

        // Fires when you let go after dragging or stretching the window.
        protected override void OnResizeEnd(EventArgs e)
        {
            base.OnResizeEnd(e);
            SavePlacement();
        }

        // ---- remember where the window was ----------------------------------------------------
        // Saved every time the window is moved, stretched, maximised or changes shape, so it is
        // kept however Glasswave ends up being closed.
        private void SavePlacement()
        {
            if (!started) return;
            try
            {
                if (WindowState == FormWindowState.Minimized) return;
                if (mode == NORMAL)
                {
                    normalState = (WindowState == FormWindowState.Maximized) ? FormWindowState.Maximized : FormWindowState.Normal;
                    normalBounds = (WindowState == FormWindowState.Normal) ? Bounds : RestoreBounds;
                }
                else if (mode == MINI && WindowState == FormWindowState.Normal) miniBounds = Bounds;
                Rectangle b = normalBounds;
                if (b.Width < 200 || b.Height < 150) return;
                string text = b.X + "," + b.Y + "," + b.Width + "," + b.Height + "," + (normalState == FormWindowState.Maximized ? "1" : "0") +
                              "," + miniBounds.X + "," + miniBounds.Y + "," + miniBounds.Width + "," + miniBounds.Height;
                if (text == savedPlace) return;
                File.WriteAllText(placementFile, text);
                savedPlace = text;
            }
            catch { }
        }

        private void LoadPlacement()
        {
            Rectangle work = Screen.PrimaryScreen.WorkingArea;
            int w = Math.Min(1340, work.Width - 80), h = Math.Min(880, work.Height - 80);
            Rectangle bounds = new Rectangle(work.Left + (work.Width - w) / 2, work.Top + (work.Height - h) / 2, w, h);
            bool maximised = false;
            try
            {
                if (File.Exists(placementFile))
                {
                    string[] parts = File.ReadAllText(placementFile).Trim().Split(',');
                    if (parts.Length >= 5)
                    {
                        Rectangle saved = new Rectangle(int.Parse(parts[0]), int.Parse(parts[1]), int.Parse(parts[2]), int.Parse(parts[3]));
                        Rectangle visible = Rectangle.Intersect(saved, Screen.FromRectangle(saved).WorkingArea);
                        if (saved.Width >= 600 && saved.Height >= 400 && visible.Width > 200 && visible.Height > 150) bounds = saved;
                        maximised = parts[4] == "1";
                        if (parts.Length >= 9)
                        {
                            Rectangle mini = new Rectangle(int.Parse(parts[5]), int.Parse(parts[6]), int.Parse(parts[7]), int.Parse(parts[8]));
                            if (mini.Width >= 200 && mini.Height >= 100) miniBounds = mini;
                        }
                    }
                }
            }
            catch { }
            startBounds = bounds;
            normalBounds = bounds;
            Bounds = bounds;
            if (maximised) { normalState = FormWindowState.Maximized; WindowState = FormWindowState.Maximized; }
        }

        protected override void OnFormClosing(FormClosingEventArgs e)
        {
            SavePlacement();
            StopSound();
            Log("Window closing.");
            base.OnFormClosing(e);
        }
    }

    // ---- Windows' own way of listening to what the speakers are playing ("loopback") -------------
    // Used only while the visualizer is open. Nothing is recorded or kept: each moment of sound
    // is turned into 48 bar heights and forgotten.
    [ComImport, Guid("BCDE0395-E52F-467C-8E3D-C4579291692E")]
    internal class MMDeviceEnumeratorClass { }

    [ComImport, Guid("A95664D2-9614-4F35-A746-DE8DB63617E6"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
    internal interface IMMDeviceEnumerator
    {
        [PreserveSig] int EnumAudioEndpoints(int dataFlow, int stateMask, out IntPtr devices);
        [PreserveSig] int GetDefaultAudioEndpoint(int dataFlow, int role, out IMMDevice device);
    }

    [ComImport, Guid("D666063F-1587-4E43-81F1-B948E807363F"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
    internal interface IMMDevice
    {
        [PreserveSig] int Activate(ref Guid iid, int clsCtx, IntPtr activationParams, [MarshalAs(UnmanagedType.IUnknown)] out object instance);
    }

    [ComImport, Guid("1CB9AD4C-DBFA-4C32-B178-C2F568A703B2"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
    internal interface IAudioClient
    {
        [PreserveSig] int Initialize(int shareMode, int streamFlags, long bufferDuration, long periodicity, IntPtr format, IntPtr sessionGuid);
        [PreserveSig] int GetBufferSize(out uint frames);
        [PreserveSig] int GetStreamLatency(out long latency);
        [PreserveSig] int GetCurrentPadding(out uint frames);
        [PreserveSig] int IsFormatSupported(int shareMode, IntPtr format, out IntPtr closest);
        [PreserveSig] int GetMixFormat(out IntPtr format);
        [PreserveSig] int GetDevicePeriod(out long defaultPeriod, out long minimumPeriod);
        [PreserveSig] int Start();
        [PreserveSig] int Stop();
        [PreserveSig] int Reset();
        [PreserveSig] int SetEventHandle(IntPtr handle);
        [PreserveSig] int GetService(ref Guid iid, [MarshalAs(UnmanagedType.IUnknown)] out object service);
    }

    [ComImport, Guid("C8ADBD64-E71E-48A0-A4DE-185C395CD317"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
    internal interface IAudioCaptureClient
    {
        [PreserveSig] int GetBuffer(out IntPtr data, out uint frames, out uint flags, out ulong devicePosition, out ulong clockPosition);
        [PreserveSig] int ReleaseBuffer(uint frames);
        [PreserveSig] int GetNextPacketSize(out uint frames);
    }

    internal class SoundWatcher
    {
        private const int SIZE = 1024;                 // samples looked at each time
        private const int BANDS = 48;
        private IAudioClient client;
        private IAudioCaptureClient capture;
        private int channels, rate, bits;
        private bool isFloat;
        private float[] floats = new float[4096];
        private short[] shorts = new short[4096];
        private readonly float[] ring = new float[SIZE];
        private int ringAt;
        private readonly float[] re = new float[SIZE];
        private readonly float[] im = new float[SIZE];
        private readonly float[] window = new float[SIZE];
        private readonly float[] level = new float[BANDS];
        private readonly char[] text = new char[BANDS * 2];

        public SoundWatcher()
        {
            for (int i = 0; i < SIZE; i++) window[i] = (float)(0.5 - 0.5 * Math.Cos(2 * Math.PI * i / (SIZE - 1)));
        }

        // Returns null when listening has started, or a short reason when it could not.
        public string Start()
        {
            Stop();
            IMMDeviceEnumerator devices = null;
            IMMDevice device = null;
            IntPtr format = IntPtr.Zero;
            try
            {
                devices = (IMMDeviceEnumerator)(new MMDeviceEnumeratorClass());
                int hr = devices.GetDefaultAudioEndpoint(0, 1, out device);          // the speakers or headphones in use
                if (hr != 0 || device == null) return "no sound device (" + hr.ToString("X8") + ")";
                Guid clientId = typeof(IAudioClient).GUID;
                object found;
                hr = device.Activate(ref clientId, 23, IntPtr.Zero, out found);
                if (hr != 0 || found == null) return "the sound device would not open (" + hr.ToString("X8") + ")";
                client = (IAudioClient)found;
                hr = client.GetMixFormat(out format);
                if (hr != 0 || format == IntPtr.Zero) return "no sound format (" + hr.ToString("X8") + ")";
                int tag = (ushort)Marshal.ReadInt16(format, 0);
                channels = Marshal.ReadInt16(format, 2);
                rate = Marshal.ReadInt32(format, 4);
                bits = Marshal.ReadInt16(format, 14);
                int extra = Marshal.ReadInt16(format, 16);
                isFloat = (tag == 3) || (tag == 0xFFFE && extra >= 22 && Marshal.ReadInt32(format, 24) == 3);
                bool isPcm16 = !isFloat && bits == 16;
                if (channels < 1 || channels > 16 || rate < 8000 || !((isFloat && bits == 32) || isPcm16)) return "a sound format the visualizer does not know";
                hr = client.Initialize(0, 0x00020000, 2000000, 0, format, IntPtr.Zero);   // shared, loopback, a fifth of a second of room
                if (hr != 0) return "listening was refused (" + hr.ToString("X8") + ")";
                Guid captureId = typeof(IAudioCaptureClient).GUID;
                object service;
                hr = client.GetService(ref captureId, out service);
                if (hr != 0 || service == null) return "no capture service (" + hr.ToString("X8") + ")";
                capture = (IAudioCaptureClient)service;
                hr = client.Start();
                if (hr != 0) return "listening would not start (" + hr.ToString("X8") + ")";
                Array.Clear(ring, 0, SIZE);
                Array.Clear(level, 0, BANDS);
                return null;
            }
            catch (Exception ex) { Stop(); return ex.Message; }
            finally
            {
                if (format != IntPtr.Zero) { try { Marshal.FreeCoTaskMem(format); } catch { } }
                if (device != null) { try { Marshal.ReleaseComObject(device); } catch { } }
                if (devices != null) { try { Marshal.ReleaseComObject(devices); } catch { } }
            }
        }

        public void Stop()
        {
            try { if (client != null) client.Stop(); } catch { }
            if (capture != null) { try { Marshal.ReleaseComObject(capture); } catch { } capture = null; }
            if (client != null) { try { Marshal.ReleaseComObject(client); } catch { } client = null; }
        }

        // The newest sound as 48 bar heights, two letters each ("00" silent to "ff" loudest).
        // Returns null when the sound device has gone away.
        public string Read()
        {
            if (capture == null) return null;
            bool heard = false;
            for (int guard = 0; guard < 200; guard++)
            {
                uint waiting;
                int hr = capture.GetNextPacketSize(out waiting);
                if (hr != 0) return null;
                if (waiting == 0) break;
                IntPtr data; uint frames; uint flags; ulong position; ulong clock;
                hr = capture.GetBuffer(out data, out frames, out flags, out position, out clock);
                if (hr < 0) return null;
                int count = (int)frames, total = count * channels;
                bool silent = (flags & 2) != 0 || data == IntPtr.Zero;
                if (count > 0 && total <= 1048576)
                {
                    if (!silent)
                    {
                        if (isFloat)
                        {
                            if (floats.Length < total) floats = new float[total];
                            Marshal.Copy(data, floats, 0, total);
                        }
                        else
                        {
                            if (shorts.Length < total) shorts = new short[total];
                            Marshal.Copy(data, shorts, 0, total);
                        }
                    }
                    for (int i = 0; i < count; i++)
                    {
                        float sum = 0f;
                        if (!silent)
                        {
                            int at = i * channels;
                            if (isFloat) { for (int c = 0; c < channels; c++) sum += floats[at + c]; }
                            else { for (int c = 0; c < channels; c++) sum += shorts[at + c] / 32768f; }
                            sum /= channels;
                        }
                        ring[ringAt] = sum;
                        ringAt = (ringAt + 1) % SIZE;
                    }
                    heard = true;
                }
                capture.ReleaseBuffer(frames);
            }
            if (!heard)
            {
                // Nothing is playing: let the bars sink.
                for (int b = 0; b < BANDS; b++) level[b] *= 0.85f;
            }
            else
            {
                for (int i = 0; i < SIZE; i++) { re[i] = ring[(ringAt + i) % SIZE] * window[i]; im[i] = 0f; }
                Transform(re, im);
                double low = 40.0, high = Math.Min(16000.0, rate / 2.0 - 1.0), ratio = Math.Pow(high / low, 1.0 / BANDS);
                double edge = low;
                for (int b = 0; b < BANDS; b++)
                {
                    double next = edge * ratio;
                    int first = (int)Math.Floor(edge * SIZE / rate), last = (int)Math.Ceiling(next * SIZE / rate);
                    if (first < 1) first = 1;
                    if (last <= first) last = first + 1;
                    if (last > SIZE / 2) last = SIZE / 2;
                    double top = 0;
                    for (int k = first; k < last; k++)
                    {
                        double m = Math.Sqrt(re[k] * re[k] + im[k] * im[k]);
                        if (m > top) top = m;
                    }
                    double loud = 20.0 * Math.Log10(top / SIZE + 1e-9);                  // measured the way a browser's own analyser does
                    float v = (float)((loud + 90.0) / 80.0);                             // -90 (silent) to -10 (very loud) becomes 0 to 1
                    if (v < 0f) v = 0f; else if (v > 1f) v = 1f;
                    level[b] = v;
                    edge = next;
                }
            }
            const string HEX = "0123456789abcdef";
            for (int b = 0; b < BANDS; b++)
            {
                int n = (int)(level[b] * 255f);
                text[b * 2] = HEX[(n >> 4) & 15];
                text[b * 2 + 1] = HEX[n & 15];
            }
            return new string(text);
        }

        // A plain fast Fourier transform: turns a moment of sound into "how much of each pitch".
        private static void Transform(float[] real, float[] imag)
        {
            int n = real.Length;
            for (int i = 1, j = 0; i < n; i++)
            {
                int bit = n >> 1;
                for (; (j & bit) != 0; bit >>= 1) j ^= bit;
                j ^= bit;
                if (i < j) { float t = real[i]; real[i] = real[j]; real[j] = t; t = imag[i]; imag[i] = imag[j]; imag[j] = t; }
            }
            for (int len = 2; len <= n; len <<= 1)
            {
                double angle = -2.0 * Math.PI / len;
                float stepR = (float)Math.Cos(angle), stepI = (float)Math.Sin(angle);
                for (int i = 0; i < n; i += len)
                {
                    float curR = 1f, curI = 0f;
                    for (int k = 0; k < len / 2; k++)
                    {
                        int a = i + k, b = i + k + len / 2;
                        float xr = real[b] * curR - imag[b] * curI, xi = real[b] * curI + imag[b] * curR;
                        real[b] = real[a] - xr; imag[b] = imag[a] - xi;
                        real[a] += xr; imag[a] += xi;
                        float nr = curR * stepR - curI * stepI;
                        curI = curR * stepI + curI * stepR;
                        curR = nr;
                    }
                }
            }
        }
    }

    public static class Shell
    {
        public static void Start(string url, string dataFolder, string iconPath, string logFile)
        {
            // If something ever stops the window unexpectedly, leave a note about it in the log.
            try
            {
                AppDomain.CurrentDomain.UnhandledException += delegate(object sender, UnhandledExceptionEventArgs e)
                {
                    try { File.AppendAllText(logFile, DateTime.Now.ToString("yyyy-MM-dd HH:mm:ss") + "  CRASH: " + e.ExceptionObject + Environment.NewLine); }
                    catch { }
                };
            }
            catch { }
            Application.EnableVisualStyles();
            using (ShellForm form = new ShellForm(url, dataFolder, iconPath, logFile))
            {
                Application.Run(form);
            }
        }
    }
}
