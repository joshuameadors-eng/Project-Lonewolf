using LoneWolf.Provisioner.Disks;
using LoneWolf.Provisioner.Events;

namespace LoneWolf.Provisioner.Imaging;

public static class IsoDiskWriter
{
    /// <summary>dd-style write of the ISO file onto PhysicalDriveN (hybrid / any-OS).</summary>
    public static async Task WriteRawAsync(
        string isoPath,
        int diskNumber,
        JsonEventEmitter emit,
        CancellationToken ct)
    {
        var isoLen = new FileInfo(isoPath).Length;
        if (isoLen <= 0)
            throw new InvalidOperationException("ISO file is empty.");

        await UsbTargetGuard.AssertWritableUsbAsync(diskNumber, isoLen, ct).ConfigureAwait(false);
        await UsbTargetGuard.PrepareForRawWriteAsync(diskNumber, emit, ct).ConfigureAwait(false);

        emit.Phase(diskNumber, "iso-dd");
        emit.Progress(diskNumber, "iso-dd", 0);
        emit.Log(diskNumber, "iso-dd: writing ISO image to physical USB (all data on that stick is erased)");

        var dest = @"\\.\PhysicalDrive" + diskNumber;
        try
        {
            await using var src = new FileStream(isoPath, FileMode.Open, FileAccess.Read, FileShare.Read, 1024 * 1024);
            await using var dst = new FileStream(dest, FileMode.Open, FileAccess.Write, FileShare.ReadWrite, 1024 * 1024);
            var buf = new byte[1024 * 1024];
            long done = 0;
            int lastPct = -1;
            int n;
            while ((n = await src.ReadAsync(buf.AsMemory(0, buf.Length), ct).ConfigureAwait(false)) > 0)
            {
                await dst.WriteAsync(buf.AsMemory(0, n), ct).ConfigureAwait(false);
                done += n;
                var pct = isoLen > 0 ? (int)(done * 100 / isoLen) : 100;
                if (pct != lastPct)
                {
                    lastPct = pct;
                    emit.Progress(diskNumber, "iso-dd", Math.Min(99, pct));
                }
            }
            await dst.FlushAsync(ct).ConfigureAwait(false);
        }
        catch (UnauthorizedAccessException)
        {
            throw new InvalidOperationException(
                "Could not open the USB for raw write. Confirm you selected the USB stick (not a hard disk) and close other programs using it.");
        }
        catch (IOException ex)
        {
            throw new InvalidOperationException("Raw ISO write failed: " + Sanitize(ex.Message));
        }
        finally
        {
            await UsbTargetGuard.BringOnlineAsync(diskNumber, ct).ConfigureAwait(false);
        }

        emit.Progress(diskNumber, "iso-dd", 100);
        emit.Log(diskNumber, "iso-dd: write complete");
    }

    private static string Sanitize(string msg)
    {
        return (msg ?? "").Replace('\u2014', '-').Replace('\u2013', '-');
    }
}
