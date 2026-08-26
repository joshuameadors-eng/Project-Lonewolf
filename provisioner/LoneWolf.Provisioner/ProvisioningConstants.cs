namespace LoneWolf.Provisioner;

public static class ProvisioningConstants
{
    public const string DefaultShareRoot = @"\\WIN-HQ5JDEACV3S\Images\FB Image Creation";
    public const string DefaultShareUser = "Reflect";
    public const string DefaultSharePassword = "mer*HWE0upt*rqe@dud";
    public const string DataVolumeLabel = "Project LoneWolf";
    public const string CacheRootBase = @"C:\ProgramData\LoneWolf\EspCache";

    /// <summary>IT-managed vendor ISO folders under Remote\Staging\</summary>
    public const string BitraserShareSubdir = "Bitraser";
    public const string DestructionShareSubdir = "Destruction";
    /// <summary>Share ISO folder for Media Creator hybrid picker (operator may override with local ISO).</summary>
    public const string MediaCreatorShareSubdir = "ISO";

    public static readonly string[] DefaultLocalScanRoots =
    {
        Environment.GetFolderPath(Environment.SpecialFolder.DesktopDirectory),
        Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.UserProfile), "Downloads"),
        Environment.GetFolderPath(Environment.SpecialFolder.MyDocuments),
        @"C:\ISO",
        @"D:\",
        @"C:\Repos",
        Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.CommonApplicationData), "LoneWolf", "Sources")
    };

    public static readonly Guid GptEsp = new("c12a7328-f81f-11d2-ba4b-00a0c93ec93b");
    public static readonly Guid GptData = new("ebd0a0a2-b9e5-4433-87c0-68b6b72699c7");
}
