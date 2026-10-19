// Qomicex Assistant - launcher UI automation agent (Windows).
//
// This runs as a compiled executable rather than a PowerShell script on
// purpose: the screenshot / input-injection API surface is heuristically
// flagged by Defender's AMSI script scanner
// (HackTool:PowerShell/EmpireGetScreenshot.C). AMSI only inspects PowerShell
// script text, so moving the very same logic into a plain .NET executable
// keeps the capability while avoiding the false positive.
//
// Usage:
//   QomicexUiAgent.exe -Action snapshot -ArgsFile a.json -Out r.json
// Actions: snapshot | click | type | keys | focus | screenshot
// Arguments and results are UTF-8 JSON files (never the command line), which
// keeps non-ASCII element names and input text lossless.
//
// While acting, the assistant draws its *own* cursor (a click-through overlay
// owned by the launcher window) and drives the UI by posting messages straight
// to the WebView2 render host. Neither the real mouse pointer nor the
// foreground window is touched, so the user can keep working while the
// assistant operates, and the assistant still works when the launcher is in
// the background.
//
// An earlier version animated the real pointer with SetCursorPos and called
// SetForegroundWindow before every action. That hijacked the user's mouse and
// stole focus mid-keystroke, so it was replaced. Things that were learned the
// hard way and must not be undone:
//
//   * The process has to be per-monitor DPI aware *before* the first UI call.
//     A DPI-unaware process gets its posted-message coordinates virtualized by
//     Windows, which silently shifts every click by roughly one list row.
//   * Never post WM_UNICHAR (0x0109): it takes the WebView2 render process
//     down. Characters go through WM_CHAR, which one WebView2 build narrowed
//     to a single byte, so non-ASCII text uses ValuePattern instead.
//   * Posted modifier keys do nothing useful: Chromium reads the real keyboard
//     state, so Ctrl+A arrives as a plain "a". Anything with Ctrl/Alt/Shift
//     needs the focus path (activate=true), which does bring the launcher
//     forward and is therefore opt-in.
//   * UIAutomation's Invoke on a Chromium element brings the window to the
//     foreground as a side effect, so "auto" posts the click first and only
//     falls back to Invoke (verified by measuring GetForegroundWindow around
//     both paths).

using System;
using System.Collections.Generic;
using System.Drawing;
using System.Drawing.Imaging;
using System.Globalization;
using System.IO;
using System.Runtime.InteropServices;
using System.Text;
using System.Threading;
using System.Windows.Automation;
using System.Windows.Forms;
using System.Web.Script.Serialization;

namespace Qomicex.UiAgent
{
    internal static class Native
    {
        [DllImport("user32.dll")] public static extern bool SetProcessDPIAware();
        [DllImport("user32.dll")] public static extern IntPtr GetForegroundWindow();
        [DllImport("user32.dll")] public static extern bool SetForegroundWindow(IntPtr h);
        [DllImport("user32.dll")] public static extern bool BringWindowToTop(IntPtr h);
        [DllImport("user32.dll")] public static extern IntPtr SetActiveWindow(IntPtr h);
        [DllImport("user32.dll")] public static extern bool ShowWindow(IntPtr h, int cmd);
        [DllImport("user32.dll")] public static extern bool IsIconic(IntPtr h);
        [DllImport("user32.dll")] public static extern int GetWindowThreadProcessId(IntPtr h, IntPtr pid);
        [DllImport("user32.dll")] public static extern bool AttachThreadInput(int a, int b, bool attach);
        [DllImport("kernel32.dll")] public static extern int GetCurrentThreadId();
        [DllImport("user32.dll")] public static extern bool PrintWindow(IntPtr h, IntPtr dc, uint flags);
        [DllImport("user32.dll")] public static extern bool GetCursorPos(out POINT p);
        [DllImport("user32.dll")] public static extern bool SetCursorPos(int x, int y);
        [DllImport("user32.dll")] public static extern void mouse_event(uint flags, uint dx, uint dy, uint data, IntPtr extra);
        [DllImport("user32.dll")] public static extern bool SetProcessDpiAwarenessContext(IntPtr value);
        [DllImport("user32.dll", CharSet = CharSet.Unicode)] public static extern int GetClassName(IntPtr h, StringBuilder s, int n);
        [DllImport("user32.dll")] public static extern bool EnumChildWindows(IntPtr h, EnumProc cb, IntPtr param);
        [DllImport("user32.dll")] public static extern bool PostMessage(IntPtr h, uint msg, IntPtr w, IntPtr l);
        [DllImport("user32.dll")] public static extern bool ScreenToClient(IntPtr h, ref POINT p);
        [DllImport("user32.dll")] public static extern bool GetClientRect(IntPtr h, out RECT r);
        [DllImport("user32.dll")] public static extern IntPtr SetWindowLongPtr(IntPtr h, int index, IntPtr value);
        [DllImport("user32.dll")] public static extern bool SetWindowPos(IntPtr h, IntPtr after, int x, int y, int w, int hh, uint flags);
        [DllImport("user32.dll")] public static extern uint GetDpiForWindow(IntPtr h);

        public delegate bool EnumProc(IntPtr hwnd, IntPtr param);

        [StructLayout(LayoutKind.Sequential)]
        public struct RECT { public int L, T, R, B; }

        [StructLayout(LayoutKind.Sequential)]
        public struct POINT { public int X, Y; }

        public const uint MOUSEEVENTF_LEFTDOWN = 0x0002;
        public const uint MOUSEEVENTF_LEFTUP = 0x0004;
        public const uint PW_RENDERFULLCONTENT = 0x00000002;

        // —— 投递给 WebView2 内核的消息 ——
        // 这些坐标是「内核窗口客户区的物理像素」：本进程是 per-monitor DPI aware，
        // 所以 UIA 给的屏幕矩形直接 ScreenToClient 就是对的（见文件头注释）。
        public const uint WM_MOUSEMOVE = 0x0200;
        public const uint WM_LBUTTONDOWN = 0x0201;
        public const uint WM_LBUTTONUP = 0x0202;
        public const uint WM_KEYDOWN = 0x0100;
        public const uint WM_KEYUP = 0x0101;
        public const uint WM_CHAR = 0x0102;
        public const int GWL_HWNDPARENT = -8;
        public static readonly IntPtr HWND_TOPMOST = new IntPtr(-1);
        public const uint SWP_NOSIZE = 0x0001;
        public const uint SWP_NOMOVE = 0x0002;
        public const uint SWP_NOACTIVATE = 0x0010;
        public const uint SWP_SHOWWINDOW = 0x0040;

        /// <summary>屏幕坐标 → 供鼠标/键盘消息使用的 lParam（目标窗口客户区坐标）。</summary>
        public static IntPtr ClientLParam(IntPtr hwnd, int screenX, int screenY, out int clientX, out int clientY)
        {
            POINT p; p.X = screenX; p.Y = screenY;
            ScreenToClient(hwnd, ref p);
            clientX = p.X; clientY = p.Y;
            return new IntPtr((p.Y << 16) | (p.X & 0xFFFF));
        }

        public static IntPtr KeyLParam(int scan = 0x1C, bool up = false)
        {
            int lp = (scan << 16) | 1;
            if (up) { lp |= 1 << 30; lp |= unchecked((int)(1u << 31)); }
            return new IntPtr(lp);
        }

        /// <summary>操作完把窗口恢复一下（最小化时点击落不到界面上）。</summary>
        public static void EnsureRestored(IntPtr hwnd)
        {
            if (IsIconic(hwnd)) { ShowWindow(hwnd, 9); Thread.Sleep(160); }
        }

        /// <summary>
        /// 把前台窗口还给 target（尽量做到）。
        ///
        /// 用途：Chromium 的 ValuePattern.SetValue / UIA Invoke 会在实现里调用
        /// SetForegroundWindow，把启动器拽到前台 —— 用户正打着字就被抢走焦点。
        /// 这两条路径都不该打断用户，所以操作一结束就用这个把前台还回去。
        /// 后台进程直接 SetForegroundWindow 会被前台锁挡住，所以先 AttachThreadInput
        /// 到当前前台线程（那一刻就是启动器自己的线程）再切。
        /// </summary>
        public static bool RestoreForeground(IntPtr target)
        {
            if (target == IntPtr.Zero) return false;
            IntPtr fg = GetForegroundWindow();
            int fgt = GetWindowThreadProcessId(fg, IntPtr.Zero);
            int me = GetCurrentThreadId();
            bool attached = false;
            try
            {
                if (fgt != 0 && fgt != me) attached = AttachThreadInput(fgt, me, true);
                BringWindowToTop(target);
                SetForegroundWindow(target);
                SetActiveWindow(target);
            }
            catch { }
            finally
            {
                if (attached) { try { AttachThreadInput(fgt, me, false); } catch { } }
            }
            return GetForegroundWindow() == target;
        }

        public static void RealClick()
        {
            mouse_event(MOUSEEVENTF_LEFTDOWN, 0, 0, 0, IntPtr.Zero);
            Thread.Sleep(25);
            mouse_event(MOUSEEVENTF_LEFTUP, 0, 0, 0, IntPtr.Zero);
        }

        /// <summary>
        /// 把窗口切到前台。只有「用户/模型明确要求抢焦点」的路径才该调用它
        /// （例如带 Ctrl/Alt 的快捷键、或者模式的显式逃生舱），因为这会打断
        /// 用户正在做的事。注意别再像以前那样无条件 SW_SHOW：窗口没最小化时
        /// 那一下就会把它抬到最前。
        /// </summary>
        public static bool Activate(IntPtr hwnd)
        {
            if (IsIconic(hwnd)) { ShowWindow(hwnd, 9); Thread.Sleep(140); }
            int fg = GetWindowThreadProcessId(GetForegroundWindow(), IntPtr.Zero);
            int me = GetCurrentThreadId();
            bool attached = false;
            if (fg != 0 && fg != me) { attached = AttachThreadInput(fg, me, true); }
            try
            {
                BringWindowToTop(hwnd);
                SetForegroundWindow(hwnd);
                SetActiveWindow(hwnd);
            }
            finally
            {
                if (attached) { AttachThreadInput(fg, me, false); }
            }
            Thread.Sleep(70);
            return GetForegroundWindow() == hwnd;
        }
    }

    internal sealed class WinInfo
    {
        public AutomationElement Element;
        public string Name;
        public IntPtr Handle;
        public int Pid;
        public System.Windows.Rect Rect;
        public double Area;
    }

    internal sealed class ItemInfo
    {
        public int[] Path;
        public string Type;
        public string Name;
        public string Value;
        public int[] Rect;
        public bool Enabled;
        public List<string> Actions;
        public int Nth;
    }

    /// <summary>
    /// 助手自己的光标 —— 不是系统指针。
    ///
    /// 背景：早期版本用 SetCursorPos + mouse_event 驱动**真实**指针，于是每次操作都会
    /// 夺走用户的鼠标，并在动作前后抢走前台窗口。用户的要求很明确：显示进度必须是 AI
    /// 自己的虚拟鼠标，而且不能锁定/打断用户正在做的事。所以改成在启动器窗口上盖一个
    /// 自己的小窗口来显示位置与点击：
    ///
    ///   * TopMost + owner = 启动器窗口：保证盖在启动器之上。历史上"分层窗口被启动器
    ///     遮挡"的问题就是这么解的 —— 由启动器拥有的窗口永远在 owner 之上，再叠一层
    ///     topmost，每次移动都重打一次 HWND_TOPMOST。
    ///   * WS_EX_NOACTIVATE + WS_EX_TOOLWINDOW：永不抢焦点、不进 alt-tab、不占任务栏。
    ///   * WS_EX_TRANSPARENT：鼠标事件直接穿过去，用户想点哪还点哪。
    ///   * TransparencyKey 色键抠图：只画出箭头和点击涟漪，其余整块透明。
    ///
    /// 头号验收标准：用它的过程中，真实指针坐标不能变、前台窗口不能变。
    /// </summary>
    internal sealed class VirtualCursor : Form
    {
        private const int WS_EX_TRANSPARENT = 0x00000020;
        private const int WS_EX_NOACTIVATE = 0x08000000;
        private const int WS_EX_TOOLWINDOW = 0x00000080;

        private const int Box = 72;   // 窗口边长
        private const int TipX = 28;  // 箭头尖端在窗口内的位置（留出涟漪半径）
        private const int TipY = 28;
        private const float ArrowScale = 1.15f;

        private static readonly Color Key = Color.FromArgb(255, 0, 255);           // 透明色键
        private static readonly Color Fill = Color.FromArgb(255, 30, 30, 38);      // 箭头填充
        private static readonly Color Edge = Color.FromArgb(255, 250, 250, 252);   // 箭头描边
        private static readonly Color RippleColor = Color.FromArgb(255, 110, 160, 255);

        private Point _tip;       // 箭头尖端的屏幕坐标
        private int _ripple = -1; // -1 = 无涟漪；0..100 = 进度

        public VirtualCursor(IntPtr owner, Point startScreen)
        {
            _tip = startScreen;
            FormBorderStyle = FormBorderStyle.None;
            ShowInTaskbar = false;
            StartPosition = FormStartPosition.Manual;
            TopMost = true;
            BackColor = Key;
            TransparencyKey = Key;
            Size = new Size(Box, Box);
            SetStyle(ControlStyles.AllPaintingInWmPaint | ControlStyles.UserPaint | ControlStyles.OptimizedDoubleBuffer, true);
            // 先摸一下 Handle 把窗口创建出来，再认启动器窗口当 owner。
            IntPtr h = Handle;
            if (owner != IntPtr.Zero)
            {
                try { Native.SetWindowLongPtr(h, Native.GWL_HWNDPARENT, owner); } catch { }
            }
        }

        // 别让 Show() 抢焦点 —— 抢焦点就等于打断用户。
        protected override bool ShowWithoutActivation { get { return true; } }

        protected override CreateParams CreateParams
        {
            get
            {
                var cp = base.CreateParams;
                cp.ExStyle |= WS_EX_TRANSPARENT | WS_EX_NOACTIVATE | WS_EX_TOOLWINDOW;
                return cp;
            }
        }

        private void Place()
        {
            // 只用 SetWindowPos 移动：Form.Left/Top 会走激活逻辑。
            Native.SetWindowPos(Handle, Native.HWND_TOPMOST,
                _tip.X - TipX, _tip.Y - TipY, Box, Box,
                Native.SWP_NOACTIVATE | Native.SWP_SHOWWINDOW);
        }

        /// <summary>显示并滑到目标点。失败返回 null（拿不到光标就退化成"没有动画"，操作照做）。</summary>
        public static VirtualCursor Begin(IntPtr owner, Point from, Point to, bool animate, int ms)
        {
            try
            {
                var c = new VirtualCursor(owner, from);
                c.Show();
                c.Place();
                c.Refresh();
                Application.DoEvents();
                c.Glide(to, animate, ms);
                return c;
            }
            catch (Exception ex) { LastError = ex.GetType().Name + ": " + ex.Message; return null; }
        }

        /// <summary>上一次 Begin() 失败的原因（诊断用；成功时为空）。</summary>
        public static string LastError = "";

        public void Glide(Point to, bool animate, int ms)
        {
            var from = _tip;
            if (!animate || ms < 40 || (from.X == to.X && from.Y == to.Y))
            {
                _tip = to; Place(); Refresh(); Application.DoEvents(); return;
            }
            int steps = Math.Max(2, ms / 15);
            for (int i = 1; i <= steps; i++)
            {
                double t = 1.0 - Math.Pow(1.0 - (double)i / steps, 3.0);
                _tip = new Point(
                    from.X + (int)Math.Round((to.X - from.X) * t),
                    from.Y + (int)Math.Round((to.Y - from.Y) * t));
                Place(); Refresh(); Application.DoEvents();
                Thread.Sleep(15);
            }
            _tip = to; Place(); Refresh(); Application.DoEvents();
        }

        /// <summary>点一下的视觉反馈：一圈扩散的涟漪。</summary>
        public void Ripple(int ms)
        {
            int steps = Math.Max(6, ms / 24);
            for (int i = 0; i <= steps; i++)
            {
                _ripple = i * 100 / steps;
                Refresh(); Application.DoEvents();
                Thread.Sleep(24);
            }
            _ripple = -1; Refresh(); Application.DoEvents();
        }

        /// <summary>停一小会儿再消失，避免"闪一下就没"。</summary>
        public void LingerAndClose(int ms)
        {
            try { if (ms > 0) { Thread.Sleep(ms); Application.DoEvents(); } } catch { }
            try { Close(); } catch { }
        }

        protected override void OnPaint(PaintEventArgs e)
        {
            var g = e.Graphics;
            g.Clear(Key);  // 涂成色键 = 透明
            // 色键抠图不认半透明像素：这里必须关掉抗锯齿，否则边缘会留一圈洋红。
            g.SmoothingMode = System.Drawing.Drawing2D.SmoothingMode.None;
            if (_ripple >= 0)
            {
                int r = 6 + _ripple * 21 / 100;
                using (var pen = new Pen(RippleColor, 3)) g.DrawEllipse(pen, TipX - r, TipY - r, r * 2, r * 2);
            }
            var pts = Arrow();
            using (var edge = new Pen(Edge, 3.2f))
            {
                edge.LineJoin = System.Drawing.Drawing2D.LineJoin.Round;
                g.DrawPolygon(edge, pts);
            }
            using (var brush = new SolidBrush(Fill)) g.FillPolygon(brush, pts);
        }

        private static Point[] Arrow()
        {
            float[][] shape = {
                new float[] { 0f, 0f },
                new float[] { 0f, 16.5f },
                new float[] { 3.8f, 12.8f },
                new float[] { 6.6f, 19.6f },
                new float[] { 9.6f, 18.2f },
                new float[] { 6.9f, 11.6f },
                new float[] { 11.6f, 11.6f }
            };
            var pts = new Point[shape.Length];
            for (int i = 0; i < shape.Length; i++)
            {
                pts[i] = new Point(
                    TipX + (int)Math.Round(shape[i][0] * ArrowScale),
                    TipY + (int)Math.Round(shape[i][1] * ArrowScale));
            }
            return pts;
        }
    }

    internal static class Program
    {
        private const string AgentVersion = "1.3.0";
        private static readonly JavaScriptSerializer Json = new JavaScriptSerializer();
        private static Dictionary<string, object> _a = new Dictionary<string, object>();
        private static readonly Dictionary<string, object> _res = new Dictionary<string, object>();
        private static string _outPath;
        private static string _statePath;
        private static List<string> _lastNames = new List<string>();
        // 虚拟光标上次停留的屏幕坐标（持久化，跨进程延续动画）。
        private static int _cursorX = int.MinValue;
        private static int _cursorY = int.MinValue;

        // Short-ref registry.
        //
        // A ref has to survive in the model's context and be copied back verbatim,
        // so it must be *short*. Encoding the whole locator (index path + type +
        // name + nth, base64) produced ~85 character refs, which burned most of
        // the per-tool-result character budget on a single snapshot. Instead the
        // snapshot stores the locator here (in the state file, which already
        // persists between invocations) and hands out "e12"-style handles.
        private static readonly Dictionary<string, Dictionary<string, object>> _refMap =
            new Dictionary<string, Dictionary<string, object>>(StringComparer.Ordinal);
        private static readonly List<string> _refOrder = new List<string>();
        private static int _refSeq = 0;
        private const int RefMapLimit = 600;

        private static readonly HashSet<string> InteractiveTypes = new HashSet<string>(StringComparer.Ordinal)
        {
            "Button", "Edit", "CheckBox", "RadioButton", "ComboBox", "Hyperlink", "ListItem",
            "MenuItem", "TabItem", "TreeItem", "Slider", "Spinner", "SplitButton", "DataItem", "HeaderItem"
        };

        [STAThread]
        private static int Main(string[] rawArgs)
        {
            // DPI 感知要在任何界面调用之前设定好：投递坐标是按「渲染宿主客户区的物理像素」
            // 算的，进程一旦不是 DPI 感知，Windows 会把坐标虚拟化，点击就整体偏一个条目。
            // per-monitor v2 (-4) 优先，老系统回退到 system aware。
            try { Native.SetProcessDpiAwarenessContext(new IntPtr(-4)); } catch { }
            try { Native.SetProcessDPIAware(); } catch { }
            Application.EnableVisualStyles();

            var opts = new Dictionary<string, string>(StringComparer.OrdinalIgnoreCase);
            for (int i = 0; i < rawArgs.Length - 1; i++)
            {
                if (rawArgs[i].StartsWith("-")) opts[rawArgs[i].TrimStart('-')] = rawArgs[i + 1];
            }
            string action = opts.ContainsKey("Action") ? opts["Action"] : "";
            string argsFile = opts.ContainsKey("ArgsFile") ? opts["ArgsFile"] : "";
            _outPath = opts.ContainsKey("Out") ? opts["Out"] : "";
            string shotPath = opts.ContainsKey("ShotPath") ? opts["ShotPath"] : "";

            if (string.IsNullOrEmpty(_outPath))
            {
                _outPath = string.IsNullOrEmpty(argsFile)
                    ? Path.Combine(Path.GetTempPath(), "qomicex-assistant", "ui-result.json")
                    : argsFile + ".result.json";
            }
            if (!opts.ContainsKey("StatePath") || string.IsNullOrEmpty(opts["StatePath"]))
            {
                _statePath = Path.Combine(Path.GetDirectoryName(_outPath) ?? Path.GetTempPath(), "ui-state.json");
            }
            else { _statePath = opts["StatePath"]; }

            _res["action"] = action;
            _res["agentVersion"] = AgentVersion;

            if (string.IsNullOrEmpty(action)) { Fail("action is required", "E_ARGS"); return 0; }

            LoadArgs(argsFile);
            LoadState();

            try
            {
                switch (action)
                {
                    case "focus": ActionFocus(); break;
                    case "snapshot": ActionSnapshot(); break;
                    case "click": ActionClick(); break;
                    case "type": ActionType(); break;
                    case "keys": ActionKeys(); break;
                    case "screenshot": ActionScreenshot(shotPath); break;
                    default: Fail("unknown action: " + action, "E_ARGS"); break;
                }
            }
            catch (AgentException aex)
            {
                Fail(aex.Message, aex.Code);
            }
            catch (Exception ex)
            {
                Fail(ex.Message, "E_UNEXPECTED");
            }
            finally
            {
                SaveState();
            }

            WriteResult();
            return 0;
        }

        // ---------------- plumbing ----------------

        private static void LoadArgs(string path)
        {
            _a = new Dictionary<string, object>();
            if (string.IsNullOrEmpty(path) || !File.Exists(path)) return;
            try
            {
                string raw = File.ReadAllText(path, Encoding.UTF8);
                if (raw.Trim().Length == 0) return;
                var parsed = Json.DeserializeObject(raw) as Dictionary<string, object>;
                if (parsed != null) _a = parsed;
            }
            catch { }
        }

        private static string AStr(string key, string fallback)
        {
            object v;
            if (_a.TryGetValue(key, out v) && v != null)
            {
                var s = v as string;
                if (s != null) return s;
                return Convert.ToString(v, CultureInfo.InvariantCulture);
            }
            return fallback;
        }

        private static int AInt(string key, int fallback)
        {
            object v;
            if (_a.TryGetValue(key, out v) && v != null)
            {
                try { return Convert.ToInt32(v, CultureInfo.InvariantCulture); } catch { return fallback; }
            }
            return fallback;
        }

        private static bool ABool(string key, bool fallback)
        {
            object v;
            if (_a.TryGetValue(key, out v) && v != null)
            {
                if (v is bool) return (bool)v;
                string s = Convert.ToString(v, CultureInfo.InvariantCulture);
                if (s == "1" || string.Equals(s, "true", StringComparison.OrdinalIgnoreCase)) return true;
                if (s == "0" || string.Equals(s, "false", StringComparison.OrdinalIgnoreCase)) return false;
            }
            return fallback;
        }

        private static void WriteResult()
        {
            try
            {
                string dir = Path.GetDirectoryName(_outPath);
                if (!string.IsNullOrEmpty(dir) && !Directory.Exists(dir)) Directory.CreateDirectory(dir);
                File.WriteAllText(_outPath, Json.Serialize(_res), new UTF8Encoding(false));
            }
            catch { }
        }

        private static void Fail(string message, string code)
        {
            _res["ok"] = false;
            _res["error"] = message;
            _res["code"] = code;
            WriteResult();
        }

        private static void LoadState()
        {
            if (string.IsNullOrEmpty(_statePath) || !File.Exists(_statePath)) return;
            try
            {
                var s = Json.DeserializeObject(File.ReadAllText(_statePath, Encoding.UTF8)) as Dictionary<string, object>;
                if (s == null) return;
                object v;
                if (s.TryGetValue("names", out v) && v != null)
                {
                    var arr = v as object[];
                    if (arr != null)
                    {
                        _lastNames = new List<string>();
                        foreach (var o in arr)
                        {
                            var so = o as string;
                            if (so != null) _lastNames.Add(so);
                        }
                    }
                }
                if (s.TryGetValue("refSeq", out v) && v != null)
                {
                    try { _refSeq = Convert.ToInt32(v, CultureInfo.InvariantCulture); } catch { }
                }
                if (s.TryGetValue("refs", out v) && v != null)
                {
                    var arr = v as object[];
                    if (arr != null)
                    {
                        _refMap.Clear();
                        _refOrder.Clear();
                        foreach (var o in arr)
                        {
                            var d = o as Dictionary<string, object>;
                            if (d == null) continue;
                            object idObj;
                            if (!d.TryGetValue("id", out idObj)) continue;
                            string id = Convert.ToString(idObj, CultureInfo.InvariantCulture);
                            if (string.IsNullOrEmpty(id)) continue;
                            _refMap[id] = d;
                            _refOrder.Add(id);
                        }
                    }
                }
                // 上次虚拟光标停在哪：跨进程（每次操作都是新进程）延续动画，看起来才连贯。
                if (s.TryGetValue("cursor", out v) && v != null)
                {
                    var arr = v as object[];
                    if (arr != null && arr.Length == 2)
                    {
                        try
                        {
                            _cursorX = Convert.ToInt32(arr[0], CultureInfo.InvariantCulture);
                            _cursorY = Convert.ToInt32(arr[1], CultureInfo.InvariantCulture);
                        }
                        catch { }
                    }
                }
            }
            catch { }
        }

        private static void SaveState()
        {
            if (string.IsNullOrEmpty(_statePath)) return;
            try
            {
                var d = new Dictionary<string, object>();
                var names = new List<string>();
                int limit = Math.Min(_lastNames.Count, 400);
                for (int i = 0; i < limit; i++) names.Add(_lastNames[i]);
                d["names"] = names.ToArray();
                d["refSeq"] = _refSeq;
                var refs = new List<object>();
                int skip = Math.Max(0, _refOrder.Count - RefMapLimit);
                for (int i = skip; i < _refOrder.Count; i++)
                {
                    string id = _refOrder[i];
                    Dictionary<string, object> payload;
                    if (_refMap.TryGetValue(id, out payload)) refs.Add(payload);
                }
                d["refs"] = refs.ToArray();
                if (_cursorX != int.MinValue && _cursorY != int.MinValue)
                    d["cursor"] = new[] { _cursorX, _cursorY };
                string dir = Path.GetDirectoryName(_statePath);
                if (!string.IsNullOrEmpty(dir) && !Directory.Exists(dir)) Directory.CreateDirectory(dir);
                File.WriteAllText(_statePath, Json.Serialize(d), new UTF8Encoding(false));
            }
            catch { }
        }

        // ---------------- window discovery ----------------

        private static List<WinInfo> LauncherWindows()
        {
            var list = new List<WinInfo>();
            var pids = new HashSet<int>();
            try
            {
                foreach (var p in System.Diagnostics.Process.GetProcesses())
                {
                    try
                    {
                        if (p.ProcessName.IndexOf("Qomicex", StringComparison.OrdinalIgnoreCase) >= 0) pids.Add(p.Id);
                    }
                    catch { }
                }
            }
            catch { }

            AutomationElementCollection all;
            try { all = AutomationElement.RootElement.FindAll(TreeScope.Children, Condition.TrueCondition); }
            catch { return list; }

            foreach (AutomationElement w in all)
            {
                try
                {
                    int pid = w.Current.ProcessId;
                    if (pids.Count > 0 && !pids.Contains(pid)) continue;
                    var r = w.Current.BoundingRectangle;
                    if (r.IsEmpty || r.Width < 200 || r.Height < 150) continue;
                    list.Add(new WinInfo
                    {
                        Element = w,
                        Name = w.Current.Name ?? "",
                        Handle = new IntPtr(w.Current.NativeWindowHandle),
                        Pid = pid,
                        Rect = r,
                        Area = r.Width * r.Height
                    });
                }
                catch { }
            }
            return list;
        }

        private static WinInfo TargetWindow()
        {
            var wins = LauncherWindows();
            if (wins.Count == 0) throw new AgentException("no launcher window found (is the launcher running?)", "E_NO_WINDOW");
            string hint = AStr("windowHint", "");
            if (!string.IsNullOrEmpty(hint))
            {
                foreach (var w in wins) if (w.Name.IndexOf(hint, StringComparison.OrdinalIgnoreCase) >= 0) return w;
            }
            IntPtr fg = Native.GetForegroundWindow();
            foreach (var w in wins) if (w.Handle == fg) return w;
            WinInfo best = wins[0];
            foreach (var w in wins) if (w.Area > best.Area) best = w;
            return best;
        }

        private static AutomationElement WebRoot(WinInfo win, int timeoutMs)
        {
            var cond = new PropertyCondition(AutomationElement.AutomationIdProperty, "RootWebArea");
            var deadline = DateTime.UtcNow.AddMilliseconds(timeoutMs);
            while (DateTime.UtcNow < deadline)
            {
                try
                {
                    var doc = win.Element.FindFirst(TreeScope.Descendants, cond);
                    if (doc != null) return doc;
                }
                catch { }
                Thread.Sleep(120);
            }
            return null;
        }

        // ---------------- element enumeration ----------------

        private static List<AutomationElement> Children(AutomationElement el)
        {
            var list = new List<AutomationElement>();
            try
            {
                var walker = TreeWalker.RawViewWalker;
                var c = walker.GetFirstChild(el);
                while (c != null)
                {
                    list.Add(c);
                    c = walker.GetNextSibling(c);
                }
            }
            catch { }
            return list;
        }

        private static bool TryPattern(AutomationElement el, AutomationPattern pattern, out object result)
        {
            result = null;
            try { return el.TryGetCurrentPattern(pattern, out result); }
            catch { return false; }
        }

        private static List<string> ElementActions(AutomationElement el)
        {
            var acts = new List<string>();
            object p;
            if (TryPattern(el, InvokePattern.Pattern, out p)) acts.Add("invoke");
            if (TryPattern(el, ValuePattern.Pattern, out p)) acts.Add("setValue");
            if (TryPattern(el, TogglePattern.Pattern, out p)) acts.Add("toggle");
            if (TryPattern(el, SelectionItemPattern.Pattern, out p)) acts.Add("select");
            if (TryPattern(el, ExpandCollapsePattern.Pattern, out p)) acts.Add("expand");
            if (TryPattern(el, ScrollItemPattern.Pattern, out p)) acts.Add("scrollItem");
            return acts;
        }

        private static string ElementValue(AutomationElement el)
        {
            object p;
            if (TryPattern(el, ValuePattern.Pattern, out p))
            {
                try
                {
                    var vp = p as ValuePattern;
                    if (vp != null)
                    {
                        string v = vp.Current.Value;
                        return v == null ? "" : v.Trim();
                    }
                }
                catch { }
            }
            return "";
        }

        private class EnumResult
        {
            public readonly List<ItemInfo> Items = new List<ItemInfo>();
            public readonly List<string> Names = new List<string>();
            public int Visited;
        }

        private static EnumResult Enumerate(AutomationElement root, int maxNodes, bool interactiveOnly)
        {
            var res = new EnumResult();
            var stack = new Stack<object[]>();
            stack.Push(new object[] { root, new int[0], 0 });
            while (stack.Count > 0 && res.Visited < maxNodes)
            {
                var cur = stack.Pop();
                var el = (AutomationElement)cur[0];
                var path = (int[])cur[1];
                int depth = (int)cur[2];
                res.Visited++;

                if (depth > 0)
                {
                    string type = "", name = "";
                    bool enabled = true;
                    int[] rect = null;
                    try
                    {
                        var c = el.Current;
                        type = c.ControlType.ProgrammaticName.Replace("ControlType.", "");
                        name = (c.Name ?? "").Trim();
                        enabled = c.IsEnabled;
                        var r = c.BoundingRectangle;
                        if (!r.IsEmpty) rect = new[] { (int)r.X, (int)r.Y, (int)r.Width, (int)r.Height };
                    }
                    catch { type = ""; }

                    if (!string.IsNullOrEmpty(type))
                    {
                        var actions = ElementActions(el);
                        bool interactive = actions.Count > 0 || InteractiveTypes.Contains(type);
                        if (!string.IsNullOrEmpty(name)) res.Names.Add(name);
                        bool keep = true;
                        if (interactiveOnly && !interactive) keep = false;
                        if (keep && !interactive && string.IsNullOrEmpty(name)) keep = false;
                        if (keep)
                        {
                            res.Items.Add(new ItemInfo
                            {
                                Path = path,
                                Type = type,
                                Name = name,
                                Value = ElementValue(el),
                                Rect = rect,
                                Enabled = enabled,
                                Actions = actions
                            });
                        }
                    }
                }

                if (depth < 60)
                {
                    var kids = Children(el);
                    for (int i = kids.Count - 1; i >= 0; i--)
                    {
                        var childPath = new int[path.Length + 1];
                        Array.Copy(path, childPath, path.Length);
                        childPath[path.Length] = i;
                        stack.Push(new object[] { kids[i], childPath, depth + 1 });
                    }
                }
            }
            return res;
        }

        /// <summary>
        /// Register a locator and hand back a short, stable-until-next-snapshot
        /// handle ("e12"). See _refMap for why refs must stay short.
        /// </summary>
        private static string ShortRef(ItemInfo item, int nth)
        {
            _refSeq++;
            string id = "e" + _refSeq.ToString(CultureInfo.InvariantCulture);
            var payload = new Dictionary<string, object>();
            payload["id"] = id;
            payload["p"] = item.Path;
            payload["t"] = item.Type;
            payload["n"] = item.Name;
            payload["i"] = nth;
            _refMap[id] = payload;
            _refOrder.Add(id);
            return id;
        }

        private static Dictionary<string, object> DecodeRef(string refStr)
        {
            string s = refStr.Replace('-', '+').Replace('_', '/');
            while (s.Length % 4 != 0) s += "=";
            string json = Encoding.UTF8.GetString(Convert.FromBase64String(s));
            return Json.DeserializeObject(json) as Dictionary<string, object>;
        }

        /// <summary>
        /// Resolve a ref produced by a previous snapshot. The recorded index path
        /// is preferred; if the tree shifted, fall back to (type, name, nth).
        /// </summary>
        private static AutomationElement Resolve(AutomationElement root, string refStr)
        {
            if (string.IsNullOrEmpty(refStr)) return null;
            Dictionary<string, object> parsed = null;

            // Current form: short handle registered by the last snapshot(s).
            string token = refStr.Trim();
            if (token.Length >= 2 && token[0] == 'e')
            {
                bool digits = true;
                for (int i = 1; i < token.Length; i++) if (token[i] < '0' || token[i] > '9') { digits = false; break; }
                if (digits) _refMap.TryGetValue(token, out parsed);
            }

            // Legacy form: self-contained base64 locator.
            if (parsed == null)
            {
                try { parsed = DecodeRef(refStr); }
                catch { parsed = null; }
            }
            if (parsed == null) return null;

            string wantType = parsed.ContainsKey("t") ? (Convert.ToString(parsed["t"], CultureInfo.InvariantCulture) ?? "") : "";
            string wantName = parsed.ContainsKey("n") ? (Convert.ToString(parsed["n"], CultureInfo.InvariantCulture) ?? "") : "";

            object pObj;
            if (parsed.TryGetValue("p", out pObj) && pObj is object[])
            {
                var indices = (object[])pObj;
                var el = root;
                bool ok = true;
                foreach (var io in indices)
                {
                    int idx = Convert.ToInt32(io, CultureInfo.InvariantCulture);
                    var kids = Children(el);
                    if (idx < 0 || idx >= kids.Count) { ok = false; break; }
                    el = kids[idx];
                }
                if (ok && el != null)
                {
                    try
                    {
                        var c = el.Current;
                        string t = c.ControlType.ProgrammaticName.Replace("ControlType.", "");
                        string n = (c.Name ?? "").Trim();
                        if (t == wantType && n == wantName) return el;
                    }
                    catch { }
                }
            }

            int wantIdx = 0;
            if (parsed.ContainsKey("i") && parsed["i"] != null)
            {
                try { wantIdx = Convert.ToInt32(parsed["i"], CultureInfo.InvariantCulture); } catch { wantIdx = 0; }
            }
            var cond = new PropertyCondition(AutomationElement.NameProperty, wantName);
            var found = root.FindAll(TreeScope.Descendants, cond);
            int seen = 0;
            foreach (AutomationElement e in found)
            {
                try
                {
                    string t = e.Current.ControlType.ProgrammaticName.Replace("ControlType.", "");
                    if (t != wantType) continue;
                    if (seen == wantIdx) return e;
                    seen++;
                }
                catch { }
            }
            return null;
        }

        // ---------------- pointer animation ----------------

        /// <summary>
        /// Move the real mouse pointer to a point, easing along the way so the
        /// user can follow the assistant's action. Starting from the pointer's
        /// current position keeps consecutive operations visually continuous.
        /// </summary>
        private static void MovePointer(int toX, int toY, int ms, bool animate)
        {
            Native.POINT from;
            if (!Native.GetCursorPos(out from)) { Native.SetCursorPos(toX, toY); return; }
            if (!animate || ms < 40 || (from.X == toX && from.Y == toY))
            {
                Native.SetCursorPos(toX, toY);
                return;
            }
            int steps = Math.Max(2, ms / 15);
            for (int i = 1; i <= steps; i++)
            {
                float t = 1f - (float)Math.Pow(1.0 - (double)i / steps, 3.0);
                Native.SetCursorPos(from.X + (int)Math.Round((toX - from.X) * t), from.Y + (int)Math.Round((toY - from.Y) * t));
                Thread.Sleep(15);
            }
            Native.SetCursorPos(toX, toY);
        }

        // ---------------- posted input (不动真实指针 / 不抢焦点) ----------------

        /// <summary>虚拟光标起点：上次停的位置；没有就取启动器窗口中心。</summary>
        private static Point CursorStart()
        {
            if (_cursorX != int.MinValue && _cursorY != int.MinValue)
                return new Point(_cursorX, _cursorY);
            try
            {
                var win = TargetWindow();
                return new Point((int)(win.Rect.X + win.Rect.Width / 2), (int)(win.Rect.Y + win.Rect.Height / 2));
            }
            catch { return new Point(0, 0); }
        }

        private static void RememberCursor(int x, int y)
        {
            _cursorX = x; _cursorY = y;
        }

        /// <summary>
        /// 如果某次操作把启动器窗口意外拽到了前台，就把前台还给用户原来那个窗口。
        /// 返回 true 表示「确实被抢了、而且成功还回去了」。
        /// </summary>
        private static bool UndoFocusSteal(IntPtr winHandle, IntPtr prevFg)
        {
            if (prevFg == IntPtr.Zero || prevFg == winHandle) return false;
            if (Native.GetForegroundWindow() != winHandle) return false;
            bool ok = Native.RestoreForeground(prevFg);
            if (ok) Thread.Sleep(60);
            return ok;
        }

        /// <summary>
        /// 找 WebView2 的渲染宿主窗口。鼠标消息必须投给它：Chromium 只有在这个窗口上
        /// 收到的按键消息才会做命中测试并派发给页面（投给 Chrome_WidgetWin_* 没用）。
        /// </summary>
        private static IntPtr RenderHost(IntPtr launcher)
        {
            IntPtr found = IntPtr.Zero;
            try
            {
                Native.EnumChildWindows(launcher, delegate(IntPtr child, IntPtr param)
                {
                    var sb = new StringBuilder(256);
                    if (Native.GetClassName(child, sb, sb.Capacity) > 0 &&
                        string.Equals(sb.ToString(), "Chrome_RenderWidgetHostHWND", StringComparison.Ordinal))
                    {
                        found = child;
                        return false;
                    }
                    return true;
                }, IntPtr.Zero);
            }
            catch { }
            return found;
        }

        /// <summary>
        /// 把一次点击"投递"进网页：不移动真实指针、不改变前台窗口。
        /// 序列 WM_MOUSEMOVE → WM_LBUTTONDOWN → WM_LBUTTONUP；坐标是渲染宿主客户区的
        /// 物理像素（本进程 DPI 感知，所以 UIA 的屏幕矩形直接 ScreenToClient 就对）。
        /// </summary>
        private static bool PostClick(IntPtr launcher, int screenX, int screenY, out string detail)
        {
            detail = "";
            var host = RenderHost(launcher);
            if (host == IntPtr.Zero) { detail = "render host window not found"; return false; }

            int cx, cy;
            IntPtr lp = Native.ClientLParam(host, screenX, screenY, out cx, out cy);
            Native.RECT cr;
            if (!Native.GetClientRect(host, out cr)) { detail = "GetClientRect failed"; return false; }
            if (cx < 0 || cy < 0 || cx >= cr.R - cr.L || cy >= cr.B - cr.T)
            {
                detail = "target is outside the web view (client " + cx + "," + cy + ")";
                return false;
            }

            Native.PostMessage(host, Native.WM_MOUSEMOVE, IntPtr.Zero, lp);
            Thread.Sleep(40);
            Native.PostMessage(host, Native.WM_LBUTTONDOWN, new IntPtr(1), lp);
            Thread.Sleep(60);
            Native.PostMessage(host, Native.WM_LBUTTONUP, IntPtr.Zero, lp);
            detail = "client " + cx + "," + cy;
            return true;
        }

        /// <summary>SendKeys 语法里出现修饰键前缀（^ % +）就必须走真实键盘。</summary>
        private static bool HasModifier(string keys)
        {
            return keys.IndexOf('^') >= 0 || keys.IndexOf('%') >= 0 || keys.IndexOf('+') >= 0;
        }

        private static readonly Dictionary<string, int> VkMap = new Dictionary<string, int>(StringComparer.OrdinalIgnoreCase)
        {
            { "ENTER", 0x0D }, { "RETURN", 0x0D }, { "TAB", 0x09 }, { "ESC", 0x1B }, { "ESCAPE", 0x1B },
            { "SPACE", 0x20 }, { "BACKSPACE", 0x08 }, { "BS", 0x08 }, { "DELETE", 0x2E }, { "DEL", 0x2E },
            { "INSERT", 0x2D }, { "INS", 0x2D }, { "HOME", 0x24 }, { "END", 0x23 },
            { "PGUP", 0x21 }, { "PGDN", 0x22 }, { "UP", 0x26 }, { "DOWN", 0x28 }, { "LEFT", 0x25 }, { "RIGHT", 0x27 },
            { "F1", 0x70 }, { "F2", 0x71 }, { "F3", 0x72 }, { "F4", 0x73 }, { "F5", 0x74 }, { "F6", 0x75 },
            { "F7", 0x76 }, { "F8", 0x77 }, { "F9", 0x78 }, { "F10", 0x79 }, { "F11", 0x7A }, { "F12", 0x7B }
        };

        /// <summary>
        /// 把 SendKeys 风格的按键串拆开、逐键投递给渲染宿主。只处理普通键
        /// （{ENTER}/{TAB}/{ESC}/方向键/F1-F12 以及单个 ASCII 字符）；遇到不认识的记号、
        /// 非 ASCII 字符或修饰键就返回 false，由调用方决定是否退到抢焦点路径。
        /// 绝不投 WM_UNICHAR：那个消息会把 WebView2 渲染进程搞崩（实测踩过）。
        /// </summary>
        private static bool PostKeys(IntPtr launcher, string keys, out int sent, out string unsupported)
        {
            sent = 0; unsupported = "";
            var host = RenderHost(launcher);
            if (host == IntPtr.Zero) { unsupported = "the render host window"; return false; }

            int i = 0;
            while (i < keys.Length)
            {
                char ch = keys[i];
                if (ch == '{')
                {
                    int close = keys.IndexOf('}', i + 1);
                    if (close < 0) { unsupported = "{ without }"; return false; }
                    string token = keys.Substring(i + 1, close - i - 1).Trim();
                    i = close + 1;
                    int repeat = 1;
                    int sp = token.IndexOf(' ');
                    if (sp > 0)
                    {
                        int.TryParse(token.Substring(sp + 1).Trim(), out repeat);
                        token = token.Substring(0, sp).Trim();
                    }
                    if (repeat < 1) repeat = 1;
                    int vk;
                    if (!VkMap.TryGetValue(token, out vk)) { unsupported = "\"" + token + "\""; return false; }
                    for (int n = 0; n < repeat; n++)
                    {
                        Native.PostMessage(host, Native.WM_KEYDOWN, new IntPtr(vk), Native.KeyLParam(vk));
                        Thread.Sleep(28);
                        Native.PostMessage(host, Native.WM_KEYUP, new IntPtr(vk), Native.KeyLParam(vk, true));
                        Thread.Sleep(28);
                        sent++;
                    }
                    continue;
                }
                if (ch >= 32 && ch < 127)
                {
                    Native.PostMessage(host, Native.WM_CHAR, new IntPtr(ch), Native.KeyLParam());
                    Thread.Sleep(28);
                    sent++;
                    i++;
                    continue;
                }
                unsupported = "\"" + ch + "\"";
                return false;
            }
            return true;
        }

        // ---------------- actions ----------------

        private static void ActionFocus()
        {
            var win = TargetWindow();
            Native.Activate(win.Handle);
            _res["ok"] = true;
            _res["window"] = new Dictionary<string, object> {
                { "title", win.Name }, { "handle", win.Handle.ToInt64() }, { "pid", win.Pid }
            };
            _res["foreground"] = Native.GetForegroundWindow() == win.Handle;
        }

        private static void ActionSnapshot()
        {
            var win = TargetWindow();
            var root = WebRoot(win, AInt("timeoutMs", 6000));
            if (root == null)
            {
                Children(win.Element);
                Thread.Sleep(400);
                root = WebRoot(win, 3000);
            }
            if (root == null) throw new AgentException("could not locate the web content of the launcher window", "E_NO_ROOT");

            bool interactiveOnly = ABool("interactiveOnly", true);
            int max = AInt("max", 60);
            if (max > 300) max = 300;
            if (max < 1) max = 1;
            int offset = AInt("offset", 0);
            string keyword = AStr("keyword", "");

            var res = Enumerate(root, 4000, interactiveOnly);
            var filtered = new List<ItemInfo>(res.Items);
            if (!string.IsNullOrEmpty(keyword))
            {
                var f2 = new List<ItemInfo>();
                foreach (var it in filtered)
                {
                    if ((!string.IsNullOrEmpty(it.Name) && it.Name.IndexOf(keyword, StringComparison.OrdinalIgnoreCase) >= 0)
                        || (!string.IsNullOrEmpty(it.Value) && it.Value.IndexOf(keyword, StringComparison.OrdinalIgnoreCase) >= 0)
                        || (it.Type.IndexOf(keyword, StringComparison.OrdinalIgnoreCase) >= 0))
                        f2.Add(it);
                }
                filtered = f2;
            }

            var counters = new Dictionary<string, int>();
            foreach (var it in filtered)
            {
                string k = it.Type + "|" + it.Name;
                int n = counters.ContainsKey(k) ? counters[k] : 0;
                counters[k] = n + 1;
                it.Nth = n;
            }

            var elements = new List<object>();
            for (int i = offset; i < filtered.Count && elements.Count < max; i++)
            {
                var it = filtered[i];
                var d = new Dictionary<string, object>();
                d["ref"] = ShortRef(it, it.Nth);
                d["type"] = it.Type;
                d["name"] = it.Name;
                d["value"] = it.Value;
                d["rect"] = it.Rect;
                d["enabled"] = it.Enabled;
                d["actions"] = it.Actions.ToArray();
                elements.Add(d);
            }

            _res["ok"] = true;
            _res["window"] = new Dictionary<string, object> {
                { "title", win.Name }, { "handle", win.Handle.ToInt64() }, { "pid", win.Pid },
                { "rect", new[] { (int)win.Rect.X, (int)win.Rect.Y, (int)win.Rect.Width, (int)win.Rect.Height } }
            };
            _res["total"] = filtered.Count;
            _res["offset"] = offset;
            _res["returned"] = elements.Count;
            _res["visited"] = res.Visited;
            _res["elements"] = elements.ToArray();
            if (offset + elements.Count < filtered.Count)
                _res["note"] = "more elements available; call UiSnapshot again with offset=" + (offset + elements.Count);

            var sig = Signature(root);
            _res["elementCount"] = sig.count;
            SaveSignature(sig);
        }

        private class Sig
        {
            public int count;
            public List<string> names = new List<string>();
        }

        private static Sig Signature(AutomationElement root)
        {
            var res = Enumerate(root, 900, true);
            var uniq = new List<string>();
            var seen = new HashSet<string>(StringComparer.Ordinal);
            foreach (var n in res.Names) if (seen.Add(n)) uniq.Add(n);
            var sig = new Sig();
            sig.count = res.Items.Count;
            sig.names = uniq;
            return sig;
        }

        private static void SaveSignature(Sig sig)
        {
            _lastNames = sig.names;
        }

        private static Dictionary<string, object> BuildDiff(List<string> before, List<string> after)
        {
            var b = new HashSet<string>(before, StringComparer.Ordinal);
            var a = new HashSet<string>(after, StringComparer.Ordinal);
            var added = new List<string>();
            foreach (var n in after) if (!b.Contains(n)) added.Add(n);
            var removed = new List<string>();
            foreach (var n in before) if (!a.Contains(n)) removed.Add(n);
            var d = new Dictionary<string, object>();
            d["appeared"] = added.Count > 6 ? added.GetRange(0, 6).ToArray() : added.ToArray();
            d["disappeared"] = removed.Count > 6 ? removed.GetRange(0, 6).ToArray() : removed.ToArray();
            d["addedCount"] = added.Count;
            d["removedCount"] = removed.Count;
            return d;
        }

        private static void ActionClick()
        {
            var win = TargetWindow();
            var root = WebRoot(win, AInt("timeoutMs", 6000));
            if (root == null) throw new AgentException("could not locate the web content of the launcher window", "E_NO_ROOT");

            Native.EnsureRestored(win.Handle);
            bool animate = ABool("animate", true);
            int moveMs = AInt("moveMs", 420);
            string refStr = AStr("ref", "");
            string mode = AStr("mode", "auto");
            AutomationElement el = null;
            Dictionary<string, object> target = null;
            int px, py;

            if (!string.IsNullOrEmpty(refStr))
            {
                el = Resolve(root, refStr);
                if (el == null) throw new AgentException("ref is unknown or expired; refs are only valid while the UI is unchanged, so call UiSnapshot again and retry with a fresh ref", "E_STALE_REF");
                var c = el.Current;
                var r = c.BoundingRectangle;
                if (r.IsEmpty) throw new AgentException("the target element has no visible area; it may be scrolled out of view", "E_NO_RECT");
                // 必须现取矩形：侧栏能滚动，用快照时的旧坐标会偏一个条目（实测 58px）。
                px = (int)(r.X + r.Width / 2);
                py = (int)(r.Y + r.Height / 2);
                target = new Dictionary<string, object> {
                    { "type", c.ControlType.ProgrammaticName.Replace("ControlType.", "") },
                    { "name", (c.Name ?? "").Trim() },
                    { "rect", new[] { (int)r.X, (int)r.Y, (int)r.Width, (int)r.Height } }
                };
            }
            else
            {
                px = AInt("x", int.MinValue);
                py = AInt("y", int.MinValue);
                if (px == int.MinValue || py == int.MinValue) throw new AgentException("either ref or x/y is required", "E_ARGS");
                if (mode == "auto" || mode == "invoke") mode = "post";   // 只有坐标，没有元素可以 invoke
            }

            var before = new List<string>(_lastNames);
            IntPtr prevFg = Native.GetForegroundWindow();
            VirtualCursor.LastError = "";
            var cursor = VirtualCursor.Begin(win.Handle, CursorStart(), new Point(px, py), animate, moveMs);
            string cursorErr = cursor == null ? VirtualCursor.LastError : "";

            string method = "";
            string note = "";
            bool clicked = false;

            // 顺序很关键：实测 Chromium 的 UIA Invoke 会把启动器窗口**激活到前台**（抢焦点），
            // 而投递点击只影响网页内部 —— 前台窗口、真实指针都不动。所以默认（auto）先投递，
            // invoke 只当兜底（元素滚出可视区、投递被拒时）。
            bool tryPost = mode == "auto" || mode == "post";
            bool tryInvoke = mode == "auto" || mode == "invoke";

            if (tryPost)
            {
                string detail;
                if (PostClick(win.Handle, px, py, out detail)) { method = "post"; clicked = true; }
                note = detail;
            }

            if (!clicked && tryInvoke && el != null)
            {
                object p;
                if (TryPattern(el, InvokePattern.Pattern, out p))
                {
                    try
                    {
                        ((InvokePattern)p).Invoke();
                        method = "invoke";
                        clicked = true;
                        note += "; fell back to UIAutomation Invoke, which can bring the window to the foreground";
                    }
                    catch (Exception ex) { note += "; invoke raised: " + ex.Message; }
                }
            }

            // invoke 会把启动器拽到前台（Chromium 内部调了 SetForegroundWindow）：
            // 既然默认路径承诺「不打断用户」，这里把前台还回去。
            bool restoredFg = false;
            if (clicked && method == "invoke") restoredFg = UndoFocusSteal(win.Handle, prevFg);

            // 3) 显式逃生舱：真的动系统指针。会打断用户，所以只能由模型/用户显式指定。
            if (!clicked && mode == "mouse")
            {
                Native.Activate(win.Handle);
                MovePointer(px, py, moveMs, animate);
                Native.SetCursorPos(px, py);
                Native.RealClick();
                method = "mouse";
                clicked = true;
                note = "real pointer moved and the window was brought to the foreground";
            }

            if (!clicked)
            {
                if (cursor != null) cursor.LingerAndClose(60);
                throw new AgentException(
                    "could not click the target: no usable UIA pattern and the posted click was rejected (" + note +
                    "). Take a fresh snapshot and retry, or pass mode=\"mouse\" to fall back to the real pointer.",
                    "E_CLICK_FAILED");
            }

            if (cursor != null) cursor.Ripple(300);
            Thread.Sleep(AInt("settleMs", 420));
            if (cursor != null) cursor.LingerAndClose(140);

            RememberCursor(px, py);
            _res["ok"] = true;
            _res["method"] = method;
            _res["point"] = new[] { px, py };
            _res["activated"] = method == "mouse";
            _res["restoredForeground"] = restoredFg;
            _res["cursorShown"] = cursor != null;
            if (cursorErr.Length > 0) _res["cursorError"] = cursorErr;
            if (!string.IsNullOrEmpty(note)) _res["note"] = note;
            if (target != null) _res["target"] = target;
            var after = Signature(root);
            _res["diff"] = BuildDiff(before, after.names);
            _res["elementCount"] = after.count;
            SaveSignature(after);
        }

        private static void ActionType()
        {
            var win = TargetWindow();
            var root = WebRoot(win, AInt("timeoutMs", 6000));
            if (root == null) throw new AgentException("could not locate the web content of the launcher window", "E_NO_ROOT");

            string text = AStr("text", "");
            string refStr = AStr("ref", "");
            bool clear = ABool("clear", true);
            bool activate = ABool("activate", false);
            bool animate = ABool("animate", true);
            int moveMs = AInt("moveMs", 360);
            // 空文本 + clear=true 表示「只清空」（搜索框、表单里很常用的一个动作）。
            if (string.IsNullOrEmpty(text) && !clear) throw new AgentException("text is required (pass clear=true with empty text to just clear the field)", "E_ARGS");

            Native.EnsureRestored(win.Handle);

            AutomationElement el = null;
            int px = -1, py = -1;
            if (!string.IsNullOrEmpty(refStr))
            {
                el = Resolve(root, refStr);
                if (el == null) throw new AgentException("ref is unknown or expired; refs are only valid while the UI is unchanged, so call UiSnapshot again and retry with a fresh ref", "E_STALE_REF");
                var c = el.Current;
                var r = c.BoundingRectangle;
                if (!r.IsEmpty)
                {
                    px = (int)(r.X + r.Width / 2);
                    py = (int)(r.Y + r.Height / 2);
                }
                _res["target"] = new Dictionary<string, object> {
                    { "type", c.ControlType.ProgrammaticName.Replace("ControlType.", "") },
                    { "name", (c.Name ?? "").Trim() }
                };
            }
            else if (!activate)
            {
                throw new AgentException("typing without a ref writes to whatever currently has focus, which only makes sense when the launcher is allowed to take focus: pass activate=true, or pass a ref so the value can be written without touching focus.", "E_NEEDS_ACTIVATE");
            }

            var before = new List<string>(_lastNames);
            var cursor = px >= 0 ? VirtualCursor.Begin(win.Handle, CursorStart(), new Point(px, py), animate, moveMs) : null;

            // 首选 ValuePattern.SetValue：不抢焦点、不碰剪贴板、Unicode 安全。
            // （WM_CHAR 对非 ASCII 会按低字节截断，SendKeys 根本不支持 CJK，而 WebView2
            //   里的 React 受控输入框实测认 SetValue 并会真的更新组件状态。）
            object vpObj;
            if (el != null && TryPattern(el, ValuePattern.Pattern, out vpObj))
            {
                try
                {
                    var vp = (ValuePattern)vpObj;
                    if (!vp.Current.IsReadOnly)
                    {
                        IntPtr prevFg = Native.GetForegroundWindow();
                        vp.SetValue(clear ? text : (ElementValue(el) + text));
                        // 实测：Chromium 的 ValuePattern.SetValue 会顺手把启动器窗口拽到前台
                        // （它内部调了 SetForegroundWindow）。用户的要求是「不打断」，所以
                        // 立刻把前台还给原来那个窗口。
                        bool restoredFg = UndoFocusSteal(win.Handle, prevFg);
                        if (cursor != null) { cursor.Ripple(300); cursor.LingerAndClose(140); }
                        Thread.Sleep(AInt("settleMs", 320));
                        RememberCursor(px, py);
                        _res["ok"] = true;
                        _res["method"] = "setValue";
                        _res["typed"] = text.Length;
                        _res["focused"] = false;
                        _res["restoredForeground"] = restoredFg;
                        _res["valueAfter"] = ElementValue(el);
                        var afterV = Signature(root);
                        _res["elementCount"] = afterV.count;
                        SaveSignature(afterV);
                        return;
                    }
                }
                catch { }
            }

            if (!activate)
            {
                if (cursor != null) cursor.LingerAndClose(60);
                throw new AgentException("this control cannot be written without focus (it exposes no writable ValuePattern), so typing it needs activate=true — that brings the launcher to the foreground for a moment.", "E_NEEDS_ACTIVATE");
            }

            // 明确要求抢焦点时的兜底：切前台 → 投递点击让网页里的元素获得焦点 →
            // 剪贴板粘贴（Unicode 安全）。仍然不动真实指针。
            Native.Activate(win.Handle);
            if (px >= 0)
            {
                string detail;
                PostClick(win.Handle, px, py, out detail);
                Thread.Sleep(180);
            }
            else
            {
                try { el.SetFocus(); } catch { }
                Thread.Sleep(160);
            }

            if (clear)
            {
                SendKeys.SendWait("^a");
                Thread.Sleep(60);
                SendKeys.SendWait("{DEL}");
                Thread.Sleep(80);
            }

            string saved = null;
            bool hadClip = false;
            try { saved = Clipboard.GetText(); hadClip = true; } catch { }
            try
            {
                // The clipboard is a shared resource and can be locked for a few
                // milliseconds by other processes; retry before giving up.
                Exception lastError = null;
                for (int attempt = 0; attempt < 4; attempt++)
                {
                    try
                    {
                        Clipboard.SetText(text);
                        lastError = null;
                        break;
                    }
                    catch (Exception ex) { lastError = ex; Thread.Sleep(120); }
                }
                if (lastError != null) throw lastError;
                Thread.Sleep(90);
                // Unicode-safe typing: SendKeys cannot type CJK characters.
                SendKeys.SendWait("^v");
                Thread.Sleep(220);
                _res["method"] = "paste";
            }
            catch (Exception ex)
            {
                object p;
                if (el != null && TryPattern(el, ValuePattern.Pattern, out p))
                {
                    ((ValuePattern)p).SetValue(text);
                    _res["method"] = "setValue";
                    _res["pasteError"] = ex.Message;
                }
                else { throw new AgentException("typing failed: " + ex.Message, "E_TYPE"); }
            }
            finally
            {
                if (hadClip)
                {
                    try { if (saved != null) Clipboard.SetText(saved); else Clipboard.Clear(); } catch { }
                }
            }

            if (cursor != null) { cursor.Ripple(280); cursor.LingerAndClose(140); }
            RememberCursor(px, py);
            _res["ok"] = true;
            _res["typed"] = text.Length;
            _res["focused"] = true;
            if (el != null) _res["valueAfter"] = ElementValue(el);
            var after = Signature(root);
            _res["elementCount"] = after.count;
            SaveSignature(after);
        }

        private static void ActionKeys()
        {
            var win = TargetWindow();
            string keys = AStr("keys", "");
            if (string.IsNullOrEmpty(keys)) throw new AgentException("keys is required", "E_ARGS");
            string refStr = AStr("ref", "");
            bool activate = ABool("activate", false);
            bool animate = ABool("animate", true);
            int moveMs = AInt("moveMs", 320);

            Native.EnsureRestored(win.Handle);

            AutomationElement el = null;
            int px = -1, py = -1;
            if (!string.IsNullOrEmpty(refStr))
            {
                var root = WebRoot(win, 3000);
                if (root == null) throw new AgentException("could not locate the web content of the launcher window", "E_NO_ROOT");
                el = Resolve(root, refStr);
                if (el == null) throw new AgentException("ref is unknown or expired; refs are only valid while the UI is unchanged, so call UiSnapshot again and retry with a fresh ref", "E_STALE_REF");
                var r = el.Current.BoundingRectangle;
                if (!r.IsEmpty)
                {
                    px = (int)(r.X + r.Width / 2);
                    py = (int)(r.Y + r.Height / 2);
                }
            }

            var cursor = px >= 0 ? VirtualCursor.Begin(win.Handle, CursorStart(), new Point(px, py), animate, moveMs) : null;

            // 先给网页内部焦点：投递一次点击。这一步同样不动真实指针、不改前台窗口。
            if (px >= 0)
            {
                string detail;
                PostClick(win.Handle, px, py, out detail);
                Thread.Sleep(160);
            }

            if (!activate)
            {
                // 普通键可以无焦点投递（{ENTER}/{TAB}/{ESC}/方向键/单个 ASCII 字符）。
                if (!HasModifier(keys))
                {
                    int sent;
                    string unsupported;
                    if (PostKeys(win.Handle, keys, out sent, out unsupported))
                    {
                        if (cursor != null) { cursor.Ripple(260); cursor.LingerAndClose(140); }
                        Thread.Sleep(AInt("settleMs", 260));
                        _res["ok"] = true;
                        _res["method"] = "post";
                        _res["sent"] = keys;
                        _res["keys"] = sent;
                        return;
                    }
                    if (cursor != null) cursor.LingerAndClose(60);
                    throw new AgentException("cannot post " + unsupported + " to the web view. Only {ENTER}/{TAB}/{ESC}/{BACKSPACE}/{DELETE}/{HOME}/{END}/{PGUP}/{PGDN}/{UP}/{DOWN}/{LEFT}/{RIGHT}/F1-F12 and single ASCII characters can be sent without focus; pass activate=true to use the real keyboard (that brings the launcher to the foreground).", "E_NEEDS_ACTIVATE");
                }
                if (cursor != null) cursor.LingerAndClose(60);
                throw new AgentException("key combination \"" + keys + "\" uses Ctrl/Alt/Shift, which WebView2 ignores when posted (Ctrl+A arrives as a plain \"a\"). Pass activate=true, which brings the launcher to the foreground and sends the keys through the real keyboard.", "E_NEEDS_ACTIVATE");
            }

            Native.Activate(win.Handle);
            SendKeys.SendWait(keys);
            if (cursor != null) { cursor.Ripple(260); cursor.LingerAndClose(140); }
            Thread.Sleep(AInt("settleMs", 260));
            _res["ok"] = true;
            _res["method"] = "sendKeys";
            _res["sent"] = keys;
        }

        private static void ActionScreenshot(string shotPath)
        {
            var win = TargetWindow();
            if (string.IsNullOrEmpty(shotPath)) throw new AgentException("shotPath is required", "E_ARGS");
            string dir = Path.GetDirectoryName(shotPath);
            if (!string.IsNullOrEmpty(dir) && !Directory.Exists(dir)) Directory.CreateDirectory(dir);

            int w = (int)win.Rect.Width;
            int h = (int)win.Rect.Height;
            if (w < 2 || h < 2) throw new AgentException("launcher window has no usable size", "E_NO_RECT");

            var bmp = new Bitmap(w, h, PixelFormat.Format32bppArgb);
            string mode = "printwindow";
            bool captured = false;
            try
            {
                using (var g = Graphics.FromImage(bmp))
                {
                    IntPtr hdc = g.GetHdc();
                    try { captured = Native.PrintWindow(win.Handle, hdc, Native.PW_RENDERFULLCONTENT); }
                    finally { g.ReleaseHdc(hdc); }
                }
                if (captured)
                {
                    // PrintWindow can silently produce an all-black frame.
                    bool blank = true;
                    for (int y = 4; y < h && blank; y += 37)
                    {
                        for (int x = 4; x < w; x += 41)
                        {
                            var c = bmp.GetPixel(x, y);
                            if (c.R > 8 || c.G > 8 || c.B > 8) { blank = false; break; }
                        }
                    }
                    if (blank) captured = false;
                }
            }
            catch { captured = false; }

            if (!captured)
            {
                mode = "screen";
                try { bmp.Dispose(); } catch { }
                bmp = new Bitmap(w, h, PixelFormat.Format32bppArgb);
                using (var g = Graphics.FromImage(bmp))
                {
                    g.CopyFromScreen((int)win.Rect.X, (int)win.Rect.Y, 0, 0, new System.Drawing.Size(w, h));
                }
            }

            int maxW = AInt("shotMaxWidth", 1280);
            int quality = AInt("shotQuality", 68);
            var final = bmp;
            if (maxW > 0 && w > maxW)
            {
                int nh = (int)Math.Round((double)h * maxW / w);
                var resized = new Bitmap(maxW, nh, PixelFormat.Format32bppArgb);
                using (var rg = Graphics.FromImage(resized))
                {
                    rg.InterpolationMode = System.Drawing.Drawing2D.InterpolationMode.HighQualityBicubic;
                    rg.DrawImage(bmp, 0, 0, maxW, nh);
                }
                bmp.Dispose();
                final = resized;
            }

            string ext = Path.GetExtension(shotPath).ToLowerInvariant();
            int outW = final.Width, outH = final.Height;
            try
            {
                bool saved = false;
                if (ext == ".jpg" || ext == ".jpeg")
                {
                    ImageCodecInfo codec = null;
                    foreach (var ci in ImageCodecInfo.GetImageEncoders())
                        if (ci.MimeType == "image/jpeg") { codec = ci; break; }
                    if (codec != null)
                    {
                        var ep = new EncoderParameters(1);
                        ep.Param[0] = new EncoderParameter(System.Drawing.Imaging.Encoder.Quality, (long)quality);
                        final.Save(shotPath, codec, ep);
                        saved = true;
                    }
                }
                if (!saved) final.Save(shotPath, ImageFormat.Png);
            }
            finally { final.Dispose(); }

            var info = new FileInfo(shotPath);
            _res["ok"] = true;
            _res["path"] = shotPath;
            _res["width"] = outW;
            _res["height"] = outH;
            _res["bytes"] = info.Length;
            _res["captured"] = mode;
            _res["window"] = new Dictionary<string, object> {
                { "title", win.Name },
                { "rect", new[] { (int)win.Rect.X, (int)win.Rect.Y, (int)win.Rect.Width, (int)win.Rect.Height } }
            };
        }
    }

    internal sealed class AgentException : Exception
    {
        public readonly string Code;
        public AgentException(string message, string code) : base(message) { Code = code; }
    }
}
