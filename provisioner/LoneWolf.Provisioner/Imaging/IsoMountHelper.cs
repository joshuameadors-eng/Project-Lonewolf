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
        var escaped = localPath.Replace("'", "''");
        var scriptPath = Path.Combine(Path.GetTempPath(), "lw-iso-mount-" + Guid.NewGuid().ToString("N") + ".ps1");
        var script = $@"
$ErrorActionPreference = 'Stop'
$path = '{escaped}'
$img = Mount-DiskImage -ImagePath $path -StorageType ISO -Access ReadOnly -PassThru -ErrorAction Stop
Start-Sleep -Milliseconds 600
function Get-LwIsoLetter($image) {{
  $vol = $image | Get-Volume -ErrorAction SilentlyContinue
  foreach ($v in @($vol)) {{ if ($v.DriveLetter) {{ return [string]$v.DriveLetter }} }}
  $di = Get-DiskImage -ImagePath $path -ErrorAction SilentlyContinue
  if ($di) {{
    $vols = $di | Get-Volume -ErrorAction SilentlyContinue
    foreach ($v in @($vols)) {{ if ($v.DriveLetter) {{ return [string]$v.DriveLetter }} }}
  }}
  return $null
}}
$letter = Get-LwIsoLetter $img
if (-not $letter) {{
  Start-Sleep -Milliseconds 1200
  $letter = Get-LwIsoLetter $img
}}
if (-not $letter) {{
  throw 'ISO mounted but Windows did not assign a drive letter.'
}}
Write-Output $letter
";
        await File.WriteAllTextAsync(scriptPath, script, ct).ConfigureAwait(false);
        try
        {
            var result = await ProcessRunner.RunAsync(
                "powershell.exe",
                $"-NoProfile -NonInteractive -ExecutionPolicy Bypass -File \"{scriptPath}\"",
                ct).ConfigureAwait(false);
            var output = (result.Output ?? "").Trim();
            string? letter = null;
            foreach (var line in output.Split('\n', StringSplitOptions.RemoveEmptyEntries | StringSplitOptions.TrimEntries))
            {
                var t = line.Trim().TrimEnd(':');
                if (t.Length == 1 && char.IsLetter(t[0])) letter = t;
            }
            if (result.ExitCode != 0 || string.IsNullOrWhiteSpace(letter))
                throw new InvalidOperationException($"Failed to mount ISO: {(string.IsNullOrWhiteSpace(output) ? isoPath : output)}");

            _driveLetter = letter.Trim().TrimEnd(':') + ":";
            emitter.Log(logDisk, $"ISO mounted at {_driveLetter}");
            return _driveLetter;
        }
        finally
        {
            try { File.Delete(scriptPath); } catch { /* ignore */ }
        }
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
