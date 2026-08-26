using System.Diagnostics;
using LoneWolf.Provisioner.Events;

namespace LoneWolf.Provisioner.Imaging;

public sealed class IsoMountHelper : IDisposable
{
    private string? _localIsoPath;
    private string? _mountedIsoPath;
    private string? _driveLetter;
    private bool _disposed;

    public string? DriveLetter => _driveLetter;

    public async Task<string> MountAsync(string isoPath, JsonEventEmitter? log = null, int logDisk = 0, CancellationToken ct = default)
    {
        var emitter = log ?? new JsonEventEmitter();
        var localPath = isoPath;

        if (isoPath.StartsWith(@"\\", StringComparison.Ordinal))
        {
            var tempIso = Path.Combine(Path.GetTempPath(), "LW-ISO-" + Guid.NewGuid().ToString("N")[..8] + ".iso");
            emitter.Log(logDisk, "iso-mount: copying UNC ISO to local temp...");
            await Task.Run(() => File.Copy(isoPath, tempIso, overwrite: true), ct).ConfigureAwait(false);
            _localIsoPath = tempIso;
            localPath = tempIso;
        }

        _mountedIsoPath = localPath;

        var psi = new ProcessStartInfo
        {
            FileName = "powershell.exe",
            Arguments = $"-NoProfile -Command \"(Mount-DiskImage -ImagePath '{localPath.Replace("'", "''")}' -PassThru | Get-Volume).DriveLetter\"",
            UseShellExecute = false,
            RedirectStandardOutput = true,
            CreateNoWindow = true
        };

        using var proc = Process.Start(psi) ?? throw new InvalidOperationException("Failed to start PowerShell for ISO mount");
        var output = await proc.StandardOutput.ReadToEndAsync(ct).ConfigureAwait(false);
        await proc.WaitForExitAsync(ct).ConfigureAwait(false);

        if (proc.ExitCode != 0 || string.IsNullOrWhiteSpace(output))
            throw new InvalidOperationException($"Failed to mount ISO: {isoPath}");

        _driveLetter = output.Trim() + ":";
        emitter.Log(logDisk, $"ISO mounted at {_driveLetter}");
        return _driveLetter;
    }

    public void Dispose()
    {
        if (_disposed) return;
        _disposed = true;

        try
        {
            if (_mountedIsoPath != null && File.Exists(_mountedIsoPath))
                DismountIso(_mountedIsoPath);
            if (_localIsoPath != null && File.Exists(_localIsoPath))
            {
                try { File.Delete(_localIsoPath); } catch { /* ignore */ }
            }
        }
        catch { /* ignore cleanup errors */ }
    }

    public static void DismountIso(string isoPath)
    {
        try
        {
            Process.Start(new ProcessStartInfo
            {
                FileName = "powershell.exe",
                Arguments = $"-NoProfile -Command \"Dismount-DiskImage -ImagePath '{isoPath.Replace("'", "''")}'\"",
                UseShellExecute = false,
                CreateNoWindow = true
            })?.WaitForExit(30000);
        }
        catch { /* ignore */ }
    }
}
