#Requires -Version 5.1
<#
  Compare an exe ProductVersion / FileVersion to the launcher version being published.
  Match on the first three numeric parts (5.4.6 equals 5.4.6.0).
  Exit 0 on match, 1 on mismatch, 2 if the file is missing.
#>
[CmdletBinding()]
param(
    [Parameter(Mandatory)]
    [string]$Path,
    [Parameter(Mandatory)]
    [string]$Expected
)

$ErrorActionPreference = 'Stop'

function Get-LwThreePartVersion {
    param([string]$Raw)
    $parts = @(([string]$Raw -replace '[^0-9.]', '').Split('.') | Where-Object { $_ -ne '' } | Select-Object -First 3)
    while ($parts.Count -lt 3) { $parts += '0' }
    return ($parts -join '.')
}

if (-not (Test-Path -LiteralPath $Path)) {
    Write-Host ("REFUSE: missing exe (expected version {0}): {1}" -f $Expected, $Path)
    exit 2
}

$info = [System.Diagnostics.FileVersionInfo]::GetVersionInfo((Resolve-Path -LiteralPath $Path).Path)
$want = Get-LwThreePartVersion $Expected
$product = Get-LwThreePartVersion $info.ProductVersion
$file = Get-LwThreePartVersion $info.FileVersion
$ok = ($product -eq $want) -or ($file -eq $want)
if (-not $ok) {
    Write-Host ("REFUSE: {0} ProductVersion='{1}' FileVersion='{2}' does not match publish version {3}. Rebuild (npm run build) so dist matches package.json. Do not upload a stale dist." -f $Path, $info.ProductVersion, $info.FileVersion, $Expected)
    exit 1
}
Write-Host ("OK: {0} ProductVersion={1} FileVersion={2} matches {3}" -f $Path, $info.ProductVersion, $info.FileVersion, $Expected)
exit 0
