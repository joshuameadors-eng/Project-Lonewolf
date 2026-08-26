using System.Text.Json;

namespace LoneWolf.Provisioner.Debug;

internal static class DbgLog
{
    private const string LogPath = @"C:\Repos\debug-daf1b1.log";
    private const string SessionId = "daf1b1";

    public static void Write(string location, string message, object? data, string hypothesisId, string runId = "pre-fix")
    {
        try
        {
            var line = JsonSerializer.Serialize(new
            {
                sessionId = SessionId,
                timestamp = DateTimeOffset.UtcNow.ToUnixTimeMilliseconds(),
                location,
                message,
                data,
                hypothesisId,
                runId
            });
            File.AppendAllText(LogPath, line + Environment.NewLine);
        }
        catch { /* ignore debug log failures */ }
    }
}
