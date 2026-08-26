using LoneWolf.Provisioner.Profiles;
using LoneWolf.Provisioner.Share;

namespace LoneWolf.Provisioner.Sources;

public sealed class ResolvedSource
{
    public string Path { get; set; } = "";
    public string Kind { get; set; } = "iso"; // iso | folder | wim
    public string Origin { get; set; } = "share";
    public string? Arch { get; set; }
    public bool UseIsoMode { get; set; }
    public string? IsoPath { get; set; }
    public string? WimPath { get; set; }
    public string? FolderPath { get; set; }
    /// <summary>Human-readable explanation of which source was auto-selected and why (logged at build start).</summary>
    public string? SelectionReason { get; set; }
}

public static class SourceResolver
{
    public static ResolvedSource Resolve(
        WorkflowProfile profile,
        string? explicitSourcePath,
        string? shareRoot,
        string? localProjectRoot)
    {
        if (!profile.AllowOperatorSource)
            explicitSourcePath = null;

        if (!string.IsNullOrWhiteSpace(explicitSourcePath))
            return ResolveExplicit(explicitSourcePath, profile);

        var stagingRoot = !string.IsNullOrWhiteSpace(localProjectRoot)
            ? Path.Combine(localProjectRoot, "Staging")
            : ConnectDeploymentShare.GetStagingRoot(shareRoot ?? ProvisioningConstants.DefaultShareRoot);

        if (string.IsNullOrWhiteSpace(localProjectRoot))
            ConnectDeploymentShare.Connect(shareRoot ?? ProvisioningConstants.DefaultShareRoot);

        if (profile.ProvisionMode == "vendor-iso")
        {
            var subdir = profile.ShareIsoSubdir ?? ProvisioningConstants.BitraserShareSubdir;
            var isoDir = Path.Combine(stagingRoot, subdir);
            var isos = Directory.Exists(isoDir)
                ? Directory.GetFiles(isoDir, "*.iso").OrderByDescending(File.GetLastWriteTimeUtc).ToArray()
                : Array.Empty<string>();
            if (isos.Length == 0)
                throw new InvalidOperationException(
                    profile.AllowOperatorSource
                        ? $"No ISO found in {isoDir}. Stage media on the share or select a local source."
                        : $"No vendor ISO found in {isoDir}. Contact IT to stage the required image.");
            return new ResolvedSource
            {
                Path = isos[0],
                Kind = "iso",
                Origin = "share",
                UseIsoMode = true,
                IsoPath = isos[0]
            };
        }

        // Default (auto) resolution for the lonewolf + win-install profiles.
        // The ISO is the PROVEN media source (mount ISO → overlay → inject → per-disk BCD rebuild),
        // so it is preferred over any pre-staged <arch>.wim. This only affects auto resolution — an
        // explicit operator selection (--source) is handled by ResolveExplicit above and is honored
        // unchanged, and vendor-iso profiles (Media Creator / Bitraser / Destruction) returned earlier.
        var arch = profile.Arch ?? "AMD64";
        var wim = Path.Combine(stagingRoot, arch, $"{arch}.wim");

        var isoRoot = Path.Combine(stagingRoot, "ISO");
        string? iso = null;
        foreach (var dir in new[] { isoRoot, stagingRoot })
        {
            if (!Directory.Exists(dir)) continue;
            iso = Directory.GetFiles(dir, "*.iso")
                .Where(f => Path.GetFileName(f).Contains($"({arch})", StringComparison.OrdinalIgnoreCase))
                .OrderByDescending(File.GetLastWriteTimeUtc)
                .FirstOrDefault();
            if (iso != null) break;
        }

        // ISO wins whenever one exists — even if a staged <arch>.wim is also present.
        if (iso != null)
        {
            return new ResolvedSource
            {
                Path = iso,
                Kind = "iso",
                Origin = "share",
                Arch = arch,
                UseIsoMode = true,
                IsoPath = iso,
                SelectionReason = File.Exists(wim)
                    ? $"source: ISO '{Path.GetFileName(iso)}' chosen (preferred over staged {arch}.wim for profile {profile.Id})"
                    : $"source: ISO '{Path.GetFileName(iso)}' chosen for profile {profile.Id}"
            };
        }

        // No ISO available — fall back to the staged WIM rather than hard-failing.
        if (File.Exists(wim))
        {
            return new ResolvedSource
            {
                Path = wim,
                Kind = "wim",
                Origin = "share",
                Arch = arch,
                UseIsoMode = false,
                WimPath = wim,
                SelectionReason = $"source: staged WIM '{arch}.wim' chosen (no ISO for {arch} found in {isoRoot} or {stagingRoot}; falling back to WIM)"
            };
        }

        throw new InvalidOperationException(
            $"No ISO for {arch} and no WIM at {wim} in {stagingRoot}. Stage media on the share or select a local source.");
    }

    private static ResolvedSource ResolveExplicit(string path, WorkflowProfile profile)
    {
        if (File.Exists(path) && path.EndsWith(".wim", StringComparison.OrdinalIgnoreCase))
        {
            return new ResolvedSource
            {
                Path = path,
                Kind = "wim",
                Origin = "manual",
                Arch = profile.Arch,
                UseIsoMode = profile.NoPayload && profile.ForceIsoForNoPayload ? false : false,
                WimPath = path
            };
        }

        if (File.Exists(path) && path.EndsWith(".iso", StringComparison.OrdinalIgnoreCase))
        {
            var forceIso = profile.NoPayload || profile.ProvisionMode == "vendor-iso";
            return new ResolvedSource
            {
                Path = path,
                Kind = "iso",
                Origin = "manual",
                Arch = profile.Arch ?? LocalIsoScanner.InferArch(Path.GetFileName(path)),
                UseIsoMode = true,
                IsoPath = path
            };
        }

        if (Directory.Exists(path))
        {
            return new ResolvedSource
            {
                Path = path,
                Kind = "folder",
                Origin = "manual",
                Arch = profile.Arch,
                UseIsoMode = false,
                FolderPath = path
            };
        }

        throw new FileNotFoundException($"Source not found: {path}");
    }
}
