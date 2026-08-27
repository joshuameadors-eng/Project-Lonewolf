using System.Text;

namespace LoneWolf.Provisioner.Imaging;

public enum IsoWriteKind
{
    HybridDd,
    WindowsExtract,
    RawDd
}

public sealed class IsoHeaderInfo
{
    public bool Iso9660 { get; init; }
    public bool Mbr { get; init; }
    public bool Gpt { get; init; }
    public bool Hybrid => Iso9660 && (Mbr || Gpt);
}

public static class IsoMediaKind
{
    public const int HeaderBytesNeeded = 0x8800;

    public static IsoHeaderInfo InspectHeader(byte[] buf)
    {
        var iso9660 = AsciiEquals(buf, 0x8001, "CD001");
        var mbr = buf.Length > 511 && buf[510] == 0x55 && buf[511] == 0xAA;
        var gpt = AsciiEquals(buf, 512, "EFI PART");
        return new IsoHeaderInfo { Iso9660 = iso9660, Mbr = mbr, Gpt = gpt };
    }

    public static IsoHeaderInfo InspectFile(string isoPath)
    {
        using var fs = new FileStream(isoPath, FileMode.Open, FileAccess.Read, FileShare.ReadWrite);
        var buf = new byte[HeaderBytesNeeded];
        var n = fs.Read(buf, 0, buf.Length);
        if (n < buf.Length)
        {
            var slice = new byte[n];
            Buffer.BlockCopy(buf, 0, slice, 0, n);
            return InspectHeader(slice);
        }
        return InspectHeader(buf);
    }

    public static bool LooksLikeWindowsInstallerLayout(string isoRoot)
    {
        if (string.IsNullOrWhiteSpace(isoRoot)) return false;
        var sources = Path.Combine(isoRoot, "sources");
        foreach (var name in new[] { "install.wim", "install.esd", "install.swm" })
        {
            if (File.Exists(Path.Combine(sources, name))) return true;
        }
        return false;
    }

    public static IsoWriteKind Plan(IsoHeaderInfo header, bool windowsLayout)
    {
        if (windowsLayout) return IsoWriteKind.WindowsExtract;
        if (header.Hybrid) return IsoWriteKind.HybridDd;
        return IsoWriteKind.RawDd;
    }

    private static bool AsciiEquals(byte[] buf, int offset, string expected)
    {
        var bytes = Encoding.ASCII.GetBytes(expected);
        if (buf.Length < offset + bytes.Length) return false;
        for (var i = 0; i < bytes.Length; i++)
        {
            if (buf[offset + i] != bytes[i]) return false;
        }
        return true;
    }
}
