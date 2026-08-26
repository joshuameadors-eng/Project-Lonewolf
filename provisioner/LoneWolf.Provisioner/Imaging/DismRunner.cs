namespace LoneWolf.Provisioner.Imaging;

/// <summary>Serializes all DISM /Mount-Image operations — concurrent mounts fail on Windows.</summary>
public sealed class DismRunner
{
    private static readonly SemaphoreSlim GlobalLock = new(1, 1);

    public async Task<ProcessResult> MountImageAsync(
        string imageFile,
        string mountDir,
        bool readOnly,
        CancellationToken ct = default,
        Action<int>? onProgress = null,
        int index = 1)
    {
        await GlobalLock.WaitAsync(ct).ConfigureAwait(false);
        try
        {
            var ro = readOnly ? " /ReadOnly" : "";
            var args = $"/Mount-Image /ImageFile:\"{imageFile}\" /Index:{index} /MountDir:\"{mountDir}\"{ro}";
            return await ProcessRunner.RunAsync("dism.exe", args, ct, onProgress).ConfigureAwait(false);
        }
        finally
        {
            GlobalLock.Release();
        }
    }

    public async Task<ProcessResult> UnmountImageAsync(
        string mountDir,
        bool commit,
        CancellationToken ct = default,
        Action<int>? onProgress = null)
    {
        await GlobalLock.WaitAsync(ct).ConfigureAwait(false);
        try
        {
            var flag = commit ? "/Commit" : "/Discard";
            var args = $"/Unmount-Image /MountDir:\"{mountDir}\" {flag}";
            return await ProcessRunner.RunAsync("dism.exe", args, ct, onProgress).ConfigureAwait(false);
        }
        finally
        {
            GlobalLock.Release();
        }
    }

    public async Task<ProcessResult> AddPackageAsync(
        string mountDir,
        string cabPath,
        CancellationToken ct = default,
        Action<int>? onProgress = null)
    {
        await GlobalLock.WaitAsync(ct).ConfigureAwait(false);
        try
        {
            var args = $"/Image:\"{mountDir}\" /Add-Package /PackagePath:\"{cabPath}\" /Quiet";
            return await ProcessRunner.RunAsync("dism.exe", args, ct, onProgress).ConfigureAwait(false);
        }
        finally
        {
            GlobalLock.Release();
        }
    }
}
