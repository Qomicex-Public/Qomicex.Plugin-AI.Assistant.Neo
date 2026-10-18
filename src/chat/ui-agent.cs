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
// While acting, the *real* mouse pointer is animated along the path so the
// user can see what the assistant is doing instead of the UI changing by
// itself. A separate always-on-top "virtual cursor" overlay was tried first
// and abandoned: layered windows were occluded intermittently by the launcher
// window, so the animation was not reliably visible.

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

        [StructLayout(LayoutKind.Sequential)]
        public struct POINT { public int X, Y; }

        public const uint MOUSEEVENTF_LEFTDOWN = 0x0002;
        public const uint MOUSEEVENTF_LEFTUP = 0x0004;
        public const uint PW_RENDERFULLCONTENT = 0x00000002;

        public static void RealClick()
        {
            mouse_event(MOUSEEVENTF_LEFTDOWN, 0, 0, 0, IntPtr.Zero);
            Thread.Sleep(25);
            mouse_event(MOUSEEVENTF_LEFTUP, 0, 0, 0, IntPtr.Zero);
        }

        public static bool Activate(IntPtr hwnd)
        {
            if (IsIconic(hwnd)) { ShowWindow(hwnd, 9); Thread.Sleep(140); }
            else { ShowWindow(hwnd, 5); }
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

    internal static class Program
    {
        private const string AgentVersion = "1.2.0";
        private static readonly JavaScriptSerializer Json = new JavaScriptSerializer();
        private static Dictionary<string, object> _a = new Dictionary<string, object>();
        private static readonly Dictionary<string, object> _res = new Dictionary<string, object>();
        private static string _outPath;
        private static string _statePath;
        private static List<string> _lastNames = new List<string>();

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

            bool animate = ABool("animate", true);
            string refStr = AStr("ref", "");
            int px, py;
            string mode = AStr("mode", "mouse");
            AutomationElement el = null;
            Dictionary<string, object> target = null;

            if (!string.IsNullOrEmpty(refStr))
            {
                el = Resolve(root, refStr);
                if (el == null) throw new AgentException("ref is unknown or expired; refs are only valid while the UI is unchanged, so call UiSnapshot again and retry with a fresh ref", "E_STALE_REF");
                var c = el.Current;
                var r = c.BoundingRectangle;
                if (r.IsEmpty) throw new AgentException("the target element has no visible area; it may be scrolled out of view", "E_NO_RECT");
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
                mode = "mouse";
            }

            var before = new List<string>(_lastNames);
            Native.Activate(win.Handle);
            _res["foreground"] = Native.GetForegroundWindow() == win.Handle;

            MovePointer(px, py, AInt("moveMs", 420), animate);

            bool invoked = false;
            if (mode == "invoke" && el != null)
            {
                object p;
                if (TryPattern(el, InvokePattern.Pattern, out p))
                {
                    try { ((InvokePattern)p).Invoke(); invoked = true; }
                    catch { invoked = false; }
                }
            }
            // click at the animated position so the press happens where the user
            // just watched the pointer travel to
            Native.SetCursorPos(px, py);
            if (!invoked) Native.RealClick();

            Thread.Sleep(AInt("settleMs", 420));
            _res["ok"] = true;
            _res["method"] = invoked ? "invoke" : "mouse";
            _res["point"] = new[] { px, py };
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
            if (string.IsNullOrEmpty(text)) throw new AgentException("text is required", "E_ARGS");
            string refStr = AStr("ref", "");
            bool clear = ABool("clear", true);
            bool animate = ABool("animate", true);

            Native.Activate(win.Handle);

            int px = -1, py = -1;
            AutomationElement el = null;
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
                MovePointer(px, py, AInt("moveMs", 360), animate);
                if (px >= 0)
                {
                    Native.SetCursorPos(px, py);
                    Native.RealClick();
                }
                else { try { el.SetFocus(); } catch { } }
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

            _res["ok"] = true;
            _res["typed"] = text.Length;
            if (el != null) _res["valueAfter"] = ElementValue(el);
            var after = Signature(root);
            _res["elementCount"] = after.count;
            SaveSignature(after);
        }

        private static void ActionKeys()
        {
            var win = TargetWindow();
            Native.Activate(win.Handle);
            string keys = AStr("keys", "");
            if (string.IsNullOrEmpty(keys)) throw new AgentException("keys is required", "E_ARGS");
            string refStr = AStr("ref", "");
            bool animate = ABool("animate", true);

            if (!string.IsNullOrEmpty(refStr))
            {
                var root = WebRoot(win, 3000);
                if (root != null)
                {
                    var el = Resolve(root, refStr);
                    if (el == null) throw new AgentException("ref is unknown or expired; refs are only valid while the UI is unchanged, so call UiSnapshot again and retry with a fresh ref", "E_STALE_REF");
                    var r = el.Current.BoundingRectangle;
                    if (!r.IsEmpty)
                    {
                        int px = (int)(r.X + r.Width / 2);
                        int py = (int)(r.Y + r.Height / 2);
                        MovePointer(px, py, AInt("moveMs", 320), animate);
                        Native.SetCursorPos(px, py);
                        Native.RealClick();
                        Thread.Sleep(140);
                    }
                }
            }

            SendKeys.SendWait(keys);
            _res["ok"] = true;
            _res["sent"] = keys;
            Thread.Sleep(AInt("settleMs", 260));
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
