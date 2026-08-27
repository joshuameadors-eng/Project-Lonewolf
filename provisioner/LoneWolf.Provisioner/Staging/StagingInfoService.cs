using LoneWolf.Provisioner.Profiles;
using LoneWolf.Provisioner.Share;
using LoneWolf.Provisioner.Sources;

namespace LoneWolf.Provisioner.Staging;

public sealed class StagingArchInfo
{
    public string WimBuildDate { get; set; } = "";
    public string PayloadHash { get; set; } = "";
    public bool Enabled { get; set; }
}

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
    public string? IsoLastWrite { get; set; }
    public string? BitraserIsoFile { get; set; }
    public Dictionary<string, StagingArchInfo> Architectures { get; set; } = new(StringComparer.OrdinalIgnoreCase);
}

public static class StagingInfoService
{
    public static StagingInfo Get(string workflowType, string? shareRoot, string? localProjectRoot)
    {
        var profile = WorkflowProfileRegistry.Get(workflowType);
        var wf = profile.Id;
        var info = new StagingInfo { WorkflowType = wf };
        info.Architectures["AMD64"] = new StagingArchInfo { Enabled = true };
        info.Architectures["ARM64"] = new StagingArchInfo { Enabled = false };

        string stagingRoot;
        if (!string.IsNullOrWhiteSpace(localProjectRoot))
            stagingRoot = Path.Combine(localProjectRoot, "Staging");
        else
        {
            var root = shareRoot ?? ProvisioningConstants.DefaultShareRoot;
            ConnectDeploymentShare.Connect(root);
            stagingRoot = ConnectDeploymentShare.GetStagingRoot(root);
        }

        // ISO share must not host VERSION.json. Product version is overlaid by the launcher from bundled VERSION.json.

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
                    var isoYmd = File.GetLastWriteTimeUtc(iso).ToString("yyyy-MM-dd");
                    info.BuildDate = isoYmd;
                    info.IsoLastWrite = File.GetLastWriteTimeUtc(iso).ToString("o");
                }
            }
            return info;
        }

        var arch = profile.Arch ?? "AMD64";
        var wim = Path.Combine(stagingRoot, arch, $"{arch}.wim");
        info.WimAvailable = File.Exists(wim);
        if (info.WimAvailable)
        {
            var wimTime = File.GetLastWriteTimeUtc(wim);
            var wimYmd = wimTime.ToString("yyyy-MM-dd");
            info.BuildDate = wimYmd;
            EnsureArch(info, arch).WimBuildDate = wimYmd;
        }

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
        if (foundIso != null)
        {
            info.IsoFile = Path.GetFileName(foundIso);
            var isoTime = File.GetLastWriteTimeUtc(foundIso);
            info.IsoLastWrite = isoTime.ToString("o");
            var isoYmd = isoTime.ToString("yyyy-MM-dd");
            info.BuildDate = isoYmd;
            EnsureArch(info, arch).WimBuildDate = isoYmd;
        }

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

    private static StagingArchInfo EnsureArch(StagingInfo info, string arch)
    {
        if (!info.Architectures.TryGetValue(arch, out var entry) || entry == null)
        {
            entry = new StagingArchInfo { Enabled = true };
            info.Architectures[arch] = entry;
        }
        return entry;
    }
}
