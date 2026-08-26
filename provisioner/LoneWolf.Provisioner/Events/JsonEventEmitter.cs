using System.Text.Json;
using System.Text.Json.Serialization;

namespace LoneWolf.Provisioner.Events;

public sealed class JsonEventEmitter
{
    private static readonly JsonSerializerOptions Options = new()
    {
        DefaultIgnoreCondition = JsonIgnoreCondition.WhenWritingNull,
        PropertyNamingPolicy = JsonNamingPolicy.CamelCase
    };

    public void Emit(Dictionary<string, object?> data)
    {
        Console.WriteLine(JsonSerializer.Serialize(data, Options));
        Console.Out.Flush();
    }

    public void Phase(int disk, string phase) =>
        Emit(new() { ["event"] = "phase", ["disk"] = disk, ["phase"] = phase });

    public void Progress(int disk, string phase, int pct) =>
        Emit(new() { ["event"] = "progress", ["disk"] = disk, ["phase"] = phase, ["pct"] = pct });

    public void Start(int disk, string workflow) =>
        Emit(new() { ["event"] = "start", ["disk"] = disk, ["workflow"] = workflow });

    public void Done(int disk, bool success, string? message = null)
    {
        var d = new Dictionary<string, object?> { ["event"] = "done", ["disk"] = disk, ["success"] = success };
        if (message != null) d["message"] = message;
        Emit(d);
    }

    public void Error(int disk, string message, string? code = null)
    {
        var d = new Dictionary<string, object?> { ["event"] = "error", ["disk"] = disk, ["message"] = message };
        if (code != null) d["code"] = code;
        Emit(d);
    }

    public void Log(int disk, string message) =>
        Emit(new() { ["event"] = "log", ["disk"] = disk, ["message"] = message });

    public void Summary(int[] succeeded, int[] failed) =>
        Emit(new() { ["event"] = "summary", ["succeeded"] = succeeded, ["failed"] = failed });

    public void Exit(int code) =>
        Emit(new() { ["event"] = "exit", ["code"] = code });
}
