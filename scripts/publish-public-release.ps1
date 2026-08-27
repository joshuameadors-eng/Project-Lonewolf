#Requires -Version 5.1
<#
  Publish to joshuameadors-eng/Project-Lonewolf-Releases:

  Public git tree (source, unauthenticated raw/Contents API):
    payload/ and powershell/ folders
    FirstBase-payload.zip (tracked zip of those folders for Quick Update)
    bin/LoneWolf-Launcher.exe
    latest.json

  GitHub Releases page:
    LoneWolf-Launcher-Setup.exe only

  Does not embed a token. Does not skip git hooks. Does not force-push.
#>
[CmdletBinding()]
param(
    [string]$Tag = 'installer',
    [string]$Title = 'LoneWolf Installer',
    [string]$PrivateRepoRoot = '',
    [switch]$SkipPayloadZip,
    [switch]$CompileBootstrapper,
    [switch]$ValidateOnly
)

$ErrorActionPreference = 'Stop'
$gh = $null
foreach ($c in @(
    'gh',
    "$env:ProgramFiles\GitHub CLI\gh.exe",
    "$env:LOCALAPPDATA\Programs\GitHub CLI\gh.exe"
)) {
    if ($c -eq 'gh') {
        $cmd = Get-Command gh -ErrorAction SilentlyContinue
        if ($cmd) { $gh = $cmd.Source; break }
    } elseif (Test-Path -LiteralPath $c) { $gh = $c; break }
}
if (-not $gh -and -not $ValidateOnly) { throw 'GitHub CLI (gh) not found. Install it and run gh auth login.' }

$git = $null
$gitCmd = Get-Command git -ErrorAction SilentlyContinue
if ($gitCmd) { $git = $gitCmd.Source }
if (-not $git -and -not $ValidateOnly) { throw 'git not found on PATH.' }

if (-not $PrivateRepoRoot) { $PrivateRepoRoot = (Resolve-Path (Join-Path $PSScriptRoot '..')).Path }

if ($CompileBootstrapper) {
    & powershell.exe -NoProfile -ExecutionPolicy Bypass -File (Join-Path $PrivateRepoRoot 'scripts\compile-bootstrapper.ps1')
}

$pkg = Get-Content -Raw -LiteralPath (Join-Path $PrivateRepoRoot 'package.json') | ConvertFrom-Json
$verJson = Get-Content -Raw -LiteralPath (Join-Path $PrivateRepoRoot 'src\powershell\VERSION.json') | ConvertFrom-Json
$rt = Get-Content -Raw -LiteralPath (Join-Path $PrivateRepoRoot 'installer\dotnet-runtime.json') | ConvertFrom-Json
$launcherVersion = [string]$pkg.version
$payloadVersion  = if ($verJson.PSObject.Properties['payloadVersion'] -and $verJson.payloadVersion) {
    [string]$verJson.payloadVersion
} else {
    [string]$verJson.version
}
if (-not $Tag) { $Tag = 'installer' }
if (-not $Title) { $Title = 'LoneWolf Installer' }
$setupDownloadUrl = "https://github.com/joshuameadors-eng/Project-Lonewolf-Releases/releases/download/installer/LoneWolf-Launcher-Setup.exe"

$owner = 'joshuameadors-eng'
$repo  = 'Project-Lonewolf-Releases'
$full  = "$owner/$repo"
$latestPage = "https://github.com/$full/releases/latest"
$defaultBranch = 'main'
if ($gh -and -not $ValidateOnly) {
    try {
        $branchMeta = & $gh repo view $full --json defaultBranchRef | ConvertFrom-Json
        if ($branchMeta.defaultBranchRef.name) { $defaultBranch = [string]$branchMeta.defaultBranchRef.name }
    } catch { }
}
$rawBase = "https://raw.githubusercontent.com/$full/$defaultBranch"

$stage = Join-Path $env:TEMP ("lw-publish-" + [guid]::NewGuid().ToString('n'))
New-Item -ItemType Directory -Path $stage -Force | Out-Null

$manifest = [ordered]@{
    launcherVersion = $launcherVersion
    payloadVersion  = $payloadVersion
    channel         = 'release'
    source          = 'github-public-source'
    latestReleaseUrl = $latestPage
    installerTag    = 'installer'
    manifestUrl     = "$rawBase/latest.json"
    contentsApiUrl  = "https://api.github.com/repos/$full/contents/latest.json"
    defaultBranch   = $defaultBranch
    dotnet          = [ordered]@{
        id          = [string]$rt.id
        major       = [int]$rt.major
        arch        = [string]$rt.arch
        displayName = [string]$rt.displayName
        installerUrl = [string]$rt.akaMsUrl
    }
    assets          = [ordered]@{
        setup       = 'LoneWolf-Launcher-Setup.exe'
        installer   = 'LoneWolf-Launcher-Setup.exe'
        portable    = 'bin/LoneWolf-Launcher.exe'
        payload     = 'FirstBase-payload.zip'
        payloadDir  = 'payload/'
        powershellDir = 'powershell/'
        manifest    = 'latest.json'
    }
    urls            = [ordered]@{
        setup    = $setupDownloadUrl
        portable = "$rawBase/bin/LoneWolf-Launcher.exe"
        payload  = "$rawBase/FirstBase-payload.zip"
        manifest = "$rawBase/latest.json"
    }
}
$manifestPath = Join-Path $stage 'latest.json'
$jsonText = $manifest | ConvertTo-Json -Depth 6
$utf8NoBom = New-Object System.Text.UTF8Encoding $false
[System.IO.File]::WriteAllText($manifestPath, $jsonText, $utf8NoBom)

$payloadZip = Join-Path $stage 'FirstBase-payload.zip'
if (-not $SkipPayloadZip) {
    $zipRoot = Join-Path $stage 'ziproot'
    New-Item -ItemType Directory -Path (Join-Path $zipRoot 'payload') -Force | Out-Null
    New-Item -ItemType Directory -Path (Join-Path $zipRoot 'powershell') -Force | Out-Null
    Copy-Item -Path (Join-Path $PrivateRepoRoot 'src\payload\*') -Destination (Join-Path $zipRoot 'payload') -Recurse -Force
    Copy-Item -Path (Join-Path $PrivateRepoRoot 'src\powershell\*.ps1') -Destination (Join-Path $zipRoot 'powershell') -Force
    Copy-Item -Path (Join-Path $PrivateRepoRoot 'src\powershell\VERSION.json') -Destination (Join-Path $zipRoot 'powershell') -Force
    if (Test-Path -LiteralPath $payloadZip) { Remove-Item -LiteralPath $payloadZip -Force }
    Compress-Archive -Path (Join-Path $zipRoot 'payload'), (Join-Path $zipRoot 'powershell') -DestinationPath $payloadZip -Force
}

$dist = Join-Path $PrivateRepoRoot 'dist'
$setup = Join-Path $dist 'LoneWolf-Launcher-Setup.exe'
$portable = Join-Path $dist 'LoneWolf-Launcher.exe'
$assertVer = Join-Path $PrivateRepoRoot 'scripts\Assert-LwExeVersion.ps1'

function Assert-PublishExe {
    param([string]$ExePath, [string]$Label)
    if (-not (Test-Path -LiteralPath $ExePath)) {
        throw ("REFUSE: missing {0} at {1}. Run npm run build so FileVersion matches {2}. Do not publish a stale dist." -f $Label, $ExePath, $launcherVersion)
    }
    & powershell.exe -NoProfile -ExecutionPolicy Bypass -File $assertVer -Path $ExePath -Expected $launcherVersion
    if ($LASTEXITCODE -ne 0) {
        throw ("REFUSE: {0} version does not match publish version {1}." -f $Label, $launcherVersion)
    }
}

Assert-PublishExe -ExePath $portable -Label 'LoneWolf-Launcher.exe'
$unpackedExe = Join-Path $dist 'win-unpacked\LoneWolf-Launcher.exe'
if (Test-Path -LiteralPath $unpackedExe) {
    Assert-PublishExe -ExePath $unpackedExe -Label 'win-unpacked LoneWolf-Launcher.exe'
}
if (Test-Path -LiteralPath (Join-Path $dist 'LoneWolf-Launcher-Nsis.exe')) {
    Write-Warning 'dist\\LoneWolf-Launcher-Nsis.exe is leftover and is not published.'
}
$assertOverlay = Join-Path $PrivateRepoRoot 'scripts\Assert-LwSetupOverlay.ps1'
& powershell.exe -NoProfile -ExecutionPolicy Bypass -File $assertOverlay -Path $setup -Expected '0.0.0'
if ($LASTEXITCODE -ne 0) {
    throw 'REFUSE: Setup is not the unversioned bootstrapper (no overlay, FileVersion 0.0.0.0). Compile with scripts/compile-bootstrapper.ps1. Do not advertise Setup as launcher 5.4.x.'
}

$exeBytes = (Get-Item -LiteralPath $portable).Length
$exeMb = [math]::Round($exeBytes / 1MB, 1)
if ($exeBytes -ge 100MB) {
    Write-Warning ("bin/LoneWolf-Launcher.exe is {0} MB. GitHub warns at 100 MB for git files. LFS is not enabled; push may fail." -f $exeMb)
} else {
    Write-Host ("Portable exe size {0} MB (under 100 MB git file warning)." -f $exeMb)
}

if ($ValidateOnly) {
    Write-Host "ValidateOnly: versions match $launcherVersion. Not uploading."
    exit 0
}

function Remove-NonSetupReleaseAssets {
    param([string]$RelTag)
    if (-not $RelTag) { return }
    $prevEap = $ErrorActionPreference
    $ErrorActionPreference = 'Continue'
    $json = & $gh release view $RelTag --repo $full --json assets 2>$null
    $viewExit = $LASTEXITCODE
    $ErrorActionPreference = $prevEap
    if ($viewExit -ne 0 -or -not $json) { return }
    $view = $json | ConvertFrom-Json
    foreach ($a in @($view.assets)) {
        $n = [string]$a.name
        if ($n -and $n -ne 'LoneWolf-Launcher-Setup.exe') {
            Write-Host ("Removing extra release asset {0} from {1}" -f $n, $RelTag)
            & $gh release delete-asset $RelTag $n --repo $full --yes
            if ($LASTEXITCODE -ne 0) {
                Write-Warning ("Could not delete {0} from {1}. Old extra assets may remain on that tag." -f $n, $RelTag)
            }
        }
    }
}

$clone = Join-Path $env:TEMP ("lw-public-src-" + [guid]::NewGuid().ToString('n'))
Write-Host "Cloning public source $full"
& $gh repo clone $full $clone -- --depth 1
if ($LASTEXITCODE -ne 0) { throw "gh repo clone $full failed" }

$payloadDir = Join-Path $clone 'payload'
$psDir = Join-Path $clone 'powershell'
$binDir = Join-Path $clone 'bin'
if (Test-Path -LiteralPath $payloadDir) { Remove-Item -LiteralPath $payloadDir -Recurse -Force }
if (Test-Path -LiteralPath $psDir) { Remove-Item -LiteralPath $psDir -Recurse -Force }
New-Item -ItemType Directory -Path $payloadDir -Force | Out-Null
New-Item -ItemType Directory -Path $psDir -Force | Out-Null
New-Item -ItemType Directory -Path $binDir -Force | Out-Null

Copy-Item -Path (Join-Path $PrivateRepoRoot 'src\payload\*') -Destination $payloadDir -Recurse -Force
Copy-Item -Path (Join-Path $PrivateRepoRoot 'src\powershell\*.ps1') -Destination $psDir -Force
Copy-Item -Path (Join-Path $PrivateRepoRoot 'src\powershell\VERSION.json') -Destination $psDir -Force
if (-not (Test-Path -LiteralPath $payloadZip)) { throw 'FirstBase-payload.zip was not built (SkipPayloadZip without a zip).' }
Copy-Item -LiteralPath $payloadZip -Destination (Join-Path $clone 'FirstBase-payload.zip') -Force
Copy-Item -LiteralPath $portable -Destination (Join-Path $binDir 'LoneWolf-Launcher.exe') -Force
Copy-Item -LiteralPath $manifestPath -Destination (Join-Path $clone 'latest.json') -Force
Copy-Item -LiteralPath (Join-Path $PrivateRepoRoot 'installer\PUBLIC-README.md') -Destination (Join-Path $clone 'README.md') -Force

Push-Location $clone
try {
    & $git add -A
    if ($LASTEXITCODE -ne 0) { throw 'git add failed on public repo' }
    $st = & $git status --porcelain
    if ($st) {
        $commitMsg = @"
Publish LoneWolf launcher $launcherVersion / payload $payloadVersion source assets.

Payload, portable exe, and latest.json live in the git tree. Releases page is the unversioned installer tool only.
"@
        $an = (& $git log -1 --format='%an').Trim()
        $ae = (& $git log -1 --format='%ae').Trim()
        if (-not $an) { $an = 'Joshua Meadors' }
        if (-not $ae) { $ae = 'joshuameadors-eng@users.noreply.github.com' }
        & $git -c "user.name=$an" -c "user.email=$ae" commit -m $commitMsg
        if ($LASTEXITCODE -ne 0) { throw 'git commit failed on public repo' }
        & $git push origin HEAD
        if ($LASTEXITCODE -ne 0) { throw 'git push failed on public repo (no force-push).' }
        Write-Host "Pushed public source tree ($defaultBranch)."
    } else {
        Write-Host 'Public source tree already up to date.'
    }
} finally {
    Pop-Location
}

$notes = @"
installer=LoneWolf-Launcher-Setup.exe (unversioned tool, tag installer)
launcherVersion=$launcherVersion (portable exe in source bin/)
payloadVersion=$payloadVersion
dotnet=$($rt.displayName) ($($rt.arch))

This release asset is the installer tool only: LoneWolf-Launcher-Setup.exe
It installs .NET if needed and downloads the latest portable from latest.json at install time.

Single installer URL:
$setupDownloadUrl

Payload scripts and portable LoneWolf-Launcher.exe are files in the public repository (not attached here).
Versioning: latest.json in the source tree (raw.githubusercontent.com).

Unsigned: SmartScreen may warn. One UAC for the whole first install (.NET + files + shortcut).
Launcher Update replaces the portable exe in place and does not re-run this Setup.
"@

$releaseFiles = @($setup)
$prevEap = $ErrorActionPreference
$ErrorActionPreference = 'Continue'
$existing = & $gh release view $Tag --repo $full 2>$null
$viewExit = $LASTEXITCODE
$ErrorActionPreference = $prevEap
if ($viewExit -eq 0 -and $existing) {
    Write-Host "Release $Tag exists - uploading Setup.exe only (clobber)."
    & $gh release upload $Tag @releaseFiles --repo $full --clobber
    if ($LASTEXITCODE -ne 0) { throw "gh release upload $Tag failed" }
    & $gh release edit $Tag --repo $full --title $Title --notes $notes --latest
    if ($LASTEXITCODE -ne 0) { Write-Warning "gh release edit --latest failed; installer tag may not be the GitHub latest pointer." }
} else {
    Write-Host "Creating release $Tag on $full (Setup.exe only)"
    & $gh release create $Tag @releaseFiles --repo $full --title $Title --notes $notes --latest
    if ($LASTEXITCODE -ne 0) { throw "gh release create $Tag failed" }
}

Remove-NonSetupReleaseAssets -RelTag $Tag
$prevEap = $ErrorActionPreference
$ErrorActionPreference = 'Continue'
$listJson = & $gh release list --repo $full --limit 20 --json tagName 2>$null
$ErrorActionPreference = $prevEap
if ($listJson) {
    $list = $listJson | ConvertFrom-Json
    foreach ($row in @($list)) {
        $t = [string]$row.tagName
        if ($t) { Remove-NonSetupReleaseAssets -RelTag $t }
    }
}

Write-Host "Published Setup to https://github.com/$full/releases/tag/$Tag"
Write-Host "Single installer URL: $setupDownloadUrl"
Write-Host "Latest page: $latestPage"
Write-Host "Public source: payload/, powershell/, FirstBase-payload.zip, bin/LoneWolf-Launcher.exe, latest.json"
Write-Host "Release asset (only): LoneWolf-Launcher-Setup.exe (unversioned installer tool)"
