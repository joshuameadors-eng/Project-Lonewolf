using System.Security.Cryptography;
using System.Text.Json;
using LoneWolf.Provisioner.Debug;
using LoneWolf.Provisioner.Disks;
using LoneWolf.Provisioner.Share;
using LoneWolf.Provisioner.Events;
using LoneWolf.Provisioner.Imaging;
using LoneWolf.Provisioner.Profiles;

namespace LoneWolf.Provisioner.Engine;

public sealed class BuildContext
{
    public required WorkflowProfile Profile { get; init; }
    public required string WorkflowType { get; init; }
    public required string AppResourcesPath { get; init; }
    public required string CacheRoot { get; init; }
    public required string ContentRoot { get; init; }
    public required string OverlayCache { get; init; }
    public required string EspCache { get; init; }
    public required string StagingVersion { get; init; }
    public bool DevBuild { get; init; }
    public string? LauncherVersion { get; init; }
    public string? ScriptVersion { get; init; }
    public string? ShareLauncherVersion { get; init; }
    public string? ShareScriptVersion { get; init; }
    public string? ImageBuildDate { get; init; }
    public string? SharedWimMount { get; set; }
    public long SharedWimSourceBytes { get; set; }
    public string? StagingWindowsDir { get; set; }
    public string? IsoDriveLetter { get; set; }
    public string StartnetPath { get; init; } = "";
    public string? WpeOcPath { get; init; }
    public bool UseIsoMode { get; init; }
    public bool NoPayload => Profile.NoPayload;
    public IsoWriteKind IsoWriteKind { get; set; }
    public string? IsoFilePath { get; set; }
}

public sealed class BuildEngine
{
    private readonly JsonEventEmitter _emit = new();
    private readonly DismRunner _dism = new();

    public async Task<int> RunAsync(BuildOptions opts, CancellationToken ct)
    {
        var profile = WorkflowProfileRegistry.Get(opts.WorkflowType);
        var cacheRoot = opts.CacheRoot ?? Path.Combine(ProvisioningConstants.CacheRootBase, profile.CacheSuffix);
        var espCache = Path.Combine(cacheRoot, "esp");
        var overlayCache = Path.Combine(cacheRoot, "overlay");

        var contentRoot = Path.Combine(opts.AppResourcesPath, "payload");
        if (!Directory.Exists(contentRoot))
            contentRoot = opts.AppResourcesPath;

        Directory.CreateDirectory(espCache);
        Directory.CreateDirectory(overlayCache);

        var stagingVersion = ReadPayloadVersion(opts);
        var stagingRoot = GetStagingRoot(opts);
        var stagingWindowsDir = Path.Combine(stagingRoot, profile.Arch ?? "AMD64");
        string? imageBuildDate = null;
        if (!string.IsNullOrWhiteSpace(opts.ResolvedSource.IsoPath) && File.Exists(opts.ResolvedSource.IsoPath))
            imageBuildDate = File.GetLastWriteTimeUtc(opts.ResolvedSource.IsoPath).ToString("yyyy-MM-dd");

        var ctx = new BuildContext
        {
            Profile = profile,
            WorkflowType = opts.WorkflowType.ToUpperInvariant(),
            AppResourcesPath = opts.AppResourcesPath,
            CacheRoot = cacheRoot,
            ContentRoot = contentRoot,
            OverlayCache = overlayCache,
            EspCache = espCache,
            StagingVersion = stagingVersion,
            DevBuild = opts.DevBuild,
            LauncherVersion = opts.LauncherVersion,
            ScriptVersion = opts.ScriptVersion,
            ShareLauncherVersion = opts.ShareLauncherVersion,
            ShareScriptVersion = opts.ShareScriptVersion,
            ImageBuildDate = imageBuildDate,
            StagingWindowsDir = Directory.Exists(stagingWindowsDir) ? stagingWindowsDir : null,
            StartnetPath = Path.Combine(contentRoot, "Deploy", "WinPE-Startnet.cmd"),
            WpeOcPath = opts.WpeOcPath,
            UseIsoMode = opts.ResolvedSource.UseIsoMode
        };

        _emit.Emit(new Dictionary<string, object?>
        {
            ["event"] = "init",
            ["workflowType"] = ctx.WorkflowType,
            ["diskNumbers"] = opts.DiskNumbers,
            ["sequential"] = opts.Sequential
        });

        // Surface which media source was auto-selected (ISO preferred over staged WIM for
        // lonewolf/win-install) so the operator can see the chosen source and why in the log.
        if (!string.IsNullOrEmpty(opts.ResolvedSource.SelectionReason))
            _emit.Log(0, opts.ResolvedSource.SelectionReason!);

        IsoMountHelper? isoMount = null;
        try
        {
            if (profile.ProvisionMode == "vendor-iso")
            {
                var isoFile = opts.ResolvedSource.IsoPath
                    ?? throw new InvalidOperationException("No ISO selected. Pick a local ISO or a share ISO.");
                ctx.IsoFilePath = isoFile;
                var header = IsoMediaKind.InspectFile(isoFile);
                ctx.IsoWriteKind = IsoMediaKind.Plan(header, windowsLayout: false);

                if (ctx.IsoWriteKind != IsoWriteKind.HybridDd)
                {
                    try
                    {
                        isoMount = new IsoMountHelper();
                        ctx.IsoDriveLetter = await isoMount.MountAsync(isoFile, _emit, 0, ct).ConfigureAwait(false);
                        var win = IsoMediaKind.LooksLikeWindowsInstallerLayout(ctx.IsoDriveLetter + "\\");
                        ctx.IsoWriteKind = IsoMediaKind.Plan(header, win);
                    }
                    catch (Exception ex)
                    {
                        _emit.Log(0, "iso-mount: Windows did not expose a drive letter (" + SanitizeAscii(ex.Message) + "). Using raw ISO write.");
                        ctx.IsoWriteKind = IsoWriteKind.RawDd;
                        isoMount?.Dispose();
                        isoMount = null;
                        ctx.IsoDriveLetter = null;
                    }
                }

                _emit.Log(0, "media-creator: write mode " + ctx.IsoWriteKind);

                if (ctx.IsoWriteKind is IsoWriteKind.HybridDd or IsoWriteKind.RawDd)
                {
                    isoMount?.Dispose();
                    isoMount = null;
                    ctx.IsoDriveLetter = null;
                }
            }
            else if (opts.ResolvedSource.UseIsoMode && opts.ResolvedSource.IsoPath != null)
            {
                isoMount = new IsoMountHelper();
                ctx.IsoDriveLetter = await isoMount.MountAsync(opts.ResolvedSource.IsoPath, _emit, 0, ct).ConfigureAwait(false);
                _emit.Emit(new Dictionary<string, object?> { ["event"] = "iso-mode", ["disk"] = 0, ["isoFile"] = Path.GetFileName(opts.ResolvedSource.IsoPath) });
            }
            else if (!opts.OverlayOnly && !opts.PreCacheOnly && opts.ResolvedSource.WimPath != null)
            {
                await PrepareSharedWimMountAsync(ctx, opts.ResolvedSource.WimPath, ct).ConfigureAwait(false);
            }

            if (!opts.OverlayOnly && profile.ProvisionMode != "vendor-iso")
            {
                if (!(profile.NoPayload && ctx.IsoDriveLetter != null))
                {
                    await BuildEspCacheAsync(ctx, ct).ConfigureAwait(false);
                    // Overlay content (TechInstall.cmd, WUPayload scripts, etc.) is cheap
                    // text/script data with no relation to the ESP boot.wim/bootmgfw.efi
                    // freshness check inside BuildEspCacheAsync. Always rebuild it here so
                    // payload source edits are picked up on every build, even when the
                    // (large, slow) ESP cache is still within its freshness window and its
                    // internal rebuild â€” including its own overlay refresh â€” gets skipped.
                    await BuildOverlayCacheAsync(ctx, ct).ConfigureAwait(false);
                }
            }
            else if (opts.OverlayOnly && profile.ProvisionMode != "vendor-iso")
            {
                await BuildOverlayCacheAsync(ctx, ct).ConfigureAwait(false);
            }

            if (opts.PreCacheOnly)
            {
                _emit.Done(0, true, "Pre-cache complete");
                return 0;
            }

            var succeeded = new List<int>();
            var failed = new List<int>();

            if (opts.Sequential)
            {
                foreach (var disk in opts.DiskNumbers)
                {
                    var ok = await WriteDiskAsync(disk, ctx, opts, ct).ConfigureAwait(false);
                    if (ok) succeeded.Add(disk); else failed.Add(disk);
                }
            }
            else
            {
                var tasks = opts.DiskNumbers.Select(async disk =>
                {
                    try
                    {
                        var ok = await WriteDiskAsync(disk, ctx, opts, ct).ConfigureAwait(false);
                        return (disk, ok);
                    }
                    catch
                    {
                        return (disk, false);
                    }
                });
                var results = await Task.WhenAll(tasks).ConfigureAwait(false);
                foreach (var (disk, ok) in results)
                {
                    if (ok) succeeded.Add(disk); else failed.Add(disk);
                }
            }

            _emit.Summary(succeeded.ToArray(), failed.ToArray());
            _emit.Exit(failed.Count > 0 ? 1 : 0);
            return failed.Count > 0 ? 1 : 0;
        }
        finally
        {
            await CleanupSharedWimAsync(ctx, ct).ConfigureAwait(false);
            isoMount?.Dispose();
        }
    }

    private async Task<bool> WriteDiskAsync(int diskNumber, BuildContext ctx, BuildOptions opts, CancellationToken ct)
    {
        _emit.Start(diskNumber, ctx.WorkflowType);
        try
        {
            if (opts.OverlayOnly)
            {
                await OverlayUpdateAsync(diskNumber, ctx, ct).ConfigureAwait(false);
            }
            else if (ctx.Profile.ProvisionMode == "vendor-iso")
            {
                await VendorIsoWriteAsync(diskNumber, ctx, ct).ConfigureAwait(false);
            }
            else
            {
                await FullBuildAsync(diskNumber, ctx, opts, ct).ConfigureAwait(false);
            }

            _emit.Done(diskNumber, true);
            return true;
        }
        catch (Exception ex)
        {
            _emit.Error(diskNumber, ex.Message, "BUILD_FAILED");
            _emit.Done(diskNumber, false, ex.Message);
            return false;
        }
    }

    private async Task VendorIsoWriteAsync(int diskNumber, BuildContext ctx, CancellationToken ct)
    {
        var isoFile = ctx.IsoFilePath
            ?? throw new InvalidOperationException("No ISO file path for Media Creator.");
        var isoLen = new FileInfo(isoFile).Length;
        await UsbTargetGuard.AssertWritableUsbAsync(diskNumber, isoLen, ct).ConfigureAwait(false);

        if (ctx.IsoWriteKind is IsoWriteKind.HybridDd or IsoWriteKind.RawDd)
        {
            try
            {
                await IsoDiskWriter.WriteRawAsync(isoFile, diskNumber, _emit, ct).ConfigureAwait(false);
            }
            catch (Exception ex)
            {
                throw new InvalidOperationException(
                    "Raw ISO write failed. This image may not be a hybrid/dd ISO (for example macOS restore images). " +
                    SanitizeAscii(ex.Message));
            }
            _emit.Phase(diskNumber, "done");
            return;
        }

        if (string.IsNullOrWhiteSpace(ctx.IsoDriveLetter))
            throw new InvalidOperationException("Windows installer ISO could not be mounted. Close other mounts and retry.");

        // Windows installer ISO that is not hybrid: ESP + NTFS data (install.wim stays whole
        // on NTFS, no SWM split). ESP must be large enough for boot.wim.
        var isoRoot = ctx.IsoDriveLetter + "\\";
        var espBytes = VendorIsoEspBytes(isoRoot);
        _emit.Log(diskNumber, $"vendor-iso: ESP size {espBytes / (1024 * 1024)} MB (boot.wim + headroom)");

        var (espRoot, dataRoot) = await DiskPartitioner.PartitionUsbAsync(
            diskNumber, espBytes, ProvisioningConstants.DataVolumeLabel, _emit, ct).ConfigureAwait(false);

        _emit.Phase(diskNumber, "esp-copy");
        CopyIsoBootToEsp(isoRoot, espRoot);
        DiskPartitioner.EnsureEspBootWim(espRoot, dataRoot, isoRoot, null, _emit, diskNumber);
        DiskPartitioner.EnsureEspBootChain(espRoot, _emit, diskNumber);

        // ISO BCD binds to the optical-media device GUID. Recreate a locate-relative
        // ramdisk BCD so UEFI boots after repartition (same sequence as FullBuild).
        _emit.Phase(diskNumber, "bcd-build");
        await DiskPartitioner.RebuildEspBcd(espRoot, _emit, diskNumber, ct).ConfigureAwait(false);
        DiskPartitioner.ValidateEspBootChain(espRoot);

        _emit.Phase(diskNumber, "data-copy");
        _emit.Progress(diskNumber, "data-copy", 0);
        var rc = await ProcessRunner.RobocopyWithProgressAsync(
            isoRoot,
            dataRoot,
            "/E /R:1 /W:1 /NP /NJH /NJS",
            pctMin: 0,
            pctMax: 98,
            pct => _emit.Progress(diskNumber, "data-copy", pct),
            ct,
            reportLog: msg => _emit.Log(diskNumber, msg)).ConfigureAwait(false);
        if (!ProcessRunner.IsRobocopySuccess(rc))
            throw new InvalidOperationException($"robocopy vendor ISO failed (exit {rc})");
        _emit.Progress(diskNumber, "data-copy", 100);

        _emit.Phase(diskNumber, "done");
    }

    /// <summary>
    /// ESP must hold boot.wim + boot.sdi + EFI loaders. Floor 2 GiB so typical WinPE
    /// images fit; cap 4 GiB so the data partition still has room for install.wim.
    /// </summary>
    private static long VendorIsoEspBytes(string isoRoot)
    {
        long need = 80L * 1024 * 1024;
        try
        {
            var bootWim = Path.Combine(isoRoot, "sources", "boot.wim");
            if (File.Exists(bootWim)) need += new FileInfo(bootWim).Length;
            var sdi = Path.Combine(isoRoot, "boot", "boot.sdi");
            if (File.Exists(sdi)) need += new FileInfo(sdi).Length;
        }
        catch { /* size from ISO is best-effort */ }
        need = (long)(need * 1.25) + (64L * 1024 * 1024);
        const long min = 2L * 1024 * 1024 * 1024;
        const long max = 4L * 1024 * 1024 * 1024;
        if (need < min) return min;
        if (need > max) return max;
        return need;
    }

    private async Task FullBuildAsync(int diskNumber, BuildContext ctx, BuildOptions opts, CancellationToken ct)
    {
        // 2 GiB ESP: must hold sources\boot.wim (a WinPE image with drivers is commonly 700 MB-1.5 GB;
        // the current media boot.wim is ~818 MB) plus the boot loaders/fonts (~50 MB) and enough
        // headroom for DISM startnet-injection to rewrite boot.wim on commit. A 1 GiB ESP left only
        // ~150 MB free after boot.wim, risking a silent disk-full that reproduces the 0xc000000f boot
        // failure this build path is meant to prevent. Legacy Invoke-LoneWolfBuild.ps1 sized the ESP
        // to (measured boot files + 20% headroom), which for this media rounds to ~1.5 GB.
        var espBytes = 2L * 1024 * 1024 * 1024;
        var (espRoot, dataRoot) = await DiskPartitioner.PartitionUsbAsync(
            diskNumber, espBytes, ProvisioningConstants.DataVolumeLabel, _emit, ct).ConfigureAwait(false);

        _emit.Phase(diskNumber, "esp-copy");

        if (ctx.NoPayload && ctx.IsoDriveLetter != null)
            CopyIsoBootToEsp(ctx.IsoDriveLetter + "\\", espRoot);
        else
            DiskPartitioner.CopyDirectory(ctx.EspCache, espRoot);

        DiskPartitioner.EnsureEspBootChain(espRoot, _emit, diskNumber);

        if (ctx.IsoDriveLetter != null && (ctx.UseIsoMode || ctx.NoPayload))
        {
            _emit.Phase(diskNumber, "data-copy");
            _emit.Progress(diskNumber, "data-copy", 0);
            var isoRoot = ctx.IsoDriveLetter + "\\";
            var rc = await ProcessRunner.RobocopyWithProgressAsync(
                isoRoot,
                dataRoot,
                "/E /R:1 /W:1 /NP /NJH /NJS",
                pctMin: 0,
                pctMax: 98,
                pct => _emit.Progress(diskNumber, "data-copy", pct),
                ct,
                reportLog: msg => _emit.Log(diskNumber, msg)).ConfigureAwait(false);
            if (!ProcessRunner.IsRobocopySuccess(rc))
                throw new InvalidOperationException($"robocopy ISO to data failed (exit {rc})");
            _emit.Progress(diskNumber, "data-copy", 100);
            await ClearIsoBootArtifactAttributesAsync(dataRoot, diskNumber, ct).ConfigureAwait(false);
        }
        else if (ctx.SharedWimMount != null)
        {
            _emit.Phase(diskNumber, "dism");
            _emit.Progress(diskNumber, "dism", 0);
            _emit.Log(diskNumber, $"wim-shared: robocopy from shared mount {ctx.SharedWimMount} -> {dataRoot}");

            // #region agent log
            var (_, refreshedData) = await DiskPartitioner.FindPartitionLettersAsync(diskNumber, ct).ConfigureAwait(false);
            long srcFileCount = 0, srcBytes = 0;
            try
            {
                if (Directory.Exists(ctx.SharedWimMount))
                {
                    foreach (var f in Directory.EnumerateFiles(ctx.SharedWimMount, "*", SearchOption.AllDirectories))
                    {
                        srcFileCount++;
                        srcBytes += new FileInfo(f).Length;
                    }
                }
            }
            catch { /* ignore */ }
            var destWritable = false;
            try
            {
                if (Directory.Exists(dataRoot))
                {
                    var probe = Path.Combine(dataRoot, $".lw-write-probe-{Guid.NewGuid():N}");
                    File.WriteAllText(probe, "ok");
                    File.Delete(probe);
                    destWritable = true;
                }
            }
            catch { /* ignore */ }
            DbgLog.Write(
                "BuildEngine.cs:FullBuildAsync:pre-robocopy",
                "WIM robocopy preflight",
                new
                {
                    diskNumber,
                    sharedWimMount = ctx.SharedWimMount,
                    sharedWimMountEndsWithSlash = ctx.SharedWimMount.EndsWith('\\'),
                    sharedWimMountExists = Directory.Exists(ctx.SharedWimMount),
                    srcFileCount,
                    srcBytes,
                    dataRoot,
                    dataRootExists = Directory.Exists(dataRoot),
                    refreshedDataRoot = refreshedData,
                    dataRootMatchesRefreshed = string.Equals(dataRoot, refreshedData, StringComparison.OrdinalIgnoreCase),
                    destWritable
                },
                "H1,H2,H3,H4");
            // #endregion

            var rc = await ProcessRunner.RobocopyWithProgressAsync(
                ctx.SharedWimMount,
                dataRoot,
                "/E /COPY:DAT /DCOPY:DAT /R:1 /W:2 /NP /NJH /NJS",
                pctMin: 0,
                pctMax: 98,
                pct => _emit.Progress(diskNumber, "dism", pct),
                ct,
                sourceBytes: ctx.SharedWimSourceBytes,
                reportLog: msg => _emit.Log(diskNumber, msg)).ConfigureAwait(false);
            if (!ProcessRunner.IsRobocopySuccess(rc))
                throw new InvalidOperationException($"robocopy WIM mount failed (exit {rc})");
            _emit.Log(diskNumber, $"wim-shared: robocopy complete (exit {rc})");
            _emit.Progress(diskNumber, "dism", 100);
            await ClearIsoBootArtifactAttributesAsync(dataRoot, diskNumber, ct).ConfigureAwait(false);
            PopulateEspFromData(espRoot, dataRoot, diskNumber);
            DiskPartitioner.EnsureEspBootChain(espRoot, _emit, diskNumber);
        }

        var (latestEsp, latestData) = await DiskPartitioner.FindPartitionLettersAsync(diskNumber, ct).ConfigureAwait(false);
        if (latestEsp != null) espRoot = latestEsp;
        if (latestData != null) dataRoot = latestData;

        // Guarantee the WinPE image is on the ESP BEFORE startnet-injection. The BCD copied from the
        // media points its ramdisk at [boot]\sources\boot.wim (the boot volume = ESP); without this
        // file the USB fails at boot with 0xc000000f. The staging-sourced ESP cache often lacks
        // boot.wim and PopulateEspFromData intentionally skips *.wim, so copy it here (cache -> data
        // -> ISO). InjectWinPeAsync then injects the custom startnet.cmd into this ESP boot.wim.
        var isoRootForWim = ctx.IsoDriveLetter != null ? ctx.IsoDriveLetter + "\\" : null;
        DiskPartitioner.EnsureEspBootWim(espRoot, dataRoot, isoRootForWim, ctx.EspCache, _emit, diskNumber);

        await InjectWinPeAsync(diskNumber, espRoot, ctx, ct).ConfigureAwait(false);

        if (ctx.NoPayload && ctx.IsoDriveLetter != null)
            await CopyWinInstallDeployFilesAsync(diskNumber, dataRoot, ctx, ct).ConfigureAwait(false);
        else
            await ApplyOverlayAsync(diskNumber, espRoot, dataRoot, ctx, ct).ConfigureAwait(false);

        await ClearIsoBootArtifactAttributesAsync(dataRoot, diskNumber, ct).ConfigureAwait(false);

        // Fresh, partition-independent WinPE BCD on the ESP â€” the PROVEN per-disk bcdedit /createstore
        // rebuild from Invoke-LoneWolfBuild.ps1. Replaces the Windows-Setup BCD copied off the ISO
        // (whose fixed device GUID does not resolve on the repartitioned USB â†’ 0xc0000034/0xc000000f).
        // Runs per disk (each edits its own ESP's store file, so this is parallel-safe) after the
        // boot files (bootmgfw.efi / boot.wim / boot.sdi) are guaranteed present above.
        _emit.Phase(diskNumber, "bcd-build");
        await DiskPartitioner.RebuildEspBcd(espRoot, _emit, diskNumber, ct).ConfigureAwait(false);

        await WriteVersionStampAsync(dataRoot, ctx, diskNumber, opts.OverlayOnly, ct).ConfigureAwait(false);

        // Fail loudly if the ESP boot chain is incomplete rather than shipping a stick that dies at
        // boot with 0xc000000f. Validated last so any earlier step that failed to place boot.wim,
        // boot.sdi, bootmgfw.efi, or the BCD (e.g. a swallowed disk-full copy) surfaces as a build error.
        DiskPartitioner.ValidateEspBootChain(espRoot);
    }

    private async Task CopyWinInstallDeployFilesAsync(int diskNumber, string dataRoot, BuildContext ctx, CancellationToken ct)
    {
        await Task.Run(() =>
        {
            var autounattendInstall = Path.Combine(ctx.ContentRoot, "Policy", "autounattend-install.xml");
            var autounattendSrc = File.Exists(autounattendInstall)
                ? autounattendInstall
                : Path.Combine(ctx.ContentRoot, "Policy", "autounattend.xml");
            var firstBaseRoot = Path.Combine(dataRoot, "FirstBase");
            if (File.Exists(autounattendSrc))
            {
                Directory.CreateDirectory(firstBaseRoot);
                File.Copy(autounattendSrc, Path.Combine(firstBaseRoot, "Autounattend.xml"), overwrite: true);
                Directory.CreateDirectory(Path.Combine(firstBaseRoot, "Policy"));
                File.Copy(autounattendSrc, Path.Combine(firstBaseRoot, "Policy", "Autounattend.xml"), overwrite: true);
                _emit.Log(diskNumber, "WIN-INSTALL: copied Autounattend.xml to FirstBase\\ and FirstBase\\Policy\\");
            }
            else
            {
                _emit.Log(diskNumber, $"WIN-INSTALL: WARNING - autounattend.xml not found at '{autounattendSrc}'");
            }

            var deployDir = Path.Combine(firstBaseRoot, "Deploy");
            Directory.CreateDirectory(deployDir);

            var techInstall = Path.Combine(ctx.ContentRoot, "Deploy", ctx.Profile.TechInstallScript);
            if (File.Exists(techInstall))
            {
                File.Copy(techInstall, Path.Combine(deployDir, "TechInstall.cmd"), overwrite: true);
                _emit.Log(diskNumber, "WIN-INSTALL: copied TechInstall-Install.cmd to FirstBase\\Deploy\\TechInstall.cmd");
            }

            foreach (var deployFile in new[] { "WinPE-Startnet.cmd", "disksetup.cmd", "Show-DeployBanner.ps1", "Invoke-FbDeployUi.ps1" })
            {
                var src = Path.Combine(ctx.ContentRoot, "Deploy", deployFile);
                if (!File.Exists(src)) continue;
                File.Copy(src, Path.Combine(deployDir, deployFile), overwrite: true);
                _emit.Log(diskNumber, $"WIN-INSTALL: copied {deployFile} to FirstBase\\Deploy\\{deployFile}");
            }

            var peFontDstDir = Path.Combine(deployDir, "Fonts");
            Directory.CreateDirectory(peFontDstDir);
            var peFontDst = Path.Combine(peFontDstDir, "cascadiamono.ttf");
            var peFontCandidates = new[]
            {
                Path.Combine(ctx.ContentRoot, "Deploy", "Fonts", "cascadiamono.ttf"),
                Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.Windows), "Fonts", "cascadiamono.ttf"),
                Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.Windows), "Fonts", "CascadiaMono.ttf"),
                Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.Windows), "Fonts", "CascadiaMonoPL.ttf"),
            };
            var peFontSrc = Array.Find(peFontCandidates, File.Exists);
            if (peFontSrc != null)
            {
                File.Copy(peFontSrc, peFontDst, overwrite: true);
                _emit.Log(diskNumber, "WIN-INSTALL: staged WinPE Braille font to FirstBase\\Deploy\\Fonts\\cascadiamono.ttf");
            }

            // fb-im front-end: cmd launcher at volume ROOT; PS backend + fb-dump backend under FirstBase\WUPayload\Tools\.
            var toolsDir = Path.Combine(firstBaseRoot, "WUPayload", "Tools");
            var imCmd = Path.Combine(ctx.ContentRoot, "Tools", "fb-im.cmd");
            if (File.Exists(imCmd))
                File.Copy(imCmd, Path.Combine(dataRoot, "fb-im.cmd"), overwrite: true);
            foreach (var toolFile in new[] { "fb-im.ps1", "fb-dump.ps1" })
            {
                var src = Path.Combine(ctx.ContentRoot, "Tools", toolFile);
                if (!File.Exists(src)) continue;
                Directory.CreateDirectory(toolsDir);
                File.Copy(src, Path.Combine(toolsDir, toolFile), overwrite: true);
            }

            var logDir = Path.Combine(firstBaseRoot, "FirstBase-UsbLogs");
            Directory.CreateDirectory(logDir);
            File.WriteAllText(
                Path.Combine(logDir, "FirstBase-Layout.txt"),
                "Layout=Split\r\nBuilder=LoneWolf.Provisioner\r\n");
        }, ct).ConfigureAwait(false);
    }

    private async Task OverlayUpdateAsync(int diskNumber, BuildContext ctx, CancellationToken ct)
    {
        _emit.Phase(diskNumber, "overlay-update");
        var (esp, data) = await DiskPartitioner.FindPartitionLettersAsync(diskNumber, ct).ConfigureAwait(false);
        if (data == null)
            throw new InvalidOperationException($"No data partition on disk {diskNumber}");
        await ApplyOverlayAsync(diskNumber, esp, data, ctx, ct).ConfigureAwait(false);
        await WriteVersionStampAsync(data, ctx, diskNumber, overlayOnly: true, ct).ConfigureAwait(false);
    }

    private async Task ApplyOverlayAsync(int diskNumber, string? espRoot, string dataRoot, BuildContext ctx, CancellationToken ct)
    {
        _emit.Phase(diskNumber, "overlay");
        await Task.Run(() =>
        {
            // Data partition first â€” carries install.wim, Scripts\, and full WUPayload\.
            ApplyOverlayCacheToPartition(ctx.OverlayCache, dataRoot, skipWuPayload: false);

            if (!string.IsNullOrEmpty(espRoot))
                ApplyOverlayCacheToPartition(ctx.OverlayCache, espRoot, skipWuPayload: true);

            var dismApply = Path.Combine(dataRoot, "FirstBase", "Deploy", "Invoke-FirstBaseDismApply.ps1");
            var wuPayloadDir = Path.Combine(dataRoot, "FirstBase", "WUPayload");
            var wuPayloadFiles = Directory.Exists(wuPayloadDir)
                ? Directory.EnumerateFiles(wuPayloadDir, "*", SearchOption.AllDirectories).Count()
                : 0;
            _emit.Log(diskNumber,
                $"overlay: FirstBase\\Deploy\\Invoke-FirstBaseDismApply.ps1={(File.Exists(dismApply) ? "ok" : "MISSING")}; WUPayload files={wuPayloadFiles}");
        }, ct).ConfigureAwait(false);
    }

    private static void ApplyOverlayCacheToPartition(string overlayCache, string partRoot, bool skipWuPayload)
    {
        if (!Directory.Exists(overlayCache)) return;
        foreach (var entry in Directory.GetFileSystemEntries(overlayCache))
        {
            var name = Path.GetFileName(entry);
            if (string.IsNullOrEmpty(name)) continue;

            var dst = Path.Combine(partRoot, name);
            if (Directory.Exists(entry))
            {
                // WUPayload now lives under FirstBase\; when staging the small ESP we copy
                // the FirstBase tree but omit its large WUPayload subtree.
                if (skipWuPayload && name.Equals("FirstBase", StringComparison.OrdinalIgnoreCase))
                {
                    Directory.CreateDirectory(dst);
                    foreach (var sub in Directory.GetFileSystemEntries(entry))
                    {
                        var subName = Path.GetFileName(sub);
                        if (string.IsNullOrEmpty(subName)) continue;
                        if (subName.Equals("WUPayload", StringComparison.OrdinalIgnoreCase)) continue;
                        var subDst = Path.Combine(dst, subName);
                        if (Directory.Exists(sub))
                            DiskPartitioner.CopyDirectory(sub, subDst);
                        else
                            DiskPartitioner.SafeCopyFile(sub, subDst);
                    }
                    continue;
                }
                DiskPartitioner.CopyDirectory(entry, dst);
            }
            else
                DiskPartitioner.SafeCopyFile(entry, dst);
        }

        var logDir = Path.Combine(partRoot, "FirstBase", "FirstBase-UsbLogs");
        Directory.CreateDirectory(logDir);
        File.WriteAllText(
            Path.Combine(logDir, "FirstBase-Layout.txt"),
            "Layout=Split\r\nBuilder=LoneWolf.Provisioner\r\n");
    }

    private static void CopyOverlayPayloadFile(string contentRoot, string overlayCache, string srcRel, string dstRel)
    {
        var src = Path.Combine(contentRoot, srcRel);
        if (!File.Exists(src)) return;
        var dst = Path.Combine(overlayCache, dstRel);
        var parent = Path.GetDirectoryName(dst);
        if (!string.IsNullOrEmpty(parent))
            Directory.CreateDirectory(parent);
        File.Copy(src, dst, overwrite: true);
    }

    private static readonly (string Src, string Dst)[] FullOverlayMap =
    {
        ("Deploy\\TechInstall.cmd", "FirstBase\\Deploy\\TechInstall.cmd"),
        ("Deploy\\disksetup.cmd", "FirstBase\\Deploy\\disksetup.cmd"),
        ("Deploy\\Invoke-FirstBaseRaidProbe.ps1", "FirstBase\\Deploy\\Invoke-FirstBaseRaidProbe.ps1"),
        ("Deploy\\WinPE-Startnet.cmd", "FirstBase\\Deploy\\WinPE-Startnet.cmd"),
        ("Deploy\\Show-DeployBanner.ps1", "FirstBase\\Deploy\\Show-DeployBanner.ps1"),
        ("Deploy\\Invoke-FbDeployUi.ps1", "FirstBase\\Deploy\\Invoke-FbDeployUi.ps1"),
        // Shared dev/release resolver. Needed in Deploy\ for the WinPE banner and
        // deploy screen, and in WUPayload\ so TechInstall can stage it to the device
        // for the splashes and fb-im. Both surfaces default to release without it.
        ("FirstBaseBuildIdentity.ps1", "FirstBase\\Deploy\\FirstBaseBuildIdentity.ps1"),
        ("FirstBaseBuildIdentity.ps1", "FirstBase\\WUPayload\\FirstBaseBuildIdentity.ps1"),
        ("Scripts\\Invoke-FirstBaseDismApply.ps1", "FirstBase\\Deploy\\Invoke-FirstBaseDismApply.ps1"),
        ("Policy\\autounattend.xml", "FirstBase\\Autounattend.xml"),
        ("Policy\\autounattend.xml", "FirstBase\\Policy\\Autounattend.xml"),
        ("SetupComplete.cmd", "FirstBase\\WUPayload\\SetupComplete.cmd"),
        ("Invoke-WindowsUpdateLoop.ps1", "FirstBase\\WUPayload\\Invoke-WindowsUpdateLoop.ps1"),
        ("Tools\\fb-dump.ps1", "FirstBase\\WUPayload\\Tools\\fb-dump.ps1"),
        ("Tools\\fb-im.cmd", "fb-im.cmd"),
        ("Tools\\fb-im.ps1", "FirstBase\\WUPayload\\Tools\\fb-im.ps1"),
        ("FirstBaseDebugHotkeyWatcher.ps1", "FirstBase\\WUPayload\\FirstBaseDebugHotkeyWatcher.ps1"),
        ("FirstBaseDeferredOobeSound.ps1", "FirstBase\\WUPayload\\FirstBaseDeferredOobeSound.ps1"),
        ("FirstBaseHandoffSplash.ps1", "FirstBase\\WUPayload\\FirstBaseHandoffSplash.ps1"),
        ("FirstBaseOobeDeferredSoundBootstrap.ps1", "FirstBase\\WUPayload\\FirstBaseOobeDeferredSoundBootstrap.ps1"),
        ("FirstBaseOobeOperatorFinalize.ps1", "FirstBase\\WUPayload\\FirstBaseOobeOperatorFinalize.ps1"),
        ("FirstBaseOpenSettingsAndFinish.ps1", "FirstBase\\WUPayload\\FirstBaseOpenSettingsAndFinish.ps1"),
        ("FirstBasePostSysprepOobeSoundArm.ps1", "FirstBase\\WUPayload\\FirstBasePostSysprepOobeSoundArm.ps1"),
        ("FirstBaseShowSplash.ps1", "FirstBase\\WUPayload\\FirstBaseShowSplash.ps1"),
        ("FirstBaseSplashSingleInstance.ps1", "FirstBase\\WUPayload\\FirstBaseSplashSingleInstance.ps1"),
        ("FirstBaseSplashWatcher.ps1", "FirstBase\\WUPayload\\FirstBaseSplashWatcher.ps1"),
        ("FirstBaseVersion.cmd", "FirstBase\\WUPayload\\FirstBaseVersion.cmd"),
        ("FirstBaseVersion.ps1", "FirstBase\\WUPayload\\FirstBaseVersion.ps1"),
        ("FirstBaseWuEngine.ps1", "FirstBase\\WUPayload\\FirstBaseWuEngine.ps1"),
        ("Show-UpdateProgress.ps1", "FirstBase\\WUPayload\\Show-UpdateProgress.ps1"),
        ("FirstBaseSplashTechMenu.ps1", "FirstBase\\WUPayload\\FirstBaseSplashTechMenu.ps1"),
        ("Tools\\seal_command.txt", "FirstBase\\WUPayload\\Tools\\seal_command.txt"),
        ("Tools\\Show-SplashNow.cmd", "FirstBase\\WUPayload\\Tools\\Show-SplashNow.cmd"),
        ("Deploy\\Fonts\\cascadiamono.ttf", "FirstBase\\Deploy\\Fonts\\cascadiamono.ttf"),
    };

    // WinPE optional components required for TechInstall.cmd and its helpers to run PowerShell
    // (Invoke-FirstBaseDismApply.ps1, and â€” critically â€” the MEDIADISK resolver + USB-disarm
    // fallbacks). Order matters: WinPE-PowerShell depends on WMI, NetFx and Scripting, so add them
    // first. Each base cab is followed by its matching _en-us language cab when present (the language
    // cab may sit alongside the base or under an en-us\ subfolder). The stock Windows Setup media
    // boot.wim (image index 2, the one the BCD ramdisk boots) ships WITHOUT these, so WinPE has no
    // powershell.exe unless we add them here. Mirrors the WinPE-OC add in Invoke-LoneWolfBuild.ps1.
    private static readonly string[] WinPeOcOrder = { "WinPE-WMI", "WinPE-NetFX", "WinPE-Scripting", "WinPE-PowerShell" };

    private static string MountedPowerShellPath(string mountDir) =>
        Path.Combine(mountDir, "Windows", "System32", "WindowsPowerShell", "v1.0", "powershell.exe");

    private async Task<bool> AddWinPeOptionalComponentsAsync(int disk, string mountDir, BuildContext ctx, CancellationToken ct)
    {
        var pwsh = MountedPowerShellPath(mountDir);
        var ocPath = ctx.WpeOcPath;
        if (string.IsNullOrEmpty(ocPath) || !Directory.Exists(ocPath))
        {
            _emit.Log(disk, $"winpe-oc: WinPE-OCs folder not found at '{ocPath}' â€” PowerShell will NOT be added to WinPE");
            return File.Exists(pwsh);
        }

        foreach (var pkg in WinPeOcOrder)
        {
            var baseCab = Path.Combine(ocPath, $"{pkg}.cab");
            if (!File.Exists(baseCab))
            {
                _emit.Log(disk, $"winpe-oc: base package {pkg}.cab missing in '{ocPath}' â€” skipping");
                continue;
            }
            _emit.Log(disk, $"winpe-oc: adding {pkg}...");
            var r = await _dism.AddPackageAsync(mountDir, baseCab, ct).ConfigureAwait(false);
            if (r.ExitCode != 0)
                _emit.Log(disk, $"winpe-oc: WARNING {pkg} /Add-Package failed (exit {r.ExitCode}) â€” continuing");

            foreach (var langCab in new[]
            {
                Path.Combine(ocPath, $"{pkg}_en-us.cab"),
                Path.Combine(ocPath, "en-us", $"{pkg}_en-us.cab")
            })
            {
                if (!File.Exists(langCab)) continue;
                _emit.Log(disk, $"winpe-oc: adding {pkg}_en-us...");
                var rl = await _dism.AddPackageAsync(mountDir, langCab, ct).ConfigureAwait(false);
                if (rl.ExitCode != 0)
                    _emit.Log(disk, $"winpe-oc: WARNING {pkg}_en-us /Add-Package failed (exit {rl.ExitCode}) â€” continuing");
                break;
            }
        }

        var present = File.Exists(pwsh);
        _emit.Log(disk, present
            ? "winpe-oc: PowerShell verified present in WinPE image (System32\\WindowsPowerShell\\v1.0\\powershell.exe)"
            : "winpe-oc: WARNING powershell.exe NOT present after adding optional components");
        return present;
    }

    private async Task InjectWinPeAsync(int diskNumber, string espRoot, BuildContext ctx, CancellationToken ct)
    {
        if (ctx.Profile.ProvisionMode == "vendor-iso") return;

        _emit.Phase(diskNumber, "winpe-inject");
        var bootWim = Path.Combine(espRoot, "sources", "boot.wim");
        if (!File.Exists(bootWim) || !File.Exists(ctx.StartnetPath))
        {
            _emit.Log(diskNumber, "startnet-inject: boot.wim or startnet missing â€” skipping");
            return;
        }

        var sentinel = Path.Combine(ctx.EspCache, "sources", "boot.wim.lw-injected");
        if (File.Exists(sentinel) && File.Exists(ctx.StartnetPath))
        {
            var sentHash = (await File.ReadAllTextAsync(sentinel, ct).ConfigureAwait(false)).Trim();
            var curHash = Convert.ToHexString(SHA256.HashData(await File.ReadAllBytesAsync(ctx.StartnetPath, ct).ConfigureAwait(false)));
            if (string.Equals(sentHash, curHash, StringComparison.OrdinalIgnoreCase))
            {
                _emit.Log(diskNumber, "startnet-inject: pre-injected via cache sentinel â€” skipping");
                return;
            }
        }

        // The ESP boot.wim is copied (attributes and all) from the network-share-sourced ESP cache,
        // so it carries the ReadOnly attribute. DISM /Mount-Image (read-write) + /Commit cannot write
        // back to a read-only WIM, so the mount fails, injection is silently skipped, and the stock
        // Windows-Setup boot.wim ships. Clear it first â€” mirrors Invoke-StartnetInjection in the PS builder.
        DiskPartitioner.ClearFileAttributes(bootWim);

        // Track whether PowerShell landed on each image index we committed. The BCD ramdisk boots
        // the WIM's dwBootIndex (index 2, "Windows Setup", on this media), so PowerShell MUST be
        // present on the booted index or TechInstall's PS helpers + MEDIADISK/USB-disarm fallbacks
        // silently degrade and the machine re-image-loops. Fail the build loudly rather than ship
        // a PowerShell-less WinPE.
        var mountedAny = false;
        var pwshMissingIndexes = new List<int>();
        foreach (var index in new[] { 1, 2 })
        {
            var mountDir = Path.Combine(Path.GetTempPath(), $"LWPEMount_{diskNumber}_{index}");
            Directory.CreateDirectory(mountDir);
            try
            {
                _emit.Log(diskNumber, $"startnet-inject: mounting boot.wim index {index}...");
                var mount = await _dism.MountImageAsync(bootWim, mountDir, readOnly: false, ct, index: index).ConfigureAwait(false);
                if (mount.ExitCode != 0)
                {
                    // Index 1 must exist and mount; index 2 is absent on some single-image media
                    // (e.g. custom WinPE-only boot.wim), so treat its failure as non-fatal and skip.
                    if (index == 1)
                        throw new InvalidOperationException($"DISM mount boot.wim index {index} failed: {mount.Output}");
                    _emit.Log(diskNumber, $"startnet-inject: boot.wim has no index {index} (exit {mount.ExitCode}) â€” skipping (non-fatal)");
                    continue;
                }
                mountedAny = true;

                var target = Path.Combine(mountDir, "Windows", "System32", "startnet.cmd");
                File.Copy(ctx.StartnetPath, target, overwrite: true);

                var winpeshl = Path.Combine(mountDir, "Windows", "System32", "winpeshl.ini");
                await File.WriteAllTextAsync(winpeshl,
                    "[LaunchApps]\r\ncmd.exe, /c X:\\Windows\\System32\\startnet.cmd\r\n", ct).ConfigureAwait(false);

                var pwshOk = await AddWinPeOptionalComponentsAsync(diskNumber, mountDir, ctx, ct).ConfigureAwait(false);
                if (!pwshOk) pwshMissingIndexes.Add(index);

                var preflight = Path.Combine(ctx.ContentRoot, "Deploy", "Invoke-FbUefiPreflight.ps1");
                if (File.Exists(preflight))
                {
                    var psDest = Path.Combine(mountDir, "Windows", "System32", "Invoke-FbUefiPreflight.ps1");
                    File.Copy(preflight, psDest, overwrite: true);
                }

                _emit.Log(diskNumber, $"startnet-inject: committing boot.wim index {index}...");
                var unmount = await _dism.UnmountImageAsync(mountDir, commit: true, ct).ConfigureAwait(false);
                if (unmount.ExitCode != 0)
                    throw new InvalidOperationException($"DISM unmount boot.wim failed: {unmount.Output}");

                _emit.Log(diskNumber, $"startnet-inject: boot.wim index {index} committed");
            }
            finally
            {
                try { Directory.Delete(mountDir, recursive: true); } catch { /* ignore */ }
            }
        }

        if (mountedAny && pwshMissingIndexes.Count > 0)
            throw new InvalidOperationException(
                $"WinPE PowerShell missing after inject on boot.wim index(es) [{string.Join(",", pwshMissingIndexes)}]. "
                + $"Stage the WinPE optional components ({string.Join(", ", WinPeOcOrder)}) at '{ctx.WpeOcPath}'. "
                + "Refusing to ship a PowerShell-less WinPE (would re-image loop).");
    }

    private async Task BuildEspCacheAsync(BuildContext ctx, CancellationToken ct)
    {
        // Proven flow: rebuild the ESP boot template from the CURRENT source on EVERY build.
        // The old cross-build freshness skip (IsEspCacheFresh) let a stale boot.wim / stale boot
        // files / an uninjected image survive across runs â€” one of the failure classes this rework
        // eliminates. Wipe and recreate so nothing from a previous ISO/build lingers, then re-copy
        // and re-inject boot.wim once (per build, not per disk).
        try
        {
            if (Directory.Exists(ctx.EspCache))
                Directory.Delete(ctx.EspCache, recursive: true);
        }
        catch (Exception ex)
        {
            _emit.Log(0, $"esp-cache: could not wipe previous template ({ex.Message}); continuing with overwrite");
        }

        _emit.Progress(0, "esp-copy", 0);
        Directory.CreateDirectory(Path.Combine(ctx.EspCache, "sources"));

        if (ctx.IsoDriveLetter != null)
        {
            await BuildEspCacheFromIsoAsync(ctx, ct).ConfigureAwait(false);
        }
        else if (!string.IsNullOrEmpty(ctx.StagingWindowsDir))
        {
            await BuildEspCacheFromStagingAsync(ctx, ct).ConfigureAwait(false);
        }
        else if (ctx.SharedWimMount != null)
        {
            await BuildEspCacheFromWimMountAsync(ctx, ct).ConfigureAwait(false);
        }
        else
        {
            _emit.Log(0, "esp-cache: no staging folder or ISO source â€” overlay only");
            _emit.Progress(0, "esp-copy", 50);
        }

        // NOTE: overlay cache rebuild is handled by the caller (RunAsync) unconditionally,
        // not here â€” it must run even on the early-return "esp-cache is fresh" path above.
        await InjectCacheBootWimAsync(ctx, ct).ConfigureAwait(false);
        _emit.Progress(0, "esp-copy", 100);
    }

    private async Task BuildEspCacheFromIsoAsync(BuildContext ctx, CancellationToken ct)
    {
        var isoRoot = ctx.IsoDriveLetter + "\\";
        var entries = Directory.GetFileSystemEntries(isoRoot)
            .Where(e =>
            {
                var name = Path.GetFileName(e);
                return !name.Equals("sources", StringComparison.OrdinalIgnoreCase)
                       && !(name.EndsWith(".wim", StringComparison.OrdinalIgnoreCase)
                            || name.EndsWith(".esd", StringComparison.OrdinalIgnoreCase)
                            || name.EndsWith(".swm", StringComparison.OrdinalIgnoreCase));
            })
            .ToArray();

        var total = Math.Max(1, entries.Length);
        for (var i = 0; i < entries.Length; i++)
        {
            ct.ThrowIfCancellationRequested();
            var pct = Math.Min(79, (int)Math.Round((i + 1) / (double)total * 80));
            _emit.Progress(0, "esp-copy", pct);

            var name = Path.GetFileName(entries[i]);
            var dest = Path.Combine(ctx.EspCache, name);
            if (Directory.Exists(entries[i]))
                DiskPartitioner.CopyDirectory(entries[i], dest);
            else
                DiskPartitioner.SafeCopyFile(entries[i], dest);
        }

        _emit.Progress(0, "esp-copy", 85);
        CopyIsoBootToEsp(isoRoot, ctx.EspCache);
        SynthesizeEspBootFiles(ctx.EspCache, ctx.StagingWindowsDir);
        await Task.CompletedTask.ConfigureAwait(false);
    }

    private async Task BuildEspCacheFromStagingAsync(BuildContext ctx, CancellationToken ct)
    {
        var stagingDir = ctx.StagingWindowsDir!;
        _emit.Log(0, $"esp-cache: copying from staging folder {stagingDir}");

        var items = Directory.GetFileSystemEntries(stagingDir)
            .Where(e =>
            {
                var name = Path.GetFileName(e);
                return !name.EndsWith(".wim", StringComparison.OrdinalIgnoreCase)
                       && !name.EndsWith(".esd", StringComparison.OrdinalIgnoreCase)
                       && !name.EndsWith(".swm", StringComparison.OrdinalIgnoreCase);
            })
            .ToArray();

        var total = Math.Max(1, items.Length);
        for (var i = 0; i < items.Length; i++)
        {
            ct.ThrowIfCancellationRequested();
            var pct = Math.Min(95, (int)Math.Round((i + 1) / (double)total * 100));
            _emit.Progress(0, "esp-copy", pct);

            var item = items[i];
            var name = Path.GetFileName(item);
            if (Directory.Exists(item) && name.Equals("sources", StringComparison.OrdinalIgnoreCase))
            {
                var dstSrc = Path.Combine(ctx.EspCache, "sources");
                Directory.CreateDirectory(dstSrc);
                foreach (var child in Directory.GetFiles(item))
                {
                    var childName = Path.GetFileName(child);
                    if (childName.Equals("boot.wim", StringComparison.OrdinalIgnoreCase)
                        || childName.EndsWith(".sdi", StringComparison.OrdinalIgnoreCase))
                    {
                        DiskPartitioner.SafeCopyFile(child, Path.Combine(dstSrc, childName));
                    }
                }
            }
            else if (Directory.Exists(item))
            {
                DiskPartitioner.CopyDirectory(item, Path.Combine(ctx.EspCache, name));
            }
            else
            {
                DiskPartitioner.SafeCopyFile(item, Path.Combine(ctx.EspCache, name));
            }
        }

        RestoreEspSentinel(ctx);
        SynthesizeEspBootFiles(ctx.EspCache, stagingDir);
        await Task.CompletedTask.ConfigureAwait(false);
    }

    private async Task BuildEspCacheFromWimMountAsync(BuildContext ctx, CancellationToken ct)
    {
        _emit.Log(0, $"esp-cache: copying boot files from shared WIM mount {ctx.SharedWimMount}");
        var mount = ctx.SharedWimMount!;
        foreach (var entry in Directory.GetFileSystemEntries(mount))
        {
            var name = Path.GetFileName(entry);
            if (name.Equals("sources", StringComparison.OrdinalIgnoreCase)) continue;
            if (name.EndsWith(".wim", StringComparison.OrdinalIgnoreCase)) continue;
            var dest = Path.Combine(ctx.EspCache, name);
            if (Directory.Exists(entry))
                DiskPartitioner.CopyDirectory(entry, dest);
            else
                DiskPartitioner.SafeCopyFile(entry, dest);
        }

        var espSources = Path.Combine(ctx.EspCache, "sources");
        Directory.CreateDirectory(espSources);
        var bootWim = Path.Combine(mount, "sources", "boot.wim");
        if (File.Exists(bootWim))
            DiskPartitioner.SafeCopyFile(bootWim, Path.Combine(espSources, "boot.wim"));

        _emit.Progress(0, "esp-copy", 80);
        SynthesizeEspBootFiles(ctx.EspCache, ctx.StagingWindowsDir);
        await Task.CompletedTask.ConfigureAwait(false);
    }

    private static void RestoreEspSentinel(BuildContext ctx)
    {
        if (string.IsNullOrEmpty(ctx.StagingWindowsDir)) return;

        var sentinelSrc = Path.Combine(ctx.StagingWindowsDir, "sources", "boot.wim.lw-injected");
        var sentinelDst = Path.Combine(ctx.EspCache, "sources", "boot.wim.lw-injected");
        var espBootWim = Path.Combine(ctx.EspCache, "sources", "boot.wim");
        try
        {
            if (File.Exists(sentinelDst)) File.Delete(sentinelDst);
            if (File.Exists(sentinelSrc) && File.Exists(espBootWim)
                && File.GetLastWriteTimeUtc(sentinelSrc) >= File.GetLastWriteTimeUtc(espBootWim))
            {
                File.Copy(sentinelSrc, sentinelDst, overwrite: true);
            }
        }
        catch { /* ignore */ }
    }

    private static void SynthesizeEspBootFiles(string espCache, string? stagingWindowsDir)
    {
        var bootmgfwDst = Path.Combine(espCache, "efi", "microsoft", "boot", "bootmgfw.efi");
        if (!File.Exists(bootmgfwDst))
        {
            var bootmgfwSrc = Path.Combine(espCache, "efi", "boot", "bootx64.efi");
            if (File.Exists(bootmgfwSrc))
            {
                Directory.CreateDirectory(Path.GetDirectoryName(bootmgfwDst)!);
                File.Copy(bootmgfwSrc, bootmgfwDst, overwrite: true);
            }
        }

        var fallbackDir = Path.Combine(espCache, "EFI", "Boot");
        var fallbackEfi = Path.Combine(fallbackDir, "bootx64.efi");
        if (!File.Exists(fallbackEfi))
        {
            Directory.CreateDirectory(fallbackDir);
            var src = Path.Combine(espCache, "efi", "microsoft", "boot", "bootmgfw.efi");
            if (File.Exists(src))
                File.Copy(src, fallbackEfi, overwrite: true);
        }
    }

    private async Task BuildOverlayCacheAsync(BuildContext ctx, CancellationToken ct)
    {
        await Task.Run(() =>
        {
            if (Directory.Exists(ctx.OverlayCache))
                Directory.Delete(ctx.OverlayCache, recursive: true);
            Directory.CreateDirectory(ctx.OverlayCache);

            if (ctx.Profile.NoPayload)
            {
                Directory.CreateDirectory(Path.Combine(ctx.OverlayCache, "FirstBase", "Policy"));
                Directory.CreateDirectory(Path.Combine(ctx.OverlayCache, "FirstBase", "Deploy"));
                Directory.CreateDirectory(Path.Combine(ctx.OverlayCache, "FirstBase", "WUPayload", "Tools"));

                var policyFile = Path.Combine(ctx.ContentRoot, ctx.Profile.AutounattendFile);
                if (File.Exists(policyFile))
                {
                    CopyOverlayPayloadFile(ctx.ContentRoot, ctx.OverlayCache, ctx.Profile.AutounattendFile, "FirstBase\\Autounattend.xml");
                    CopyOverlayPayloadFile(ctx.ContentRoot, ctx.OverlayCache, ctx.Profile.AutounattendFile, "FirstBase\\Policy\\Autounattend.xml");
                }

                var techInstall = Path.Combine(ctx.ContentRoot, "Deploy", ctx.Profile.TechInstallScript);
                if (File.Exists(techInstall))
                    CopyOverlayPayloadFile(ctx.ContentRoot, ctx.OverlayCache, $"Deploy\\{ctx.Profile.TechInstallScript}", "FirstBase\\Deploy\\TechInstall.cmd");

                foreach (var deployFile in new[] { "WinPE-Startnet.cmd", "disksetup.cmd", "Show-DeployBanner.ps1", "Invoke-FbDeployUi.ps1" })
                    CopyOverlayPayloadFile(ctx.ContentRoot, ctx.OverlayCache, $"Deploy\\{deployFile}", $"FirstBase\\Deploy\\{deployFile}");

                // fb-im front-end: cmd launcher at volume ROOT; PS backend + fb-dump backend under FirstBase\WUPayload\Tools\.
                CopyOverlayPayloadFile(ctx.ContentRoot, ctx.OverlayCache, "Tools\\fb-im.cmd", "fb-im.cmd");
                CopyOverlayPayloadFile(ctx.ContentRoot, ctx.OverlayCache, "Tools\\fb-im.ps1", "FirstBase\\WUPayload\\Tools\\fb-im.ps1");
                CopyOverlayPayloadFile(ctx.ContentRoot, ctx.OverlayCache, "Tools\\fb-dump.ps1", "FirstBase\\WUPayload\\Tools\\fb-dump.ps1");
            }
            else
            {
                Directory.CreateDirectory(Path.Combine(ctx.OverlayCache, "FirstBase", "Deploy"));
                Directory.CreateDirectory(Path.Combine(ctx.OverlayCache, "FirstBase", "Policy"));
                Directory.CreateDirectory(Path.Combine(ctx.OverlayCache, "FirstBase", "WUPayload"));
                Directory.CreateDirectory(Path.Combine(ctx.OverlayCache, "FirstBase", "WUPayload", "Tools"));

                foreach (var (src, dst) in FullOverlayMap)
                    CopyOverlayPayloadFile(ctx.ContentRoot, ctx.OverlayCache, src, dst);

                var scriptsSrc = Path.Combine(ctx.ContentRoot, "Scripts");
                if (Directory.Exists(scriptsSrc))
                    DiskPartitioner.CopyDirectory(scriptsSrc, Path.Combine(ctx.OverlayCache, "FirstBase", "Scripts"));
            }

            var overlayFiles = Directory.Exists(ctx.OverlayCache)
                ? Directory.EnumerateFiles(ctx.OverlayCache, "*", SearchOption.AllDirectories).Count()
                : 0;
            _emit.Log(0, $"overlay-cache: {overlayFiles} files staged at {ctx.OverlayCache}");
        }, ct).ConfigureAwait(false);
    }

    private async Task InjectCacheBootWimAsync(BuildContext ctx, CancellationToken ct)
    {
        var bootWim = Path.Combine(ctx.EspCache, "sources", "boot.wim");
        if (!File.Exists(bootWim) || !File.Exists(ctx.StartnetPath))
        {
            _emit.Log(0, "startnet inject: boot.wim or startnet missing â€” skipping");
            return;
        }

        var sentinel = Path.Combine(ctx.EspCache, "sources", "boot.wim.lw-injected");
        if (File.Exists(sentinel) && File.Exists(ctx.StartnetPath))
        {
            var sentHash = (await File.ReadAllTextAsync(sentinel, ct).ConfigureAwait(false)).Trim();
            var curHash = Convert.ToHexString(SHA256.HashData(await File.ReadAllBytesAsync(ctx.StartnetPath, ct).ConfigureAwait(false)));
            if (string.Equals(sentHash, curHash, StringComparison.OrdinalIgnoreCase)
                && File.GetLastWriteTimeUtc(sentinel) >= File.GetLastWriteTimeUtc(bootWim))
            {
                _emit.Log(0, "startnet inject: boot.wim pre-injection complete");
                return;
            }
        }

        _emit.Log(0, "startnet inject: preparing cache boot.wim...");
        _emit.Progress(0, "esp-copy", 96);

        // boot.wim copied from the network-share staging source carries the ReadOnly attribute
        // (File.Copy preserves source attributes). DISM /Mount-Image (read-write) + /Commit cannot
        // write back to a read-only WIM, so BOTH index mounts fail, injection is skipped, and the
        // stock Windows-Setup boot.wim ships. Because its dwBootIndex is 2 ("Windows Setup"), the
        // ramdisk boots straight into setup.exe / the language-select screen and startnet.cmd never
        // runs. Clear ReadOnly first â€” this mirrors Invoke-StartnetInjection in Invoke-LoneWolfBuild.ps1,
        // which explicitly clears IsReadOnly before mounting.
        DiskPartitioner.ClearFileAttributes(bootWim);

        var committed = new List<int>();
        var failed = new List<int>();
        var pwshMissingIndexes = new List<int>();
        foreach (var index in new[] { 1, 2 })
        {
            var mountDir = Path.Combine(Path.GetTempPath(), "LWCacheInject_" + Guid.NewGuid().ToString("N")[..8]);
            Directory.CreateDirectory(mountDir);
            try
            {
                _emit.Log(0, $"startnet inject: mounting boot.wim index {index}...");
                var m = await _dism.MountImageAsync(bootWim, mountDir, false, ct, index: index).ConfigureAwait(false);
                if (m.ExitCode != 0)
                {
                    _emit.Log(0, $"startnet inject: mount index {index} failed (exit {m.ExitCode}) â€” skipping");
                    failed.Add(index);
                    continue;
                }

                File.Copy(ctx.StartnetPath, Path.Combine(mountDir, "Windows", "System32", "startnet.cmd"), true);

                // Replace winpeshl.ini so bootmgr launches startnet.cmd and NOT the stock
                // \sources\setup.exe (which shows the Windows Setup language-selection UI and
                // never runs WinPE-Startnet.cmd â†’ TechInstall.cmd). This matches the proven
                // per-disk inject; the earlier cache-inject path omitted it.
                var winpeshl = Path.Combine(mountDir, "Windows", "System32", "winpeshl.ini");
                DiskPartitioner.ClearFileAttributes(winpeshl);
                await File.WriteAllTextAsync(winpeshl,
                    "[LaunchApps]\r\ncmd.exe, /c X:\\Windows\\System32\\startnet.cmd\r\n", ct).ConfigureAwait(false);

                // Add WinPE PowerShell (+ WMI/NetFx/Scripting) so TechInstall's PS helpers and,
                // critically, the MEDIADISK resolver + USB-disarm fallbacks work at deploy time.
                // Without PowerShell the machine re-image loops (disarm never runs). This cache
                // path previously never added the OCs â€” the direct cause of the missing-PowerShell
                // + re-image-loop regression.
                var pwshOk = await AddWinPeOptionalComponentsAsync(0, mountDir, ctx, ct).ConfigureAwait(false);
                if (!pwshOk) pwshMissingIndexes.Add(index);

                var preflight = Path.Combine(ctx.ContentRoot, "Deploy", "Invoke-FbUefiPreflight.ps1");
                if (File.Exists(preflight))
                    File.Copy(preflight, Path.Combine(mountDir, "Windows", "System32", "Invoke-FbUefiPreflight.ps1"), true);

                _emit.Log(0, $"startnet inject: committing boot.wim index {index}...");
                var u = await _dism.UnmountImageAsync(mountDir, true, ct).ConfigureAwait(false);
                if (u.ExitCode != 0)
                {
                    _emit.Log(0, $"startnet inject: commit index {index} failed (exit {u.ExitCode}) â€” discarding");
                    await _dism.UnmountImageAsync(mountDir, false, ct).ConfigureAwait(false);
                    failed.Add(index);
                    continue;
                }
                committed.Add(index);
                _emit.Progress(0, "esp-copy", index == 1 ? 98 : 99);
            }
            finally
            {
                try { Directory.Delete(mountDir, recursive: true); } catch { /* ignore */ }
            }
        }

        // Refuse to ship a PowerShell-less WinPE: if any committed index lacks powershell.exe the
        // deployed USB would re-image loop (TechInstall can't resolve the media disk / disarm the
        // stick without PS). Fail the build loudly with actionable guidance instead.
        if (committed.Count > 0 && pwshMissingIndexes.Count > 0)
            throw new InvalidOperationException(
                $"WinPE PowerShell missing after cache inject on boot.wim index(es) [{string.Join(",", pwshMissingIndexes)}]. "
                + $"Stage the WinPE optional components ({string.Join(", ", WinPeOcOrder)}) at '{ctx.WpeOcPath}'. "
                + "Refusing to ship a PowerShell-less WinPE (would re-image loop).");

        // Only stamp the pre-injection sentinel when EVERY index we could mount was committed with
        // our winpeshl.ini. The sentinel makes the per-disk InjectWinPeAsync skip its own injection,
        // so writing it after a failed/partial inject is exactly what let the stock setup.exe boot.wim
        // ship (the original regression). If anything failed, leave the sentinel unset (and remove any
        // stale one) so the per-disk fallback re-attempts the injection on each USB's own ESP boot.wim.
        if (committed.Count > 0 && failed.Count == 0)
        {
            var hash = Convert.ToHexString(SHA256.HashData(await File.ReadAllBytesAsync(ctx.StartnetPath, ct).ConfigureAwait(false)));
            await File.WriteAllTextAsync(sentinel, hash, ct).ConfigureAwait(false);
            _emit.Log(0, $"startnet inject: cache boot.wim pre-injection complete (indexes committed: {string.Join(",", committed)})");
        }
        else
        {
            if (File.Exists(sentinel))
            {
                try { File.Delete(sentinel); } catch { /* ignore */ }
            }
            _emit.Log(0,
                $"startnet inject: cache boot.wim NOT fully injected (committed=[{string.Join(",", committed)}], failed=[{string.Join(",", failed)}]) â€” sentinel left unset; per-disk injection will run");
        }
    }

    private async Task PrepareSharedWimMountAsync(BuildContext ctx, string wimPath, CancellationToken ct)
    {
        var workDir = Path.Combine(Path.GetTempPath(), "LW-WimShared-" + Guid.NewGuid().ToString("N")[..8]);
        var localWim = Path.Combine(workDir, "staging.wim");
        var mountDir = Path.Combine(workDir, "mount");
        Directory.CreateDirectory(workDir);
        Directory.CreateDirectory(mountDir);

        _emit.Log(0, "wim-shared: copying WIM to local temp...");
        var wimDir = Path.GetDirectoryName(wimPath)!;
        var wimFile = Path.GetFileName(wimPath);
        var copyResult = await ProcessRunner.RunAsync("robocopy.exe",
            $"{ProcessRunner.QuoteCommandLinePath(wimDir)} {ProcessRunner.QuoteCommandLinePath(workDir)} \"{wimFile}\" /R:1 /W:2 /NP /NJH /NJS", ct).ConfigureAwait(false);
        if (!ProcessRunner.IsRobocopySuccess(copyResult.ExitCode))
            throw new InvalidOperationException($"WIM copy failed (exit {copyResult.ExitCode})");
        _emit.Log(0, "wim-shared: local WIM copy complete");

        var leaf = Path.GetFileName(wimPath);
        if (!leaf.Equals("staging.wim", StringComparison.OrdinalIgnoreCase))
            File.Move(Path.Combine(workDir, leaf), localWim, overwrite: true);

        _emit.Log(0, "wim-shared: mounting read-only...");
        var mount = await _dism.MountImageAsync(localWim, mountDir, true, ct).ConfigureAwait(false);
        if (mount.ExitCode != 0)
            throw new InvalidOperationException($"Shared WIM mount failed: {mount.Output}");

        ctx.SharedWimMount = mountDir;

        const string wimRobocopyArgs = "/E /COPY:DAT /DCOPY:DAT";
        _emit.Log(0, "wim-shared: measuring robocopy source bytes...");
        ctx.SharedWimSourceBytes = await ProcessRunner.GetRobocopyByteTotalAsync(mountDir, wimRobocopyArgs, ct)
            .ConfigureAwait(false);
        if (ctx.SharedWimSourceBytes <= 0)
        {
            _emit.Log(0, "wim-shared: robocopy list sizing failed; falling back to directory walk");
            ctx.SharedWimSourceBytes = await CopyProgress.GetDirectoryByteSizeAsync(mountDir, ct).ConfigureAwait(false);
        }

        if (ctx.SharedWimSourceBytes <= 0)
        {
            try { ctx.SharedWimSourceBytes = new FileInfo(localWim).Length; }
            catch { ctx.SharedWimSourceBytes = 1; }
        }

        _emit.Log(0, $"wim-shared: mount ready ({CopyProgress.FormatBytes(ctx.SharedWimSourceBytes)} robocopy source bytes)");

        // #region agent log
        long mountFileCount = 0, mountBytes = 0;
        try
        {
            foreach (var f in Directory.EnumerateFiles(mountDir, "*", SearchOption.AllDirectories))
            {
                mountFileCount++;
                mountBytes += new FileInfo(f).Length;
            }
        }
        catch { /* ignore */ }
        DbgLog.Write(
            "BuildEngine.cs:PrepareSharedWimMountAsync:post-mount",
            "Shared WIM mount ready",
            new
            {
                wimPath,
                localWim,
                mountDir,
                mountExists = Directory.Exists(mountDir),
                mountFileCount,
                mountBytes,
                dismExit = mount.ExitCode
            },
            "H2");
        // #endregion
    }

    private async Task CleanupSharedWimAsync(BuildContext ctx, CancellationToken ct)
    {
        if (string.IsNullOrEmpty(ctx.SharedWimMount)) return;
        await _dism.UnmountImageAsync(ctx.SharedWimMount, false, ct).ConfigureAwait(false);
        try
        {
            var parent = Directory.GetParent(ctx.SharedWimMount)?.FullName;
            if (parent != null) Directory.Delete(parent, true);
        }
        catch { /* ignore */ }
    }

    private static void CopyIsoBootToEsp(string isoRoot, string espRoot)
    {
        foreach (var entry in Directory.GetFileSystemEntries(isoRoot))
        {
            var name = Path.GetFileName(entry);
            if (name.Equals("sources", StringComparison.OrdinalIgnoreCase)) continue;
            if (name.EndsWith(".wim", StringComparison.OrdinalIgnoreCase)) continue;
            var dest = Path.Combine(espRoot, name);
            if (Directory.Exists(entry))
                DiskPartitioner.CopyDirectory(entry, dest);
            else
                DiskPartitioner.SafeCopyFile(entry, dest);
        }
        var espSources = Path.Combine(espRoot, "sources");
        Directory.CreateDirectory(espSources);
        var bootWim = Path.Combine(isoRoot, "sources", "boot.wim");
        if (File.Exists(bootWim))
            DiskPartitioner.SafeCopyFile(bootWim, Path.Combine(espSources, "boot.wim"));
        var bootSdi = Path.Combine(isoRoot, "boot", "boot.sdi");
        if (File.Exists(bootSdi))
        {
            var espBoot = Path.Combine(espRoot, "boot");
            Directory.CreateDirectory(espBoot);
            DiskPartitioner.SafeCopyFile(bootSdi, Path.Combine(espBoot, "boot.sdi"));
        }
    }

    private static readonly HashSet<string> SkipDataRootEntries = new(StringComparer.OrdinalIgnoreCase)
    {
        "System Volume Information",
        "$RECYCLE.BIN",
        "RECYCLER",
        "FirstBase-UsbLogs",
        "LW_LOGS"
    };

    private static void PopulateEspFromData(string espRoot, string dataRoot, int disk)
    {
        // #region agent log
        DbgLog.Write(
            "BuildEngine.cs:PopulateEspFromData:enter",
            "esp-populate starting",
            new { disk, espRoot, dataRoot },
            "H6",
            "post-fix");
        // #endregion

        foreach (var entry in SafeGetFileSystemEntries(dataRoot))
        {
            var name = Path.GetFileName(entry);
            if (name.Equals("sources", StringComparison.OrdinalIgnoreCase)) continue;
            if (SkipDataRootEntries.Contains(name)) continue;
            if (name.EndsWith(".wim", StringComparison.OrdinalIgnoreCase)) continue;
            var dest = Path.Combine(espRoot, name);
            try
            {
                if (Directory.Exists(entry))
                    DiskPartitioner.CopyDirectory(entry, dest);
                else
                    DiskPartitioner.SafeCopyFile(entry, dest);
            }
            catch (UnauthorizedAccessException) { /* matches PS Copy-Item -ErrorAction SilentlyContinue */ }
            catch (IOException) { /* skip inaccessible ISO artifacts (e.g. autorun.inf) */ }
        }
        var espSources = Path.Combine(espRoot, "sources");
        Directory.CreateDirectory(espSources);
        var dataSources = Path.Combine(dataRoot, "sources");
        if (Directory.Exists(dataSources))
        {
            foreach (var f in SafeGetFiles(dataSources, "*.sdi"))
            {
                DiskPartitioner.SafeCopyFile(f, Path.Combine(espSources, Path.GetFileName(f)));
            }
        }

        // #region agent log
        DbgLog.Write(
            "BuildEngine.cs:PopulateEspFromData:done",
            "esp-populate complete",
            new { disk, espRoot, dataRoot },
            "H6",
            "post-fix");
        // #endregion
    }

    private static IEnumerable<string> SafeGetFileSystemEntries(string root)
    {
        try { return Directory.GetFileSystemEntries(root); }
        catch { return Array.Empty<string>(); }
    }

    private static IEnumerable<string> SafeGetFiles(string root, string pattern)
    {
        try { return Directory.GetFiles(root, pattern); }
        catch { return Array.Empty<string>(); }
    }

    private async Task ClearIsoBootArtifactAttributesAsync(string dataRoot, int diskNumber, CancellationToken ct)
    {
        // Hide Windows boot/media at volume root so Explorer shows only fb-im.cmd + FirstBase\.
        // Bootability is unchanged: BCD still resolves \sources\boot.wim at the volume root.
        try
        {
            foreach (var bootItem in new[]
            {
                "boot", "bootmgr", "bootmgr.efi", "setup.exe", "autorun.inf",
                "sources", "efi", "EFI", "support", "Support",
                "boot.disabled", "bootmgr.disabled", "bootmgr.efi.disabled"
            })
            {
                var bootPath = Path.Combine(dataRoot, bootItem);
                if (!Directory.Exists(bootPath) && !File.Exists(bootPath)) continue;
                try
                {
                    await ProcessRunner.RunAsync("attrib.exe", $"+H +S \"{bootPath}\" /D /S", ct).ConfigureAwait(false);
                }
                catch
                {
                    // Non-fatal â€” matches PS swallowing attrib failures.
                }
            }

            foreach (var keep in new[] { "fb-im.cmd", "FirstBase" })
            {
                var keepPath = Path.Combine(dataRoot, keep);
                if (!Directory.Exists(keepPath) && !File.Exists(keepPath)) continue;
                try
                {
                    await ProcessRunner.RunAsync("attrib.exe", $"-H -S \"{keepPath}\" /D", ct).ConfigureAwait(false);
                }
                catch { }
            }

            _emit.Log(diskNumber, "Hid Windows boot/media at volume root; left fb-im.cmd + FirstBase visible");
        }
        catch (Exception ex)
        {
            _emit.Log(diskNumber, $"WARNING: Could not hide ISO boot/media attributes: {ex.Message}");
        }
    }

    private static async Task WriteVersionStampAsync(string dataRoot, BuildContext ctx, int diskNumber, bool overlayOnly, CancellationToken ct)
    {
        var stampImageDate = ctx.ImageBuildDate;
        var existingPath = Path.Combine(dataRoot, "FirstBase", "LW_VERSION.json");
        if (overlayOnly && File.Exists(existingPath))
        {
            try
            {
                using var existing = JsonDocument.Parse(await File.ReadAllTextAsync(existingPath, ct).ConfigureAwait(false));
                if (existing.RootElement.TryGetProperty("imageBuildDate", out var ibd) && ibd.ValueKind == JsonValueKind.String)
                    stampImageDate = ibd.GetString();
                else if (existing.RootElement.TryGetProperty("wimBuildDate", out var wbd) && wbd.ValueKind == JsonValueKind.String)
                    stampImageDate = wbd.GetString();
            }
            catch { /* keep current ISO date only for full rebuilds */ }
        }
        var stamp = JsonSerializer.Serialize(new
        {
            builtBy = "LoneWolfLauncher",
            workflowType = ctx.WorkflowType,
            version = ctx.StagingVersion,
            scriptVersion = string.IsNullOrWhiteSpace(ctx.ScriptVersion) ? ctx.StagingVersion : ctx.ScriptVersion,
            payloadVersion = string.IsNullOrWhiteSpace(ctx.ScriptVersion) ? ctx.StagingVersion : ctx.ScriptVersion,
            builtAt = DateTime.UtcNow.ToString("o"),
            diskNumber,
            devBuild = ctx.DevBuild,
            launcherVersion = ctx.LauncherVersion,
            shareLauncherVersion = ctx.ShareLauncherVersion,
            shareScriptVersion = ctx.ShareScriptVersion,
            imageBuildDate = stampImageDate,
            wimBuildDate = stampImageDate
        });
        var firstBaseRoot = Path.Combine(dataRoot, "FirstBase");
        Directory.CreateDirectory(firstBaseRoot);
        await File.WriteAllTextAsync(Path.Combine(firstBaseRoot, "LW_VERSION.json"), stamp, ct).ConfigureAwait(false);
        if (ctx.DevBuild)
        {
            try
            {
                var wu = Path.Combine(firstBaseRoot, "WUPayload");
                Directory.CreateDirectory(wu);
                await File.WriteAllTextAsync(
                    Path.Combine(wu, ".dev-build"),
                    $"devBuild=1\r\nlauncherVersion={ctx.LauncherVersion}\r\nscriptVersion={ctx.ScriptVersion}\r\nshareLauncherVersion={ctx.ShareLauncherVersion}\r\nshareScriptVersion={ctx.ShareScriptVersion}\r\nbuiltAt={DateTime.UtcNow:o}\r\n",
                    ct).ConfigureAwait(false);
            }
            catch { /* non-fatal */ }
        }
    }

    private static string GetStagingRoot(BuildOptions opts) =>
        !string.IsNullOrWhiteSpace(opts.LocalProjectRoot)
            ? Path.Combine(opts.LocalProjectRoot, "Staging")
            : ConnectDeploymentShare.GetStagingRoot(opts.ShareRoot ?? ProvisioningConstants.DefaultShareRoot);

    private static string ReadPayloadVersion(BuildOptions opts)
    {
        if (!string.IsNullOrWhiteSpace(opts.ScriptVersion))
            return opts.ScriptVersion;
        try
        {
            var bundled = Path.Combine(opts.AppResourcesPath, "powershell", "VERSION.json");
            if (!File.Exists(bundled))
                bundled = Path.Combine(opts.AppResourcesPath, "VERSION.json");
            if (!File.Exists(bundled)) return "unknown";
            using var doc = System.Text.Json.JsonDocument.Parse(File.ReadAllText(bundled));
            if (doc.RootElement.TryGetProperty("payloadVersion", out var pv))
            {
                var s = pv.GetString();
                if (!string.IsNullOrWhiteSpace(s)) return s;
            }
            return doc.RootElement.TryGetProperty("version", out var v) ? v.GetString() ?? "unknown" : "unknown";
        }
        catch { return "unknown"; }
    }

    private static string SanitizeAscii(string msg)
    {
        return (msg ?? "").Replace('\u2014', '-').Replace('\u2013', '-');
    }
}

public sealed class BuildOptions
{
    public string WorkflowType { get; set; } = "AMD64";
    public int[] DiskNumbers { get; set; } = Array.Empty<int>();
    public Sources.ResolvedSource ResolvedSource { get; set; } = new();
    public string? ExplicitSource { get; set; }
    public string AppResourcesPath { get; set; } = "";
    public string? CacheRoot { get; set; }
    public string? ShareRoot { get; set; }
    public string? LocalProjectRoot { get; set; }
    public string? WpeOcPath { get; set; }
    public bool PreCacheOnly { get; set; }
    public bool OverlayOnly { get; set; }
    public bool Sequential { get; set; }
    public bool DevBuild { get; set; }
    public string? LauncherVersion { get; set; }
    public string? ScriptVersion { get; set; }
    public string? ShareLauncherVersion { get; set; }
    public string? ShareScriptVersion { get; set; }
}
