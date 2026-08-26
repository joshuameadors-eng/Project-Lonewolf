using System.Diagnostics;
using System.Text;
using System.Text.RegularExpressions;
using LoneWolf.Provisioner.Debug;

namespace LoneWolf.Provisioner.Imaging;

public sealed class ProcessResult
{
    public int ExitCode { get; init; }
    public string Output { get; init; } = "";
}

public static class ProcessRunner
{
    public static bool IsRobocopySuccess(int exitCode) => exitCode is >= 0 and <= 7;

    private static readonly Regex RobocopyBytesSummary =
        new(@"^\s*Bytes\s*:\s*([\d,]+)", RegexOptions.IgnoreCase | RegexOptions.Compiled);

    /// <summary>
    /// List-only robocopy pass — returns total bytes that would be copied (matches real /E robocopy).
    /// Reliable on DISM-mounted WIM trees where Directory.EnumerateFiles under-counts.
    /// </summary>
    public static async Task<long> GetRobocopyByteTotalAsync(
        string source,
        string extraArgs,
        CancellationToken ct = default)
    {
        var srcPath = source.EndsWith('\\') ? source : source + "\\";
        var dummyDst = Path.Combine(Path.GetTempPath(), "LW-RoboList-" + Guid.NewGuid().ToString("N")[..8]);
        Directory.CreateDirectory(dummyDst);
        var dstPath = dummyDst + "\\";

        try
        {
            var args =
                $"{QuoteCommandLinePath(srcPath)} {QuoteCommandLinePath(dstPath)} {extraArgs} /L /BYTES /R:0 /W:0 /NC /NDL /NFL /NP";
            var result = await RunAsync("robocopy.exe", args, ct).ConfigureAwait(false);
            return TryParseRobocopySummaryBytes(result.Output);
        }
        finally
        {
            try { Directory.Delete(dummyDst, true); } catch { /* ignore */ }
        }
    }

    internal static long TryParseRobocopySummaryBytes(string output)
    {
        foreach (var line in output.Split('\n'))
        {
            var m = RobocopyBytesSummary.Match(line);
            if (!m.Success) continue;
            if (long.TryParse(m.Groups[1].Value.Replace(",", ""), out var bytes))
                return bytes;
        }

        return 0;
    }

    /// <summary>
    /// Quote a path for CreateProcess. A trailing backslash before " escapes the closing quote
    /// (e.g. "E:\" consumes the quote and breaks robocopy argument parsing).
    /// </summary>
    internal static string QuoteCommandLinePath(string path)
    {
        if (string.IsNullOrEmpty(path)) return "\"\"";
        if (path.EndsWith('\\'))
            return $"\"{path}.\"";
        return $"\"{path}\"";
    }

    public static async Task<ProcessResult> RunAsync(
        string fileName,
        string arguments,
        CancellationToken ct = default,
        Action<int>? onProgress = null)
    {
        var psi = new ProcessStartInfo
        {
            FileName = fileName,
            Arguments = arguments,
            UseShellExecute = false,
            RedirectStandardOutput = true,
            RedirectStandardError = true,
            CreateNoWindow = true,
            StandardOutputEncoding = Encoding.UTF8,
            StandardErrorEncoding = Encoding.UTF8
        };

        using var proc = new Process { StartInfo = psi, EnableRaisingEvents = true };
        var output = new StringBuilder();
        var lastPct = -1;

        void HandleLine(string? line)
        {
            if (line == null) return;
            output.AppendLine(line);
            if (onProgress != null && DismProgressParser.TryParsePercent(line, out var pct) && pct > lastPct)
            {
                lastPct = pct;
                onProgress(pct);
            }
        }

        proc.OutputDataReceived += (_, e) => HandleLine(e.Data);
        proc.ErrorDataReceived += (_, e) => HandleLine(e.Data);

        proc.Start();
        proc.BeginOutputReadLine();
        proc.BeginErrorReadLine();
        await proc.WaitForExitAsync(ct).ConfigureAwait(false);

        return new ProcessResult { ExitCode = proc.ExitCode, Output = output.ToString() };
    }

    /// <summary>
    /// Runs robocopy while polling destination byte size (matches legacy Invoke-LoneWolfBuild.ps1 dism phase).
    /// </summary>
    public static async Task<int> RobocopyWithProgressAsync(
        string source,
        string dest,
        string extraArgs,
        int pctMin,
        int pctMax,
        Action<int> reportProgress,
        CancellationToken ct = default,
        long sourceBytes = 0,
        Action<string>? reportLog = null)
    {
        // Start robocopy immediately — do not block on a full source-tree walk (WIM mounts are huge).
        var srcPath = source.EndsWith('\\') ? source : source + "\\";
        var dstPath = dest.EndsWith('\\') ? dest : dest + "\\";
        var args = $"{QuoteCommandLinePath(srcPath)} {QuoteCommandLinePath(dstPath)} {extraArgs}";

        var psi = new ProcessStartInfo
        {
            FileName = "robocopy.exe",
            Arguments = args,
            UseShellExecute = false,
            RedirectStandardOutput = true,
            RedirectStandardError = true,
            CreateNoWindow = true,
            StandardOutputEncoding = Encoding.UTF8,
            StandardErrorEncoding = Encoding.UTF8
        };

        using var proc = new Process { StartInfo = psi, EnableRaisingEvents = true };
        proc.OutputDataReceived += (_, _) => { };
        proc.ErrorDataReceived += (_, _) => { };

        proc.Start();
        proc.BeginOutputReadLine();
        proc.BeginErrorReadLine();

        var exitTask = proc.WaitForExitAsync(ct);

        reportLog?.Invoke($"robocopy: {srcPath} -> {dstPath}");

        // Compute source size in parallel with robocopy (or use caller-supplied value).
        var srcBytesTask = sourceBytes > 0
            ? Task.FromResult(sourceBytes)
            : CopyProgress.GetDirectoryByteSizeAsync(srcPath, ct);

        var lastPct = -1;
        var pollNum = 0;
        var lastWaitLogPoll = 0;
        long srcBytes = 0;

        while (!exitTask.IsCompleted)
        {
            try
            {
                await Task.Delay(2000, ct).ConfigureAwait(false);
            }
            catch (OperationCanceledException)
            {
                try { proc.Kill(entireProcessTree: true); } catch { /* ignore */ }
                throw;
            }

            if (exitTask.IsCompleted) break;

            pollNum++;
            try
            {
                if (srcBytes <= 0)
                {
                    if (srcBytesTask.IsCompleted)
                    {
                        if (srcBytesTask.IsFaulted)
                        {
                            reportLog?.Invoke("robocopy: source size walk failed — using robocopy /L fallback");
                            srcBytes = Math.Max(1, await GetRobocopyByteTotalAsync(srcPath.TrimEnd('\\'), extraArgs, ct)
                                .ConfigureAwait(false));
                        }
                        else
                            srcBytes = Math.Max(1, srcBytesTask.Result);
                    }
                    else
                    {
                        reportLog?.Invoke($"robocopy: measuring source size ({pollNum * 2}s elapsed)...");
                        continue;
                    }
                }

                var dstBytes = await SafeGetDirectoryByteSizeAsync(dstPath, ct).ConfigureAwait(false);

                // Walk-based sizing can stay at 0 when robocopy has only created junction shells;
                // a periodic robocopy /L pass matches source sizing and sees real copied bytes.
                if (dstBytes <= 0 && pollNum >= 5 && pollNum % 15 == 0)
                {
                    dstBytes = await GetRobocopyByteTotalAsync(dstPath.TrimEnd('\\'), extraArgs, ct)
                        .ConfigureAwait(false);
                    if (dstBytes > 0)
                        reportLog?.Invoke($"robocopy: dest size via /L pass = {CopyProgress.FormatBytes(dstBytes)}");
                }

                if (dstBytes <= 0)
                {
                    // USB/exFAT copies often show no dest bytes until robocopy flushes — avoid spamming every 2s.
                    if (pollNum - lastWaitLogPoll >= 15)
                    {
                        lastWaitLogPoll = pollNum;
                        reportLog?.Invoke(
                            $"robocopy: waiting for destination data at {dstPath} ({pollNum * 2}s elapsed, src={CopyProgress.FormatBytes(srcBytes)})");
                    }
                    continue;
                }

                var ratio = Math.Min(1.0, (double)dstBytes / srcBytes);
                var pct = Math.Min(pctMax, pctMin + (int)((pctMax - pctMin) * ratio));
                if (pct > lastPct)
                {
                    lastPct = pct;
                    reportProgress(pct);
                }

                reportLog?.Invoke(
                    $"robocopy: {CopyProgress.FormatBytes(dstBytes)} / {CopyProgress.FormatBytes(srcBytes)} ({pct}%)");
            }
            catch (Exception ex) when (ex is not OperationCanceledException)
            {
                reportLog?.Invoke($"robocopy: progress poll skipped ({ex.Message})");
            }
        }

        if (srcBytes <= 0)
        {
            try
            {
                srcBytes = Math.Max(1, await srcBytesTask.ConfigureAwait(false));
            }
            catch
            {
                srcBytes = Math.Max(1, await GetRobocopyByteTotalAsync(srcPath.TrimEnd('\\'), extraArgs, ct)
                    .ConfigureAwait(false));
            }
        }

        await exitTask.ConfigureAwait(false);

        // Final poll so the UI does not sit at 0% until BuildEngine emits 100%.
        try
        {
            var finalDst = await SafeGetDirectoryByteSizeAsync(dstPath, ct).ConfigureAwait(false);
            if (finalDst <= 0)
                finalDst = await GetRobocopyByteTotalAsync(dstPath.TrimEnd('\\'), extraArgs.Trim(), ct).ConfigureAwait(false);
            if (finalDst > 0 && srcBytes > 0)
            {
                var finalRatio = Math.Min(1.0, (double)finalDst / srcBytes);
                var finalPct = Math.Min(pctMax, pctMin + (int)((pctMax - pctMin) * finalRatio));
                if (finalPct > lastPct)
                    reportProgress(finalPct);
            }
        }
        catch (Exception ex) when (ex is not OperationCanceledException)
        {
            reportLog?.Invoke($"robocopy: final progress poll skipped ({ex.Message})");
        }

        return proc.ExitCode;
    }

    private static async Task<long> SafeGetDirectoryByteSizeAsync(string path, CancellationToken ct)
    {
        try
        {
            return await CopyProgress.GetDirectoryByteSizeAsync(path, ct).ConfigureAwait(false);
        }
        catch
        {
            return 0;
        }
    }

    public static async Task<int> RobocopyAsync(string source, string dest, string extraArgs = "/E /R:1 /W:2 /NP /NJH /NJS", CancellationToken ct = default)
    {
        var args = $"{QuoteCommandLinePath(source)} {QuoteCommandLinePath(dest)} {extraArgs}";
        var result = await RunAsync("robocopy.exe", args, ct).ConfigureAwait(false);

        // #region agent log
        DbgLog.Write(
            "ProcessRunner.cs:RobocopyAsync",
            IsRobocopySuccess(result.ExitCode) ? "robocopy complete" : "robocopy failed",
            new
            {
                source,
                dest,
                extraArgs,
                args,
                exitCode = result.ExitCode,
                outputTail = result.Output.Length > 2000 ? result.Output[^2000..] : result.Output
            },
            "H5",
            IsRobocopySuccess(result.ExitCode) ? "post-fix" : "pre-fix");
        // #endregion

        return result.ExitCode;
    }
}
