#Requires -Version 5.1
<#
.SYNOPSIS
  One-time admin helper: pre-injects WinPE-Startnet.cmd into boot.wim at staging time.

.DESCRIPTION
  Run this script ONCE after extracting the ISO with _extract-iso.ps1 and (optionally)
  after staging WinPE OC packages with _stage-winpe-ocs.ps1.

  The script mounts boot.wim index 1 and 2 via DISM, injects WinPE-Startnet.cmd into
  Windows\System32\startnet.cmd, patches winpeshl.ini to suppress setup.exe, and
  optionally adds WinPE-WMI / WinPE-NetFX / WinPE-Scripting / WinPE-PowerShell from
  Remote\Staging\WinPE-OCs\.

  On success a sentinel file (boot.wim.lw-injected) is written next to boot.wim,
  containing the SHA256 hash of WinPE-Startnet.cmd.  The LoneWolf Launcher compares
  this hash at build time and skips the 8-15 minute DISM injection step when it
  matches, reducing pre-cache to roughly 1 minute (file copy only).

  Re-run whenever WinPE-Startnet.cmd changes to refresh the pre-injected boot.wim.

.EXAMPLE
  .\_inject-boot-wim.ps1

.NOTES
  Requires Administrator elevation.
  Requires DISM (dism.exe) - present on all modern Windows installations.
#>

[CmdletBinding()]
param()

$ErrorActionPreference = 'Stop'

# ---------------------------------------------------------------------------
# Elevation check
# ---------------------------------------------------------------------------
$isAdmin = [Security.Principal.WindowsPrincipal]::new(
    [Security.Principal.WindowsIdentity]::GetCurrent()
).IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)

if (-not $isAdmin) {
    Write-Error "This script must be run as Administrator.`nRight-click PowerShell and choose 'Run as administrator', then re-run."
    exit 1
}

# ---------------------------------------------------------------------------
# Paths
# ---------------------------------------------------------------------------
$bootWimPath  = Join-Path $PSScriptRoot 'Remote\Staging\AMD64\sources\boot.wim'
$wpeOcPath    = Join-Path $PSScriptRoot 'Remote\Staging\WinPE-OCs'
$startnetPath = Join-Path $PSScriptRoot 'src\payload\Deploy\WinPE-Startnet.cmd'
$sentinelPath = Join-Path $PSScriptRoot 'Remote\Staging\AMD64\sources\boot.wim.lw-injected'

Write-Host ''
Write-Host 'LoneWolf boot.wim pre-injector'
Write-Host '================================='
Write-Host "  boot.wim   : $bootWimPath"
Write-Host "  startnet   : $startnetPath"
Write-Host "  WinPE-OCs  : $wpeOcPath"
Write-Host "  sentinel   : $sentinelPath"
Write-Host ''

# ---------------------------------------------------------------------------
# Validate required files
# ---------------------------------------------------------------------------
if (-not (Test-Path -LiteralPath $bootWimPath)) {
    Write-Error "boot.wim not found at:`n  $bootWimPath`n`nRun _extract-iso.ps1 first to extract the ISO contents into Remote\Staging\AMD64\."
    exit 1
}

if (-not (Test-Path -LiteralPath $startnetPath)) {
    Write-Error "WinPE-Startnet.cmd not found at:`n  $startnetPath`n`nEnsure the repository is complete and the src\payload\Deploy\ directory is present."
    exit 1
}

# WinPE-OCs are optional - injection proceeds without them
$hasOcs = Test-Path -LiteralPath $wpeOcPath
if (-not $hasOcs) {
    Write-Warning "WinPE-OCs directory not found at: $wpeOcPath`nProceeding without OC packages - PowerShell will not be available in WinPE."
    Write-Warning "Run _stage-winpe-ocs.ps1 first if you need PowerShell in WinPE, then re-run this script."
    Write-Host ''
}

# ---------------------------------------------------------------------------
# Sentinel check - skip if boot.wim is already up to date
# ---------------------------------------------------------------------------
$currentHash = (Get-FileHash -LiteralPath $startnetPath -Algorithm SHA256).Hash

if (Test-Path -LiteralPath $sentinelPath) {
    $existingHash = (Get-Content -LiteralPath $sentinelPath -Raw -Encoding ascii).Trim()
    if ($existingHash -eq $currentHash) {
        Write-Host 'boot.wim is already up to date, skipping injection.' -ForegroundColor Green
        Write-Host "  Sentinel hash : $existingHash"
        Write-Host ''
        exit 0
    }
    Write-Host "Sentinel hash mismatch - re-injecting boot.wim."
    Write-Host "  Stored hash   : $existingHash"
    Write-Host "  Current hash  : $currentHash"
    Write-Host ''
}

# ---------------------------------------------------------------------------
# Clear ReadOnly attribute - boot.wim copied from a network share often
# has ReadOnly set; DISM /Commit must write back to the file.
# ---------------------------------------------------------------------------
try {
    Set-ItemProperty -LiteralPath $bootWimPath -Name IsReadOnly -Value $false -ErrorAction Stop
} catch {
    Write-Warning "Could not clear ReadOnly on boot.wim: $($_.Exception.Message)"
}

# ---------------------------------------------------------------------------
# Inject indexes 1 and 2
# ---------------------------------------------------------------------------
$mountBase  = Join-Path $env:TEMP 'LWInject'
$scriptError = $null

foreach ($wimIndex in 1, 2) {
    if ($scriptError) { break }

    $mountDir  = Join-Path $mountBase ([guid]::NewGuid().ToString('N').Substring(0, 8))
    $isMounted = $false

    try {
        New-Item -ItemType Directory -Force -Path $mountDir | Out-Null
        Write-Host "Mounting boot.wim index $wimIndex ..."
        Write-Host "  Mount dir : $mountDir"

        $mountOut = & dism.exe /Mount-Image /ImageFile:"$bootWimPath" /Index:$wimIndex /MountDir:"$mountDir" 2>&1
        if ($LASTEXITCODE -ne 0) {
            throw "DISM /Mount-Image index $wimIndex failed (exit $LASTEXITCODE): $($mountOut -join ' | ')"
        }
        $isMounted = $true

        $sysDir = Join-Path $mountDir 'Windows\System32'
        if (-not (Test-Path -LiteralPath $sysDir)) {
            throw "Windows\System32 not found in mounted boot.wim index $wimIndex (unexpected WIM structure)"
        }

        # Inject startnet.cmd
        $targetStartnet = Join-Path $sysDir 'startnet.cmd'
        Copy-Item -LiteralPath $startnetPath -Destination $targetStartnet -Force
        Write-Host "  [OK] startnet.cmd written (index $wimIndex)"

        # Patch winpeshl.ini to suppress setup.exe and launch startnet.cmd instead.
        # The stock boot.wim winpeshl.ini has a [LaunchApps] entry pointing to
        # \sources\setup.exe which causes the Windows language-selection screen.
        $winpeshlPath = Join-Path $sysDir 'winpeshl.ini'
        Set-ItemProperty -LiteralPath $winpeshlPath -Name IsReadOnly -Value $false -ErrorAction SilentlyContinue
        [System.IO.File]::WriteAllText(
            $winpeshlPath,
            "[LaunchApps]`r`ncmd.exe, /c X:\Windows\System32\startnet.cmd`r`n",
            [System.Text.Encoding]::ASCII
        )
        Write-Host "  [OK] winpeshl.ini patched (index $wimIndex) - setup.exe suppressed"

        # Add WinPE OC packages when staged cabs are present.
        # Non-fatal: a missing cab is skipped; a DISM failure is warned and skipped.
        if ($hasOcs) {
            foreach ($pkg in @('WinPE-WMI', 'WinPE-NetFX', 'WinPE-Scripting', 'WinPE-PowerShell')) {
                $cabFile = Join-Path $wpeOcPath "$pkg.cab"
                if (Test-Path -LiteralPath $cabFile) {
                    Write-Host "  Adding $pkg to index $wimIndex ..."
                    & dism.exe /Image:"$mountDir" /Add-Package /PackagePath:"$cabFile" /Quiet 2>&1 | Out-Null
                    if ($LASTEXITCODE -ne 0) {
                        Write-Warning "  $pkg /Add-Package failed (exit $LASTEXITCODE) - skipping package (non-fatal)"
                    } else {
                        Write-Host "  [OK] $pkg added (index $wimIndex)"
                    }
                } else {
                    Write-Warning "  $pkg.cab not found in $wpeOcPath - skipping package"
                }
            }
        }

        Write-Host "Committing boot.wim index $wimIndex ..."
        $unmountOut = & dism.exe /Unmount-Image /MountDir:"$mountDir" /Commit 2>&1
        if ($LASTEXITCODE -ne 0) {
            throw "DISM /Unmount-Image /Commit index $wimIndex failed (exit $LASTEXITCODE): $($unmountOut -join ' | ')"
        }
        $isMounted = $false
        Write-Host "  [OK] Index $wimIndex committed successfully." -ForegroundColor Green
        Write-Host ''

    } catch {
        $scriptError = "Injection FAILED (index $wimIndex): $($_.Exception.Message)"
    } finally {
        if ($isMounted) {
            Write-Host "  Discarding uncommitted WIM mount (index $wimIndex, cleanup) ..."
            & dism.exe /Unmount-Image /MountDir:"$mountDir" /Discard 2>&1 | Out-Null
        }
        Remove-Item -LiteralPath $mountDir -Recurse -Force -ErrorAction SilentlyContinue
    }
}

# Clean up mount base dir if empty
Remove-Item -LiteralPath $mountBase -Force -ErrorAction SilentlyContinue

if ($scriptError) {
    Write-Error $scriptError
    exit 1
}

# ---------------------------------------------------------------------------
# Write sentinel
# ---------------------------------------------------------------------------
# SHA256 hash of WinPE-Startnet.cmd written as plain ASCII text.
# The launcher compares this at build time to decide whether to skip injection.
$currentHash | Set-Content -LiteralPath $sentinelPath -Encoding ascii

Write-Host '== Injection complete ================================================='
Write-Host ''
Write-Host '  boot.wim has been pre-injected with WinPE-Startnet.cmd.' -ForegroundColor Green
Write-Host "  Sentinel written : $sentinelPath"
Write-Host "  SHA256 hash      : $currentHash"
Write-Host ''
Write-Host '  The LoneWolf Launcher will now SKIP DISM injection at build time.'
Write-Host '  Pre-cache will take ~1 minute (file copy) instead of 8-15 minutes.'
Write-Host ''
Write-Host '  Re-run this script whenever src\payload\Deploy\WinPE-Startnet.cmd changes.'
Write-Host '======================================================================'
Write-Host ''
