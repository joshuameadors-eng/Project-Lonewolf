<#
.SYNOPSIS
  Embeds a requireAdministrator UAC manifest into the built portable EXE.
  Run this after `npm run build` to ensure UAC always prompts on launch.
#>
[CmdletBinding()]
param()

$ErrorActionPreference = 'Stop'

# Find x64 mt.exe in Windows SDK — always prefer x64 over x86/arm64
$sdkBinRoots = @(
  'C:\Program Files (x86)\Windows Kits\10\bin',
  'C:\Program Files\Windows Kits\10\bin'
)

$mtExe = $null
foreach ($root in $sdkBinRoots) {
  if (-not (Test-Path $root)) { continue }
  # Look for versioned subdirectories (e.g. 10.0.26100.0), newest first
  $verDirs = Get-ChildItem -Path $root -Directory -ErrorAction SilentlyContinue |
             Where-Object { $_.Name -match '^\d+\.' } |
             Sort-Object { [version]($_.Name -replace '[^\d.]','') } -Descending
  foreach ($vd in $verDirs) {
    $candidate = Join-Path $vd.FullName 'x64\mt.exe'
    if (Test-Path $candidate) { $mtExe = $candidate; break }
    $candidate = Join-Path $vd.FullName 'x86\mt.exe'
    if (Test-Path $candidate) { $mtExe = $candidate; break }
  }
  if ($mtExe) { break }
  # Flat layout fallback (no version subdir)
  foreach ($arch in @('x64','x86')) {
    $candidate = Join-Path $root "$arch\mt.exe"
    if (Test-Path $candidate) { $mtExe = $candidate; break }
  }
  if ($mtExe) { break }
}

if (-not $mtExe) {
  Write-Error 'mt.exe (x64) not found. Install the Windows 10/11 SDK via Visual Studio Installer or winget.'
  exit 1
}
Write-Host "Using mt.exe: $mtExe"

$exePath = Join-Path $PSScriptRoot 'dist\LoneWolf-Launcher.exe'
if (-not (Test-Path $exePath)) {
  Write-Error "EXE not found at: $exePath`nRun 'npm run build' first."
  exit 1
}

$manifestContent = @'
<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<assembly xmlns="urn:schemas-microsoft-com:asm.v1" manifestVersion="1.0">
  <trustInfo xmlns="urn:schemas-microsoft-com:asm.v3">
    <security>
      <requestedPrivileges>
        <requestedExecutionLevel level="requireAdministrator" uiAccess="false"/>
      </requestedPrivileges>
    </security>
  </trustInfo>
</assembly>
'@

$manifestPath = Join-Path $env:TEMP 'lonewolf-uac.manifest'
Set-Content -LiteralPath $manifestPath -Value $manifestContent -Encoding UTF8

try {
  Write-Host "Embedding manifest into: $exePath"
  & $mtExe -nologo -manifest $manifestPath -outputresource:"`"$exePath`";#1" 2>&1 | ForEach-Object { Write-Host $_ }
  if ($LASTEXITCODE -ne 0) { throw "mt.exe exited with code $LASTEXITCODE" }
  Write-Host 'Manifest embedded successfully. UAC will always prompt on launch.'
} finally {
  Remove-Item -LiteralPath $manifestPath -ErrorAction SilentlyContinue
}
