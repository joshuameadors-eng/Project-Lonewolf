using System.Text.RegularExpressions;

namespace LoneWolf.Provisioner.Imaging;

/// <summary>Parses DISM console progress lines such as "[ 45.0% ]".</summary>
public static partial class DismProgressParser
{
    [GeneratedRegex(@"\[\s*(\d+(?:\.\d+)?)\s*%\s*\]", RegexOptions.Compiled)]
    private static partial Regex ProgressPattern();

    public static bool TryParsePercent(string? line, out int pct)
    {
        pct = 0;
        if (string.IsNullOrWhiteSpace(line)) return false;

        var match = ProgressPattern().Match(line);
        if (!match.Success) return false;
        if (!double.TryParse(match.Groups[1].Value, out var value)) return false;

        pct = Math.Clamp((int)Math.Round(value), 0, 100);
        return true;
    }
}
