<#
.SYNOPSIS
  Standalone LoneWolf updater: Quick (payload/scripts) vs Launcher (exe/setup).

.DESCRIPTION
  Invoked by the Electron launcher or from a prompt. Never embeds tokens.
  Packaged builds pull versions from public git-tree latest.json
  (raw.githubusercontent.com / Contents API). Payload and portable exe live
  in that source tree. The installer tool (LoneWolf-Launcher-Setup.exe) lives
  on a stable GitHub Releases tag named installer and is first-install only.
  Dev checkouts (npm start) use the local src/ tree for Quick Update destage -
  they do not require a GitHub payload download to test USB sticks.

  Channels are exclusive:
    quick     -> payload zip from public SOURCE tree (never launcher exe/setup)
    launcher  -> portable LoneWolf-Launcher.exe from SOURCE tree (never Setup, never payload)
#>
[CmdletBinding()]
param(
    [ValidateSet('check', 'resolve', 'quick', 'launcher')]
    [string]$Action = 'check',

    [ValidateSet('quick', 'launcher', 'both')]
    [string]$Channel = 'both',

    [string]$CurrentLauncherVersion = '',
    [string]$CurrentPayloadVersion  = '',

    # Packaged: process.resourcesPath. Extract payload here. Never the exe dir for quick.
    [string]$ResourcesRoot = '',

    [string]$LocalSrcRoot = '',

    [switch]$DevLocal,
    [switch]$DryRun,

    [string]$FixturePath = '',
    [string]$ManifestFixturePath = '',
    [string]$ChannelConfigPath = '',
    [string]$TargetExe = ''
)

$ErrorActionPreference = 'Stop'

function Get-ChannelConfig {
    if ($ChannelConfigPath -and (Test-Path -LiteralPath $ChannelConfigPath)) {
        return Get-Content -Raw -LiteralPath $ChannelConfigPath | ConvertFrom-Json
    }
    $beside = Join-Path $PSScriptRoot 'release-channel.json'
    if (Test-Path -LiteralPath $beside) {
        return Get-Content -Raw -LiteralPath $beside | ConvertFrom-Json
    }
    return [pscustomobject]@{
        owner           = 'joshuameadors-eng'
        repo            = 'Project-Lonewolf-Releases'
        apiLatestUrl    = 'https://api.github.com/repos/joshuameadors-eng/Project-Lonewolf-Releases/releases/latest'
        manifestUrl     = 'https://raw.githubusercontent.com/joshuameadors-eng/Project-Lonewolf-Releases/main/latest.json'
        contentsApiUrl  = 'https://api.github.com/repos/joshuameadors-eng/Project-Lonewolf-Releases/contents/latest.json'
        setupAsset      = 'LoneWolf-Launcher-Setup.exe'
        setupUrl        = 'https://github.com/joshuameadors-eng/Project-Lonewolf-Releases/releases/download/installer/LoneWolf-Launcher-Setup.exe'
        portablePath    = 'bin/LoneWolf-Launcher.exe'
        payloadAsset    = 'FirstBase-payload.zip'
        manifestAsset   = 'latest.json'
    }
}

function Compare-LwSemVer {
    param([string]$A, [string]$B)
    $parse = {
        param($s)
        return @( ([string]$s -replace '[^0-9.]', '').Split('.') | ForEach-Object { [int]($_ -as [string]) } )
    }
    $aa = & $parse $A
    $bb = & $parse $B
    $len = [Math]::Max($aa.Count, $bb.Count)
    for ($i = 0; $i -lt $len; $i++) {
        $x = if ($i -lt $aa.Count) { [int]$aa[$i] } else { 0 }
        $y = if ($i -lt $bb.Count) { [int]$bb[$i] } else { 0 }
        if ($x -ne $y) { return ($x - $y) }
    }
    return 0
}

function Get-AssetUrl {
    param($Release, [string]$ExactName)
    if (-not $Release -or -not $Release.assets) { return $null }
    foreach ($a in @($Release.assets)) {
        if ([string]$a.name -eq $ExactName) { return [string]$a.browser_download_url }
    }
    return $null
}

function Test-IsSourceTreeUrl {
    param([string]$Url)
    if (-not $Url) { return $false }
    if ($Url -match '/releases/download/' -or $Url -match '/releases/latest/download/') { return $false }
    return (
        $Url -match 'raw\.githubusercontent\.com/' -or
        $Url -match '/repos/.+/contents/' -or
        $Url -match 'github\.com/.+/raw/'
    )
}

function Test-IsReleaseSetupUrl {
    param([string]$Url)
    if (-not $Url) { return $false }
    return (
        ($Url -match '/releases/download/.+/LoneWolf-Launcher-Setup\.exe$' -or
         $Url -match '/releases/latest/download/LoneWolf-Launcher-Setup\.exe$')
    )
}

function Get-LatestRelease {
    param($Cfg)
    if ($FixturePath -and (Test-Path -LiteralPath $FixturePath)) {
        return Get-Content -Raw -LiteralPath $FixturePath | ConvertFrom-Json
    }
    $url = [string]$Cfg.apiLatestUrl
    $headers = @{
        'User-Agent' = 'LoneWolf-Launcher-Updater'
        'Accept'     = 'application/vnd.github+json'
    }
    return Invoke-RestMethod -Uri $url -Headers $headers -Method Get
}

function ConvertFrom-LwJsonText {
    param($Raw)
    if ($null -eq $Raw) { return $null }
    if ($Raw -isnot [string]) { return $Raw }
    $s = $Raw.TrimStart([char]0xFEFF).Trim()
    if (-not $s) { return $null }
    return $s | ConvertFrom-Json
}

function Get-ManifestFromContentsApi {
    param([string]$ApiUrl)
    $headers = @{
        'User-Agent' = 'LoneWolf-Launcher-Updater'
        'Accept'     = 'application/vnd.github+json'
    }
    $item = Invoke-RestMethod -Uri $ApiUrl -Headers $headers -Method Get
    if (-not $item.content) { throw 'Contents API returned no content' }
    $b64 = ([string]$item.content) -replace '\s', ''
    $bytes = [Convert]::FromBase64String($b64)
    $text = [Text.Encoding]::UTF8.GetString($bytes)
    return ConvertFrom-LwJsonText $text
}

function Get-VersionManifest {
    param($Release, $Cfg)
    if ($ManifestFixturePath -and (Test-Path -LiteralPath $ManifestFixturePath)) {
        return Get-Content -Raw -LiteralPath $ManifestFixturePath | ConvertFrom-Json
    }

    $headers = @{ 'User-Agent' = 'LoneWolf-Launcher-Updater'; 'Accept' = 'application/json' }
    if ($Cfg.manifestUrl) {
        try {
            $got = Invoke-RestMethod -Uri ([string]$Cfg.manifestUrl) -Headers $headers -Method Get
            $parsed = ConvertFrom-LwJsonText $got
            if ($parsed -and $parsed.launcherVersion) { return $parsed }
        } catch { }
    }
    if ($Cfg.contentsApiUrl) {
        try {
            return Get-ManifestFromContentsApi -ApiUrl ([string]$Cfg.contentsApiUrl)
        } catch { }
    }

    $body = if ($Release) { [string]$Release.body } else { '' }
    if ($body -match '\{[\s\S]*"launcherVersion"[\s\S]*\}') {
        try { return $Matches[0] | ConvertFrom-Json } catch { }
    }
    $tag = if ($Release) { ([string]$Release.tag_name) -replace '^[vV]', '' } else { $null }
    return [pscustomobject]@{
        launcherVersion = $tag
        payloadVersion  = $null
    }
}

function Resolve-ChannelAssets {
    param($Release, $Cfg, $Manifest, [string]$WantChannel)

    $setupUrl = $null
    if ($Manifest -and $Manifest.urls -and $Manifest.urls.setup) {
        $setupUrl = [string]$Manifest.urls.setup
    }
    if (-not $setupUrl) {
        $setupUrl = Get-AssetUrl -Release $Release -ExactName $Cfg.setupAsset
    }
    if (-not $setupUrl) {
        $setupUrl = "https://github.com/$($Cfg.owner)/$($Cfg.repo)/releases/download/installer/LoneWolf-Launcher-Setup.exe"
    }

    $payloadUrl = $null
    if ($Manifest -and $Manifest.urls -and $Manifest.urls.payload) {
        $payloadUrl = [string]$Manifest.urls.payload
    }

    $portableUrl = $null
    if ($Manifest -and $Manifest.urls -and $Manifest.urls.portable) {
        $portableUrl = [string]$Manifest.urls.portable
    }

    if ($payloadUrl -and -not (Test-IsSourceTreeUrl $payloadUrl)) {
        throw "Quick payload URL must be public source (raw), not a release asset: $payloadUrl"
    }
    if ($portableUrl -and -not (Test-IsSourceTreeUrl $portableUrl)) {
        throw "Portable exe URL must be public source (raw), not a release asset: $portableUrl"
    }
    if ($setupUrl -and -not (Test-IsReleaseSetupUrl $setupUrl)) {
        throw "Launcher Setup URL must be a GitHub Release asset: $setupUrl"
    }

    $quickUrls = @()
    if ($payloadUrl) { $quickUrls += $payloadUrl }
    $launcherUrls = @()
    if ($WantChannel -eq 'launcher') {
        if ($portableUrl) { $launcherUrls += $portableUrl }
    } else {
        if ($setupUrl) { $launcherUrls += $setupUrl }
    }

    foreach ($u in $quickUrls) {
        if ($u -match 'LoneWolf-Launcher-Setup\.exe$' -or ($u -match 'LoneWolf-Launcher\.exe$' -and $u -notmatch 'payload')) {
            throw "Quick channel resolved a launcher exe URL: $u"
        }
        if ($u -match '/releases/download/' -or $u -match '/releases/latest/download/') {
            throw "Quick channel must not use a Releases download URL: $u"
        }
    }
    foreach ($u in $launcherUrls) {
        if ($u -match 'FirstBase-payload\.zip$') {
            throw "Launcher channel resolved a payload zip URL: $u"
        }
        if ($WantChannel -eq 'launcher' -and $u -match 'LoneWolf-Launcher-Setup\.exe$') {
            throw "Launcher Update must not re-run Setup: $u"
        }
    }

    $out = [ordered]@{
        setupUrl     = $setupUrl
        portableUrl  = $portableUrl
        payloadUrl   = $payloadUrl
        launcherUrl  = $portableUrl
        launcherKind = $(if ($portableUrl) { 'portable' } else { $null })
        quickUrl     = $payloadUrl
    }
    if ($WantChannel -eq 'quick') {
        $out.launcherUrl = $null
        $out.launcherKind = $null
        $out.setupUrl = $null
        $out.portableUrl = $null
    } elseif ($WantChannel -eq 'launcher') {
        $out.payloadUrl = $null
        $out.quickUrl = $null
        $out.launcherUrl = $portableUrl
        $out.launcherKind = $(if ($portableUrl) { 'portable' } else { $null })
    }
    return [pscustomobject]$out
}

function Write-LwJson {
    param($Obj)
    $Obj | ConvertTo-Json -Compress -Depth 8
}

function Get-LwStableLauncherExe {
    return (Join-Path ${env:ProgramFiles} 'Project LoneWolf Launcher\LoneWolf-Launcher.exe')
}

function Test-LwUnstableLauncherPath {
    param([string]$Path)
    if (-not $Path) { return $true }
    $p = [string]$Path
    if ($p -match '(?i)\\Temp\\') { return $true }
    if ($p -match '(?i)\\Downloads\\') { return $true }
    if ($p -match '(?i)LoneWolf-Launcher-Setup\.exe$') { return $true }
    if ($p -match '(?i)\.(new|incoming)$') { return $true }
    return $false
}

function Ensure-LwShortcutIfMissing {
    param([string]$LnkPath, [string]$ExePath)
    if (-not $ExePath -or -not (Test-Path -LiteralPath $ExePath)) { return }
    if (Test-LwUnstableLauncherPath -Path $ExePath) { return }
    $needsWrite = $true
    if (Test-Path -LiteralPath $LnkPath) {
        try {
            $w0 = New-Object -ComObject WScript.Shell
            $cur = [string]($w0.CreateShortcut($LnkPath).TargetPath)
            if ($cur -eq $ExePath) { return }
            if (-not (Test-LwUnstableLauncherPath -Path $cur)) { return }
        } catch {
            return
        }
        $needsWrite = $true
    }
    if (-not $needsWrite) { return }
    $dir = Split-Path $LnkPath
    if ($dir -and -not (Test-Path -LiteralPath $dir)) {
        New-Item -ItemType Directory -Path $dir -Force | Out-Null
    }
    $w = New-Object -ComObject WScript.Shell
    $s = $w.CreateShortcut($LnkPath)
    $s.TargetPath = $ExePath
    $s.WorkingDirectory = Split-Path $ExePath
    $s.WindowStyle = 1
    $s.Description = 'Project LoneWolf Launcher'
    $s.Save()
    if (Test-Path -LiteralPath $LnkPath) {
        $bytes = [System.IO.File]::ReadAllBytes($LnkPath)
        if ($bytes.Length -gt 0x15) {
            $bytes[0x15] = $bytes[0x15] -bor 0x20
            [System.IO.File]::WriteAllBytes($LnkPath, $bytes)
        }
    }
}

function Copy-LwPortableBesideRunning {
    param([string]$SourceExe, [string]$TargetExe)
    $out = [ordered]@{
        replacedInPlace = $false
        pendingRestart  = $false
        stagedNewPath   = $null
        copyError       = $null
    }
    if (-not $TargetExe -or -not (Test-Path -LiteralPath $SourceExe)) { return [pscustomobject]$out }
    if ($TargetExe -match 'electron\.exe$' -or $TargetExe -match 'node\.exe$') { return [pscustomobject]$out }
    $targetDir = Split-Path $TargetExe
    if ($targetDir -and -not (Test-Path -LiteralPath $targetDir)) {
        New-Item -ItemType Directory -Path $targetDir -Force | Out-Null
    }
    $staged = "$TargetExe.incoming"
    if ([string]$SourceExe -ne [string]$staged) {
        try {
            Copy-Item -LiteralPath $SourceExe -Destination $staged -Force -ErrorAction Stop
        } catch {
            $out.copyError = $_.Exception.Message
            $out.pendingRestart = $true
            return [pscustomobject]$out
        }
    }
    $out.stagedNewPath = $staged
    try {
        Copy-Item -LiteralPath $staged -Destination $TargetExe -Force -ErrorAction Stop
        $out.replacedInPlace = $true
        $out.pendingRestart = $true
        return [pscustomobject]$out
    } catch {
        $out.copyError = $_.Exception.Message
        $out.pendingRestart = $true
        return [pscustomobject]$out
    }
}

function Invoke-HttpDownload {
    param([string]$Url, [string]$Dest)
    $headers = @{ 'User-Agent' = 'LoneWolf-Launcher-Updater' }
    Invoke-WebRequest -Uri $Url -Headers $headers -OutFile $Dest -UseBasicParsing
    try { Unblock-File -LiteralPath $Dest -ErrorAction SilentlyContinue } catch { }
}

function Install-QuickPayload {
    param([string]$ZipPath, [string]$DestRoot)
    if (-not (Test-Path -LiteralPath $DestRoot)) {
        throw "Resources root not found: $DestRoot"
    }
    $stage = Join-Path $env:TEMP ("lw-payload-" + [guid]::NewGuid().ToString('n'))
    New-Item -ItemType Directory -Path $stage -Force | Out-Null
    try {
        Expand-Archive -LiteralPath $ZipPath -DestinationPath $stage -Force
        $payloadSrc = Join-Path $stage 'payload'
        $psSrc      = Join-Path $stage 'powershell'
        if (-not (Test-Path -LiteralPath $payloadSrc) -and -not (Test-Path -LiteralPath $psSrc)) {
            throw 'Payload zip must contain payload/ and/or powershell/ folders'
        }
        Get-ChildItem -LiteralPath $stage -Recurse -File -Filter 'LoneWolf-Launcher*.exe' -ErrorAction SilentlyContinue |
            ForEach-Object { throw "Refusing quick update: zip contains launcher exe $($_.Name)" }
        Get-ChildItem -LiteralPath $stage -Recurse -File -Filter '*.lnk' -ErrorAction SilentlyContinue |
            ForEach-Object { throw "Refusing quick update: zip contains shortcut $($_.Name)" }
        Get-ChildItem -LiteralPath $stage -Recurse -File -Filter 'LoneWolf-Launcher-Setup.exe' -ErrorAction SilentlyContinue |
            ForEach-Object { throw "Refusing quick update: zip contains Setup $($_.Name)" }
        if (Test-Path -LiteralPath $payloadSrc) {
            $payloadDst = Join-Path $DestRoot 'payload'
            if (-not (Test-Path -LiteralPath $payloadDst)) { New-Item -ItemType Directory -Path $payloadDst -Force | Out-Null }
            Copy-Item -Path (Join-Path $payloadSrc '*') -Destination $payloadDst -Recurse -Force
        }
        if (Test-Path -LiteralPath $psSrc) {
            $psDst = Join-Path $DestRoot 'powershell'
            if (-not (Test-Path -LiteralPath $psDst)) { New-Item -ItemType Directory -Path $psDst -Force | Out-Null }
            Copy-Item -Path (Join-Path $psSrc '*') -Destination $psDst -Recurse -Force
        }
    } finally {
        Remove-Item -LiteralPath $stage -Recurse -Force -ErrorAction SilentlyContinue
    }
}

$cfg = Get-ChannelConfig
$result = [ordered]@{
    ok                         = $true
    action                     = $Action
    channel                    = $Channel
    mode                       = $(if ($DevLocal) { 'dev-local' } else { 'github' })
    currentLauncherVersion     = $CurrentLauncherVersion
    currentPayloadVersion      = $CurrentPayloadVersion
    latestLauncherVersion      = $null
    latestPayloadVersion       = $null
    releaseChannel             = $null
    launcherUpdateAvailable    = $false
    payloadUpdateAvailable     = $false
    updateAvailable            = $false
    setupUrl                   = $null
    portableUrl                = $null
    payloadUrl                 = $null
    launcherUrl                = $null
    launcherKind               = $null
    quickUrl                   = $null
    skippedDownload            = $false
    error                      = $null
    publicRepo                 = "https://github.com/$($cfg.owner)/$($cfg.repo)"
}

function Invoke-LwUpdaterCore {
    if ($DevLocal -and $Action -in @('quick', 'check', 'resolve')) {
        $result.mode = 'dev-local'
        $result.skippedDownload = $true
        $result.message = 'Dev checkout: Quick Update destages from local src/. GitHub payload pull is for packaged installs only.'
        if ($LocalSrcRoot) { $result.localSrcRoot = $LocalSrcRoot }
        return [pscustomobject]$result
    }

    $release = $null
    $releaseFetchError = $null
    try {
        $release = Get-LatestRelease -Cfg $cfg
    } catch {
        $releaseFetchError = $_.Exception.Message
    }

    $manifest = Get-VersionManifest -Release $release -Cfg $cfg
    if ((-not $manifest -or -not $manifest.launcherVersion) -and $Action -in @('check', 'resolve')) {
        $result.ok = $true
        $result.error = $releaseFetchError
        $result.skippedDownload = $true
        $result.message = 'No public source latest.json yet (or GitHub unreachable).'
        return [pscustomobject]$result
    }
    $result.latestLauncherVersion = if ($manifest.launcherVersion) { [string]$manifest.launcherVersion } else { $null }
    $result.latestPayloadVersion  = if ($manifest.payloadVersion) { [string]$manifest.payloadVersion } else { $null }
    $result.releaseChannel = if ($manifest.channel) { [string]$manifest.channel } else { 'release' }

    $want = if ($Action -in @('quick', 'launcher')) { $Action } else { $Channel }
    $assets = Resolve-ChannelAssets -Release $release -Cfg $cfg -Manifest $manifest -WantChannel $want
    $result.setupUrl     = $assets.setupUrl
    $result.portableUrl  = $assets.portableUrl
    $result.payloadUrl   = $assets.payloadUrl
    $result.launcherUrl  = $assets.launcherUrl
    $result.launcherKind = $assets.launcherKind
    $result.quickUrl     = $assets.quickUrl

    if ($result.latestLauncherVersion -and $CurrentLauncherVersion) {
        $result.launcherUpdateAvailable = (Compare-LwSemVer $result.latestLauncherVersion $CurrentLauncherVersion) -gt 0
    }
    if ($result.latestPayloadVersion -and $CurrentPayloadVersion) {
        $result.payloadUpdateAvailable = (Compare-LwSemVer $result.latestPayloadVersion $CurrentPayloadVersion) -gt 0
    } elseif ($result.quickUrl -and $CurrentPayloadVersion -and -not $result.latestPayloadVersion) {
        # Manifest missing payloadVersion: do not treat that as a launcher update.
        $result.payloadUpdateAvailable = $false
    }

    # Backward-compat flag is LAUNCHER only -- never force an exe replace for scripts.
    $result.updateAvailable = [bool]$result.launcherUpdateAvailable

    if ($Action -in @('check', 'resolve') -or $DryRun) {
        return [pscustomobject]$result
    }

    if ($Action -eq 'quick') {
        if (-not $result.quickUrl) { throw 'No payload URL in public source latest.json' }
        if (-not $ResourcesRoot) { throw 'ResourcesRoot is required for packaged quick update' }
        $zip = Join-Path $env:TEMP 'FirstBase-payload.zip'
        Invoke-HttpDownload -Url $result.quickUrl -Dest $zip
        Install-QuickPayload -ZipPath $zip -DestRoot $ResourcesRoot
        Remove-Item -LiteralPath $zip -Force -ErrorAction SilentlyContinue
        $result.applied = 'quick'
        return [pscustomobject]$result
    }

    if ($Action -eq 'launcher') {
        if (-not $result.portableUrl) { throw 'No portable exe URL in public source latest.json' }
        $stable = Get-LwStableLauncherExe
        $targetDir = Split-Path $stable
        if (-not (Test-Path -LiteralPath $targetDir)) {
            New-Item -ItemType Directory -Path $targetDir -Force | Out-Null
        }
        $dest = "$stable.incoming"
        Invoke-HttpDownload -Url $result.portableUrl -Dest $dest
        $result.downloadedPath = $dest
        $result.launcherKind = 'portable'
        $result.applied = 'launcher'
        $exeForShortcut = $stable
        $result.targetExe = $exeForShortcut
        $copy = Copy-LwPortableBesideRunning -SourceExe $dest -TargetExe $exeForShortcut
        $result.replacedInPlace = [bool]$copy.replacedInPlace
        $result.pendingRestart = $true
        $result.stagedNewPath = $copy.stagedNewPath
        if ($copy.copyError -and -not $copy.replacedInPlace) {
            $result.message = 'Launcher exe is in use. Swap is scheduled after a clean restart. The installed exe was left in place.'
        }
        try {
            $desk = Join-Path ([Environment]::GetFolderPath('CommonDesktopDirectory')) 'Project LoneWolf Launcher.lnk'
            $sm = Join-Path ([Environment]::GetFolderPath('CommonStartMenu')) 'Programs\Project LoneWolf Launcher.lnk'
            Ensure-LwShortcutIfMissing -LnkPath $desk -ExePath $exeForShortcut
            Ensure-LwShortcutIfMissing -LnkPath $sm -ExePath $exeForShortcut
        } catch {
            $result.shortcutWarning = $_.Exception.Message
        }
        return [pscustomobject]$result
    }

    return [pscustomobject]$result
}

$final = $null
try {
    $final = Invoke-LwUpdaterCore
} catch {
    $result.ok = $false
    $result.error = $_.Exception.Message
    $final = [pscustomobject]$result
}
Write-LwJson $final
# Do not call exit / SetShouldExit. Those kill a hosted PowerShell session and Electron
# reports "PS exit N" even after JSON was written. -File then uses leftover LASTEXITCODE.
$global:LASTEXITCODE = 0
