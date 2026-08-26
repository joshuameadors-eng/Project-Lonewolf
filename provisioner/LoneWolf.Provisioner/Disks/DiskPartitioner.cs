using System.Diagnostics;
using System.Text;
using LoneWolf.Provisioner.Events;
using LoneWolf.Provisioner.Imaging;

namespace LoneWolf.Provisioner.Disks;

public static class DiskPartitioner
{
    public static async Task<(string EspRoot, string DataRoot)> PartitionUsbAsync(
        int diskNumber,
        long espBytes,
        string dataLabel,
        JsonEventEmitter emit,
        CancellationToken ct)
    {
        emit.Phase(diskNumber, "partitioning");

        // Match Invoke-LoneWolfBuild.ps1 / Build-UsbStick.ps1: Clear-Disk + Set-Disk GPT is
        // idempotent on rebuild sticks. diskpart "clean" + "convert gpt" fails when the USB is
        // already GPT ("not MBR formatted") because convert gpt only accepts empty MBR disks.
        var scriptPath = Path.Combine(Path.GetTempPath(), $"lw-partition-{diskNumber}-{Guid.NewGuid():N}.ps1");
        var escapedLabel = dataLabel.Replace("'", "''");
        var script = $@"
$ErrorActionPreference = 'Stop'
Import-Module Storage -ErrorAction Stop
$dataLabel = '{escapedLabel}'
$disk = Get-Disk -Number {diskNumber} -ErrorAction Stop
$disk | Clear-Disk -RemoveData -Confirm:$false -ErrorAction Stop
$disk | Set-Disk -PartitionStyle GPT -ErrorAction Stop
$disk = Get-Disk -Number {diskNumber} -ErrorAction Stop
$esp = $disk | New-Partition -Size {espBytes} `
  -GptType '{{c12a7328-f81f-11d2-ba4b-00a0c93ec93b}}' -AssignDriveLetter -ErrorAction Stop
try {{
  $esp | Format-Volume -FileSystem FAT32 -NewFileSystemLabel 'FB_ESP' -Confirm:$false | Out-Null
}} catch {{
  $el = ($esp | Get-Volume).DriveLetter
  & cmd /c ""format $el`: /FS:FAT32 /Q /V:FB_ESP /Y"" | Out-Null
  if ($LASTEXITCODE -ne 0) {{ throw ""FAT32 format failed on drive $el"" }}
}}
$data = $disk | New-Partition -UseMaximumSize `
  -GptType '{{ebd0a0a2-b9e5-4433-87c0-68b6b72699c7}}' -AssignDriveLetter -ErrorAction Stop
try {{
  $data | Format-Volume -FileSystem NTFS -NewFileSystemLabel $dataLabel -Confirm:$false | Out-Null
}} catch {{
  $dl = ($data | Get-Volume -ErrorAction SilentlyContinue).DriveLetter
  if ($dl) {{
    & cmd /c ""format $dl`: /FS:NTFS /Q /V:`""$dataLabel`"" /Y"" | Out-Null
    if ($LASTEXITCODE -ne 0) {{ throw ""NTFS format failed on drive $dl"" }}
  }} else {{
    throw
  }}
}}
";

        await File.WriteAllTextAsync(scriptPath, script, ct).ConfigureAwait(false);

        try
        {
            var result = await ProcessRunner.RunAsync(
                "powershell.exe",
                $"-NoProfile -NonInteractive -ExecutionPolicy Bypass -File \"{scriptPath}\"",
                ct).ConfigureAwait(false);
            if (result.ExitCode != 0)
                throw new InvalidOperationException($"partition failed (exit {result.ExitCode}): {result.Output}");
        }
        finally
        {
            try { File.Delete(scriptPath); } catch { /* ignore */ }
        }

        await Task.Delay(2000, ct).ConfigureAwait(false);

        var (esp, data) = await FindPartitionLettersAsync(diskNumber, ct).ConfigureAwait(false);
        if (esp == null || data == null)
            throw new InvalidOperationException($"Could not resolve drive letters for disk {diskNumber}");

        return (esp, data);
    }

    public static async Task<(string? Esp, string? Data)> FindPartitionLettersAsync(int diskNumber, CancellationToken ct)
    {
        string? esp = null, data = null;
        for (var i = 0; i < 30; i++)
        {
            var psi = new ProcessStartInfo
            {
                FileName = "powershell.exe",
                Arguments = $"-NoProfile -Command \"Get-Partition -DiskNumber {diskNumber} | ForEach-Object {{ $v = $_ | Get-Volume -ErrorAction SilentlyContinue; if ($v.DriveLetter) {{ Write-Output ($_.GptType.ToString() + ':' + $v.DriveLetter) }} }}\"",
                UseShellExecute = false,
                RedirectStandardOutput = true,
                CreateNoWindow = true
            };
            using var p = Process.Start(psi);
            if (p != null)
            {
                var output = await p.StandardOutput.ReadToEndAsync(ct).ConfigureAwait(false);
                await p.WaitForExitAsync(ct).ConfigureAwait(false);
                foreach (var line in output.Split('\n', StringSplitOptions.RemoveEmptyEntries))
                {
                    var parts = line.Trim().Split(':');
                    if (parts.Length < 2) continue;
                    var gpt = parts[0];
                    var letter = parts[1].Trim() + ":\\";
                    if (gpt.Contains("c12a7328", StringComparison.OrdinalIgnoreCase)) esp = letter;
                    if (gpt.Contains("ebd0a0a2", StringComparison.OrdinalIgnoreCase)) data = letter;
                }
            }
            if (esp != null && data != null) break;
            await Task.Delay(1000, ct).ConfigureAwait(false);
        }
        return (esp, data);
    }

    public static void SynthesizeBootmgfw(string espRoot, JsonEventEmitter emit, int disk)
    {
        var dst = Path.Combine(espRoot, "efi", "microsoft", "boot", "bootmgfw.efi");
        if (File.Exists(dst)) return;
        var src = Path.Combine(espRoot, "efi", "boot", "bootx64.efi");
        if (!File.Exists(src)) return;
        Directory.CreateDirectory(Path.GetDirectoryName(dst)!);
        File.Copy(src, dst, overwrite: true);
        emit.Log(disk, "synthesised efi\\microsoft\\boot\\bootmgfw.efi from bootx64.efi");
    }

    /// <summary>bootmgfw synthesis plus EFI\Boot\bootx64.efi removable-media fallback.</summary>
    public static void EnsureEspBootChain(string espRoot, JsonEventEmitter emit, int disk)
    {
        SynthesizeBootmgfw(espRoot, emit, disk);

        var fallbackDir = Path.Combine(espRoot, "EFI", "Boot");
        var fallbackEfi = Path.Combine(fallbackDir, "bootx64.efi");
        if (File.Exists(fallbackEfi)) return;

        var src = Path.Combine(espRoot, "efi", "microsoft", "boot", "bootmgfw.efi");
        if (!File.Exists(src)) return;

        Directory.CreateDirectory(fallbackDir);
        File.Copy(src, fallbackEfi, overwrite: true);
    }

    /// <summary>
    /// Guarantees the WinPE boot image (<c>sources\boot.wim</c>) is present on the ESP.
    ///
    /// The BCD copied from the media references the WinPE ramdisk as
    /// <c>ramdisk=[boot]\sources\boot.wim,{ramdiskoptions}</c> — <c>[boot]</c> resolves to the
    /// partition bootmgr loaded from, i.e. the ESP. If <c>\sources\boot.wim</c> is absent from
    /// the ESP, bootmgr loads bootmgfw.efi, reads the BCD, then fails to open the ramdisk WIM and
    /// aborts with <c>0xc000000f</c> ("a required device is inaccessible") before WinPE ever starts.
    ///
    /// boot.wim is deliberately NOT copied by <c>PopulateEspFromData</c> (which skips all *.wim so
    /// the multi-GB install image never lands on the ESP) and is frequently absent from the ESP
    /// cache when the build source is a staging folder whose <c>sources\</c> holds only the install
    /// image. This method closes that gap by copying boot.wim onto the ESP from the best available
    /// source — the injected cache copy first (already carries the custom startnet.cmd), then the
    /// data partition, then the mounted ISO. Returns true when boot.wim is present on the ESP.
    /// </summary>
    public static bool EnsureEspBootWim(
        string espRoot, string? dataRoot, string? isoRoot, string? espCache, JsonEventEmitter emit, int disk)
    {
        var espSources = Path.Combine(espRoot, "sources");
        var espBootWim = Path.Combine(espSources, "boot.wim");
        if (File.Exists(espBootWim))
        {
            emit.Log(disk, "esp-bootwim: sources\\boot.wim already present on ESP");
            return true;
        }

        Directory.CreateDirectory(espSources);

        var candidates = new List<string>();
        if (!string.IsNullOrEmpty(espCache)) candidates.Add(Path.Combine(espCache, "sources", "boot.wim"));
        if (!string.IsNullOrEmpty(dataRoot)) candidates.Add(Path.Combine(dataRoot, "sources", "boot.wim"));
        if (!string.IsNullOrEmpty(isoRoot)) candidates.Add(Path.Combine(isoRoot, "sources", "boot.wim"));

        foreach (var src in candidates)
        {
            if (!File.Exists(src)) continue;
            SafeCopyFile(src, espBootWim);
            if (File.Exists(espBootWim))
            {
                emit.Log(disk, $"esp-bootwim: copied sources\\boot.wim to ESP from '{src}'");
                return true;
            }
            emit.Log(disk, $"esp-bootwim: WARNING copy from '{src}' did not land on ESP (disk full or locked?)");
        }

        emit.Log(disk, "esp-bootwim: WARNING - no boot.wim source found; ESP will fail to boot (0xc000000f)");
        return false;
    }

    /// <summary>
    /// Verifies the ESP carries a complete, self-consistent UEFI WinPE boot chain and throws a
    /// descriptive <see cref="InvalidOperationException"/> otherwise. Catching an incomplete ESP at
    /// build time turns a silent, unbootable-USB (<c>0xc000000f</c>) into a hard build failure the
    /// operator can act on, and guards against the tolerant <see cref="SafeCopyFile"/> swallowing a
    /// disk-full/locked error on any of the required boot artifacts.
    /// </summary>
    public static void ValidateEspBootChain(string espRoot)
    {
        var missing = new List<string>();

        void RequireFile(string relPath, string description)
        {
            var full = Path.Combine(espRoot, relPath.Replace('\\', Path.DirectorySeparatorChar));
            if (!File.Exists(full)) { missing.Add($"{relPath} ({description})"); return; }
            try { if (new FileInfo(full).Length == 0) missing.Add($"{relPath} ({description}) is empty"); }
            catch { /* stat failure is non-fatal for the existence check */ }
        }

        RequireFile(@"sources\boot.wim", "WinPE ramdisk image referenced by the BCD");
        RequireFile(@"boot\boot.sdi", "ramdisk SDI referenced by {ramdiskoptions}");
        RequireFile(@"efi\microsoft\boot\bootmgfw.efi", "UEFI Windows Boot Manager");
        RequireFile(@"efi\microsoft\boot\BCD", "UEFI boot configuration store");

        if (missing.Count > 0)
            throw new InvalidOperationException(
                "ESP boot chain incomplete - USB would fail at boot with 0xc000000f. Missing/invalid: "
                + string.Join("; ", missing));
    }

    /// <summary>
    /// Rebuilds a fresh, partition-independent WinPE BCD on the ESP — the PROVEN sequence from
    /// <c>Invoke-LoneWolfBuild.ps1</c> (~lines 1300-1346). The Windows-Setup BCD copied off the ISO
    /// references the source media by a fixed device GUID; on a repartitioned USB that device no
    /// longer resolves, so bootmgr aborts with 0xc0000034 / 0xc000000f / 0xc0000098. Recreating the
    /// store with <c>device locate</c> and a <c>ramdisk=[boot]\sources\boot.wim</c> loader makes the
    /// chain resolve relative to whatever partition bootmgr loaded from (the ESP), independent of any
    /// GUID.
    ///
    /// IMPORTANT (regression guard): bcdedit identifier tokens (<c>{bootmgr}</c>, <c>{ramdiskoptions}</c>,
    /// and the parsed loader GUID) are passed WITHOUT surrounding quotes. <see cref="ProcessRunner"/>
    /// forwards the argument string to CreateProcess verbatim; wrapping the tokens in literal single
    /// quotes (as an earlier C# port did — <c>'{bootmgr}'</c>) makes bcdedit reject them with
    /// "The entry identifier specified is not valid." Only the store path and space-bearing
    /// descriptions are quoted.
    /// </summary>
    public static async Task RebuildEspBcd(string espRoot, JsonEventEmitter emit, int disk, CancellationToken ct)
    {
        var bcdDir = Path.Combine(espRoot, "EFI", "Microsoft", "Boot");
        var bcdPath = Path.Combine(bcdDir, "BCD");
        Directory.CreateDirectory(bcdDir);

        ClearFileAttributes(bcdPath);
        if (File.Exists(bcdPath))
        {
            try { File.Delete(bcdPath); }
            catch (Exception ex)
            {
                emit.Log(disk, $"bcd-build: WARNING could not delete existing BCD ({ex.Message}); createstore may fail");
            }
        }

        emit.Log(disk, $"bcd-build: creating fresh WinPE BCD at {bcdPath} ...");
        var q = $"\"{bcdPath}\"";

        async Task<ProcessResult> Bcd(string args) =>
            await ProcessRunner.RunAsync("bcdedit.exe", args, ct).ConfigureAwait(false);

        try
        {
            var r = await Bcd($"/createstore {q}").ConfigureAwait(false);
            if (r.ExitCode != 0)
                throw new InvalidOperationException($"bcdedit /createstore failed (exit {r.ExitCode}): {r.Output.Trim()}");

            r = await Bcd($"/store {q} /create {{bootmgr}} /d \"Windows Boot Manager\"").ConfigureAwait(false);
            if (r.ExitCode != 0)
                throw new InvalidOperationException($"bcdedit /create {{bootmgr}} failed (exit {r.ExitCode}): {r.Output.Trim()}");

            await Bcd($"/store {q} /set {{bootmgr}} device locate").ConfigureAwait(false);
            await Bcd($"/store {q} /set {{bootmgr}} path \\EFI\\Microsoft\\Boot\\bootmgfw.efi").ConfigureAwait(false);
            await Bcd($"/store {q} /set {{bootmgr}} timeout 0").ConfigureAwait(false);

            var wpe = await Bcd($"/store {q} /create /d \"Windows PE\" /application osloader").ConfigureAwait(false);
            if (wpe.ExitCode != 0)
                throw new InvalidOperationException($"bcdedit /create osloader failed (exit {wpe.ExitCode}): {wpe.Output.Trim()}");

            var m = System.Text.RegularExpressions.Regex.Match(wpe.Output, @"\{[0-9a-fA-F-]+\}");
            if (!m.Success)
                throw new InvalidOperationException($"Could not parse WinPE loader GUID from bcdedit output: {wpe.Output.Trim()}");
            var wpeGuid = m.Value;

            // Ramdisk device string has no spaces, so it is a single unquoted token.
            const string ramdisk = "ramdisk=[boot]\\sources\\boot.wim,{ramdiskoptions}";
            await Bcd($"/store {q} /set {wpeGuid} device {ramdisk}").ConfigureAwait(false);
            await Bcd($"/store {q} /set {wpeGuid} osdevice {ramdisk}").ConfigureAwait(false);
            await Bcd($"/store {q} /set {wpeGuid} path \\windows\\system32\\boot\\winload.efi").ConfigureAwait(false);
            await Bcd($"/store {q} /set {wpeGuid} systemroot \\windows").ConfigureAwait(false);
            await Bcd($"/store {q} /set {wpeGuid} winpe yes").ConfigureAwait(false);
            await Bcd($"/store {q} /set {wpeGuid} detecthal yes").ConfigureAwait(false);

            await Bcd($"/store {q} /set {{bootmgr}} displayorder {wpeGuid}").ConfigureAwait(false);
            await Bcd($"/store {q} /default {wpeGuid}").ConfigureAwait(false);

            r = await Bcd($"/store {q} /create {{ramdiskoptions}} /d \"Ramdisk Options\"").ConfigureAwait(false);
            if (r.ExitCode != 0)
                throw new InvalidOperationException($"bcdedit /create {{ramdiskoptions}} failed (exit {r.ExitCode}): {r.Output.Trim()}");
            await Bcd($"/store {q} /set {{ramdiskoptions}} ramdisksdidevice boot").ConfigureAwait(false);
            await Bcd($"/store {q} /set {{ramdiskoptions}} ramdisksdipath \\boot\\boot.sdi").ConfigureAwait(false);

            // Validate the store parses before we hand the operator an unbootable stick.
            var enumResult = await Bcd($"/store {q} /enum all").ConfigureAwait(false);
            if (enumResult.ExitCode != 0)
                throw new InvalidOperationException($"bcdedit /enum validation failed (exit {enumResult.ExitCode}): {enumResult.Output.Trim()}");
            if (!enumResult.Output.Contains("ramdisk", StringComparison.OrdinalIgnoreCase))
                emit.Log(disk, "bcd-build: WARNING /enum output did not mention the ramdisk loader — verify the store");

            emit.Log(disk, $"bcd-build: WinPE BCD created and validated (loader={wpeGuid})");
        }
        catch (Exception ex)
        {
            // Fatal: without a valid BCD the USB boots to 0xc0000034/0xc000000f. Surface it as a
            // build error (mirrors the intent of ValidateEspBootChain) rather than shipping a dud.
            emit.Log(disk, $"bcd-build: FAILED - {ex.Message}");
            throw new InvalidOperationException(
                $"BCD rebuild failed on ESP {espRoot} — USB would fail at boot (0xc0000034/0xc000000f): {ex.Message}", ex);
        }
    }

    public static void CopyDirectory(string source, string dest, bool excludeInstallImages = false)
    {
        Directory.CreateDirectory(dest);
        foreach (var entry in Directory.GetFileSystemEntries(source))
        {
            var name = Path.GetFileName(entry);
            if (name is "System Volume Information" or "$RECYCLE.BIN") continue;
            var destPath = Path.Combine(dest, name);
            if (Directory.Exists(entry))
                CopyDirectory(entry, destPath, excludeInstallImages);
            else
            {
                if (excludeInstallImages && name.EndsWith(".wim", StringComparison.OrdinalIgnoreCase)) continue;
                SafeCopyFile(entry, destPath);
            }
        }
    }

    /// <summary>
    /// Clears ReadOnly/Hidden/System attributes on <paramref name="path"/> so it can be
    /// overwritten or deleted. Best-effort — swallows failures. Stale files copied off an
    /// ISO (e.g. autorun.inf, bootmgr) commonly carry these attributes and otherwise cause
    /// File.Copy(overwrite:true) to throw UnauthorizedAccessException.
    /// </summary>
    public static void ClearFileAttributes(string path)
    {
        try
        {
            if (File.Exists(path))
                File.SetAttributes(path, FileAttributes.Normal);
        }
        catch { /* best-effort */ }
    }

    /// <summary>
    /// Copies a single file with overwrite semantics, first clearing protective attributes on
    /// the destination so a stale read-only/hidden/system file (e.g. an autorun.inf left from a
    /// prior ISO-sourced run) does not abort the copy. Individual unrecoverable failures are
    /// logged-as-skipped rather than thrown, matching the tolerant copy convention used across
    /// the provisioner.
    /// </summary>
    public static void SafeCopyFile(string source, string dest)
    {
        var parent = Path.GetDirectoryName(dest);
        if (!string.IsNullOrEmpty(parent)) Directory.CreateDirectory(parent);
        ClearFileAttributes(dest);
        try
        {
            File.Copy(source, dest, overwrite: true);
        }
        catch (UnauthorizedAccessException)
        {
            // Retry once after a harder attribute clear; skip if still protected/locked.
            ClearFileAttributes(dest);
            try { File.Copy(source, dest, overwrite: true); } catch { /* skip protected file (e.g. autorun.inf) */ }
        }
        catch (IOException)
        {
            // Locked/in-use destination — skip rather than aborting the whole build.
        }
    }
}
