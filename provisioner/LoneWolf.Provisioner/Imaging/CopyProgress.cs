namespace LoneWolf.Provisioner.Imaging;



internal static class CopyProgress

{

    /// <summary>

    /// Sum on-disk file lengths under <paramref name="root"/>.

    /// Uses an explicit directory walk so junction/reparse directories are traversed

    /// (Directory.EnumerateFiles RecurseSubdirectories does not enter them).

    /// Inaccessible files/dirs are skipped (matches PS Get-ChildItem -ErrorAction SilentlyContinue).

    /// </summary>

    public static long GetDirectoryByteSize(string root)

    {

        try

        {

            if (string.IsNullOrWhiteSpace(root) || !Directory.Exists(root)) return 0;



            long total = 0;

            var visited = new HashSet<string>(StringComparer.OrdinalIgnoreCase);

            WalkDirectoryTree(root, ref total, visited);

            return total;

        }

        catch

        {

            return 0;

        }

    }



    private static void WalkDirectoryTree(string dir, ref long total, HashSet<string> visited)

    {

        string normalized;

        try { normalized = Path.GetFullPath(dir).TrimEnd('\\', '/'); }

        catch { return; }



        if (!visited.Add(normalized)) return;



        string[] files;

        try { files = Directory.GetFiles(dir); }

        catch { files = Array.Empty<string>(); }



        foreach (var file in files)

        {

            try { total += new FileInfo(file).Length; }

            catch (UnauthorizedAccessException) { /* skip */ }

            catch (IOException) { /* skip */ }

        }



        string[] subdirs;

        try { subdirs = Directory.GetDirectories(dir); }

        catch { subdirs = Array.Empty<string>(); }



        foreach (var sub in subdirs)

            WalkDirectoryTree(sub, ref total, visited);

    }



    public static Task<long> GetDirectoryByteSizeAsync(string root, CancellationToken ct = default) =>

        Task.Run(() => GetDirectoryByteSize(root), ct);



    public static string FormatBytes(long bytes)

    {

        if (bytes < 1024) return $"{bytes} B";

        if (bytes < 1024L * 1024) return $"{bytes / 1024.0:F1} KB";

        if (bytes < 1024L * 1024 * 1024) return $"{bytes / (1024.0 * 1024):F1} MB";

        return $"{bytes / (1024.0 * 1024 * 1024):F2} GB";

    }

}

