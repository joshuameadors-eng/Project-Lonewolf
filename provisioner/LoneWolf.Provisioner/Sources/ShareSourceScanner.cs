using LoneWolf.Provisioner.Profiles;
using LoneWolf.Provisioner.Share;

namespace LoneWolf.Provisioner.Sources;

public static class ShareSourceScanner
{
    public static IReadOnlyList<SourceEntry> Scan(
        string workflowType,
        string? shareRoot = null,
        string? localProjectRoot = null)
    {
        var results = new List<SourceEntry>();
        var wf = workflowType.ToUpperInvariant();
        var profile = WorkflowProfileRegistry.Get(wf);

        string stagingRoot;
        if (!string.IsNullOrWhiteSpace(localProjectRoot))
            stagingRoot = Path.Combine(localProjectRoot, "Staging");
        else
        {
            var root = shareRoot ?? ProvisioningConstants.DefaultShareRoot;
            if (string.IsNullOrWhiteSpace(localProjectRoot))
                ConnectDeploymentShare.Connect(root);
            stagingRoot = ConnectDeploymentShare.GetStagingRoot(root);
        }

        if (!Directory.Exists(stagingRoot))
            return results;

        switch (profile.ProvisionMode)
        {
            case "vendor-iso":
                if (string.Equals(profile.Id, "MEDIA-CREATOR", StringComparison.OrdinalIgnoreCase))
                    ScanMediaCreatorIsos(stagingRoot, results);
                else
                    ScanVendorIso(stagingRoot, profile.ShareIsoSubdir ?? ProvisioningConstants.BitraserShareSubdir, results);
                break;
            default:
                ScanWindowsMedia(stagingRoot, profile.Arch ?? "AMD64", results);
                break;
        }

        if (results.Count > 0)
            results[0].IsDefault = true;

        return results;
    }

    private static void ScanWindowsMedia(string stagingRoot, string arch, List<SourceEntry> results)
    {
        var wimPath = Path.Combine(stagingRoot, arch, $"{arch}.wim");
        if (File.Exists(wimPath))
        {
            var fi = new FileInfo(wimPath);
            results.Add(new SourceEntry
            {
                Path = wimPath,
                Name = fi.Name,
                Origin = "share",
                Kind = "wim",
                Arch = arch,
                WorkflowHint = "windows",
                SizeBytes = fi.Length,
                LastModified = fi.LastWriteTimeUtc,
                IsDefault = true
            });
        }

        var isoRoot = Path.Combine(stagingRoot, "ISO");
        var isoDirs = new[] { isoRoot, stagingRoot };
        foreach (var dir in isoDirs.Where(Directory.Exists))
        {
            foreach (var iso in Directory.EnumerateFiles(dir, "*.iso")
                         .Where(f => Path.GetFileName(f).Contains($"({arch})", StringComparison.OrdinalIgnoreCase))
                         .OrderByDescending(f => new FileInfo(f).LastWriteTimeUtc))
            {
                var fi = new FileInfo(iso);
                results.Add(new SourceEntry
                {
                    Path = iso,
                    Name = fi.Name,
                    Origin = "share",
                    Kind = "iso",
                    Arch = arch,
                    WorkflowHint = "windows",
                    SizeBytes = fi.Length,
                    LastModified = fi.LastWriteTimeUtc
                });
            }
        }
    }

    private static void ScanMediaCreatorIsos(string stagingRoot, List<SourceEntry> results)
    {
        var isoDir = Path.Combine(stagingRoot, ProvisioningConstants.MediaCreatorShareSubdir);
        if (!Directory.Exists(isoDir)) return;

        foreach (var iso in Directory.EnumerateFiles(isoDir, "*.iso")
                     .OrderByDescending(f => new FileInfo(f).LastWriteTimeUtc))
        {
            var fi = new FileInfo(iso);
            results.Add(new SourceEntry
            {
                Path = iso,
                Name = fi.Name,
                Origin = "share",
                Kind = "iso",
                Arch = LocalIsoScanner.InferArch(fi.Name),
                WorkflowHint = "media-creator",
                SizeBytes = fi.Length,
                LastModified = fi.LastWriteTimeUtc
            });
        }
    }

    private static void ScanVendorIso(string stagingRoot, string subdir, List<SourceEntry> results)
    {
        var dir = Path.Combine(stagingRoot, subdir);
        if (!Directory.Exists(dir)) return;

        foreach (var iso in Directory.EnumerateFiles(dir, "*.iso")
                     .OrderByDescending(f => new FileInfo(f).LastWriteTimeUtc))
        {
            var fi = new FileInfo(iso);
            results.Add(new SourceEntry
            {
                Path = iso,
                Name = fi.Name,
                Origin = "share",
                Kind = "iso",
                WorkflowHint = subdir.Equals(ProvisioningConstants.BitraserShareSubdir, StringComparison.OrdinalIgnoreCase)
                    ? "bitraser"
                    : subdir.Equals(ProvisioningConstants.DestructionShareSubdir, StringComparison.OrdinalIgnoreCase)
                        ? "destruction"
                        : "vendor-iso",
                SizeBytes = fi.Length,
                LastModified = fi.LastWriteTimeUtc
            });
        }
    }
}
