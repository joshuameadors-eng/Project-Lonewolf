namespace LoneWolf.Provisioner.Sources;

public sealed class SourceEntry
{
    public string Path { get; set; } = "";
    public string Name { get; set; } = "";
    public string Origin { get; set; } = "local"; // local | share | manual
    public string Kind { get; set; } = "iso"; // iso | folder | wim
    public string? Arch { get; set; }
    public string? WorkflowHint { get; set; }
    public long SizeBytes { get; set; }
    public DateTime LastModified { get; set; }
    public bool IsDefault { get; set; }
}

public static class LocalIsoScanner
{
    public static IReadOnlyList<SourceEntry> Scan(IEnumerable<string>? extraRoots = null)
    {
        var roots = (extraRoots ?? ProvisioningConstants.DefaultLocalScanRoots)
            .Where(r => !string.IsNullOrWhiteSpace(r))
            .Distinct(StringComparer.OrdinalIgnoreCase)
            .ToList();

        var results = new List<SourceEntry>();
        var seen = new HashSet<string>(StringComparer.OrdinalIgnoreCase);

        foreach (var root in roots)
        {
            if (!Directory.Exists(root) && root != @"D:\") continue;

            ScanDirectory(root, depth: 0, maxDepth: 2, results, seen);
        }

        return results.OrderByDescending(r => r.LastModified).ToList();
    }

    private static void ScanDirectory(string dir, int depth, int maxDepth, List<SourceEntry> results, HashSet<string> seen)
    {
        try
        {
            foreach (var file in Directory.EnumerateFiles(dir, "*.iso", SearchOption.TopDirectoryOnly))
            {
                if (!seen.Add(file)) continue;
                var fi = new FileInfo(file);
                results.Add(new SourceEntry
                {
                    Path = file,
                    Name = fi.Name,
                    Origin = "local",
                    Kind = "iso",
                    Arch = InferArch(fi.Name),
                    WorkflowHint = InferWorkflow(fi.Name),
                    SizeBytes = fi.Length,
                    LastModified = fi.LastWriteTimeUtc
                });
            }

            if (depth < maxDepth)
            {
                foreach (var sub in Directory.EnumerateDirectories(dir))
                {
                    var name = Path.GetFileName(sub);
                    if (name is "node_modules" or ".git" or "dist") continue;
                    ScanDirectory(sub, depth + 1, maxDepth, results, seen);
                }
            }
        }
        catch { /* skip inaccessible */ }
    }

    internal static string? InferArch(string name)
    {
        var u = name.ToUpperInvariant();
        if (u.Contains("ARM64") || u.Contains("SNAPDRAGON")) return "ARM64";
        if (u.Contains("AMD64") || u.Contains("X64")) return "AMD64";
        return null;
    }

    internal static string? InferWorkflow(string name)
    {
        var u = name.ToUpperInvariant();
        if (u.Contains("BITRASER")) return "bitraser";
        if (u.Contains("WIPE") || u.Contains("DESTRUCT") || u.Contains("NUKE")) return "destruction";
        if (u.Contains("WINDOWS")) return "windows";
        return null;
    }
}
