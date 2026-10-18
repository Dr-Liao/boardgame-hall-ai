using System;
using System.Collections.Generic;
using System.Diagnostics;
using System.IO;
using System.Linq;
using System.Net;
using System.Text;

// 免安装版启动器（协议 2）。目录布局与 current.ini 字段见 lib/install.js。
//   1. 按 current.ini 选择 app-* 与 runtime-* 目录；指针缺失或损坏时取最高版本，再回退到旧布局 app/runtime。
//   2. 子进程以 75 退出表示更新已就绪，重新读取 current.ini 后再启动。
//   3. 带 trial=1 的新版本非正常退出时，回滚到 previousApp / previousRuntime，并把版本记入 failed。
// 本文件以 UTF-8 保存，编译时需传 /codepage:65001。
internal static class Launcher
{
    private const int RestartExitCode = 75;
    private const string Protocol = "2";
    private static readonly string[] PointerKeys = { "app", "runtime", "previousApp", "previousRuntime", "trial", "failed" };

    private static int Main()
    {
        Console.OutputEncoding = Encoding.UTF8;
        Console.Title = "桌游大厅";
        string root = AppDomain.CurrentDomain.BaseDirectory.TrimEnd(Path.DirectorySeparatorChar);
        int restarts = 0;
        bool rolledBack = false;
        while (true)
        {
            string appDir, runtimeDir;
            if (!Resolve(root, out appDir, out runtimeDir))
            {
                Fail("无法启动桌游大厅：找不到程序或运行时文件夹。", "请完整解压发布包，不要单独移动 EXE。");
                return 1;
            }
            int code;
            try
            {
                code = Run(root, appDir, runtimeDir);
            }
            catch (Exception error)
            {
                Console.Error.WriteLine("无法启动桌游大厅：" + error.Message);
                code = 1;
            }
            if (code == RestartExitCode && restarts++ < 20) continue;
            if (code != 0 && code != RestartExitCode && !rolledBack && Rollback(root))
            {
                rolledBack = true;
                Console.WriteLine();
                Console.WriteLine("新版本启动失败，已自动回滚到上一版本，正在重新启动……");
                continue;
            }
            if (code != 0) Fail("启动失败，请查看上方信息。", null);
            return code;
        }
    }

    private static int Run(string root, string appDir, string runtimeDir)
    {
        var start = new ProcessStartInfo {
            FileName = Path.Combine(root, runtimeDir, "node.exe"),
            Arguments = "--disable-warning=UNDICI-EHPA \"" + Path.Combine(root, appDir, "portable.mjs") + "\"",
            WorkingDirectory = Path.Combine(root, appDir),
            UseShellExecute = false
        };
        // A portable release never reads the development installation's saves.
        start.EnvironmentVariables["DSH_HOME"] = Path.Combine(root, "user-data");
        start.EnvironmentVariables["BOARDGAME_INSTALL_ROOT"] = root;
        start.EnvironmentVariables["BOARDGAME_LAUNCHER"] = Protocol;
        ApplySystemProxy(start.EnvironmentVariables);
        using (var child = Process.Start(start))
        {
            child.WaitForExit();
            return child.ExitCode;
        }
    }

    // Node 的 fetch 不读 Windows 系统代理（Clash、v2rayN 等的“系统代理”模式），
    // 只认 HTTPS_PROXY 等环境变量，且要 NODE_USE_ENV_PROXY=1（Node 22.21+）才生效。
    private static void ApplySystemProxy(System.Collections.Specialized.StringDictionary env)
    {
        string[] keys = { "HTTPS_PROXY", "https_proxy", "HTTP_PROXY", "http_proxy" };
        if (!keys.Any(key => !string.IsNullOrEmpty(env[key])))
        {
            try
            {
                var target = new Uri("https://raw.githubusercontent.com/");
                Uri proxy = WebRequest.GetSystemWebProxy().GetProxy(target);
                if (proxy == null || proxy == target || proxy.Host == target.Host) return;
                string address = "http://" + proxy.Authority;
                env["HTTPS_PROXY"] = address;
                env["HTTP_PROXY"] = address;
                if (string.IsNullOrEmpty(env["NO_PROXY"]) && string.IsNullOrEmpty(env["no_proxy"])) env["NO_PROXY"] = "localhost,127.0.0.1,::1";
                Console.WriteLine("  使用系统代理：" + address);
            }
            catch (Exception)
            {
                return;
            }
        }
        if (string.IsNullOrEmpty(env["NODE_USE_ENV_PROXY"])) env["NODE_USE_ENV_PROXY"] = "1";
    }

    private static bool Resolve(string root, out string appDir, out string runtimeDir)
    {
        var pointer = ReadPointer(root);
        appDir = null;
        runtimeDir = null;
        if (pointer != null && IsApp(root, Get(pointer, "app")) && IsRuntime(root, Get(pointer, "runtime")))
        {
            appDir = Get(pointer, "app");
            runtimeDir = Get(pointer, "runtime");
            return true;
        }
        appDir = Highest(root, "app-", name => IsApp(root, name)) ?? (IsApp(root, "app") ? "app" : null);
        runtimeDir = Highest(root, "runtime-", name => IsRuntime(root, name)) ?? (IsRuntime(root, "runtime") ? "runtime" : null);
        return appDir != null && runtimeDir != null;
    }

    private static bool Rollback(string root)
    {
        var pointer = ReadPointer(root);
        if (pointer == null || Get(pointer, "trial") != "1" || Get(pointer, "app") == null) return false;
        string previousApp = Get(pointer, "previousApp");
        string previousRuntime = Get(pointer, "previousRuntime") ?? Get(pointer, "runtime");
        if (!IsApp(root, previousApp) || !IsRuntime(root, previousRuntime)) return false;
        string failedVersion = Get(pointer, "app").StartsWith("app-") ? Get(pointer, "app").Substring(4) : Get(pointer, "app");
        var failed = (Get(pointer, "failed") ?? "").Split(new[] { ',' }, StringSplitOptions.RemoveEmptyEntries).Select(v => v.Trim()).ToList();
        if (!failed.Contains(failedVersion)) failed.Add(failedVersion);
        var next = new Dictionary<string, string> {
            { "app", previousApp },
            { "runtime", previousRuntime },
            { "failed", string.Join(",", failed) }
        };
        WritePointer(root, next);
        return true;
    }

    private static string Highest(string root, string prefix, Func<string, bool> valid)
    {
        if (!Directory.Exists(root)) return null;
        return Directory.GetDirectories(root, prefix + "*")
            .Select(Path.GetFileName)
            .Where(name => !name.EndsWith(".partial") && valid(name))
            .Select(name => new { name, version = ParseVersion(name.Substring(prefix.Length)) })
            .Where(item => item.version != null)
            .OrderByDescending(item => item.version)
            .Select(item => item.name)
            .FirstOrDefault();
    }

    private static Version ParseVersion(string text)
    {
        Version version;
        return Version.TryParse(text, out version) ? version : null;
    }

    private static bool IsApp(string root, string name)
    {
        return SafeName(name) && File.Exists(Path.Combine(root, name, "portable.mjs"));
    }

    private static bool IsRuntime(string root, string name)
    {
        return SafeName(name) && File.Exists(Path.Combine(root, name, "node.exe"));
    }

    private static bool SafeName(string name)
    {
        return !string.IsNullOrEmpty(name) && name.IndexOfAny(new[] { '/', '\\', ':' }) < 0 && name != "." && name != "..";
    }

    private static string Get(Dictionary<string, string> pointer, string key)
    {
        string value;
        return pointer.TryGetValue(key, out value) && value.Length > 0 ? value : null;
    }

    private static Dictionary<string, string> ReadPointer(string root)
    {
        string file = Path.Combine(root, "current.ini");
        if (!File.Exists(file)) return null;
        try
        {
            var pointer = new Dictionary<string, string>();
            foreach (string line in File.ReadAllLines(file, new UTF8Encoding(false)))
            {
                int index = line.IndexOf('=');
                if (index <= 0) continue;
                string key = line.Substring(0, index).Trim();
                if (PointerKeys.Contains(key)) pointer[key] = line.Substring(index + 1).Trim();
            }
            return pointer;
        }
        catch (IOException)
        {
            return null;
        }
    }

    private static void WritePointer(string root, Dictionary<string, string> pointer)
    {
        string file = Path.Combine(root, "current.ini");
        string temporary = file + ".tmp";
        var lines = PointerKeys.Where(key => Get(pointer, key) != null).Select(key => key + "=" + pointer[key]);
        File.WriteAllText(temporary, string.Join("\n", lines) + "\n", new UTF8Encoding(false));
        if (File.Exists(file)) File.Replace(temporary, file, null);
        else File.Move(temporary, file);
    }

    private static void Fail(string message, string hint)
    {
        Console.Error.WriteLine(message);
        if (hint != null) Console.Error.WriteLine(hint);
        if (Console.IsInputRedirected) return;
        Console.WriteLine("按回车关闭。");
        Console.ReadLine();
    }
}
