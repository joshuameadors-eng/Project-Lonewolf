#Requires -Version 5.1
<#
  Compile LoneWolf-Launcher-Setup.exe (Framework 4.8 WinForms host + embedded PS1).
  This file is the unversioned installer tool. It downloads the latest portable
  launcher from public latest.json at install time. Do not bake NSIS or a stale
  dist exe into Setup (that made Setup look like launcher 5.4.x and NSIS
  uninstall deleted the desktop shortcut on re-run).
#>
[CmdletBinding()]
param(
    [string]$RepoRoot = '',
    [string]$OutputExe = ''
)

$ErrorActionPreference = 'Stop'
if (-not $RepoRoot) { $RepoRoot = (Resolve-Path (Join-Path $PSScriptRoot '..')).Path }

$csc = Join-Path ${env:WINDIR} 'Microsoft.NET\Framework64\v4.0.30319\csc.exe'
if (-not (Test-Path -LiteralPath $csc)) { throw "csc.exe not found: $csc (.NET Framework 4.8 targeting pack)" }

$dist = Join-Path $RepoRoot 'dist'
if (-not (Test-Path -LiteralPath $dist)) { New-Item -ItemType Directory -Path $dist -Force | Out-Null }

$outExe = if ($OutputExe) { $OutputExe } else { Join-Path $dist 'LoneWolf-Launcher-Setup.exe' }
$outDir = Split-Path $outExe -Parent
if (-not (Test-Path -LiteralPath $outDir)) { New-Item -ItemType Directory -Path $outDir -Force | Out-Null }

# electron-builder used to write NSIS to this same filename. Never wrap it.
$staleNsis = Join-Path $dist 'LoneWolf-Launcher-Nsis.exe'
if ((Test-Path -LiteralPath $outExe) -and -not $OutputExe) {
    $len = (Get-Item -LiteralPath $outExe).Length
    if ($len -gt 2MB) {
        Write-Host "Replacing large dist Setup.exe (likely leftover NSIS) with the bootstrapper."
        if (Test-Path -LiteralPath $staleNsis) { Remove-Item -LiteralPath $staleNsis -Force -ErrorAction SilentlyContinue }
        Move-Item -LiteralPath $outExe -Destination $staleNsis -Force
    }
}

$icon = Join-Path $RepoRoot 'assets\icon.ico'
$hostCs = Join-Path $RepoRoot 'installer\LoneWolfSetupHost.cs'
$manifest = Join-Path $RepoRoot 'installer\app.manifest'
$ps1 = Join-Path $RepoRoot 'installer\Install-LoneWolfLauncher.ps1'

# Installer tool identity: never track launcherVersion (5.4.x).
$asmInfo = Join-Path $env:TEMP ('LwSetupAssemblyInfo-' + [guid]::NewGuid().ToString('n') + '.cs')
@(
    'using System.Reflection;'
    '[assembly: AssemblyTitle("LoneWolf Installer")]'
    '[assembly: AssemblyProduct("FirstBase Installer")]'
    '[assembly: AssemblyCompany("FirstBase")]'
    '[assembly: AssemblyDescription("Installs the latest Project LoneWolf Launcher. This tool is not versioned with the launcher.")]'
    '[assembly: AssemblyVersion("0.0.0.0")]'
    '[assembly: AssemblyFileVersion("0.0.0.0")]'
    '[assembly: AssemblyInformationalVersion("installer")]'
) | Set-Content -LiteralPath $asmInfo -Encoding ASCII

$sidebar = Join-Path $RepoRoot 'build\installerSidebar.bmp'
$rtJson = Join-Path $RepoRoot 'installer\dotnet-runtime.json'
$cscArgs = @(
    '/nologo', '/t:winexe', '/platform:x64',
    "/out:$outExe",
    "/win32manifest:$manifest",
    "/resource:$ps1,Install-LoneWolfLauncher.ps1",
    '/r:System.Windows.Forms.dll',
    '/r:System.Drawing.dll',
    $hostCs,
    $asmInfo
)
if (Test-Path -LiteralPath $icon) { $cscArgs = @("/resource:$icon,icon.ico") + $cscArgs }
if (Test-Path -LiteralPath $sidebar) { $cscArgs = @("/resource:$sidebar,installerSidebar.bmp") + $cscArgs }
if (Test-Path -LiteralPath $rtJson) { $cscArgs = @("/resource:$rtJson,dotnet-runtime.json") + $cscArgs }
if (Test-Path -LiteralPath $icon) { $cscArgs = @("/win32icon:$icon") + $cscArgs }

& $csc @cscArgs
if ($LASTEXITCODE -ne 0) {
    Remove-Item -LiteralPath $asmInfo -Force -ErrorAction SilentlyContinue
    throw "csc failed: $LASTEXITCODE"
}
Remove-Item -LiteralPath $asmInfo -Force -ErrorAction SilentlyContinue

Write-Host "Bootstrapper (unversioned installer tool): $outExe ($((Get-Item $outExe).Length) bytes)"
