$log    = "C:\Repos\ProjectLoneWolfLauncher\extract-iso.log"
$isoPath = "C:\Repos\ProjectLoneWolfLauncher\Remote\Staging\ISO\25h2_updates_6.18(amd64).ISO"
$dstDir  = "C:\Repos\ProjectLoneWolfLauncher\Remote\Staging\AMD64"

"[START $(Get-Date -Format 'HH:mm:ss')] Mounting ISO: $isoPath" | Out-File $log -Encoding utf8

$diskImage = $null
try {
    $diskImage = Mount-DiskImage -ImagePath $isoPath -PassThru -ErrorAction Stop
    $driveLetter = ''
    for ($r = 0; $r -lt 5 -and [string]::IsNullOrEmpty($driveLetter); $r++) {
        if ($r -gt 0) { Start-Sleep -Seconds 1 }
        $vol = $diskImage | Get-Volume -ErrorAction SilentlyContinue
        if ($vol -and $vol.DriveLetter) { $driveLetter = $vol.DriveLetter + ':\' }
    }
    "[$(Get-Date -Format 'HH:mm:ss')] Mounted at $driveLetter" | Add-Content $log

    "[$(Get-Date -Format 'HH:mm:ss')] Robocopy -> $dstDir (excluding install.wim/esd/swm)" | Add-Content $log
    & robocopy.exe $driveLetter $dstDir /E /XF 'install.wim' 'install.esd' 'install.swm' /R:1 /W:1 /NP /NJH /NJS 2>&1 |
        Tee-Object -FilePath $log -Append

    "[DONE $(Get-Date -Format 'HH:mm:ss')] ISO files extracted to $dstDir" | Add-Content $log
} catch {
    "[ERROR $(Get-Date -Format 'HH:mm:ss')] $_" | Add-Content $log
} finally {
    if ($diskImage) {
        Dismount-DiskImage -ImagePath $isoPath -ErrorAction SilentlyContinue | Out-Null
        "[$(Get-Date -Format 'HH:mm:ss')] ISO dismounted." | Add-Content $log
    }
}
