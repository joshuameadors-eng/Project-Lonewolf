#Requires -Version 5.1
<#
  LoneWolf Installer / FirstBase installer (unversioned tool).
  Elevation: one UAC at the start (this script's RunAs relaunch, or the compiled
  Setup.exe app.manifest requireAdministrator). Child steps never use RunAs:
  .NET runtime /quiet, file copy, shortcuts.

  Installs dependencies plus the latest portable launcher from public latest.json
  (urls.portable / bin/LoneWolf-Launcher.exe). Does not bake a launcher version
  into this tool. Does not run NSIS (NSIS uninstall deleted the desktop shortcut).

  Runtime: .NET 8 Desktop Runtime x64 - see installer/dotnet-runtime.json
  (provisioner is net8.0-windows, win-x64, not self-contained).
#>
[CmdletBinding()]
param(
    [switch]$Silent,
    [switch]$Headless,
    [switch]$AlreadyElevated,
    [switch]$DumpPlan,
    [switch]$SkipDotNetDownload,
    [switch]$MockDotNetPresent,
    [switch]$MockDotNetMissing,
    [string]$MockRuntimeInstaller = '',
    [string]$InstallDir = '',
    [string]$InnerNsis = '',
    [string]$PortableExe = '',
    [string]$LatestJsonUrl = 'https://raw.githubusercontent.com/joshuameadors-eng/Project-Lonewolf-Releases/main/latest.json',
    [string]$DotNetInstallerUrl = '',
    [string]$RuntimeConfigPath = ''
)

$ErrorActionPreference = 'Stop'
Add-Type -AssemblyName System.Windows.Forms
Add-Type -AssemblyName System.Drawing

function Get-RuntimeConfig {
    $candidates = @()
    if ($RuntimeConfigPath) { $candidates += $RuntimeConfigPath }
    $candidates += (Join-Path $PSScriptRoot 'dotnet-runtime.json')
    $candidates += (Join-Path (Split-Path $PSScriptRoot -Parent) 'installer\dotnet-runtime.json')
    foreach ($c in $candidates) {
        if ($c -and (Test-Path -LiteralPath $c)) {
            return Get-Content -Raw -LiteralPath $c | ConvertFrom-Json
        }
    }
    return [pscustomobject]@{
        id             = 'windowsdesktop'
        major          = 8
        arch           = 'x64'
        displayName    = '.NET 8 Desktop Runtime'
        akaMsUrl       = 'https://aka.ms/dotnet/8.0/windowsdesktop-runtime-win-x64.exe'
        sharedFxName   = 'Microsoft.WindowsDesktop.App'
        quietArgs      = @('/install', '/quiet', '/norestart')
    }
}

function Test-IsAdmin {
    $p = [Security.Principal.WindowsPrincipal][Security.Principal.WindowsIdentity]::GetCurrent()
    return $p.IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)
}

function Test-DotNet8DesktopRuntime {
    param($Cfg)
    if ($MockDotNetPresent) { return $true }
    if ($MockDotNetMissing) { return $false }
    $fx = [string]$Cfg.sharedFxName
    if (-not $fx) { $fx = 'Microsoft.WindowsDesktop.App' }
    $major = [string]$Cfg.major
    $roots = @(
        (Join-Path ${env:ProgramFiles} "dotnet\shared\$fx"),
        (Join-Path ${env:ProgramFiles} "dotnet\shared\Microsoft.NETCore.App")
    )
    foreach ($root in $roots[0..0]) {
        if (Test-Path -LiteralPath $root) {
            $hit = Get-ChildItem -LiteralPath $root -Directory -ErrorAction SilentlyContinue |
                Where-Object { $_.Name -like "$major.*" }
            if ($hit) { return $true }
        }
    }
    $reg = "HKLM:\SOFTWARE\dotnet\Setup\InstalledVersions\x64\sharedfx\$fx"
    if (Test-Path -LiteralPath $reg) {
        $props = Get-ItemProperty -LiteralPath $reg -ErrorAction SilentlyContinue
        foreach ($n in $props.PSObject.Properties.Name) {
            if ($n -like "$major.*") { return $true }
        }
    }
    return $false
}

function Set-ShortcutRunAsAdmin {
    param([string]$LnkPath)
    if (-not (Test-Path -LiteralPath $LnkPath)) { return }
    $bytes = [System.IO.File]::ReadAllBytes($LnkPath)
    if ($bytes.Length -gt 0x15) {
        $bytes[0x15] = $bytes[0x15] -bor 0x20
        [System.IO.File]::WriteAllBytes($LnkPath, $bytes)
    }
}

function New-LwShortcut {
    param([string]$LnkPath, [string]$Target, [string]$WorkDir)
    $w = New-Object -ComObject WScript.Shell
    $s = $w.CreateShortcut($LnkPath)
    $s.TargetPath = $Target
    $s.WorkingDirectory = $WorkDir
    $s.WindowStyle = 1
    $s.Description = 'Project LoneWolf Launcher'
    $s.Save()
    Set-ShortcutRunAsAdmin -LnkPath $LnkPath
}

function Test-ShortcutPointsAt {
    param([string]$LnkPath, [string]$Target)
    if (-not (Test-Path -LiteralPath $LnkPath)) { return $false }
    try {
        $w = New-Object -ComObject WScript.Shell
        $s = $w.CreateShortcut($LnkPath)
        return ([string]$s.TargetPath -eq $Target)
    } catch { return $false }
}

function Get-SmartAppControlGuideText {
    return @'
Why this started happening
Install and update now download unsigned Windows programs from GitHub
(raw bin/LoneWolf-Launcher.exe and the unversioned Setup). Smart App Control
treats those as untrusted, so it can block Setup and the portable exe even
when that did not happen before. Signing the files (Azure code signing, about
$10/month) is the real fix. Do not turn off Microsoft Defender.

1. Check Smart App Control mode first
   Open Windows Security -> App & browser control -> Smart App Control.
   That is the usual Windows 11 path.

2. If the mode is Evaluation
   You can usually turn Smart App Control Off from that page.

3. If the mode is On (enforcement)
   Off is often greyed out. Microsoft commonly requires a PC reset to turn it
   off. This app cannot promise a one-click Off. If Off is unavailable, do not
   hunt for a hidden switch. Use More info -> Run anyway on the block dialog
   if Windows still offers it, or SmartScreen "Run anyway" when that dialog
   appears instead.

4. SmartScreen (separate from Smart App Control)
   "Windows protected your PC" -> More info -> Run anyway, only if you trust
   this installer. That does not disable Defender.

Do not disable Windows Defender / Microsoft Defender Antivirus to get past this.
'@
}

function Test-LikelySacOrSmartScreenFail {
    param([string]$Message)
    if (-not $Message) { return $false }
    return [bool]($Message -match 'SmartScreen|Smart App Control|untrusted|could not be downloaded|WebException|403|aborted|SSL|blocked|virus|threat|Unauthorized|0x80070005|being used by another process|The request was aborted')
}

function Show-InstallErrorUi {
    param([string]$Message)
    $showGuide = Test-LikelySacOrSmartScreenFail -Message $Message
    $form = New-Object System.Windows.Forms.Form
    $form.Text = 'LoneWolf Installer'
    $form.StartPosition = 'CenterScreen'
    $form.FormBorderStyle = 'FixedDialog'
    $form.MaximizeBox = $false
    $form.MinimizeBox = $false
    $form.Width = 560
    $form.Height = $(if ($showGuide) { 620 } else { 220 })
    $form.BackColor = [System.Drawing.Color]::FromArgb(24, 24, 32)

    $lbl = New-Object System.Windows.Forms.Label
    $lbl.ForeColor = [System.Drawing.Color]::FromArgb(248, 113, 113)
    $lbl.Location = New-Object System.Drawing.Point(16, 12)
    $lbl.Size = New-Object System.Drawing.Size(520, 48)
    $lbl.Text = $Message
    $form.Controls.Add($lbl)

    if ($showGuide) {
        $box = New-Object System.Windows.Forms.TextBox
        $box.Multiline = $true
        $box.ReadOnly = $true
        $box.ScrollBars = 'Vertical'
        $box.BackColor = [System.Drawing.Color]::FromArgb(18, 18, 24)
        $box.ForeColor = [System.Drawing.Color]::FromArgb(226, 232, 240)
        $box.Font = New-Object System.Drawing.Font('Consolas', 8)
        $box.Location = New-Object System.Drawing.Point(16, 64)
        $box.Size = New-Object System.Drawing.Size(512, 460)
        $box.Text = Get-SmartAppControlGuideText
        $form.Controls.Add($box)
    }

    $ok = New-Object System.Windows.Forms.Button
    $ok.Text = 'OK'
    $ok.DialogResult = [System.Windows.Forms.DialogResult]::OK
    $ok.Location = New-Object System.Drawing.Point(430, $(if ($showGuide) { 536 } else { 140 }))
    $form.Controls.Add($ok)
    $form.AcceptButton = $ok
    [void]$form.ShowDialog()
}

function Ensure-LwShortcuts {
    param([string]$ExePath)
    if (-not $ExePath -or -not (Test-Path -LiteralPath $ExePath)) { return }
    $workDir = Split-Path $ExePath
    $desk = Join-Path ([Environment]::GetFolderPath('CommonDesktopDirectory')) 'Project LoneWolf Launcher.lnk'
    $sm = Join-Path ([Environment]::GetFolderPath('CommonStartMenu')) 'Programs\Project LoneWolf Launcher.lnk'
    $smDir = Split-Path $sm
    if (-not (Test-Path -LiteralPath $smDir)) { New-Item -ItemType Directory -Path $smDir -Force | Out-Null }
    foreach ($lnk in @($desk, $sm)) {
        if (-not (Test-Path -LiteralPath $lnk) -or -not (Test-ShortcutPointsAt -LnkPath $lnk -Target $ExePath)) {
            New-LwShortcut -LnkPath $lnk -Target $ExePath -WorkDir $workDir
        }
    }
}

$script:rt = Get-RuntimeConfig
if (-not $DotNetInstallerUrl) { $DotNetInstallerUrl = [string]$script:rt.akaMsUrl }
$script:runtimeDisplay = [string]$script:rt.displayName
$script:quietArgs = @($script:rt.quietArgs)
if (-not $InstallDir) { $InstallDir = Join-Path ${env:ProgramFiles} 'Project LoneWolf Launcher' }

$plan = [ordered]@{
    runtimeId            = [string]$script:rt.id
    runtimeMajor         = [int]$script:rt.major
    runtimeArch          = [string]$script:rt.arch
    runtimeDisplayName   = $script:runtimeDisplay
    sharedFxName         = [string]$script:rt.sharedFxName
    dotNetInstallerUrl   = $DotNetInstallerUrl
    dotNetInstallArgs    = $script:quietArgs
    childUsesRunAs       = $false
    nsisReRequestAdmin   = $false
    publicLatestJson     = $LatestJsonUrl
    setupAsset           = 'LoneWolf-Launcher-Setup.exe'
    setupUrl             = 'https://github.com/joshuameadors-eng/Project-Lonewolf-Releases/releases/download/installer/LoneWolf-Launcher-Setup.exe'
    portableAsset        = 'LoneWolf-Launcher.exe'
    payloadAsset         = 'FirstBase-payload.zip'
    manifestAsset        = 'latest.json'
    dotNetPresent        = [bool](Test-DotNet8DesktopRuntime -Cfg $script:rt)
    skipDownloadIfPresent= $true
    downloadPortableAtInstall = $true
    innerNsisUsed        = $false
    stableInstallDir     = $InstallDir
    installerProductName = 'LoneWolf Installer'
}

if ($DumpPlan) {
    $plan | ConvertTo-Json -Compress -Depth 5
    exit 0
}

# Single elevation: compiled Setup.exe already elevated via manifest (-AlreadyElevated).
# Direct .ps1 launch: one elevated relaunch here. No other elevation in this file.
if (-not $AlreadyElevated -and -not (Test-IsAdmin)) {
    $argList = @(
        '-NoProfile', '-STA', '-ExecutionPolicy', 'Bypass',
        '-File', $PSCommandPath, '-AlreadyElevated'
    )
    if ($Silent) { $argList += '-Silent' }
    if ($Headless) { $argList += '-Headless' }
    if ($SkipDotNetDownload) { $argList += '-SkipDotNetDownload' }
    if ($InstallDir) { $argList += '-InstallDir'; $argList += $InstallDir }
    if ($PortableExe) { $argList += '-PortableExe'; $argList += $PortableExe }
    $p = Start-Process -FilePath (Join-Path $env:SystemRoot 'System32\WindowsPowerShell\v1.0\powershell.exe') -Verb RunAs -ArgumentList $argList -PassThru -Wait
    exit $(if ($p) { $p.ExitCode } else { 1 })
}

$script:stepNames = @(
    'Preparing',
    "Checking / installing $script:runtimeDisplay",
    'Installing LoneWolf Launcher',
    'Creating desktop shortcut',
    'Done'
)
$script:stepIndex = 0
$script:statusText = 'Starting...'
$script:ui = $null

function Update-Ui {
    param([int]$Step, [int]$Pct, [string]$Status)
    $script:stepIndex = $Step
    $script:statusText = $Status
    if ($script:ui) {
        $script:ui.pct = $Pct
        $script:ui.status = $Status
        $script:ui.step = $Step
        if ($script:ui.form -and -not $script:ui.form.IsDisposed) {
            $script:ui.form.BeginInvoke([action]{
                if ($script:ui.bar) { $script:ui.bar.Value = [Math]::Max(0, [Math]::Min(100, $script:ui.pct)) }
                if ($script:ui.lbl) { $script:ui.lbl.Text = $script:ui.status }
                for ($i = 0; $i -lt $script:ui.stepLabels.Count; $i++) {
                    $mark = if ($i -lt $script:ui.step) { '[x]' } elseif ($i -eq $script:ui.step) { '[>]' } else { '[ ]' }
                    $script:ui.stepLabels[$i].Text = "$mark  $($script:stepNames[$i])"
                    $script:ui.stepLabels[$i].ForeColor = if ($i -le $script:ui.step) {
                        [System.Drawing.Color]::FromArgb(34, 211, 238)
                    } else {
                        [System.Drawing.Color]::FromArgb(148, 163, 184)
                    }
                }
            }) | Out-Null
        }
        [System.Windows.Forms.Application]::DoEvents()
    }
}

function Show-StyledUi {
    $navy = [System.Drawing.Color]::FromArgb(1, 3, 8)
    $panel = [System.Drawing.Color]::FromArgb(7, 21, 41)
    $accent = [System.Drawing.Color]::FromArgb(34, 211, 238)
    $text = [System.Drawing.Color]::FromArgb(226, 232, 240)
    $muted = [System.Drawing.Color]::FromArgb(148, 163, 184)

    $form = New-Object System.Windows.Forms.Form
    $form.Text = 'LoneWolf Installer'
    $form.StartPosition = 'CenterScreen'
    $form.FormBorderStyle = 'FixedDialog'
    $form.MaximizeBox = $false
    $form.MinimizeBox = $false
    $form.ClientSize = New-Object System.Drawing.Size(560, 420)
    $form.BackColor = $navy
    $form.ForeColor = $text
    $form.Font = New-Object System.Drawing.Font('Segoe UI', 10)

    $icoCandidates = @(
        (Join-Path $PSScriptRoot 'icon.ico'),
        (Join-Path (Split-Path $PSScriptRoot -Parent) 'assets\icon.ico')
    )
    foreach ($ico in $icoCandidates) {
        if ($ico -and (Test-Path -LiteralPath $ico)) {
            try { $form.Icon = New-Object System.Drawing.Icon $ico } catch { }
            break
        }
    }

    $side = New-Object System.Windows.Forms.Panel
    $side.Location = New-Object System.Drawing.Point(0, 0)
    $side.Size = New-Object System.Drawing.Size(168, 420)
    $side.BackColor = $panel
    $form.Controls.Add($side)

    $bmp = Join-Path $PSScriptRoot 'installerSidebar.bmp'
    if (-not (Test-Path -LiteralPath $bmp)) {
        $bmp = Join-Path (Split-Path $PSScriptRoot -Parent) 'build\installerSidebar.bmp'
    }
    if (Test-Path -LiteralPath $bmp) {
        try {
            $pic = New-Object System.Windows.Forms.PictureBox
            $pic.Dock = 'Fill'
            $pic.SizeMode = 'Zoom'
            $pic.Image = [System.Drawing.Image]::FromFile($bmp)
            $side.Controls.Add($pic)
        } catch { }
    }

    $title = New-Object System.Windows.Forms.Label
    $title.Text = 'Project LoneWolf'
    $title.Font = New-Object System.Drawing.Font('Segoe UI Semibold', 16)
    $title.ForeColor = $accent
    $title.Location = New-Object System.Drawing.Point(188, 18)
    $title.AutoSize = $true
    $form.Controls.Add($title)

    $sub = New-Object System.Windows.Forms.Label
    $sub.Text = 'FirstBase installer - installs the latest launcher'
    $sub.ForeColor = $muted
    $sub.Location = New-Object System.Drawing.Point(190, 50)
    $sub.AutoSize = $true
    $form.Controls.Add($sub)

    $stepLabels = New-Object System.Collections.Generic.List[System.Windows.Forms.Label]
    $y = 92
    foreach ($name in $script:stepNames) {
        $l = New-Object System.Windows.Forms.Label
        $l.Text = "[ ]  $name"
        $l.ForeColor = $muted
        $l.Location = New-Object System.Drawing.Point(190, $y)
        $l.AutoSize = $true
        $form.Controls.Add($l)
        $stepLabels.Add($l)
        $y += 28
    }

    $bar = New-Object System.Windows.Forms.ProgressBar
    $bar.Location = New-Object System.Drawing.Point(190, 268)
    $bar.Size = New-Object System.Drawing.Size(340, 18)
    $bar.Style = 'Continuous'
    $form.Controls.Add($bar)

    $lbl = New-Object System.Windows.Forms.Label
    $lbl.Text = 'Preparing...'
    $lbl.ForeColor = $text
    $lbl.Location = New-Object System.Drawing.Point(190, 294)
    $lbl.Size = New-Object System.Drawing.Size(340, 48)
    $form.Controls.Add($lbl)

    $note = New-Object System.Windows.Forms.Label
    $note.Text = 'Unsigned. GitHub-downloaded Setup and portable exe can be blocked by Smart App Control. See the error page if download fails. Defender is not disabled.'
    $note.ForeColor = $muted
    $note.Font = New-Object System.Drawing.Font('Segoe UI', 8)
    $note.Location = New-Object System.Drawing.Point(190, 340)
    $note.Size = New-Object System.Drawing.Size(340, 56)
    $form.Controls.Add($note)

    $form.Show()
    $form.Refresh()
    [System.Windows.Forms.Application]::DoEvents()

    $script:ui = @{ form = $form; bar = $bar; lbl = $lbl; stepLabels = $stepLabels; pct = 0; status = ''; step = 0 }
}

function Invoke-DotNetInstall {
    param($Cfg)
    $present = Test-DotNet8DesktopRuntime -Cfg $Cfg
    if ($present) {
        Update-Ui -Step 1 -Pct 35 -Status ("{0} is already installed - skipping download." -f $script:runtimeDisplay)
        return
    }
    if ($SkipDotNetDownload) {
        throw ("{0} is required but -SkipDotNetDownload was set and it is not present." -f $script:runtimeDisplay)
    }
    $tmp = if ($MockRuntimeInstaller -and (Test-Path -LiteralPath $MockRuntimeInstaller)) {
        $MockRuntimeInstaller
    } else {
        $out = Join-Path $env:TEMP 'windowsdesktop-runtime-win-x64.exe'
        Update-Ui -Step 1 -Pct 20 -Status ("Downloading {0} from Microsoft..." -f $script:runtimeDisplay)
        Invoke-WebRequest -Uri $DotNetInstallerUrl -OutFile $out -UseBasicParsing
        $out
    }
    Update-Ui -Step 1 -Pct 30 -Status ("Installing {0} (quiet, no extra UAC)..." -f $script:runtimeDisplay)
    # Already elevated: do not request a second UAC for the runtime setup.
    $p = Start-Process -FilePath $tmp -ArgumentList $script:quietArgs -Wait -PassThru
    if ($p.ExitCode -notin 0, 3010) {
        throw "$script:runtimeDisplay installer exited $($p.ExitCode)"
    }
    if (-not $MockRuntimeInstaller -and (Test-Path -LiteralPath $tmp) -and $tmp -like '*windowsdesktop-runtime*') {
        Remove-Item -LiteralPath $tmp -Force -ErrorAction SilentlyContinue
    }
}

function Get-PublicLatest {
    try {
        $headers = @{ 'User-Agent' = 'LoneWolf-Launcher-Setup'; 'Accept' = 'application/json' }
        $got = Invoke-RestMethod -Uri $LatestJsonUrl -Headers $headers -Method Get
        if ($got -is [string]) {
            return ($got.TrimStart([char]0xFEFF).Trim() | ConvertFrom-Json)
        }
        return $got
    } catch { return $null }
}

function Get-BrowserDownloadUrl {
    param([string]$AssetName)
    $api = 'https://api.github.com/repos/joshuameadors-eng/Project-Lonewolf-Releases/releases/latest'
    $headers = @{ 'User-Agent' = 'LoneWolf-Launcher-Setup'; 'Accept' = 'application/vnd.github+json' }
    $rel = Invoke-RestMethod -Uri $api -Headers $headers
    foreach ($a in @($rel.assets)) {
        if ([string]$a.name -eq $AssetName) { return [string]$a.browser_download_url }
    }
    return $null
}

function Install-LauncherFiles {
    Update-Ui -Step 2 -Pct 55 -Status 'Installing the latest LoneWolf Launcher (portable exe)...'
    $null = $InnerNsis
    if (-not (Test-Path -LiteralPath $InstallDir)) {
        New-Item -ItemType Directory -Path $InstallDir -Force | Out-Null
    }
    $dest = Join-Path $InstallDir 'LoneWolf-Launcher.exe'
    $src = $PortableExe
    if (-not $src -or -not (Test-Path -LiteralPath $src)) {
        Update-Ui -Step 2 -Pct 50 -Status 'Downloading latest LoneWolf-Launcher.exe from public source (latest.json)...'
        $man = Get-PublicLatest
        $url = $null
        if ($man -and $man.urls -and $man.urls.portable) { $url = [string]$man.urls.portable }
        if (-not $url) {
            $url = 'https://raw.githubusercontent.com/joshuameadors-eng/Project-Lonewolf-Releases/main/bin/LoneWolf-Launcher.exe'
        }
        $src = Join-Path $InstallDir 'LoneWolf-Launcher.exe.incoming'
        Invoke-WebRequest -Uri $url -OutFile $src -UseBasicParsing -Headers @{ 'User-Agent' = 'LoneWolf-Launcher-Setup' }
    }
    Copy-Item -LiteralPath $src -Destination $dest -Force
    if ([string]$src -like '*.incoming') {
        Remove-Item -LiteralPath $src -Force -ErrorAction SilentlyContinue
    }
}

function Install-Shortcuts {
    Update-Ui -Step 3 -Pct 85 -Status 'Ensuring desktop and Start Menu shortcuts (Run as Administrator)...'
    $exe = Join-Path $InstallDir 'LoneWolf-Launcher.exe'
    if (-not (Test-Path -LiteralPath $exe)) {
        $alt = Get-ChildItem -LiteralPath $InstallDir -Filter 'LoneWolf-Launcher.exe' -Recurse -ErrorAction SilentlyContinue | Select-Object -First 1
        if ($alt) { $exe = $alt.FullName; $InstallDir = Split-Path $exe }
    }
    if (-not (Test-Path -LiteralPath $exe)) { throw ("Launcher exe not found under {0}" -f $InstallDir) }
    Ensure-LwShortcuts -ExePath $exe
}

function Invoke-InstallSteps {
    Update-Ui -Step 0 -Pct 8 -Status 'Preparing install...'
    Invoke-DotNetInstall -Cfg $script:rt
    Install-LauncherFiles
    Install-Shortcuts
    Update-Ui -Step 4 -Pct 100 -Status 'Done. You can close this window and launch Project LoneWolf Launcher from the desktop shortcut.'
}

try {
    $useUi = -not $Silent -and -not $Headless
    if ($useUi) { Show-StyledUi }
    Invoke-InstallSteps
    if ($useUi -and $script:ui.form) {
        Start-Sleep -Milliseconds 600
        $script:ui.form.Close()
    }
    exit 0
} catch {
    $msg = $_.Exception.Message
    if ($script:ui.form) {
        try { $script:ui.form.Close() } catch { }
    }
    if (-not $Silent -and -not $Headless) {
        Show-InstallErrorUi -Message $msg
    } elseif (-not $Silent) {
        Write-Error $msg
    }
    exit 1
}
