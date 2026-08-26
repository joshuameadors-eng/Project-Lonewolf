namespace LoneWolf.Provisioner.Profiles;

public sealed class WorkflowProfile
{
    public string Id { get; set; } = "";
    public string Arch { get; set; } = "AMD64";
    public string ProvisionMode { get; set; } = "lonewolf"; // lonewolf | win-install | vendor-iso
    public bool NoPayload { get; set; }
    public bool ForceIsoForNoPayload { get; set; } = true;
    public bool ApplyImage { get; set; } = true;
    public bool IncludeWuPayload { get; set; } = true;
    public string? ShareIsoSubdir { get; set; }
    /// <summary>When false, builds always use the fixed share ISO path (no operator override).</summary>
    public bool AllowOperatorSource { get; set; } = true;
    public string TechInstallScript { get; set; } = "TechInstall.cmd";
    public string AutounattendFile { get; set; } = "Policy\\autounattend.xml";
    public string CacheSuffix { get; set; } = "";
}

public static class WorkflowProfileRegistry
{
    private static readonly Dictionary<string, WorkflowProfile> Profiles = new(StringComparer.OrdinalIgnoreCase)
    {
        ["AMD64"] = new WorkflowProfile
        {
            Id = "AMD64", Arch = "AMD64", ProvisionMode = "lonewolf",
            IncludeWuPayload = true, CacheSuffix = "AMD64"
        },
        ["ARM64"] = new WorkflowProfile
        {
            Id = "ARM64", Arch = "ARM64", ProvisionMode = "lonewolf",
            IncludeWuPayload = true, CacheSuffix = "ARM64"
        },
        ["WIN-INSTALL-AMD64"] = new WorkflowProfile
        {
            Id = "WIN-INSTALL-AMD64", Arch = "AMD64", ProvisionMode = "win-install",
            NoPayload = true, ForceIsoForNoPayload = true, IncludeWuPayload = false,
            TechInstallScript = "TechInstall-Install.cmd",
            AutounattendFile = "Policy\\autounattend-install.xml",
            CacheSuffix = "AMD64-INSTALL"
        },
        ["WIN-INSTALL-ARM64"] = new WorkflowProfile
        {
            Id = "WIN-INSTALL-ARM64", Arch = "ARM64", ProvisionMode = "win-install",
            NoPayload = true, ForceIsoForNoPayload = true, IncludeWuPayload = false,
            TechInstallScript = "TechInstall-Install.cmd",
            AutounattendFile = "Policy\\autounattend-install.xml",
            CacheSuffix = "ARM64-INSTALL"
        },
        ["MEDIA-CREATOR"] = new WorkflowProfile
        {
            Id = "MEDIA-CREATOR", ProvisionMode = "vendor-iso", ApplyImage = false,
            IncludeWuPayload = false, ShareIsoSubdir = ProvisioningConstants.MediaCreatorShareSubdir,
            CacheSuffix = "MEDIA-CREATOR", AllowOperatorSource = true
        },
        ["BITRASER"] = new WorkflowProfile
        {
            Id = "BITRASER", ProvisionMode = "vendor-iso", ApplyImage = false,
            IncludeWuPayload = false, ShareIsoSubdir = ProvisioningConstants.BitraserShareSubdir,
            CacheSuffix = "BITRASER", AllowOperatorSource = false
        },
        ["DESTRUCTION"] = new WorkflowProfile
        {
            Id = "DESTRUCTION", ProvisionMode = "vendor-iso", ApplyImage = false,
            IncludeWuPayload = false, ShareIsoSubdir = ProvisioningConstants.DestructionShareSubdir,
            CacheSuffix = "DESTRUCTION", AllowOperatorSource = false
        }
    };

    public static WorkflowProfile Get(string workflowType)
    {
        var key = workflowType.ToUpperInvariant();
        if (Profiles.TryGetValue(key, out var p)) return p;
        throw new ArgumentException($"Unknown workflow: {workflowType}");
    }

    public static bool TryGet(string workflowType, out WorkflowProfile profile)
    {
        return Profiles.TryGetValue(workflowType.ToUpperInvariant(), out profile!);
    }
}
