using LoneWolf.Provisioner.Imaging;

namespace LoneWolf.Provisioner.Sources;

public sealed class SourceAnalysis
{
    public string Path { get; set; } = "";
    public string? Arch { get; set; }
    public string BuildMode { get; set; } = "none"; // wim | iso | folder | none
    public bool SecureBootReady { get; set; }
    public string Origin { get; set; } = "local";
    public List<string> Warnings { get; set; } = new();
    public List<string> CompatibleProfiles { get; set; } = new();
}

public static class SourceAnalyzer
{
    public static SourceAnalysis Analyze(string path, string? origin = null)
    {
        var analysis = new SourceAnalysis
        {
            Path = path,
            Origin = origin ?? (path.StartsWith(@"\\") ? "share" : "local")
        };

        if (File.Exists(path) && path.EndsWith(".wim", StringComparison.OrdinalIgnoreCase))
        {
            analysis.BuildMode = "wim";
            analysis.Arch = InferArchFromPath(path);
            analysis.SecureBootReady = true; // WIM apply uses split ESP layout
            AddWindowsProfiles(analysis);
            return analysis;
        }

        if (File.Exists(path) && path.EndsWith(".iso", StringComparison.OrdinalIgnoreCase))
        {
            analysis.BuildMode = "iso";
            analysis.Arch = LocalIsoScanner.InferArch(Path.GetFileName(path));
            var wf = LocalIsoScanner.InferWorkflow(Path.GetFileName(path));
            if (wf is "bitraser" or "destruction")
            {
                analysis.CompatibleProfiles.Add(wf);
                analysis.SecureBootReady = true;
            }
            else
            {
                AnalyzeIsoContents(path, analysis);
                AddWindowsProfiles(analysis);
            }
            return analysis;
        }

        if (Directory.Exists(path))
        {
            analysis.BuildMode = "folder";
            analysis.Arch = LocalIsoScanner.InferArch(Path.GetFileName(path.TrimEnd('\\')));
            AnalyzeFolderContents(path, analysis);
            if (analysis.CompatibleProfiles.Count == 0)
                AddWindowsProfiles(analysis);
            return analysis;
        }

        analysis.Warnings.Add("Path not found or unsupported type");
        return analysis;
    }

    private static void AnalyzeIsoContents(string isoPath, SourceAnalysis analysis)
    {
        IsoMountHelper? mount = null;
        try
        {
            mount = new IsoMountHelper();
            var letter = mount.MountAsync(isoPath).GetAwaiter().GetResult();
            AnalyzeFolderContents(letter + "\\", analysis);
        }
        catch (Exception ex)
        {
            analysis.Warnings.Add($"Could not mount ISO for analysis: {ex.Message}");
        }
        finally
        {
            mount?.Dispose();
        }
    }

    private static void AnalyzeFolderContents(string root, SourceAnalysis analysis)
    {
        var bootWim = Path.Combine(root, "sources", "boot.wim");
        var bootmgfw = Path.Combine(root, "efi", "microsoft", "boot", "bootmgfw.efi");
        var bootx64 = Path.Combine(root, "efi", "boot", "bootx64.efi");

        if (!File.Exists(bootWim))
            analysis.Warnings.Add("sources\\boot.wim not found — WinPE boot may fail");

        if (File.Exists(bootmgfw))
            analysis.SecureBootReady = true;
        else if (File.Exists(bootx64))
        {
            analysis.SecureBootReady = true;
            analysis.Warnings.Add("bootmgfw.efi absent — will synthesize from bootx64.efi at build time");
        }
        else
        {
            analysis.SecureBootReady = false;
            analysis.Warnings.Add("No EFI boot loader found — Secure Boot USB boot unlikely");
        }

        if (analysis.Arch == null)
            analysis.Arch = DetectArchFromInstallWim(root);
    }

    private static string? DetectArchFromInstallWim(string root)
    {
        var sources = Path.Combine(root, "sources");
        if (!Directory.Exists(sources)) return null;
        foreach (var f in Directory.EnumerateFiles(sources, "install.*"))
        {
            var name = Path.GetFileName(f).ToUpperInvariant();
            if (name.Contains("ARM")) return "ARM64";
            if (name.Contains("X64") || name.Contains("AMD")) return "AMD64";
        }
        return null;
    }

    private static string? InferArchFromPath(string path)
    {
        var u = path.ToUpperInvariant();
        if (u.Contains("ARM64")) return "ARM64";
        if (u.Contains("AMD64")) return "AMD64";
        return "AMD64";
    }

    private static void AddWindowsProfiles(SourceAnalysis analysis)
    {
        var arch = analysis.Arch ?? "AMD64";
        if (arch == "AMD64")
        {
            analysis.CompatibleProfiles.Add("AMD64");
            analysis.CompatibleProfiles.Add("WIN-INSTALL-AMD64");
        }
        if (arch == "ARM64")
        {
            analysis.CompatibleProfiles.Add("ARM64");
            analysis.CompatibleProfiles.Add("WIN-INSTALL-ARM64");
        }
    }
}
