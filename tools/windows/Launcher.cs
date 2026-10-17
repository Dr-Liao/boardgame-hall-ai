using System;
using System.Diagnostics;
using System.IO;
using System.Text;

internal static class Launcher
{
    private static int Main()
    {
        Console.OutputEncoding = Encoding.UTF8;
        Console.Title = "桌游大厅";
        string root = AppDomain.CurrentDomain.BaseDirectory;
        try
        {
            var start = new ProcessStartInfo {
                FileName = Path.Combine(root, "runtime", "node.exe"),
                Arguments = "\"" + Path.Combine(root, "app", "portable.mjs") + "\"",
                WorkingDirectory = Path.Combine(root, "app"),
                UseShellExecute = false
            };
            // A portable release never reads the development installation's saves.
            start.EnvironmentVariables["DSH_HOME"] = Path.Combine(root, "user-data");
            using (var child = Process.Start(start))
            {
                child.WaitForExit();
                if (child.ExitCode != 0 && !Console.IsInputRedirected)
                {
                    Console.WriteLine("启动失败，请查看上方信息。按回车关闭。");
                    Console.ReadLine();
                }
                return child.ExitCode;
            }
        }
        catch (Exception error)
        {
            Console.Error.WriteLine("无法启动桌游大厅：" + error.Message);
            Console.Error.WriteLine("请完整解压发布包，保留 EXE 旁的 app 和 runtime 文件夹。");
            if (!Console.IsInputRedirected) Console.ReadLine();
            return 1;
        }
    }
}
