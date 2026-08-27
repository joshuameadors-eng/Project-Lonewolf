#Requires -Version 5.1
<#
  Extract the LWPAYLOAD1 zip appended to LoneWolf-Launcher-Setup.exe and
  require every nested exe FileVersion/ProductVersion to match Expected.
  The inner NSIS installer is what per-machine Setup actually installs;
  matching only the bootstrapper stamp is not enough.
  Exit 0 on match, 1 on mismatch/missing inner NSIS, 2 if Setup is missing.
#>
[CmdletBinding()]
param(
    [Parameter(Mandatory)]
    [string]$Path,
    [Parameter(Mandatory)]
    [string]$Expected
)

$ErrorActionPreference = 'Stop'
$assertVer = Join-Path $PSScriptRoot 'Assert-LwExeVersion.ps1'

if (-not (Test-Path -LiteralPath $Path)) {
    Write-Host ("REFUSE: missing Setup.exe (expected version {0}): {1}" -f $Expected, $Path)
    exit 2
}

$exe = (Resolve-Path -LiteralPath $Path).Path
$fs = [System.IO.File]::OpenRead($exe)
$magic = [Text.Encoding]::ASCII.GetBytes('LWPAYLOAD1')
$gotMagic = ''
$zipLen = [int64]0
try {
    if ($fs.Length -lt ($magic.Length + 8)) {
        Write-Host ("REFUSE: {0} is too small to contain an install overlay. Rebuild with npm run build." -f $exe)
        exit 1
    }
    $fs.Seek(-($magic.Length + 8), 'End') | Out-Null
    $lenBuf = New-Object byte[] 8
    [void]$fs.Read($lenBuf, 0, 8)
    $magicBuf = New-Object byte[] $magic.Length
    [void]$fs.Read($magicBuf, 0, $magic.Length)
    $gotMagic = [Text.Encoding]::ASCII.GetString($magicBuf)
    $zipLen = [BitConverter]::ToInt64($lenBuf, 0)
} finally {
    $fs.Close()
}

if ($gotMagic -ne 'LWPAYLOAD1' -or $zipLen -le 0) {
    Write-Host ("REFUSE: {0} has no LWPAYLOAD1 overlay. Inner installer was not packed; do not publish." -f $exe)
    exit 1
}

$stage = Join-Path $env:TEMP ('lw-overlay-assert-' + [guid]::NewGuid().ToString('n'))
New-Item -ItemType Directory -Path $stage -Force | Out-Null
$zipPath = Join-Path $stage 'overlay.zip'
$fs = [System.IO.File]::OpenRead($exe)
try {
    $fs.Seek(-($magic.Length + 8 + $zipLen), 'End') | Out-Null
    $zf = [System.IO.File]::Create($zipPath)
    try {
        $buf = New-Object byte[] 1048576
        $left = $zipLen
        while ($left -gt 0) {
            $n = $fs.Read($buf, 0, [Math]::Min($buf.Length, $left))
            if ($n -le 0) { break }
            $zf.Write($buf, 0, $n)
            $left -= $n
        }
    } finally { $zf.Close() }
} finally { $fs.Close() }

$extract = Join-Path $stage 'extracted'
Expand-Archive -LiteralPath $zipPath -DestinationPath $extract -Force

$innerNsis = Join-Path $extract 'LoneWolf-Launcher-Nsis.exe'
if (-not (Test-Path -LiteralPath $innerNsis)) {
    Write-Host ("REFUSE: Setup overlay is missing LoneWolf-Launcher-Nsis.exe. That is the per-machine install payload; a stale or skipped NSIS wrap would leave users on an old FileVersion. Rebuild (npm run build) so the inner NSIS matches {0}." -f $Expected)
    Remove-Item -LiteralPath $stage -Recurse -Force -ErrorAction SilentlyContinue
    exit 1
}

$failed = $false
Get-ChildItem -LiteralPath $extract -Filter '*.exe' | ForEach-Object {
    & powershell.exe -NoProfile -ExecutionPolicy Bypass -File $assertVer -Path $_.FullName -Expected $Expected
    if ($LASTEXITCODE -ne 0) { $failed = $true }
}

Remove-Item -LiteralPath $stage -Recurse -Force -ErrorAction SilentlyContinue
if ($failed) {
    Write-Host ("REFUSE: nested Setup payload does not match publish version {0}." -f $Expected)
    exit 1
}
Write-Host ("OK: Setup overlay inner NSIS and nested exes match {0}" -f $Expected)
exit 0
