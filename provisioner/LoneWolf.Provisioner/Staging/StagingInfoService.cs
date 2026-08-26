using System.Text.Json;
using LoneWolf.Provisioner.Profiles;
using LoneWolf.Provisioner.Share;
using LoneWolf.Provisioner.Sources;

namespace LoneWolf.Provisioner.Staging;

public sealed class StagingInfo
{
    public string Version { get; set; } = "unknown";
    public string BuildDate { get; set; } = "";
    public string WorkflowType { get; set; } = "";
    public string BuildMode { get; set; } = "none";
    public bool WimAvailable { get; set; }
    public bool IsoAvailable { get; set; }
    public bool BitraserIsoAvailable { get; set; }
    public string? IsoFile { get; set; }
    public string? BitraserIsoFile { get; set; }
    public object? Architectures { get; set; }
}

public static class StagingInfoService
{
    public static StagingInfo Get(string workflowType, string? shareRoot, string? localProjectRoot)
    {
        var profile = WorkflowProfileRegistry.Get(workflowType);
        var wf = profile.Id;
        var info = new StagingInfo { WorkflowType = wf };

        string stagingRoot;
        if (!string.IsNullOrWhiteSpace(localProjectRoot))
            stagingRoot = Path.Combine(localProjectRoot, "Staging");
        else
        {
            var root = shareRoot ?? ProvisioningConstants.DefaultShareRoot;
            ConnectDeploymentShare.Connect(root);
            stagingRoot = ConnectDeploymentShare.GetStagingRoot(root);
        }

        var versionFile = Path.Combine(stagingRoot, "VERSION.json");
        if (File.Exists(versionFile))
        {
            try
            {
                using var doc = JsonDocument.Parse(File.ReadAllText(versionFile));
                var root = doc.RootElement;
                info.Version = root.TryGetProperty("version", out var v) ? v.GetString() ?? "unknown" : "unknown";
                info.BuildDate = root.TryGetProperty("buildDate", out var bd) ? bd.GetString() ?? "" : "";
                if (root.TryGetProperty("architectures", out var archEl))
                    info.Architectures = JsonSerializer.Deserialize<object>(archEl.GetRawText());
            }
            catch { /* ignore */ }
        }

        if (profile.ProvisionMode == "vendor-iso")
        {
            var bitraserDir = Path.Combine(stagingRoot, profile.ShareIsoSubdir ?? ProvisioningConstants.BitraserShareSubdir);
            if (Directory.Exists(bitraserDir))
            {
                var iso = Directory.GetFiles(bitraserDir, "*.iso")
                    .OrderByDescending(File.GetLastWriteTimeUtc).FirstOrDefault();
                if (iso != null)
                {
                    info.BitraserIsoAvailable = true;
                    info.IsoAvailable = true;
                    info.BitraserIsoFile = Path.GetFileName(iso);
                    info.IsoFile = info.BitraserIsoFile;
                    info.BuildMode = "iso";
                }
            }
            return info;
        }

        var arch = profile.Arch ?? "AMD64";
        var wim = Path.Combine(stagingRoot, arch, $"{arch}.wim");
        info.WimAvailable = File.Exists(wim);

        var isoRoot = Path.Combine(stagingRoot, "ISO");
        string? foundIso = null;
        foreach (var dir in new[] { isoRoot, stagingRoot })
        {
            if (!Directory.Exists(dir)) continue;
            foundIso = Directory.GetFiles(dir, "*.iso")
                .Where(f => Path.GetFileName(f).Contains($"({arch})", StringComparison.OrdinalIgnoreCase))
                .OrderByDescending(File.GetLastWriteTimeUtc).FirstOrDefault();
            if (foundIso != null) break;
        }

        info.IsoAvailable = foundIso != null;
        if (foundIso != null) info.IsoFile = Path.GetFileName(foundIso);

        info.BuildMode = info.WimAvailable ? "wim" : info.IsoAvailable ? "iso" : "none";

        var bitraserPath = Path.Combine(stagingRoot, ProvisioningConstants.BitraserShareSubdir);
        if (Directory.Exists(bitraserPath))
        {
            var bi = Directory.GetFiles(bitraserPath, "*.iso").OrderByDescending(File.GetLastWriteTimeUtc).FirstOrDefault();
            if (bi != null)
            {
                info.BitraserIsoAvailable = true;
                info.BitraserIsoFile = Path.GetFileName(bi);
            }
        }

        return info;
    }
}
