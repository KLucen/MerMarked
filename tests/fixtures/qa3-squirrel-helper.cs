using System;
using System.Diagnostics;
using System.IO;
using System.Text;
using System.Threading;

// Controlled stand-in for Update.exe. It never creates or removes shortcuts,
// installs software, or touches the copied app. Every write stays in the unique
// absolute gate directory supplied by this test process.
internal static class SquirrelHelper
{
    private static string Quote(string value)
    {
        return "\"" + value.Replace("\\", "\\\\").Replace("\"", "\\\"")
            .Replace("\r", "\\r").Replace("\n", "\\n").Replace("\t", "\\t") + "\"";
    }

    private static void WriteNew(string file, string value)
    {
        using (var stream = new FileStream(file, FileMode.CreateNew, FileAccess.Write, FileShare.Read))
        using (var writer = new StreamWriter(stream, new UTF8Encoding(false)))
            writer.Write(value);
    }

    [STAThread]
    private static int Main(string[] args)
    {
        string gate = Environment.GetEnvironmentVariable("MERMARKD_QA_SQUIRREL_GATE");
        if (String.IsNullOrEmpty(gate) || !Path.IsPathRooted(gate) || !Directory.Exists(gate)) return 120;
        string token = Environment.GetEnvironmentVariable("MERMARKD_QA_SQUIRREL_TOKEN");
        if (String.IsNullOrEmpty(token) || token.Length != 32) return 121;
        string[] accepted = { "--createShortcut=MerMarkd.exe", "--removeShortcut=MerMarkd.exe" };
        if (args.Length != 1 || Array.IndexOf(accepted, args[0]) < 0) return 122;
        string processPath = Process.GetCurrentProcess().MainModule.FileName;
        string start = "{\"pid\":" + Process.GetCurrentProcess().Id + ",\"token\":" + Quote(token)
            + ",\"helperPath\":" + Quote(processPath) + ",\"argument\":" + Quote(args[0])
            + ",\"startedUtc\":" + Quote(DateTime.UtcNow.ToString("o")) + "}";
        WriteNew(Path.Combine(gate, "helper-start.json"), start);
        DateTime deadline = DateTime.UtcNow.AddSeconds(30);
        while (!File.Exists(Path.Combine(gate, "release")))
        {
            if (DateTime.UtcNow >= deadline)
            {
                WriteNew(Path.Combine(gate, "helper-timeout.json"), "{\"token\":" + Quote(token) + "}");
                return 123;
            }
            Thread.Sleep(25);
        }
        WriteNew(Path.Combine(gate, "helper-exiting.json"), "{\"token\":" + Quote(token)
            + ",\"exitingUtc\":" + Quote(DateTime.UtcNow.ToString("o")) + "}");
        return 0;
    }
}
