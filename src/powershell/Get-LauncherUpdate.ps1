<#
.SYNOPSIS
  Checks the remote share for a newer version of the LoneWolf Launcher.
  Used by Project LoneWolf Launcher for self-update detection.

.DESCRIPTION
  Registers credentials for the share, reads VERSION.json from
  Remote\Staging\VERSION.json, and compares launcherVersion against the
  running launcher's version. Outputs a single JSON object  -  never throws
  or exits non-zero for network/parse errors.

.OUTPUTS
  If update available:
  {"updateAvailable":true,"currentVersion":"1.0.0","latestVersion":"1.1.0",
   "exeName":"LoneWolf-Launcher-portable.exe",
   "exePath":"\\\\WIN-HQ5JDEACV3S\\Images\\FB Image Creation\\Remote\\LoneWolf-Launcher-portable.exe"}

  If up to date or share unreachable:
  {"updateAvailable":false,"currentVersion":"1.0.0","latestVersion":"1.0.0",
   "exeName":"LoneWolf-Launcher-portable.exe","exePath":null}
#>

param(
    [string]$ShareRoot     = '\\WIN-HQ5JDEACV3S\Images\FB Image Creation',
    [string]$ShareUser     = 'Reflect',
    [string]$SharePassword = 'mer*HWE0upt*rqe@dud',
    [string]$CurrentVersion
)

$ErrorActionPreference = 'SilentlyContinue'

# --- Share authentication -----------------------------------------------------
function Connect-ShareCredentials {
    param([string]$ShareHost, [string]$User, [string]$Pass)
    try {
        $cmdkey = Join-Path $env:SystemRoot 'System32\cmdkey.exe'
        if (Test-Path -LiteralPath $cmdkey) {
            & $cmdkey /delete:$ShareHost 2>$null | Out-Null
            & $cmdkey /add:$ShareHost /user:$User /pass:$Pass 2>&1 | Out-Null
        }
    } catch { }
}

$shareHost = 'WIN-HQ5JDEACV3S'
if ($ShareRoot -match '^\\\\([^\\]+)\\') { $shareHost = $Matches[1] }
Connect-ShareCredentials -ShareHost $shareHost -User $ShareUser -Pass $SharePassword

# --- SemVer comparison --------------------------------------------------------
function Compare-SemVer {
    param([string]$a, [string]$b)
    $va = [version]($a -replace '[^0-9.]','')
    $vb = [version]($b -replace '[^0-9.]','')
    return $va.CompareTo($vb)  # >0 means $a > $b
}

$versionFile = Join-Path $ShareRoot 'Remote\Staging\VERSION.json'

$output = [ordered]@{
    updateAvailable = $false
    devBuild        = $false
    launcherAhead   = $false
    scriptAhead     = $false
    currentVersion  = $CurrentVersion
    latestVersion   = $CurrentVersion
    shareScriptVersion = $null
    exeName         = 'LoneWolf-Launcher.exe'
    exePath         = $null
}

try {
    if (Test-Path -LiteralPath $versionFile) {
        $vj = Get-Content -Raw -LiteralPath $versionFile | ConvertFrom-Json

        # Read launcherVersion  -  fall back to currentVersion if field is absent
        $latestVersion = if ($vj.PSObject.Properties['launcherVersion'] -and $vj.launcherVersion) {
            [string]$vj.launcherVersion
        } else {
            $CurrentVersion
        }

        $exeName = if ($vj.PSObject.Properties['launcherExeName'] -and $vj.launcherExeName) {
            [string]$vj.launcherExeName
        } else {
            'LoneWolf-Launcher.exe'
        }

        $shareScript = if ($vj.PSObject.Properties['version'] -and $vj.version) {
            [string]$vj.version
        } else {
            $null
        }

        $output.latestVersion = $latestVersion
        $output.exeName       = $exeName
        $output.shareScriptVersion = $shareScript

        if ($latestVersion -and $CurrentVersion) {
            $cmp = Compare-SemVer $latestVersion $CurrentVersion
            if ($cmp -gt 0) {
                # Share official is newer than this build - update available.
                $output.updateAvailable = $true
                $output.exePath         = Join-Path $ShareRoot "Remote\$exeName"
            } elseif ($cmp -lt 0) {
                # This build is ahead of share official - Dev build flag.
                $output.launcherAhead = $true
                $output.devBuild = $true
            }
        }
    }
} catch {
    $output.error = $_.Exception.Message
}

$output | ConvertTo-Json -Compress -Depth 3
