#Requires -Version 5.1
<#
  Compile LoneWolf-Launcher-Setup.exe (Framework 4.8 WinForms host + embedded PS1).
  If electron-builder NSIS/portable exist in dist/, rename inner NSIS and append
  a zip overlay so the bootstrapper does not need a second download.
#>
[CmdletBinding()]
param(
    [string]$RepoRoot = '',
    [string]$OutputExe = '',
    [switch]$SkipOverlay
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

function Test-LwHasPayloadOverlay {
    param([string]$ExePath)
    if (-not (Test-Path -LiteralPath $ExePath)) { return $false }
    $fs = [System.IO.File]::OpenRead((Resolve-Path -LiteralPath $ExePath).Path)
    try {
        $magic = [Text.Encoding]::ASCII.GetBytes('LWPAYLOAD1')
        if ($fs.Length -lt ($magic.Length + 8)) { return $false }
        $fs.Seek(-$magic.Length, 'End') | Out-Null
        $buf = New-Object byte[] $magic.Length
        [void]$fs.Read($buf, 0, $buf.Length)
        return ([Text.Encoding]::ASCII.GetString($buf) -eq 'LWPAYLOAD1')
    } finally { $fs.Close() }
}

$nsisOut = Join-Path $dist 'LoneWolf-Launcher-Setup.exe'
$inner = Join-Path $dist 'LoneWolf-Launcher-Nsis.exe'
# electron-builder writes a fresh NSIS to Setup.exe. Always replace the inner
# copy. If we skip when LoneWolf-Launcher-Nsis.exe already exists, the next
# wrap keeps a stale inner installer (outer Setup stamp can be new while the
# installed exe stays old).
if (-not $OutputExe) {
    if (Test-Path -LiteralPath $nsisOut) {
        $nsisLen = (Get-Item -LiteralPath $nsisOut).Length
        $alreadyWrapped = Test-LwHasPayloadOverlay $nsisOut
        if ($nsisLen -gt 2MB -and -not $alreadyWrapped) {
            Move-Item -LiteralPath $nsisOut -Destination $inner -Force
            Write-Host "Moved electron-builder NSIS to $inner (replaced any previous inner installer)"
        }
    }
}

$icon = Join-Path $RepoRoot 'assets\icon.ico'
$hostCs = Join-Path $RepoRoot 'installer\LoneWolfSetupHost.cs'
$manifest = Join-Path $RepoRoot 'installer\app.manifest'
$ps1 = Join-Path $RepoRoot 'installer\Install-LoneWolfLauncher.ps1'

$pkg = Get-Content -Raw -LiteralPath (Join-Path $RepoRoot 'package.json') | ConvertFrom-Json
$lwVer = [string]$pkg.version
$asmVer = if ($lwVer -match '^\d+\.\d+\.\d+$') { "$lwVer.0" } else { $lwVer }
$asmInfo = Join-Path $env:TEMP ('LwSetupAssemblyInfo-' + [guid]::NewGuid().ToString('n') + '.cs')
@(
    'using System.Reflection;'
    '[assembly: AssemblyTitle("Project LoneWolf Launcher Setup")]'
    '[assembly: AssemblyProduct("Project LoneWolf Launcher")]'
    '[assembly: AssemblyCompany("FirstBase")]'
    "[assembly: AssemblyVersion(`"$asmVer`")]"
    "[assembly: AssemblyFileVersion(`"$asmVer`")]"
    "[assembly: AssemblyInformationalVersion(`"$lwVer`")]"
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
    '/r:System.IO.Compression.dll',
    '/r:System.IO.Compression.FileSystem.dll',
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

if (-not $SkipOverlay) {
    $portable = Join-Path $dist 'LoneWolf-Launcher.exe'
    if (-not (Test-Path -LiteralPath $inner)) {
        throw 'REFUSE: missing dist\LoneWolf-Launcher-Nsis.exe. Run npm run build so electron-builder produces NSIS, then wrap. A leftover inner installer must not be skipped.'
    }
    $pack = @()
    $pack += @{ Name = 'LoneWolf-Launcher-Nsis.exe'; Path = $inner }
    if (Test-Path -LiteralPath $portable) { $pack += @{ Name = 'LoneWolf-Launcher.exe'; Path = $portable } }
    if ($pack.Count -gt 0) {
        $assertVer = Join-Path $RepoRoot 'scripts\Assert-LwExeVersion.ps1'
        foreach ($f in $pack) {
            & powershell.exe -NoProfile -ExecutionPolicy Bypass -File $assertVer -Path $f.Path -Expected $lwVer
            if ($LASTEXITCODE -ne 0) {
                throw ("REFUSE: {0} FileVersion does not match {1}. Delete dist\\LoneWolf-Launcher-Nsis.exe and run npm run build so the inner NSIS is rebuilt." -f $f.Name, $lwVer)
            }
        }
        $stage = Join-Path $env:TEMP ('lw-overlay-' + [guid]::NewGuid().ToString('n'))
        New-Item -ItemType Directory -Path $stage -Force | Out-Null
        foreach ($f in $pack) {
            Copy-Item -LiteralPath $f.Path -Destination (Join-Path $stage $f.Name) -Force
        }
        $zip = Join-Path $env:TEMP ('lw-overlay-' + [guid]::NewGuid().ToString('n') + '.zip')
        if (Test-Path -LiteralPath $zip) { Remove-Item -LiteralPath $zip -Force }
        Compress-Archive -Path (Join-Path $stage '*') -DestinationPath $zip -Force
        $zipBytes = [System.IO.File]::ReadAllBytes($zip)
        $lenBytes = [BitConverter]::GetBytes([int64]$zipBytes.LongLength)
        $magic = [Text.Encoding]::ASCII.GetBytes('LWPAYLOAD1')
        $fs = [System.IO.File]::Open($outExe, 'Append', 'Write')
        try {
            $fs.Write($zipBytes, 0, $zipBytes.Length)
            $fs.Write($lenBytes, 0, $lenBytes.Length)
            $fs.Write($magic, 0, $magic.Length)
        } finally { $fs.Close() }
        Remove-Item -LiteralPath $zip, $stage -Recurse -Force -ErrorAction SilentlyContinue
        Write-Host "Appended overlay ($($pack.Count) file(s)) to $outExe"
    } else {
        Write-Host 'No NSIS/portable in dist. Setup.exe will download LoneWolf-Launcher.exe from the public source tree at install time.'
    }
}

Write-Host "Bootstrapper: $outExe ($((Get-Item $outExe).Length) bytes)"
