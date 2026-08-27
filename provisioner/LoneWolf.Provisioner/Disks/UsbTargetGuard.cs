using LoneWolf.Provisioner.Events;
using LoneWolf.Provisioner.Imaging;

namespace LoneWolf.Provisioner.Disks;

/// <summary>
/// Refuse non-USB / system disks before any wipe or raw ISO write.
/// </summary>
public static class UsbTargetGuard
{
    public static async Task AssertWritableUsbAsync(int diskNumber, long isoBytes, CancellationToken ct)
    {
        if (diskNumber < 1)
            throw new InvalidOperationException("Refusing disk 0 (system disk). Select the USB stick explicitly.");

        var script = $@"
$ErrorActionPreference = 'Stop'
$n = {diskNumber}
$need = [int64]{isoBytes}
$d = Get-Disk -Number $n -ErrorAction Stop
if ($d.IsSystem) {{ throw ""Refusing system disk $n."" }}
if ($d.IsBoot) {{ throw ""Refusing boot disk $n."" }}
$usb = $false
if ([string]$d.BusType -eq 'USB') {{ $usb = $true }}
if ($d.PSObject.Properties['IsRemovable'] -and $d.IsRemovable) {{ $usb = $true }}
try {{
  $wmi = Get-CimInstance Win32_DiskDrive -ErrorAction SilentlyContinue |
    Where-Object {{ $_.DeviceID -match ('PHYSICALDRIVE' + $n + '$') }} |
    Select-Object -First 1
  if ($wmi) {{
    if ($wmi.InterfaceType -eq 'USB') {{ $usb = $true }}
    if ([string]$wmi.PNPDeviceID -like 'USBSTOR*') {{ $usb = $true }}
    if ([string]$wmi.PNPDeviceID -like 'USB\\*') {{ $usb = $true }}
  }}
}} catch {{ }}
if (-not $usb) {{ throw ""Disk $n is not a USB/removable target. Refusing to write."" }}
if ([int64]$d.Size -lt $need) {{
  throw (""USB disk $n is smaller than the ISO ("" + [math]::Round($need/1GB, 2) + "" GB needed)."" )
}}
Write-Output 'ok'
";
        var result = await RunSnippetAsync(script, ct).ConfigureAwait(false);
        if (result.ExitCode != 0 || !result.Output.Contains("ok", StringComparison.OrdinalIgnoreCase))
            throw new InvalidOperationException(CleanError(result.Output, diskNumber));
    }

    public static async Task PrepareForRawWriteAsync(int diskNumber, JsonEventEmitter emit, CancellationToken ct)
    {
        emit.Log(diskNumber, "usb-target: taking disk offline for raw ISO write");
        var script = $@"
$ErrorActionPreference = 'Stop'
$n = {diskNumber}
$d = Get-Disk -Number $n -ErrorAction Stop
if ($d.IsSystem -or $d.IsBoot) {{ throw ""Refusing system/boot disk $n."" }}
$d | Set-Disk -IsReadOnly $false -ErrorAction SilentlyContinue
try {{ $d | Clear-Disk -RemoveData -RemoveOEM -Confirm:$false -ErrorAction Stop }} catch {{
  throw ""Could not clear disk $n. Close File Explorer windows for that USB and retry.""
}}
$d = Get-Disk -Number $n -ErrorAction Stop
$d | Set-Disk -IsOffline $true -ErrorAction Stop
Write-Output 'ok'
";
        var result = await RunSnippetAsync(script, ct).ConfigureAwait(false);
        if (result.ExitCode != 0)
            throw new InvalidOperationException(CleanError(result.Output, diskNumber));
    }

    public static async Task BringOnlineAsync(int diskNumber, CancellationToken ct)
    {
        var script = $@"
$ErrorActionPreference = 'SilentlyContinue'
$n = {diskNumber}
Get-Disk -Number $n | Set-Disk -IsOffline $false
Get-Disk -Number $n | Set-Disk -IsReadOnly $false
Write-Output 'ok'
";
        await RunSnippetAsync(script, ct).ConfigureAwait(false);
    }

    private static async Task<ProcessResult> RunSnippetAsync(string script, CancellationToken ct)
    {
        var path = Path.Combine(Path.GetTempPath(), "lw-usb-guard-" + Guid.NewGuid().ToString("N") + ".ps1");
        await File.WriteAllTextAsync(path, script, ct).ConfigureAwait(false);
        try
        {
            return await ProcessRunner.RunAsync(
                "powershell.exe",
                $"-NoProfile -NonInteractive -ExecutionPolicy Bypass -File \"{path}\"",
                ct).ConfigureAwait(false);
        }
        finally
        {
            try { File.Delete(path); } catch { /* ignore */ }
        }
    }

    private static string CleanError(string output, int disk)
    {
        var t = (output ?? "").Replace('\r', ' ').Trim();
        if (string.IsNullOrWhiteSpace(t))
            return $"USB target check failed for disk {disk}.";
        if (t.Length > 400) t = t[^400..];
        return t;
    }
}
