#Requires -Version 5.1
<#
  LoneWolf-Launcher-Setup.exe must be the unversioned bootstrapper only:
  no LWPAYLOAD1 overlay (no baked NSIS/portable), FileVersion 0.0.0.0.
  Exit 0 on match, 1 on mismatch, 2 if Setup is missing.
#>
[CmdletBinding()]
param(
    [Parameter(Mandatory)]
    [string]$Path,
    [string]$Expected = '0.0.0'
)

$ErrorActionPreference = 'Stop'
$assertVer = Join-Path $PSScriptRoot 'Assert-LwExeVersion.ps1'

if (-not (Test-Path -LiteralPath $Path)) {
    Write-Host ("REFUSE: missing Setup.exe: {0}" -f $Path)
    exit 2
}

$exe = (Resolve-Path -LiteralPath $Path).Path
$fs = [System.IO.File]::OpenRead($exe)
$magic = [Text.Encoding]::ASCII.GetBytes('LWPAYLOAD1')
$gotMagic = ''
try {
    if ($fs.Length -ge ($magic.Length + 8)) {
        $fs.Seek(-($magic.Length + 8), 'End') | Out-Null
        $lenBuf = New-Object byte[] 8
        [void]$fs.Read($lenBuf, 0, 8)
        $magicBuf = New-Object byte[] $magic.Length
        [void]$fs.Read($magicBuf, 0, $magic.Length)
        $gotMagic = [Text.Encoding]::ASCII.GetString($magicBuf)
    }
} finally {
    $fs.Close()
}

if ($gotMagic -eq 'LWPAYLOAD1') {
    Write-Host ("REFUSE: {0} has a baked LWPAYLOAD1 overlay. Setup must download the latest portable at install time, not ship a stale launcher exe." -f $exe)
    exit 1
}

& powershell.exe -NoProfile -ExecutionPolicy Bypass -File $assertVer -Path $exe -Expected $Expected
if ($LASTEXITCODE -ne 0) {
    Write-Host ("REFUSE: Setup FileVersion must be {0} (installer tool is not launcher 5.4.x)." -f $Expected)
    exit 1
}

$len = (Get-Item -LiteralPath $exe).Length
if ($len -gt 8MB) {
    Write-Host ("REFUSE: {0} is {1} bytes. Bootstrapper Setup should be small; a large file is likely leftover NSIS." -f $exe, $len)
    exit 1
}

Write-Host ("OK: Setup is an unversioned bootstrapper with no overlay ({0} bytes)." -f $len)
exit 0
