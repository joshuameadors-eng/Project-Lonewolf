// .NET Framework 4.8 host: one UAC via app.manifest (requireAdministrator).
// Extracts the STA installer script and runs it already elevated.
// Does not embed the launcher exe. Install-LoneWolfLauncher.ps1 downloads
// the latest portable from public latest.json at install time.
using System;
using System.Diagnostics;
using System.IO;
using System.Reflection;
using System.Text;
using System.Windows.Forms;

internal static class LoneWolfSetupHost
{
    [STAThread]
    static int Main(string[] args)
    {
        try
        {
            var work = Path.Combine(Path.GetTempPath(), "lw-setup-" + Guid.NewGuid().ToString("n"));
            Directory.CreateDirectory(work);

            var script = Path.Combine(work, "Install-LoneWolfLauncher.ps1");
            ExtractEmbeddedScript(script);
            ExtractBranding(work);

            var psi = new ProcessStartInfo();
            psi.FileName = Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.System), "WindowsPowerShell\\v1.0\\powershell.exe");
            psi.UseShellExecute = false;
            psi.CreateNoWindow = true;
            psi.WindowStyle = ProcessWindowStyle.Hidden;

            var sb = new StringBuilder();
            sb.Append("-NoProfile -STA -ExecutionPolicy Bypass -File \"");
            sb.Append(script);
            sb.Append("\" -AlreadyElevated");

            foreach (var a in args)
            {
                if (string.Equals(a, "/S", StringComparison.OrdinalIgnoreCase) ||
                    string.Equals(a, "-S", StringComparison.OrdinalIgnoreCase) ||
                    string.Equals(a, "--silent", StringComparison.OrdinalIgnoreCase))
                {
                    sb.Append(" -Silent");
                    continue;
                }
                if (a.StartsWith("/D=", StringComparison.OrdinalIgnoreCase))
                {
                    sb.Append(" -InstallDir \"");
                    sb.Append(a.Substring(3).Trim('"'));
                    sb.Append("\"");
                    continue;
                }
                sb.Append(' ');
                if (a.IndexOf(' ') >= 0) sb.Append('"').Append(a).Append('"');
                else sb.Append(a);
            }

            psi.Arguments = sb.ToString();
            var p = Process.Start(psi);
            if (p == null) return 1;
            p.WaitForExit();
            return p.ExitCode;
        }
        catch (Exception ex)
        {
            try
            {
                MessageBox.Show(ex.Message, "LoneWolf Installer", MessageBoxButtons.OK, MessageBoxIcon.Error);
            }
            catch { }
            return 1;
        }
    }

    static void ExtractEmbeddedScript(string dest)
    {
        var asm = Assembly.GetExecutingAssembly();
        Stream s = asm.GetManifestResourceStream("Install-LoneWolfLauncher.ps1");
        if (s == null)
        {
            foreach (var name in asm.GetManifestResourceNames())
            {
                if (name.EndsWith("Install-LoneWolfLauncher.ps1", StringComparison.OrdinalIgnoreCase))
                {
                    s = asm.GetManifestResourceStream(name);
                    break;
                }
            }
        }
        if (s == null)
            throw new InvalidOperationException("Embedded installer script missing.");
        using (s)
        using (var fs = File.Create(dest))
            s.CopyTo(fs);
    }

    static void ExtractBranding(string destDir)
    {
        var asm = Assembly.GetExecutingAssembly();
        foreach (var name in asm.GetManifestResourceNames())
        {
            string destName = null;
            if (name.EndsWith("icon.ico", StringComparison.OrdinalIgnoreCase)) destName = "icon.ico";
            else if (name.EndsWith("installerSidebar.bmp", StringComparison.OrdinalIgnoreCase)) destName = "installerSidebar.bmp";
            else if (name.EndsWith("dotnet-runtime.json", StringComparison.OrdinalIgnoreCase)) destName = "dotnet-runtime.json";
            if (destName == null) continue;
            using (var s = asm.GetManifestResourceStream(name))
            using (var fs = File.Create(Path.Combine(destDir, destName)))
                if (s != null) s.CopyTo(fs);
        }
    }
}
