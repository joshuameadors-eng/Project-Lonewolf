using System.Diagnostics;
using System.Runtime.InteropServices;

namespace LoneWolf.Provisioner.Share;

public static class ConnectDeploymentShare
{
    public static void Connect(
        string shareRoot = ProvisioningConstants.DefaultShareRoot,
        string user = ProvisioningConstants.DefaultShareUser,
        string password = ProvisioningConstants.DefaultSharePassword)
    {
        var host = ExtractHost(shareRoot);
        RegisterCmdKey(host, user, password);
    }

    public static bool IsReachable(string path)
    {
        try { return Directory.Exists(path); }
        catch { return false; }
    }

    public static string GetStagingRoot(string shareRoot) =>
        Path.Combine(shareRoot, "Remote", "Staging");

    public static string GetProjectRoot(string shareRoot) =>
        Path.Combine(shareRoot, "Remote");

    private static string ExtractHost(string shareRoot)
    {
        if (shareRoot.StartsWith(@"\\", StringComparison.Ordinal))
        {
            var parts = shareRoot.TrimStart('\\').Split('\\', 2);
            return parts[0];
        }
        return "WIN-HQ5JDEACV3S";
    }

    private static void RegisterCmdKey(string host, string user, string password)
    {
        try
        {
            var cmdkey = Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.System), "cmdkey.exe");
            RunSilent(cmdkey, $"/delete:{host}");
            RunSilent(cmdkey, $"/add:{host} /user:{user} /pass:{password}");
        }
        catch { /* non-fatal */ }
    }

    private static void RunSilent(string exe, string args)
    {
        using var p = Process.Start(new ProcessStartInfo
        {
            FileName = exe,
            Arguments = args,
            UseShellExecute = false,
            CreateNoWindow = true
        });
        p?.WaitForExit(5000);
    }
}
