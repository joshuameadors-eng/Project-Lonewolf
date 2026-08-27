using System.Text.Json;
using LoneWolf.Provisioner.Engine;
using LoneWolf.Provisioner.Imaging;
using LoneWolf.Provisioner.Profiles;
using LoneWolf.Provisioner.Share;
using LoneWolf.Provisioner.Sources;
using LoneWolf.Provisioner.Staging;

namespace LoneWolf.Provisioner;

public static class Program
{
    public static async Task<int> Main(string[] args)
    {
        try
        {
            // Line-buffer stdout so JSON progress events reach the Electron parent immediately.
            var stdout = new StreamWriter(Console.OpenStandardOutput()) { AutoFlush = true };
            Console.SetOut(stdout);

            if (args.Length == 0)
            {
                PrintUsage();
                return 1;
            }

            return args[0].ToLowerInvariant() switch
            {
                "sources" => await HandleSourcesAsync(args.Skip(1).ToArray()),
                "staging" => HandleStaging(args.Skip(1).ToArray()),
                "build" => await HandleBuildAsync(args.Skip(1).ToArray()),
                "precache" => await HandlePreCacheAsync(args.Skip(1).ToArray()),
                "selftest" => HandleSelfTest(args.Skip(1).ToArray()),
                _ => Unknown(args[0])
            };
        }
        catch (Exception ex)
        {
            var emit = new Events.JsonEventEmitter();
            emit.Error(-1, ex.Message, "FATAL");
            return 1;
        }
    }

    private static Task<int> HandleSourcesAsync(string[] args)
    {
        if (args.Length == 0) return Task.FromResult(Unknown("sources"));

        var result = args[0].ToLowerInvariant() switch
        {
            "scan-local" => OutputJson(LocalIsoScanner.Scan(ParseExtraRoots(args))),
            "scan-share" => OutputJson(ShareSourceScanner.Scan(
                GetArg(args, "--workflow") ?? "AMD64",
                GetArg(args, "--share-root"),
                GetArg(args, "--local-project-root"))),
            "analyze" => OutputJson(SourceAnalyzer.Analyze(
                GetArg(args, "--path") ?? throw new ArgumentException("--path required"),
                GetArg(args, "--origin"))),
            _ => Unknown(args[0])
        };
        return Task.FromResult(result);
    }

    private static int HandleStaging(string[] args)
    {
        if (args.Length == 0 || args[0] != "info")
            return Unknown("staging");

        var wf = GetArg(args, "--workflow") ?? "AMD64";
        var info = StagingInfoService.Get(wf, GetArg(args, "--share-root"), GetArg(args, "--local-project-root"));
        return OutputJson(info);
    }

    private static async Task<int> HandleBuildAsync(string[] args)
    {
        var opts = ParseBuildOptions(args);
        var profile = WorkflowProfileRegistry.Get(opts.WorkflowType);

        // LoneWolf builds are handled exclusively by the proven local PowerShell builder
        // (src/powershell/Invoke-LoneWolfBuild.ps1), invoked directly by the Electron launcher.
        // The provisioner's LoneWolf build/precache path is intentionally disabled so there is
        // no dead or conflicting route. All OTHER workflows (win-install, vendor-iso) still build
        // here, and LoneWolf `staging info` / `sources` queries remain fully functional.
        if (string.Equals(profile.ProvisionMode, "lonewolf", StringComparison.OrdinalIgnoreCase))
            throw new NotSupportedException(
                $"LoneWolf workflow '{profile.Id}' is built by Invoke-LoneWolfBuild.ps1, not the provisioner. " +
                "This build path is disabled by design; the launcher must route LoneWolf builds to the PowerShell builder.");

        // Pre-cache warms the ESP/overlay cache only — no USB disks are written.
        // Match Invoke-LoneWolfBuild.ps1: -PreCacheOnly with -DiskNumbers 0 skips disk selection.
        if (!opts.PreCacheOnly && !opts.OverlayOnly && opts.DiskNumbers.Length == 0)
            throw new ArgumentException("No disk numbers specified");

        var resolved = SourceResolver.Resolve(
            profile,
            opts.ExplicitSource,
            opts.ShareRoot,
            opts.LocalProjectRoot);

        opts.ResolvedSource = resolved;

        if (!string.IsNullOrWhiteSpace(opts.WpeOcPath)) { /* use opts */ }
        else if (!string.IsNullOrWhiteSpace(opts.LocalProjectRoot))
            opts.WpeOcPath = Path.Combine(opts.LocalProjectRoot, "Staging", "WinPE-OCs");
        else
            opts.WpeOcPath = Path.Combine(ConnectDeploymentShare.GetStagingRoot(opts.ShareRoot ?? ProvisioningConstants.DefaultShareRoot), "WinPE-OCs");

        var engine = new BuildEngine();
        return await engine.RunAsync(opts, CancellationToken.None).ConfigureAwait(false);
    }

    private static async Task<int> HandlePreCacheAsync(string[] args)
    {
        var buildArgs = new List<string> { "--precache-only" };
        buildArgs.AddRange(args);
        return await HandleBuildAsync(buildArgs.ToArray()).ConfigureAwait(false);
    }

    private static BuildOptions ParseBuildOptions(string[] args)
    {
        var opts = new BuildOptions
        {
            WorkflowType = GetArg(args, "--workflow") ?? "AMD64",
            AppResourcesPath = GetArg(args, "--app-resources") ?? "",
            CacheRoot = GetArg(args, "--cache-root"),
            ShareRoot = GetArg(args, "--share-root"),
            LocalProjectRoot = GetArg(args, "--local-project-root"),
            ExplicitSource = GetArg(args, "--source"),
            Sequential = HasFlag(args, "--sequential"),
            OverlayOnly = HasFlag(args, "--overlay-only"),
            PreCacheOnly = HasFlag(args, "--precache-only"),
            DevBuild = HasFlag(args, "--dev-build"),
            LauncherVersion = GetArg(args, "--launcher-version"),
            ScriptVersion = GetArg(args, "--script-version"),
            ShareLauncherVersion = GetArg(args, "--share-launcher-version"),
            ShareScriptVersion = GetArg(args, "--share-script-version")
        };

        var disks = GetArg(args, "--disks");
        if (!string.IsNullOrWhiteSpace(disks))
            opts.DiskNumbers = disks.Split(',', StringSplitOptions.RemoveEmptyEntries | StringSplitOptions.TrimEntries)
                .Select(s => int.Parse(s))
                .Distinct()
                .ToArray();

        return opts;
    }

    private static IEnumerable<string>? ParseExtraRoots(string[] args)
    {
        var roots = GetArg(args, "--roots");
        return string.IsNullOrWhiteSpace(roots) ? null : roots.Split(';', StringSplitOptions.RemoveEmptyEntries);
    }

    private static string? GetArg(string[] args, string name)
    {
        for (var i = 0; i < args.Length - 1; i++)
            if (args[i].Equals(name, StringComparison.OrdinalIgnoreCase))
                return args[i + 1];
        return null;
    }

    private static bool HasFlag(string[] args, string name) =>
        args.Any(a => a.Equals(name, StringComparison.OrdinalIgnoreCase));

    private static int OutputJson(object obj)
    {
        Console.WriteLine(JsonSerializer.Serialize(obj, new JsonSerializerOptions
        {
            PropertyNamingPolicy = JsonNamingPolicy.CamelCase,
            WriteIndented = false
        }));
        Console.Out.Flush();
        return 0;
    }

    private static int HandleSelfTest(string[] args)
    {
        if (args.Length > 0 && args[0].Equals("dism-parse", StringComparison.OrdinalIgnoreCase))
        {
            var samples = new (string Line, int Expected)[]
            {
                ("[ 45.0% ]", 45),
                ("[  12% ]", 12),
                ("Processing 1 of 1 [ 99.9% ] complete", 100),
                ("[0%]", 0),
                ("[100% ]", 100),
                ("robocopy in progress", -1)
            };

            var failed = 0;
            foreach (var (line, expected) in samples)
            {
                var ok = DismProgressParser.TryParsePercent(line, out var pct);
                if (expected < 0)
                {
                    if (ok) { Console.Error.WriteLine($"FAIL: expected no match for '{line}'"); failed++; }
                    continue;
                }

                if (!ok || pct != expected)
                {
                    Console.Error.WriteLine($"FAIL: '{line}' => ok={ok} pct={pct} expected={expected}");
                    failed++;
                }
            }

            if (failed > 0) return 1;
            Console.WriteLine("dism-parse: all samples passed");
            return 0;
        }

        if (args.Length > 0 && args[0].Equals("iso-header", StringComparison.OrdinalIgnoreCase))
        {
            var buf = new byte[IsoMediaKind.HeaderBytesNeeded];
            buf[510] = 0x55;
            buf[511] = 0xAA;
            var cd = System.Text.Encoding.ASCII.GetBytes("CD001");
            Buffer.BlockCopy(cd, 0, buf, 0x8001, cd.Length);
            var h = IsoMediaKind.InspectHeader(buf);
            if (!h.Hybrid || !h.Iso9660 || !h.Mbr)
            {
                Console.Error.WriteLine("FAIL: hybrid header not detected");
                return 1;
            }
            if (IsoMediaKind.Plan(h, windowsLayout: true) != IsoWriteKind.WindowsExtract)
            {
                Console.Error.WriteLine("FAIL: windows layout should win");
                return 1;
            }
            Console.WriteLine("iso-header: hybrid and windows-priority passed");
            return 0;
        }

        return Unknown("selftest");
    }

    private static int Unknown(string cmd)
    {
        Console.Error.WriteLine($"Unknown command: {cmd}");
        PrintUsage();
        return 1;
    }

    private static void PrintUsage()
    {
        Console.Error.WriteLine("""
            LoneWolf.Provisioner — USB provisioning engine

            sources scan-local [--roots "C:\ISO;D:\"]
            sources scan-share --workflow AMD64 [--share-root UNC] [--local-project-root PATH]
            sources analyze --path <iso|folder|wim> [--origin manual]
            staging info --workflow AMD64 [--share-root UNC] [--local-project-root PATH]
            build --workflow AMD64 --disks 1,2 --app-resources PATH [--source PATH] [--cache-root PATH]
                  [--share-root UNC] [--local-project-root PATH] [--sequential] [--overlay-only]
            precache --workflow AMD64 --app-resources PATH [--share-root UNC] [--local-project-root PATH]
            """);
    }
}
