#Requires -RunAsAdministrator
<#
.SYNOPSIS
  Copies the required WinPE PowerShell OC packages from the local ADK installation
  into Remote\Staging\WinPE-OCs\ so the builder can add PowerShell to boot.wim.

.DESCRIPTION
  Run this script ONCE on a machine that has the Windows ADK + WinPE add-on installed,
  then commit or upload the resulting .cab files to the share so every builder machine
  can use them without needing ADK locally.

  Required packages (in dependency order):
    WinPE-WMI, WinPE-NetFX, WinPE-Scripting, WinPE-PowerShell

  Default ADK path (Windows 11 / ADK 10):
    C:\Program Files (x86)\Windows Kits\10\Assessment and Deployment Kit\
      Windows Preinstallation Environment\amd64\WinPE_OCs\

.PARAMETER Arch
  Target WinPE architecture. Defaults to 'amd64'. Use 'arm64' for ARM builds.

.PARAMETER AdkRoot
  Override the ADK root path if the ADK is installed in a non-default location.

.PARAMETER Destination
  Override the destination folder. Defaults to .\Remote\Staging\WinPE-OCs\
  relative to this script.

.EXAMPLE
  .\_stage-winpe-ocs.ps1
  .\_stage-winpe-ocs.ps1 -Arch arm64
  .\_stage-winpe-ocs.ps1 -AdkRoot 'D:\ADK'
#>

[CmdletBinding()]
param(
    [ValidateSet('amd64','arm64')]
    [string] $Arch        = 'amd64',

    [string] $AdkRoot     = 'C:\Program Files (x86)\Windows Kits\10\Assessment and Deployment Kit',

    [string] $Destination = ''
)

$ErrorActionPreference = 'Stop'

# --- Resolve destination ---
if (-not $Destination) {
    $Destination = Join-Path $PSScriptRoot 'Remote\Staging\WinPE-OCs'
}

# --- Locate ADK WinPE OC directory ---
$winpeOcDir = Join-Path $AdkRoot "Windows Preinstallation Environment\$Arch\WinPE_OCs"

if (-not (Test-Path -LiteralPath $winpeOcDir)) {
    $localeFallback = Join-Path $winpeOcDir 'en-us'
    if (Test-Path -LiteralPath $localeFallback) {
        $winpeOcDir = $localeFallback
    } else {
        Write-Error "ADK WinPE OC directory not found at: $winpeOcDir`n`nMake sure the Windows ADK and the WinPE Add-on are both installed.`nDownload from: https://learn.microsoft.com/en-us/windows-hardware/get-started/adk-install`n`nYou can also pass -AdkRoot to specify a custom ADK installation path."
        exit 1
    }
}

Write-Host "ADK WinPE OC source : $winpeOcDir"
Write-Host "Destination         : $Destination"
Write-Host ''

# --- Required packages (in dependency order) ---
$packages = @(
    'WinPE-WMI',
    'WinPE-NetFX',
    'WinPE-Scripting',
    'WinPE-PowerShell'
)

# --- Create destination directory ---
New-Item -ItemType Directory -Force -Path $Destination | Out-Null

# --- Copy each package ---
$copied  = [System.Collections.Generic.List[string]]::new()
$missing = [System.Collections.Generic.List[string]]::new()

foreach ($pkg in $packages) {
    $cabName = "$pkg.cab"
    $srcPrimary  = Join-Path $winpeOcDir $cabName
    $srcFallback = Join-Path $winpeOcDir "en-us\$cabName"

    if      (Test-Path -LiteralPath $srcPrimary)  { $src = $srcPrimary  }
    elseif  (Test-Path -LiteralPath $srcFallback) { $src = $srcFallback }
    else                                          { $src = $null        }

    if ($src) {
        $dst = Join-Path $Destination $cabName
        Copy-Item -LiteralPath $src -Destination $dst -Force
        $sizeMB = [math]::Round((Get-Item -LiteralPath $dst).Length / 1MB, 1)
        Write-Host "  [OK]  $cabName  ($sizeMB MB)  <- $src"
        $copied.Add($cabName)
    } else {
        Write-Warning "  [--]  $cabName  NOT FOUND in $winpeOcDir"
        $missing.Add($cabName)
    }
}

Write-Host ''
Write-Host '-- Summary --------------------------------------------------'
Write-Host "  Copied  : $($copied.Count) / $($packages.Count) packages"

if ($missing.Count -gt 0) {
    Write-Host "  Missing : $($missing -join ', ')" -ForegroundColor Yellow
    Write-Host ''
    Write-Warning "Some packages were not found. The builder will skip missing cabs and WinPE may boot without PowerShell."
} else {
    Write-Host '  All required WinPE PowerShell packages staged successfully.' -ForegroundColor Green
    Write-Host ''
    Write-Host 'Next steps:'
    Write-Host '  1. Upload Remote\Staging\WinPE-OCs\ to the share so all builder machines can use it.'
    Write-Host '  2. Run the LoneWolf Launcher - boot.wim will now include PowerShell automatically.'
}
