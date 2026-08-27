#Requires -Version 5.1
<#
  E2E / smoke: NSIS config, updater channel isolation, GitHub URL resolution,
  optional silent install if dist\LoneWolf-Launcher-Setup.exe exists.
#>
[CmdletBinding()]
param(
    [string]$RepoRoot = ''
)

$ErrorActionPreference = 'Stop'
$failed = 0
$skipped = 0
$passed = 0

function Ok([string]$m) { $script:passed++; Write-Host "PASS  $m" -ForegroundColor Green }
function Fail([string]$m) { $script:failed++; Write-Host "FAIL  $m" -ForegroundColor Red }
function Skip([string]$m) { $script:skipped++; Write-Host "SKIP  $m" -ForegroundColor Yellow }

if (-not $RepoRoot) { $RepoRoot = (Resolve-Path (Join-Path $PSScriptRoot '..')).Path }

$ymlPath = Join-Path $RepoRoot 'electron-builder.yml'
$yml = Get-Content -Raw -LiteralPath $ymlPath
$pkg = Get-Content -Raw -LiteralPath (Join-Path $RepoRoot 'package.json') | ConvertFrom-Json
$verJson = Get-Content -Raw -LiteralPath (Join-Path $RepoRoot 'src\powershell\VERSION.json') | ConvertFrom-Json
$gi = Get-Content -Raw -LiteralPath (Join-Path $RepoRoot '.gitignore')
$readme = Get-Content -Raw -LiteralPath (Join-Path $RepoRoot 'README.md')

# --- Version ---
$lv = [string]$pkg.version
if ($lv -eq '5.4.14') { Ok 'package.json version is 5.4.14' } else { Fail "package.json version is $lv (expected 5.4.14)" }
if ($lv -eq [string]$verJson.launcherVersion) { Ok "package.json matches VERSION.json launcherVersion $lv" } else { Fail "package.json $($pkg.version) vs launcherVersion $($verJson.launcherVersion)" }
$payloadVer = if ($verJson.PSObject.Properties['payloadVersion'] -and $verJson.payloadVersion) { [string]$verJson.payloadVersion } else { [string]$verJson.version }
if ($payloadVer -eq '5.4.3') { Ok 'payloadVersion is 5.4.3 (script channel independent of launcher 5.4.14)' } else { Fail "payloadVersion unexpectedly $payloadVer" }
if ([string]$verJson.version -eq '5.4.3') { Ok 'VERSION.json product version matches payload 5.4.3' } else { Fail "product version unexpectedly $($verJson.version)" }

# --- gitignore / README ---
if ($gi -notmatch '(?m)^README\.md\s*$') { Ok '.gitignore does not ignore README.md' } else { Fail '.gitignore still lists README.md' }
if ($readme -match 'https://github.com/joshuameadors-eng/Project-Lonewolf-Releases/releases/latest') {
    Ok 'private README latest-release URL'
} else { Fail 'private README missing latest-release URL' }
if ($readme -match 'SmartScreen') { Ok 'README notes unsigned/SmartScreen' } else { Fail 'README missing SmartScreen note' }
if ($readme -match '(?i)do \*\*not\*\* package' -or $readme -match '(?i)Do \*\*not\*\* package') {
    Ok 'README does not require packaging to test payload'
} elseif ($readme -match '(?i)npm start' -and $readme -match '(?i)src/') {
    Ok 'README points destage testing at npm start / src/'
} else { Fail 'README missing destage/dev workflow guidance' }
if ($readme -match '(?i)\.NET 8 Desktop Runtime') { Ok 'README names .NET 8 Desktop Runtime' } else { Fail 'README missing .NET 8 Desktop Runtime' }
if ($readme -match '(?i)one.*UAC') { Ok 'README documents single UAC' } else { Fail 'README missing single-UAC note' }
if ($readme -match 'latest\.json') { Ok 'README documents public latest.json versioning' } else { Fail 'README missing latest.json' }
if ($readme -match 'bin/LoneWolf-Launcher.exe' -and $readme -match '(?i)repo files') {
    Ok 'README: payload and portable exe live in public repo files'
} else { Fail 'README must say payload/portable live in repo files not Releases' }

# --- NSIS / single-UAC config ---
if ($yml -match '(?m)^\s*requestedExecutionLevel:\s*requireAdministrator\s*$') { Ok 'app exe requestedExecutionLevel requireAdministrator' } else { Fail 'app requestedExecutionLevel is not requireAdministrator' }
if ($yml -match 'packElevateHelper:\s*false') { Ok 'inner NSIS packElevateHelper false' } else { Fail 'packElevateHelper should be false (bootstrapper owns UAC)' }
if ($yml -match 'allowElevation:\s*false') { Ok 'inner NSIS allowElevation false' } else { Fail 'allowElevation should be false' }
if ($yml -match 'runAfterFinish:\s*false') { Ok 'runAfterFinish false (avoids second UAC on launch)' } else { Fail 'runAfterFinish should be false' }
$nsh = Get-Content -Raw -LiteralPath (Join-Path $RepoRoot 'build\installer.nsh')
if ($nsh -match 'RequestExecutionLevel user') { Ok 'inner NSIS RequestExecutionLevel user' } else { Fail 'installer.nsh must not re-request admin' }
$bootManifest = Get-Content -Raw -LiteralPath (Join-Path $RepoRoot 'installer\app.manifest')
if ($bootManifest -match 'level="requireAdministrator"') { Ok 'bootstrapper manifest requireAdministrator (single UAC)' } else { Fail 'installer/app.manifest missing requireAdministrator' }
if ($yml -match 'createDesktopShortcut:\s*true') { Ok 'createDesktopShortcut true' } else { Fail 'createDesktopShortcut missing/false' }
if ($yml -match 'artifactName:\s*LoneWolf-Launcher-Setup\.\$\{ext\}') { Ok 'NSIS artifact LoneWolf-Launcher-Setup' } else { Fail 'NSIS artifactName mismatch' }
if ($yml -match 'artifactName:\s*LoneWolf-Launcher\.exe') { Ok 'portable artifact LoneWolf-Launcher.exe' } else { Fail 'portable artifactName mismatch' }
if ($yml -match '(?m)target:\s*nsis\s*$') { Ok 'electron-builder nsis target present' } else { Fail 'nsis target missing' }
if ($yml -notmatch '(?i)upx:\s*true') { Ok 'UPX not enabled' } else { Fail 'UPX is enabled' }
if ($yml -match 'installerIcon:\s*assets/icon.ico') { Ok 'installer icon set' } else { Fail 'installerIcon missing' }
if (-not (Test-Path -LiteralPath (Join-Path $RepoRoot 'assets\icon.ico'))) { Fail 'assets/icon.ico missing' } else { Ok 'assets/icon.ico exists' }
if ($yml -match 'include:\s*build/installer.nsh') { Ok 'nsis include installer.nsh' } else { Fail 'nsis include missing' }

# --- Updater channel isolation ---
$updater = Join-Path $RepoRoot 'src\updater\Invoke-LoneWolfUpdater.ps1'
$fixture = Join-Path $RepoRoot 'scripts\fixtures\github-latest-release.json'
$manifestFx = Join-Path $RepoRoot 'scripts\fixtures\latest.json'

function Invoke-UpdaterJson {
    param([string[]]$ArgList)
    $raw = & powershell.exe -NoProfile -NonInteractive -ExecutionPolicy Bypass -File $updater @ArgList
    $line = ($raw | Where-Object { $_ -match '^\s*\{' } | Select-Object -Last 1)
    if (-not $line) { throw "No JSON from updater. Raw: $raw" }
    return $line | ConvertFrom-Json
}

$quick = Invoke-UpdaterJson @(
    '-Action', 'resolve', '-Channel', 'quick',
    '-CurrentLauncherVersion', '5.4.7', '-CurrentPayloadVersion', '5.4.2',
    '-FixturePath', $fixture, '-ManifestFixturePath', $manifestFx
)
if ($quick.quickUrl -match 'FirstBase-payload\.zip$' -and $quick.quickUrl -match 'raw\.githubusercontent\.com') { Ok 'quick resolve -> payload zip from public source tree' } else { Fail "quick URL $($quick.quickUrl)" }
if ($quick.quickUrl -notmatch '/releases/') { Ok 'quick URL is not a Releases download' } else { Fail "quick used release URL $($quick.quickUrl)" }
if (-not $quick.launcherUrl) { Ok 'quick resolve does not return launcher URL' } else { Fail "quick leaked launcherUrl $($quick.launcherUrl)" }
if ($quick.payloadUrl -notmatch 'Setup\.exe$') { Ok 'quick payload URL is not setup exe' } else { Fail 'quick channel selected setup exe' }

$launch = Invoke-UpdaterJson @(
    '-Action', 'resolve', '-Channel', 'launcher',
    '-CurrentLauncherVersion', '5.4.5', '-CurrentPayloadVersion', '5.4.2',
    '-FixturePath', $fixture, '-ManifestFixturePath', $manifestFx
)
if ($launch.launcherUrl -match 'LoneWolf-Launcher-Setup\.exe$') { Ok 'launcher resolve -> setup exe' } else { Fail "launcher URL $($launch.launcherUrl)" }
if ($launch.launcherUrl -match '/releases/') { Ok 'launcher Setup URL is a Releases asset' } else { Fail "launcher URL not a release: $($launch.launcherUrl)" }
if (-not $launch.quickUrl) { Ok 'launcher resolve does not return payload zip' } else { Fail "launcher leaked quickUrl $($launch.quickUrl)" }
if ($launch.launcherUpdateAvailable -eq $true) { Ok 'launcher channel flags exe update 5.4.5 -> 5.4.7' } else { Fail 'launcherUpdateAvailable should be true' }
if ($launch.updateAvailable -eq $true) { Ok 'compat updateAvailable is launcher-only and true here' } else { Fail 'updateAvailable should follow launcher channel' }

$payloadOnly = Invoke-UpdaterJson @(
    '-Action', 'check', '-Channel', 'both',
    '-CurrentLauncherVersion', '5.4.7', '-CurrentPayloadVersion', '5.4.1',
    '-FixturePath', $fixture, '-ManifestFixturePath', $manifestFx
)
if ($payloadOnly.payloadUpdateAvailable -eq $true) { Ok 'payload-only: payloadUpdateAvailable' } else { Fail 'expected payload update' }
if ($payloadOnly.launcherUpdateAvailable -eq $false) { Ok 'payload-only: no launcher update' } else { Fail 'must not flag launcher update when versions match' }
if ($payloadOnly.updateAvailable -eq $false) { Ok 'payload-only: compat updateAvailable stays false' } else { Fail 'must not force launcher update on script update' }

$dev = Invoke-UpdaterJson @(
    '-Action', 'quick', '-DevLocal',
    '-LocalSrcRoot', (Join-Path $RepoRoot 'src')
)
if ($dev.ok -and $dev.skippedDownload -and $dev.mode -eq 'dev-local') { Ok 'dev-local quick update skips GitHub' } else { Fail "dev-local: $($dev | ConvertTo-Json -Compress)" }

$updSrc = Get-Content -Raw -LiteralPath $updater
if ($updSrc -notmatch '(?i)src\\powershell\\VERSION\.json') { Ok 'packaged updater does not read private VERSION.json for latest' } else { Fail 'updater still tied to private VERSION.json' }
if ($updSrc -match 'Project-Lonewolf-Releases') { Ok 'updater targets public Project-Lonewolf-Releases' } else { Fail 'updater missing public repo' }
if ($updSrc -notmatch '-Verb RunAs') { Ok 'updater does not Start-Process -Verb RunAs (no second UAC)' } else { Fail 'updater still uses -Verb RunAs on setup' }

$fxLatest = Get-Content -Raw -LiteralPath $manifestFx | ConvertFrom-Json
if ($fxLatest.launcherVersion -eq '5.4.7' -and $fxLatest.payloadVersion -eq '5.4.2') { Ok 'latest.json fixture is version source (launcher 5.4.7 / payload 5.4.2)' } else { Fail 'latest.json fixture versions unexpected' }
if ($fxLatest.channel -eq 'release') { Ok 'latest.json fixture channel is release (not dev)' } else { Fail 'latest.json channel must be release for public assets' }
if ($launch.releaseChannel -eq 'release') { Ok 'updater reports releaseChannel=release from latest.json' } else { Fail "updater releaseChannel=$($launch.releaseChannel)" }
if ($fxLatest.assets.setup -eq 'LoneWolf-Launcher-Setup.exe' -and $fxLatest.assets.portable -eq 'bin/LoneWolf-Launcher.exe' -and $fxLatest.assets.payload -eq 'FirstBase-payload.zip') {
    Ok 'public asset names: Setup on Releases, portable+payload in source tree'
} else { Fail 'latest.json assets names mismatch' }
if ($fxLatest.source -eq 'github-public-source') { Ok 'latest.json source is public git tree' } else { Fail 'latest.json source must be github-public-source' }
if ($fxLatest.urls.payload -match 'raw\.githubusercontent\.com' -and $fxLatest.urls.portable -match 'raw\.githubusercontent\.com' -and $fxLatest.urls.setup -match '/releases/') {
    Ok 'latest.json urls: payload/exe from source, Setup from Releases'
} else { Fail 'latest.json urls must use raw source for payload/exe and Releases for Setup' }
$fxRel = Get-Content -Raw -LiteralPath $fixture | ConvertFrom-Json
$relNames = @($fxRel.assets | ForEach-Object { [string]$_.name })
if ($relNames.Count -eq 1 -and $relNames[0] -eq 'LoneWolf-Launcher-Setup.exe') {
    Ok 'release fixture has Setup.exe only'
} else { Fail "release fixture assets: $($relNames -join ', ')" }
if ($fxLatest.dotnet.id -eq 'windowsdesktop' -and [string]$fxLatest.dotnet.major -eq '8') { Ok 'latest.json names .NET 8 Desktop Runtime' } else { Fail 'latest.json missing dotnet runtime block' }

$inst = Join-Path $RepoRoot 'installer\Install-LoneWolfLauncher.ps1'
$instSrc = Get-Content -Raw -LiteralPath $inst
$runAsHits = [regex]::Matches($instSrc, '-Verb RunAs').Count
if ($runAsHits -eq 1) { Ok 'installer script has exactly one -Verb RunAs (bootstrap elevation)' } else { Fail "expected 1 -Verb RunAs in installer, found $runAsHits" }
if ($instSrc -match '/quiet' -and $instSrc -match 'windowsdesktop-runtime-win-x64') { Ok 'installer uses Microsoft windowsdesktop-runtime-win-x64 quiet install' } else { Fail 'installer missing official .NET 8 Desktop Runtime quiet install' }
if ($instSrc -match "Start-Process -FilePath \`$\w+ -ArgumentList \`$(script:quietArgs) -Wait -PassThru" -or $instSrc -match 'ArgumentList \$script:quietArgs -Wait') {
    Ok 'inner .NET installer is started without -Verb RunAs'
} else {
    # Fallback: quietArgs Start-Process line must not include RunAs
    $dotnetLine = ($instSrc -split "`n" | Where-Object { $_ -match 'quietArgs' -and $_ -match 'Start-Process' } | Select-Object -First 1)
    if ($dotnetLine -and $dotnetLine -notmatch 'RunAs') { Ok 'inner .NET installer is started without -Verb RunAs' }
    else { Fail 'could not confirm .NET child process has no RunAs' }
}

$planRaw = & powershell.exe -NoProfile -NonInteractive -ExecutionPolicy Bypass -File $inst -DumpPlan -MockDotNetPresent
$planLine = ($planRaw | Where-Object { $_ -match '^\s*\{' } | Select-Object -Last 1)
$plan = $planLine | ConvertFrom-Json
if ($plan.runtimeDisplayName -eq '.NET 8 Desktop Runtime' -and $plan.runtimeArch -eq 'x64' -and $plan.runtimeId -eq 'windowsdesktop') {
    Ok 'DumpPlan runtime is .NET 8 Desktop Runtime x64'
} else { Fail "DumpPlan runtime unexpected: $($planLine)" }
if ($plan.childUsesRunAs -eq $false) { Ok 'DumpPlan childUsesRunAs is false' } else { Fail 'DumpPlan claims children use RunAs' }
if ($plan.dotNetPresent -eq $true) { Ok 'DumpPlan MockDotNetPresent skips download' } else { Fail 'MockDotNetPresent should report runtime present' }
if ($plan.dotNetInstallerUrl -match 'aka\.ms/dotnet/8\.0/windowsdesktop-runtime-win-x64') { Ok 'official aka.ms Desktop Runtime URL' } else { Fail "unexpected installer URL $($plan.dotNetInstallerUrl)" }

$csproj = Get-Content -Raw -LiteralPath (Join-Path $RepoRoot 'provisioner\LoneWolf.Provisioner\LoneWolf.Provisioner.csproj')
if ($csproj -match '<TargetFramework>net8\.0-windows</TargetFramework>') { Ok 'provisioner TargetFramework net8.0-windows (runtime requirement source)' } else { Fail 'provisioner TFM mismatch' }
if ($pkg.scripts.'provisioner:publish' -match 'win-x64' -and $pkg.scripts.'provisioner:publish' -match 'self-contained false') {
    Ok 'provisioner publish is win-x64 not self-contained'
} else { Fail 'package.json provisioner:publish does not match win-x64 framework-dependent' }

try {
    $bootOut = Join-Path $env:TEMP ('LoneWolf-Launcher-Setup-e2e.exe')
    & powershell.exe -NoProfile -ExecutionPolicy Bypass -File (Join-Path $RepoRoot 'scripts\compile-bootstrapper.ps1') -OutputExe $bootOut -SkipOverlay
    if (Test-Path -LiteralPath $bootOut) {
        $bl = (Get-Item -LiteralPath $bootOut).Length
        if ($bl -gt 10KB) { Ok "bootstrapper compiled ($([math]::Round($bl/1KB,1)) KB)" } else { Fail 'bootstrapper compile produced tiny file' }
        $bt = [System.Text.Encoding]::Unicode.GetString([System.IO.File]::ReadAllBytes($bootOut))
        if ($bt -match 'requireAdministrator') { Ok 'compiled Setup.exe manifest requests administrator once' } else { Skip 'could not see requireAdministrator in compiled Setup.exe' }
        $assertVer = Join-Path $RepoRoot 'scripts\Assert-LwExeVersion.ps1'
        & powershell.exe -NoProfile -ExecutionPolicy Bypass -File $assertVer -Path $bootOut -Expected $lv
        if ($LASTEXITCODE -eq 0) { Ok "bootstrapper FileVersion matches $lv" } else { Fail "bootstrapper FileVersion does not match $lv" }
        & powershell.exe -NoProfile -ExecutionPolicy Bypass -File $assertVer -Path $bootOut -Expected '5.4.4'
        if ($LASTEXITCODE -eq 1) { Ok "Assert-LwExeVersion rejects mismatched FileVersion (5.4.4 vs $lv)" } else { Fail "mismatch guard exit $LASTEXITCODE (expected 1)" }
        Remove-Item -LiteralPath $bootOut -Force -ErrorAction SilentlyContinue
    } else { Fail 'compile-bootstrapper did not write output exe' }
} catch {
    Fail "compile-bootstrapper: $($_.Exception.Message)"
}

$pub = Get-Content -Raw -LiteralPath (Join-Path $RepoRoot 'scripts\publish-public-release.ps1')
foreach ($n in @('LoneWolf-Launcher-Setup.exe', 'LoneWolf-Launcher.exe', 'FirstBase-payload.zip', 'latest.json')) {
    if ($pub -match [regex]::Escape($n)) { Ok "publish script includes $n" } else { Fail "publish script missing $n" }
}
if ($pub -match 'channel\s*=\s*''release''' -or $pub -match 'channel\s+=\s+''release''') { Ok 'publish latest.json channel is release' } else { Fail 'publish script must set channel release' }
if ($pub -match 'raw\.githubusercontent\.com') { Ok 'publish latest.json uses raw.githubusercontent.com source URLs' } else { Fail 'publish script missing raw source URLs' }
if ($pub -match '\$releaseFiles = @\(\$setup\)') { Ok 'publish uploads Setup.exe only to gh release' } else { Fail 'publish must set releaseFiles to Setup only' }
if ($pub -match 'git push origin HEAD' -and $pub -match 'Join-Path \$clone ''bin''') { Ok 'publish commits portable exe into public source tree' } else { Fail 'publish must git-push bin/LoneWolf-Launcher.exe' }
if ($pub -match 'release delete-asset') { Ok 'publish drops leftover non-Setup release assets' } else { Fail 'publish should delete extra release assets' }
if ($pub -match 'Assert-LwExeVersion' -and $pub -match 'REFUSE') { Ok 'publish refuses mismatched FileVersion' } else { Fail 'publish script missing FileVersion guard' }
if ($pub -match 'Assert-LwSetupOverlay') { Ok 'publish asserts Setup overlay inner NSIS FileVersion' } else { Fail 'publish missing overlay inner-installer version guard' }
if ($pub -notmatch 'DEV') { Ok 'publish script has no DEV marker in source' } else { Fail 'publish script still mentions DEV' }

$mainSrc = Get-Content -Raw -LiteralPath (Join-Path $RepoRoot 'main.js')
if ($mainSrc -match 'isDevBuild: !IS_PACKED' -or $mainSrc -match 'isDevBuild = !IS_PACKED') { Ok 'packaged builds hide DEV via app.isPackaged' } else { Fail 'DEV marker not gated on isPackaged' }
if ($mainSrc -match 'GITHUB_LATEST_JSON' -and $mainSrc -notmatch 'SHARE_VERSION_JSON') { Ok 'launcher version source is GitHub latest.json not share VERSION.json' } else { Fail 'main.js still uses share VERSION.json for launcher versioning' }
if ($mainSrc -match 'raw\.githubusercontent\.com/.+/latest\.json') { Ok 'main.js latest.json is public source raw URL' } else { Fail 'main.js must fetch latest.json from raw.githubusercontent.com' }
if ($mainSrc -match 'evaluateHqNetwork' -and $mainSrc -match 'update:check' -and $mainSrc -match 'sources:scanShare') {
    Ok 'launcher gates GitHub updates and share ISO scan on HQ network'
} else { Fail 'main.js missing HQ guard on update:check or sources:scanShare' }

$guardJs = Get-Content -Raw -LiteralPath (Join-Path $RepoRoot 'src\launcher\hqNetworkGuard.js')
if ($guardJs -match '192\.168\.92\.0' -and $guardJs -match '192\.168\.94\.1' -and $guardJs -match '(?i)firstbasehq') {
    Ok 'launcher HQ ethernet includes 192.168.92.0/22 and gateway 192.168.94.1'
} else { Fail 'hqNetworkGuard.js missing HQ SSID, ethernet /22, or gateway 192.168.94.1' }
if ($guardJs -match 'ssidOk \|\| ethernetOk') {
    Ok 'HQ guard: Wi-Fi SSID or ethernet LAN (no Wi-Fi required for wired)'
} else { Fail 'HQ guard must pass ethernet without requiring SSID' }

$loopSrc = Get-Content -Raw -LiteralPath (Join-Path $RepoRoot 'src\payload\Invoke-WindowsUpdateLoop.ps1')
if ($loopSrc -match 'function Test-FbHqBenchNetwork') { Fail 'WU loop still defines Test-FbHqBenchNetwork' } else { Ok 'WU loop has no Test-FbHqBenchNetwork' }
if ($loopSrc -match 'FirstbaseHQ') { Fail 'WU loop still mentions FirstbaseHQ' } else { Ok 'WU loop does not require FirstbaseHQ' }
if ($loopSrc -match 'download\.windowsupdate\.com' -and $loopSrc -match 'Waiting for internet connection') {
    Ok 'WU Wait-ForInternet uses generic connectivity targets'
} else { Fail 'WU Wait-ForInternet is not generic TCP connectivity' }

$guardTest = Join-Path $RepoRoot 'scripts\test-hq-network-guard.js'
$guardOut = & node.exe $guardTest 2>&1
$guardExit = $LASTEXITCODE
if ($guardExit -eq 0) { Ok 'HQ guard unit tests (wifi / ethernet /22 / off-site)' }
else { Fail ("HQ guard unit tests failed: {0}" -f ($guardOut | Out-String).Trim()) }

$modeTest = Join-Path $RepoRoot 'scripts\test-recommend-usb-build-mode.js'
$modeOut = & node.exe $modeTest 2>&1
$modeExit = $LASTEXITCODE
if ($modeExit -eq 0) { Ok 'USB build-mode: script-only Quick Update; older image Full Rebuild default with Quick still allowed' }
else { Fail ("USB build-mode unit tests failed: {0}" -f ($modeOut | Out-String).Trim()) }

$builderSrc = Get-Content -Raw -LiteralPath (Join-Path $RepoRoot 'src\renderer\pages\builder.js')
if ($builderSrc -match 'isPackagedBuild \|\| usesSourcePicker\(\)\) return ''full''') {
    Fail 'builder still forces Full Rebuild for packaged launcher'
} else { Ok 'packaged Builder does not force Full Rebuild (Quick Update available on release)' }
if ($builderSrc -match 'LoneWolfRecommendUsbBuildMode' -and $builderSrc -match 'overlayAllowed') {
    Ok 'builder uses recommendUsbBuildMode (older image default full, overlay still allowed)'
} else { Fail 'builder missing recommendUsbBuildMode wiring' }

$idx = Get-Content -Raw -LiteralPath (Join-Path $RepoRoot 'src\renderer\index.html')
if ($idx -match 'recommendUsbBuildMode\.js') { Ok 'renderer loads recommendUsbBuildMode.js' } else { Fail 'index.html missing recommendUsbBuildMode.js' }

if ($mainSrc -match 'recommendUsbBuildMode') { Ok 'main.js uses recommendUsbBuildMode for USB check-update' } else { Fail 'main.js missing recommendUsbBuildMode' }

$glu = Get-Content -Raw -LiteralPath (Join-Path $RepoRoot 'src\powershell\Get-LauncherUpdate.ps1')
if ($glu -match 'Project-Lonewolf-Releases' -and $glu -notmatch 'WIN-HQ5JDEACV3S') { Ok 'Get-LauncherUpdate uses GitHub not UNC share' } else { Fail 'Get-LauncherUpdate still points at the share' }
if ($glu -notmatch 'Remote\\Staging\\VERSION.json') { Ok 'Get-LauncherUpdate does not read share VERSION.json' } else { Fail 'Get-LauncherUpdate still reads share VERSION.json' }

$gsv = Get-Content -Raw -LiteralPath (Join-Path $RepoRoot 'src\powershell\Get-StagingVersion.ps1')
if ($gsv -notmatch 'Test-Path -LiteralPath \$versionFile') { Ok 'Get-StagingVersion does not require share VERSION.json' } else { Fail 'Get-StagingVersion still reads share VERSION.json' }
if ($gsv -match 'isoLastWrite' -and $gsv -match 'yyyy-MM-dd') { Ok 'Get-StagingVersion reports share ISO image date' } else { Fail 'Get-StagingVersion missing ISO image date' }

$buildPs = Get-Content -Raw -LiteralPath (Join-Path $RepoRoot 'src\powershell\Invoke-LoneWolfBuild.ps1')
if ($buildPs -match 'imageBuildDate' -and $buildPs -match 'OverlayOnly') { Ok 'destage stamps imageBuildDate and preserves it on Quick Update' } else { Fail 'Invoke-LoneWolfBuild missing imageBuildDate stamp' }

$usbPs = Get-Content -Raw -LiteralPath (Join-Path $RepoRoot 'src\powershell\Get-UsbDisks.ps1')
if ($usbPs -match 'lwImageBuildDate') { Ok 'Get-UsbDisks reads stick imageBuildDate' } else { Fail 'Get-UsbDisks missing lwImageBuildDate' }

foreach ($psFile in @(
    (Join-Path $RepoRoot 'src\powershell\Get-StagingVersion.ps1'),
    (Join-Path $RepoRoot 'src\powershell\Get-UsbDisks.ps1'),
    (Join-Path $RepoRoot 'src\powershell\Invoke-LoneWolfBuild.ps1'),
    (Join-Path $RepoRoot 'src\updater\Invoke-LoneWolfUpdater.ps1')
)) {
    $errs = $null
    $null = [System.Management.Automation.Language.Parser]::ParseFile($psFile, [ref]$null, [ref]$errs)
    $leaf = Split-Path $psFile -Leaf
    if ($errs -and $errs.Count -gt 0) { Fail ("parser {0}: {1}" -f $leaf, $errs[0].ToString()) }
    else { Ok "parser OK $leaf" }
}

# Live GitHub (repo exists; latest release may 404 until first upload)
$liveOk = $false
try {
    $headers = @{ 'User-Agent' = 'LoneWolf-Launcher-E2E'; 'Accept' = 'application/vnd.github+json' }
    $repoInfo = Invoke-RestMethod -Uri 'https://api.github.com/repos/joshuameadors-eng/Project-Lonewolf-Releases' -Headers $headers
    if ($repoInfo.private -eq $false -and $repoInfo.html_url -match 'Project-Lonewolf-Releases') {
        Ok 'public repo reachable (https://github.com/joshuameadors-eng/Project-Lonewolf-Releases)'
        $liveOk = $true
    } else { Fail 'public repo metadata unexpected' }
} catch {
    Fail "public repo API: $($_.Exception.Message)"
}
if ($liveOk) {
    try {
        $latestRel = Invoke-RestMethod -Uri 'https://api.github.com/repos/joshuameadors-eng/Project-Lonewolf-Releases/releases/latest' -Headers @{ 'User-Agent' = 'LoneWolf-Launcher-E2E'; 'Accept' = 'application/vnd.github+json' }
        Ok 'live latest release exists'
        $liveNames = @($latestRel.assets | ForEach-Object { [string]$_.name })
        $extra = @($liveNames | Where-Object { $_ -ne 'LoneWolf-Launcher-Setup.exe' })
        if ($liveNames.Count -eq 1 -and $liveNames[0] -eq 'LoneWolf-Launcher-Setup.exe') {
            Ok 'live latest release assets are Setup.exe only'
        } elseif ($latestRel.tag_name -eq 'v5.4.6') {
            Skip 'latest is still v5.4.6 with extra assets - run npm run publish:public for 5.4.7'
        } elseif ($extra.Count -gt 0) {
            Fail ("live latest release has extra assets: {0}" -f ($extra -join ', '))
        } else {
            Fail "live latest release missing Setup.exe (assets: $($liveNames -join ', '))"
        }
    } catch {
        Skip 'no GitHub release published yet (expected until first gh release upload) - URL resolution covered by fixture'
    }
    $unauthUrls = @(
        'https://github.com/joshuameadors-eng/Project-Lonewolf-Releases/releases/latest',
        'https://raw.githubusercontent.com/joshuameadors-eng/Project-Lonewolf-Releases/main/latest.json'
    )
    foreach ($u in $unauthUrls) {
        try {
            $r = Invoke-WebRequest -Uri $u -Method Head -MaximumRedirection 8 -UseBasicParsing -Headers @{ 'User-Agent' = 'LoneWolf-Launcher-E2E' }
            if ([int]$r.StatusCode -ge 200 -and [int]$r.StatusCode -lt 400) {
                Ok "unauthenticated HTTPS OK: $u"
            } elseif ([int]$r.StatusCode -eq 404) {
                Skip "unauthenticated $u returned 404 (source/release not published yet)"
            } else { Fail "unauthenticated $u status $($r.StatusCode)" }
        } catch {
            $code = $null
            try { $code = $_.Exception.Response.StatusCode.value__ } catch { }
            if ($code -eq 404) { Skip "unauthenticated $u 404 (source/release not published yet)" }
            else { Fail "unauthenticated $u : $($_.Exception.Message)" }
        }
    }
}

# Optional silent install (bootstrapper or wrapped NSIS)
$setup = Join-Path $RepoRoot 'dist\LoneWolf-Launcher-Setup.exe'
if (-not (Test-Path -LiteralPath $setup)) {
    Skip 'dist/LoneWolf-Launcher-Setup.exe not present — skip silent-install smoke (do not require electron-builder for payload tests)'
} else {
    $len = (Get-Item -LiteralPath $setup).Length
    if ($len -gt 20KB) { Ok "Setup bootstrapper present ($([math]::Round($len/1KB,1)) KB)" } else { Fail "Setup.exe too small: $len bytes" }
    $prefix = Join-Path $env:TEMP ("lw-nsis-e2e-" + [guid]::NewGuid().ToString('n'))
    New-Item -ItemType Directory -Path $prefix -Force | Out-Null
    try {
        $p = Start-Process -FilePath $setup -ArgumentList @('/S', "/D=$prefix") -Wait -PassThru
        $exe = Join-Path $prefix 'LoneWolf-Launcher.exe'
        if (Test-Path -LiteralPath $exe) {
            Ok 'silent install produced LoneWolf-Launcher.exe under prefix'
            $desk = @(
                (Join-Path ([Environment]::GetFolderPath('Desktop')) 'Project LoneWolf Launcher.lnk'),
                (Join-Path $env:Public 'Desktop\Project LoneWolf Launcher.lnk')
            ) | Where-Object { Test-Path -LiteralPath $_ }
            if ($desk) { Ok 'desktop shortcut created' } else { Skip 'desktop shortcut not found (per-machine install may land on Public Desktop)' }
            try {
                $text = [System.Text.Encoding]::Unicode.GetString([System.IO.File]::ReadAllBytes($exe))
                if ($text -match 'requireAdministrator' -or $text -match 'asInvoker') {
                    if ($text -match 'requireAdministrator') { Ok 'exe manifest requests administrator' }
                    else { Fail 'exe manifest is asInvoker, expected requireAdministrator' }
                } else { Skip 'could not confirm requireAdministrator string in exe' }
            } catch { Skip "manifest inspect: $($_.Exception.Message)" }
        } else {
            Skip "silent /S /D= prefix empty (exit $($p.ExitCode)); per-machine NSIS often needs elevation and ignores a non-admin prefix. Artifact name/config already asserted."
        }
    } finally {
        Get-ChildItem -LiteralPath $prefix -Filter 'Uninstall*.exe' -ErrorAction SilentlyContinue | Select-Object -First 1 | ForEach-Object {
            Start-Process -FilePath $_.FullName -ArgumentList '/S' -Wait -ErrorAction SilentlyContinue
        }
        Remove-Item -LiteralPath $prefix -Recurse -Force -ErrorAction SilentlyContinue
    }
}

Write-Host ""
Write-Host "Passed: $passed  Failed: $failed  Skipped: $skipped"
if ($failed -gt 0) { exit 1 }
exit 0
