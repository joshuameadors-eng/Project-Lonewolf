const { app, BrowserWindow, ipcMain, dialog, shell } = require('electron')
const path = require('path')
const fs = require('fs')
const os = require('os')
const { spawn, exec } = require('child_process')

// ─── Early launch log (runs before anything else — helps diagnose silent crashes) ──
const LAUNCH_LOG = path.join(os.tmpdir(), 'lonewolf-launch.log')
try {
  fs.appendFileSync(LAUNCH_LOG,
    `[${new Date().toISOString()}] LAUNCH pid=${process.pid} ` +
    `isPackaged=${app.isPackaged} ` +
    `PORTABLE_EXECUTABLE_FILE=${process.env.PORTABLE_EXECUTABLE_FILE || 'UNSET'} ` +
    `execPath=${process.execPath} argv=${process.argv.join(' ')}\n`,
    'utf8')
} catch (_) {}

// ─── Crash logging ───────────────────────────────────────────────────────────
const CRASH_LOG = path.join(os.tmpdir(), 'lonewolf-crash.log')
function writeCrashLog(label, err) {
  try {
    const line = `[${new Date().toISOString()}] ${label}: ${err && err.stack ? err.stack : err}\n`
    fs.appendFileSync(CRASH_LOG, line)
    console.error(line)
  } catch (_) {}
}

process.on('uncaughtException', (err) => {
  writeCrashLog('uncaughtException', err)
  try {
    dialog.showErrorBox('Unexpected Error', String(err && err.message ? err.message : err))
  } catch (_) {}
})

process.on('unhandledRejection', (reason) => {
  writeCrashLog('unhandledRejection', reason)
})

// ─── Single instance lock ────────────────────────────────────────────────────
const gotLock = app.requestSingleInstanceLock()
if (!gotLock) {
  app.quit()
}

// ─── App User Model ID ───────────────────────────────────────────────────────
// Required for Windows toast notifications to appear as full toast cards
// (not just taskbar flashes) in both packaged and unpackaged/dev mode.
app.setAppUserModelId('com.lonewolf.launcher')

// ─── Paths ───────────────────────────────────────────────────────────────────
const IS_PACKED = app.isPackaged
const PS_DIR = IS_PACKED
  ? path.join(process.resourcesPath, 'powershell')
  : path.join(__dirname, 'src', 'powershell')
// Official (release) VERSION.json on the deployment share vs local/dev tree copy.
const SHARE_VERSION_JSON = '\\\\WIN-HQ5JDEACV3S\\Images\\FB Image Creation\\Remote\\Staging\\VERSION.json'
const LOCAL_VERSION_JSON = path.join(PS_DIR, 'VERSION.json')

const GET_USB_PS       = path.join(PS_DIR, 'Get-UsbDisks.ps1')
// Legacy PowerShell fallback when LoneWolf.Provisioner.exe is not bundled (dev without publish).
const BUILD_PS         = path.join(PS_DIR, 'Invoke-LoneWolfBuild.ps1')
const STAGING_PS       = path.join(PS_DIR, 'Get-StagingVersion.ps1')
// Dev-only pre-split producer: pre-splits install.wim into an install*.swm set and
// stages it (share, or the local Remote\Staging tree in local build mode).
const STAGE_PS         = path.join(PS_DIR, 'Stage-PreSplitImage.ps1')
const GET_UPDATE_PS    = path.join(PS_DIR, 'Get-LauncherUpdate.ps1')
const INSTALL_UPDATE_PS = path.join(PS_DIR, 'Install-LauncherUpdate.ps1')
const USB_POLICY_PS    = path.join(PS_DIR, 'Test-UsbPolicy.ps1')
const PROVISIONER_DIR  = IS_PACKED
  ? path.join(process.resourcesPath, 'provisioner')
  : path.join(__dirname, 'provisioner', 'publish')
const PROVISIONER_EXE  = path.join(PROVISIONER_DIR, 'LoneWolf.Provisioner.exe')
const RENDERER         = path.join(__dirname, 'src', 'renderer', 'index.html')

let mainWindow = null
let buildProcesses = []
let preCacheProcess = null

// ─── Dev logging ─────────────────────────────────────────────────────────────
const DEV_LOG = path.join(os.tmpdir(), 'lonewolf-dev.log')
function devLog(label, ...args) {
  if (IS_PACKED) return
  const ts = new Date().toISOString().replace('T', ' ').replace(/\.\d+Z$/, '')
  const msg = args.map(a => (typeof a === 'string' ? a : JSON.stringify(a))).join(' ')
  const line = `[${ts}] [${label}] ${msg}\n`
  process.stdout.write(line)
  try { fs.appendFileSync(DEV_LOG, line, 'utf8') } catch (_) {}
}

function killAllBuildProcesses() {
  for (const p of buildProcesses) {
    try { p.kill() } catch (_) {}
  }
  buildProcesses = []
}

// ─── Window creation ─────────────────────────────────────────────────────────
function createWindow() {
  // ─── OS-level splash window (shown immediately, before main window loads) ──
  let splash = null
  try {
    splash = new BrowserWindow({
      width: 480,
      height: 320,
      frame: false,
      transparent: true,
      alwaysOnTop: true,
      skipTaskbar: true,
      resizable: false,
      center: true,
      webPreferences: { nodeIntegration: false, contextIsolation: true }
    })
    splash.loadFile(path.join(__dirname, 'src', 'renderer', 'splash.html'))
    splash.webContents.on('did-finish-load', () => {
      splash.webContents.executeJavaScript(
        `document.querySelector('.sub').textContent = 'Launcher v${app.getVersion()}'`
      ).catch(() => {})
    })
    splash.show()
  } catch (splashErr) {
    writeCrashLog('splash creation error', splashErr)
    splash = null
  }

  try {
    mainWindow = new BrowserWindow({
      width: 1280,
      height: 820,
      minWidth: 1000,
      minHeight: 680,
      center: true,
      backgroundColor: '#010308',
      titleBarStyle: 'hidden',
      titleBarOverlay: {
        color: '#02040a',
        symbolColor: '#22d3ee',
        height: 40
      },
      icon: path.join(__dirname, 'assets', 'icon.png'),
      show: false,
      webPreferences: {
        preload: path.join(__dirname, 'preload.js'),
        contextIsolation: true,
        nodeIntegration: false,
        sandbox: false
      }
    })

    mainWindow.loadFile(RENDERER).catch((err) => {
      writeCrashLog('loadFile error', err)
      dialog.showErrorBox('Failed to load UI', `Could not load renderer:\n${err.message}`)
    })

    mainWindow.once('ready-to-show', () => {
      if (splash && !splash.isDestroyed()) splash.close()
      mainWindow.show()
      if (!IS_PACKED) mainWindow.webContents.openDevTools()
    })

    mainWindow.on('closed', () => {
      mainWindow = null
      killAllBuildProcesses()
      if (preCacheProcess) { try { preCacheProcess.kill() } catch (_) {} }
    })

    if (IS_PACKED) {
      mainWindow.webContents.on('before-input-event', (event, input) => {
        if (
          input.key === 'F12' ||
          (input.control && input.shift && input.key === 'I') ||
          (input.control && input.shift && input.key === 'J') ||
          (input.control && input.key === 'u')
        ) {
          event.preventDefault()
        }
      })
    }
  } catch (err) {
    writeCrashLog('createWindow error', err)
    dialog.showErrorBox('Window Creation Failed', `Could not create window:\n${err.message}`)
  }
}

// ─── Elevation check ─────────────────────────────────────────────────────────
// Uses PowerShell's WindowsPrincipal API — more reliable than `net session`
// which can return exit-code 0 for non-elevated domain admin sessions.
function checkElevation() {
  return new Promise((resolve) => {
    const psCmd = '[bool](([System.Security.Principal.WindowsPrincipal]' +
      '[System.Security.Principal.WindowsIdentity]::GetCurrent())' +
      '.IsInRole([System.Security.Principal.WindowsBuiltInRole]::Administrator))'
    exec(`powershell.exe -NoProfile -NonInteractive -Command "${psCmd}"`,
      { windowsHide: true },
      (_err, stdout) => resolve(stdout.trim().toLowerCase() === 'true')
    )
  })
}

function launcherPathIsUnc() {
  const p = String(process.env.PORTABLE_EXECUTABLE_FILE || process.execPath || '')
  if (!p) return false
  if (p.startsWith('\\\\')) return true
  // Win32 device namespace: \\?\UNC\server\share\...
  return /^\\\\\?\\UNC\\/i.test(p)
}

// ─── App lifecycle ────────────────────────────────────────────────────────────
app.whenReady().then(async () => {
  try { fs.appendFileSync(LAUNCH_LOG, `[${new Date().toISOString()}] READY\n`, 'utf8') } catch (_) {}

  if (IS_PACKED && launcherPathIsUnc()) {
    try { fs.appendFileSync(LAUNCH_LOG, `[${new Date().toISOString()}] NETWORK_LAUNCH blocked path=${process.env.PORTABLE_EXECUTABLE_FILE || process.execPath}\n`, 'utf8') } catch (_) {}
    await dialog.showMessageBox({
      type: 'error',
      title: 'Run from a local disk',
      message: 'Project LoneWolf Launcher cannot run from a network location.',
      detail: 'Copy LoneWolf-Launcher.exe to this PC (for example C:\\ProgramData\\LoneWolf) and run it from there.\n\nRunning from a share breaks USB writes, elevation, and updates.',
      buttons: ['OK'],
      defaultId: 0,
      noLink: true
    })
    app.quit()
    return
  }

  const elevated = await checkElevation()
  try { fs.appendFileSync(LAUNCH_LOG, `[${new Date().toISOString()}] ELEVATION_CHECK result=${elevated}\n`, 'utf8') } catch (_) {}
  if (!elevated) {
    if (!IS_PACKED) {
      // Dev mode: log a warning but continue so the app opens and build output
      // can be captured in the dev log for diagnosis.
      devLog('WARN', 'Not running as admin — build script will fail if triggered')
    } else {
      const selfPath = process.env.PORTABLE_EXECUTABLE_FILE || process.execPath
      try { fs.unlinkSync(selfPath + ':Zone.Identifier') } catch (_) {}

      // Show a visible dialog so the user explicitly initiates elevation.
      // This avoids silent-relaunch failures caused by policy/AV restrictions,
      // and makes the UAC prompt expected rather than surprising.
      const { response } = await dialog.showMessageBox({
        type: 'warning',
        title: 'Administrator Access Required',
        message: 'Project LoneWolf Launcher needs administrator access to write USB drives.',
        detail: 'Click "Relaunch as Administrator" to continue.\n\nA Windows security prompt (UAC) will appear — click Yes to proceed.',
        buttons: ['Relaunch as Administrator', 'Cancel'],
        defaultId: 0,
        cancelId: 1,
        noLink: true
      })

      if (response !== 0) {
        app.quit()
        return
      }

      // User confirmed — attempt elevation via VBScript ShellExecute runas.
      // Fall back to PowerShell Start-Process if wscript is unavailable.
      const safePath = selfPath.replace(/"/g, '""')
      let launched = false

      try {
        const vbs = `Set o = CreateObject("Shell.Application")\r\n` +
          `o.ShellExecute "${safePath}", "--lw-elevated", "", "runas", 1\r\n`
        const vbsPath = path.join(os.tmpdir(), 'lw-elevate.vbs')
        fs.writeFileSync(vbsPath, vbs, 'utf8')
        spawn('wscript.exe', [vbsPath], { detached: true, stdio: 'ignore' }).unref()
        launched = true
      } catch (_) {}

      if (!launched) {
        try {
          spawn('powershell.exe', [
            '-NoProfile', '-Command',
            `Start-Process -FilePath '${selfPath.replace(/'/g, "''")}' -ArgumentList '--lw-elevated' -Verb RunAs`
          ], { detached: true, stdio: 'ignore' }).unref()
          launched = true
        } catch (_) {}
      }

      if (!launched) {
        dialog.showErrorBox(
          'Administrator Required',
          'Could not relaunch automatically.\n\nPlease right-click the launcher and choose "Run as administrator".'
        )
      }

      setTimeout(() => app.quit(), 500)
      return
    }
  }
  createWindow()
  // Share credentials are no longer registered unconditionally at startup —
  // see ensureShareCredentials() below. This lets a fully-local dev session
  // (Settings → Local Build Mode) never touch the network, not even at launch.
}).catch((err) => {
  writeCrashLog('app.whenReady error', err)
})

app.on('second-instance', () => {
  if (mainWindow) {
    if (mainWindow.isMinimized()) mainWindow.restore()
    mainWindow.focus()
  }
})

app.on('window-all-closed', () => {
  app.quit()
})

// ─── Share credential registration ───────────────────────────────────────────
// Dev-only: when the renderer's "Local Build Mode" toggle is on, every share-
// dependent IPC (build/precache/staging-version/changelog/update-check) skips
// its network attempt entirely and this cmdkey registration never runs.
let devLocalBuildEnabled = false

function registerShareCredentials() {
  const host = 'WIN-HQ5JDEACV3S'
  exec(`cmdkey /delete:${host}`, () => {
    exec(`cmdkey /add:${host} /user:Reflect /pass:mer*HWE0upt*rqe@dud`, (err) => {
      if (err) console.warn('cmdkey registration warning:', err.message)
    })
  })
}

// Call right before any operation that touches \\WIN-HQ5JDEACV3S — registers
// credentials lazily (once per toggle-on session) instead of unconditionally
// at every startup, and is a full no-op while local build mode is active.
function ensureShareCredentials() {
  if (!IS_PACKED && devLocalBuildEnabled) return
  registerShareCredentials()
}

// ─── IPC: dev-only local build toggle ────────────────────────────────────────
// Renderer calls this whenever Settings → Local Build Mode changes (and once
// on settings-modal load) so main.js knows whether to skip the network entirely.
ipcMain.handle('dev:setLocalBuild', (event, enabled) => {
  devLocalBuildEnabled = !IS_PACKED && !!enabled
  devLog('IPC', `dev:setLocalBuild called | enabled=${devLocalBuildEnabled}`)
  return { ok: true }
})

// ─── Workflow-type normaliser ─────────────────────────────────────────────────
// Maps UI workflow type strings to provisioner workflow ids.
function resolveArch(workflowType) {
  const wt = (workflowType || '').toUpperCase()
  // QUICK-INSTALL: minimal payload-free install (its own -QuickInstall builder flag).
  if (wt === 'QUICK-INSTALL-AMD64') return { arch: 'QUICK-INSTALL-AMD64', quickInstall: true }
  if (wt === 'QUICK-INSTALL-ARM64') return { arch: 'QUICK-INSTALL-ARM64', quickInstall: true }
  if (wt === 'MEDIA-CREATOR') return { arch: 'MEDIA-CREATOR', noPayload: true }
  if (wt === 'BITRASER') return { arch: 'BITRASER', noPayload: true }
  if (wt === 'DESTRUCTION') return { arch: 'DESTRUCTION', noPayload: true }
  return { arch: wt || 'AMD64', noPayload: false }
}

// LoneWolf = the full FirstBase payload workflow (Intel/AMD "AMD64" + Snapdragon "ARM64").
// These builds are driven by the proven local PowerShell builder (Invoke-LoneWolfBuild.ps1),
// NOT the C# provisioner. Every OTHER workflow (WIN-INSTALL, MEDIA-CREATOR, BITRASER,
// DESTRUCTION) continues to use LoneWolf.Provisioner.exe unchanged.
function isLoneWolfWorkflow(rawWorkflowType) {
  const wt = (rawWorkflowType || '').toUpperCase()
  return wt === 'AMD64' || wt === 'ARM64' || wt === ''
}

// Workflows driven by the PowerShell builder (Invoke-LoneWolfBuild.ps1) rather than the
// C# provisioner. LoneWolf (full FirstBase payload, "Updates") plus the minimal QUICK-INSTALL
// (payload-free clean install, "No Updates"): QUICK-INSTALL routes here so the clean build runs
// Clear-Disk inside the elevated build job, avoiding the provisioner's nested-powershell CIM
// failure. MEDIA-CREATOR / BITRASER / DESTRUCTION stay on the provisioner.
function usesPsBuilder(rawWorkflowType) {
  const wt = (rawWorkflowType || '').toUpperCase()
  return isLoneWolfWorkflow(wt) || wt === 'QUICK-INSTALL-AMD64' || wt === 'QUICK-INSTALL-ARM64'
}

function getProvisionerExe() {
  const published = PROVISIONER_EXE
  const dllCandidates = [
    path.join(__dirname, 'provisioner', 'LoneWolf.Provisioner', 'bin', 'Release', 'net8.0-windows', 'win-x64', 'LoneWolf.Provisioner.dll'),
    path.join(__dirname, 'provisioner', 'LoneWolf.Provisioner', 'bin', 'Release', 'net8.0-windows', 'LoneWolf.Provisioner.dll'),
  ]

  let newestDll = null
  let newestMtime = 0
  for (const dll of dllCandidates) {
    if (!fs.existsSync(dll)) continue
    const mtime = fs.statSync(dll).mtimeMs
    if (mtime > newestMtime) {
      newestMtime = mtime
      newestDll = dll
    }
  }

  if (fs.existsSync(published)) {
    const pubMtime = fs.statSync(published).mtimeMs
    if (newestDll && newestMtime > pubMtime + 1000) {
      devLog('WARN', 'Using Release build provisioner (newer than publish/) — close launcher and run dotnet publish to sync')
      return { dll: true, path: newestDll }
    }
    return published
  }

  if (newestDll) return { dll: true, path: newestDll }
  return null
}

function spawnProvisioner(args) {
  const exe = getProvisionerExe()
  if (!exe) throw new Error('LoneWolf.Provisioner not found — run dotnet publish in provisioner/LoneWolf.Provisioner')
  if (typeof exe === 'object' && exe.dll) {
    const fullArgs = [exe.path, ...args]
    devLog('SPAWN', `dotnet ${fullArgs.join(' ')}`)
    return spawn('dotnet', fullArgs, { windowsHide: true })
  }
  devLog('SPAWN', `${PROVISIONER_EXE} ${args.join(' ')}`)
  return spawn(PROVISIONER_EXE, args, { windowsHide: true })
}

function runProvisionerCollect(args) {
  return new Promise((resolve, reject) => {
    const proc = spawnProvisioner(args)
    let stdout = ''
    let stderr = ''
    proc.stdout.on('data', (d) => {
      const text = d.toString()
      stdout += text
      text.split('\n').forEach(line => { if (line.trim()) devLog('STDOUT', line.trimEnd()) })
    })
    proc.stderr.on('data', (d) => {
      const text = d.toString()
      stderr += text
      text.split('\n').forEach(line => { if (line.trim()) devLog('STDERR', line.trimEnd()) })
    })
    proc.on('close', (code) => {
      devLog('EXIT', `provisioner code=${code}`)
      if (code !== 0) return reject(new Error(`Provisioner exit ${code}: ${stderr || stdout}`))
      resolve(stdout)
    })
    proc.on('error', (err) => reject(err))
  })
}

function parseProvisionerJson(stdout) {
  const jsonLine = stdout.split('\n').map(l => l.trim()).find(l => l.startsWith('{') || l.startsWith('['))
  if (!jsonLine) throw new Error('No JSON in provisioner output')
  return JSON.parse(jsonLine)
}

function buildProvisionerCommonArgs(params, workflowType, appResPath, localRemotePath, buildMeta) {
  const args = ['build', '--workflow', workflowType, '--app-resources', appResPath]
  if (params.sourcePath) args.push('--source', params.sourcePath)
  if (localRemotePath) args.push('--local-project-root', localRemotePath)
  if (params.sequentialBuild && !IS_PACKED) args.push('--sequential')
  if (buildMeta && buildMeta.devBuild) args.push('--dev-build')
  if (buildMeta && buildMeta.launcherVersion) args.push('--launcher-version', String(buildMeta.launcherVersion))
  if (buildMeta && buildMeta.scriptVersion) args.push('--script-version', String(buildMeta.scriptVersion))
  if (buildMeta && buildMeta.shareLauncherVersion) args.push('--share-launcher-version', String(buildMeta.shareLauncherVersion))
  if (buildMeta && buildMeta.shareScriptVersion) args.push('--share-script-version', String(buildMeta.shareScriptVersion))
  return args
}

// ─── PowerShell runner helpers ───────────────────────────────────────────────
function spawnPS(scriptPath, args) {
  const fullArgs = [
    '-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass',
    '-File', scriptPath, ...args
  ]
  // Suppress the routine USB-detection spawn from console + log (it polls frequently).
  // Genuine build-related spawns still log their SPAWN line.
  const isUsbDetectSpawn = /(^|[\\/])Get-UsbDisks\.ps1$/i.test(String(scriptPath || ''))
  if (!isUsbDetectSpawn) {
    devLog('SPAWN', `powershell.exe ${fullArgs.join(' ')}`)
  }
  return spawn('powershell.exe', fullArgs, { windowsHide: true })
}

function runPSCollect(scriptPath, args) {
  return new Promise((resolve, reject) => {
    const ps = spawnPS(scriptPath, args)
    let stdout = ''
    let stderr = ''
    ps.stdout.on('data', (d) => {
      const text = d.toString()
      stdout += text
      text.split('\n').forEach(line => { if (line.trim()) devLog('STDOUT', line.trimEnd()) })
    })
    ps.stderr.on('data', (d) => {
      const text = d.toString()
      stderr += text
      text.split('\n').forEach(line => { if (line.trim()) devLog('STDERR', line.trimEnd()) })
    })
    ps.on('close', (code) => {
      devLog('EXIT', `code=${code}`)
      if (code !== 0) return reject(new Error(`PS exit ${code}: ${stderr}`))
      resolve(stdout)
    })
    ps.on('error', (err) => {
      devLog('ERROR', `spawn error: ${err.message}`)
      reject(err)
    })
  })
}

// ─── IPC: app version ────────────────────────────────────────────────────────
ipcMain.handle('app:version', () => app.getVersion())

// Compare MAJOR.RELEASE.DEV (or any dotted numeric) versions. Returns >0 if a>b.
function compareLauncherSemVer(a, b) {
  const parse = (s) => String(s || '').replace(/[^0-9.]/g, '').split('.').map(n => parseInt(n, 10) || 0)
  const aa = parse(a)
  const bb = parse(b)
  const len = Math.max(aa.length, bb.length)
  for (let i = 0; i < len; i++) {
    const d = (aa[i] || 0) - (bb[i] || 0)
    if (d !== 0) return d
  }
  return 0
}

function readLocalVersionManifest() {
  try {
    return JSON.parse(fs.readFileSync(LOCAL_VERSION_JSON, 'utf8'))
  } catch (_) {
    return null
  }
}

async function readShareVersionManifest() {
  // Always register share credentials for the official VERSION.json cross-ref —
  // even when Local Build Mode is on (that mode only skips build/staging network use).
  registerShareCredentials()
  const raw = await Promise.race([
    fs.promises.readFile(SHARE_VERSION_JSON, 'utf8'),
    new Promise((_, reject) => setTimeout(() => reject(new Error('share read timeout')), 8000))
  ])
  return JSON.parse(raw)
}

/**
 * Dev-mode cross-ref: share (release) VERSION.json vs local/dev VERSION.json + package version.
 * - launcher: app.getVersion() / local.launcherVersion vs share.launcherVersion
 * - script:   local.version vs share.version  (product / staging script version)
 * isDevBuild when either local value is higher than share official.
 */
async function resolveDevVersionCrossRef() {
  const appVer = app.getVersion()
  const localManifest = readLocalVersionManifest()
  const localLauncher = (localManifest && (localManifest.launcherVersion || localManifest.version))
    ? String(localManifest.launcherVersion || localManifest.version)
    : appVer
  const localScript = (localManifest && (localManifest.version || localManifest.launcherVersion))
    ? String(localManifest.version || localManifest.launcherVersion)
    : null

  const result = {
    localLauncher: appVer,
    localLauncherManifest: localLauncher,
    localScript,
    shareLauncher: null,
    shareScript: null,
    launcherAhead: false,
    scriptAhead: false,
    isDevBuild: false,
    isUnpackaged: !IS_PACKED,
    shareError: null
  }

  // Prefer the higher of package.json vs local VERSION.json launcherVersion as "local launcher".
  const localLauncherEffective =
    compareLauncherSemVer(appVer, localLauncher) >= 0 ? appVer : localLauncher
  result.localLauncher = localLauncherEffective

  try {
    const share = await readShareVersionManifest()
    result.shareLauncher = (share && (share.launcherVersion || share.version)) ? String(share.launcherVersion || share.version) : null
    result.shareScript = (share && (share.version || share.launcherVersion)) ? String(share.version || share.launcherVersion) : null

    if (result.shareLauncher && localLauncherEffective &&
        compareLauncherSemVer(localLauncherEffective, result.shareLauncher) > 0) {
      result.launcherAhead = true
    }
    if (result.shareScript && localScript &&
        compareLauncherSemVer(localScript, result.shareScript) > 0) {
      result.scriptAhead = true
    }
    result.isDevBuild = result.launcherAhead || result.scriptAhead
  } catch (err) {
    result.shareError = err.message || String(err)
    // Unpackaged + share unreachable: treat as Dev so sticks still get the pill while testing offline.
    if (!IS_PACKED) result.isDevBuild = true
  }
  return result
}

async function resolveLauncherDevBuild() {
  const xref = await resolveDevVersionCrossRef()
  return !!xref.isDevBuild
}

ipcMain.handle('app:versionStatus', async () => {
  const xref = await resolveDevVersionCrossRef()
  return {
    local: xref.localLauncher,
    official: xref.shareLauncher,
    localScript: xref.localScript,
    officialScript: xref.shareScript,
    launcherAhead: xref.launcherAhead,
    scriptAhead: xref.scriptAhead,
    isDevBuild: xref.isDevBuild,
    isUnpackaged: xref.isUnpackaged,
    shareError: xref.shareError
  }
})

// ─── IPC: USB detect ─────────────────────────────────────────────────────────
ipcMain.handle('usb:detect', async () => {
  // Routine per-poll detection chatter (called / STDOUT / STDERR / PARSE-OK / EXIT)
  // is intentionally NOT logged — the renderer polls this once per second and it
  // floods the dev console/log. Only genuine failures below are logged.
  return new Promise((resolve) => {
    const ps = spawnPS(GET_USB_PS, [])
    let stdout = ''
    ps.stdout.on('data', (d) => {
      stdout += d.toString()
    })
    ps.stderr.on('data', () => {})
    ps.on('error', (err) => {
      devLog('ERROR', `usb:detect spawn error: ${err.message}`)
      resolve([])
    })
    ps.on('close', (code) => {
      if (code !== 0) {
        devLog('ERROR', `usb:detect non-zero exit — returning []`)
        resolve([])
        return
      }
      const trimmed = stdout.trim()
      if (!trimmed) { resolve([]); return }
      try {
        const parsed = JSON.parse(trimmed)
        // Guard: PS ConvertTo-Json can emit a bare object (not array) for a single item.
        // Wrap it so the renderer always gets an array.
        resolve(Array.isArray(parsed) ? parsed : [parsed])
      } catch (err) {
        devLog('ERROR', `JSON parse failed: ${err.message} | raw: "${trimmed.slice(0, 200)}"`)
        resolve([])
      }
    })
  })
})

// ─── IPC: USB policy check (MDM/Intune removable-storage restrictions) ──────
ipcMain.handle('system:checkUsbPolicy', async () => {
  devLog('IPC', `system:checkUsbPolicy called | script: ${USB_POLICY_PS}`)
  try {
    const raw = await runPSCollect(USB_POLICY_PS, [])
    const jsonLine = raw.split('\n').map(l => l.trim()).find(l => l.startsWith('{'))
    if (!jsonLine) throw new Error('No JSON object found in policy check output')
    return JSON.parse(jsonLine)
  } catch (err) {
    devLog('ERROR', `system:checkUsbPolicy failed: ${err.message}`)
    return { blocked: false, reasons: [] }
  }
})

// ─── IPC: share register ─────────────────────────────────────────────────────
ipcMain.handle('share:register', () => {
  return new Promise((resolve) => {
    registerShareCredentials()
    const host = 'WIN-HQ5JDEACV3S'
    const sharePath = `\\\\${host}\\Images\\FB Image Creation`
    exec(`cmd /c "if exist "${sharePath}" (echo reachable) else (echo unreachable)"`, (err, stdout) => {
      resolve({ reachable: !err && stdout.includes('reachable') })
    })
  })
})

// ─── IPC: build start ────────────────────────────────────────────────────────
ipcMain.handle('build:start', async (event, params) => {
  devLog('IPC', `build:start called | workflowType=${params.workflowType} disks=${JSON.stringify(params.disks || params.diskNumbers || [])}`)
  killAllBuildProcesses()

  const { arch: workflowType, noPayload, quickInstall } = resolveArch(params.workflowType)

  // Support new per-disk format { disks: [{number, mode}] } and legacy { diskNumbers: [...] }
  let diskEntries = []
  if (Array.isArray(params.disks)) {
    diskEntries = params.disks
  } else {
    diskEntries = (params.diskNumbers || []).map(n => ({ number: n, mode: 'full' }))
  }

  const fullNums    = diskEntries.filter(d => d.mode !== 'overlay').map(d => d.number)
  const overlayNums = diskEntries.filter(d => d.mode === 'overlay').map(d => d.number)

  const win = mainWindow
  let activeCount = 0
  const allSucceeded = []
  const allFailed    = []

  function attachBuildProcess(proc) {
    buildProcesses.push(proc)
    activeCount++
    let lineBuffer = ''

    proc.stdout.on('data', (chunk) => {
      // Buffer across chunks so a JSON event split over two TCP/pipe reads
      // is never fed half-complete to JSON.parse.
      lineBuffer += chunk.toString()
      const lines = lineBuffer.split('\n')
      lineBuffer = lines.pop() // retain the trailing incomplete line (if any)
      for (const line of lines) {
        const trimmed = line.trim()
        if (!trimmed) continue
        devLog('STDOUT', trimmed)
        try {
          const ev = JSON.parse(trimmed)
          devLog('PARSE-OK', JSON.stringify(ev).slice(0, 300))
          if (ev.event === 'summary') {
            // Accumulate — send aggregated summary when all processes finish
            ;(ev.succeeded || []).forEach(n => allSucceeded.push(n))
            ;(ev.failed    || []).forEach(n => allFailed.push(n))
          } else if (win && !win.isDestroyed()) {
            win.webContents.send('build:event', ev)
          }
        } catch (parseErr) {
          devLog('ERROR', `JSON parse failed: ${parseErr.message} | raw: "${trimmed.slice(0, 200)}"`)
        }
      }
    })

    proc.stderr.on('data', (chunk) => {
      const msg = chunk.toString().trim()
      if (msg) {
        devLog('STDERR', msg)
        if (win && !win.isDestroyed()) {
          win.webContents.send('build:event', { event: 'error', disk: -1, message: msg })
        }
      }
    })

    proc.on('close', (code) => {
      devLog('EXIT', `build process code=${code}`)
      buildProcesses = buildProcesses.filter(p => p !== proc)
      activeCount--
      if (activeCount === 0 && win && !win.isDestroyed()) {
        win.webContents.send('build:event', {
          event: 'summary',
          succeeded: allSucceeded,
          failed: allFailed
        })
        win.webContents.send('build:event', { event: 'exit', code: allFailed.length > 0 ? 1 : 0 })
      }
    })
  }

  // In dev mode process.resourcesPath points to Electron's own resources folder, not
  // the project's src tree.  Use __dirname/src so the payload bundled in the repo is found.
  const appResPath = IS_PACKED ? process.resourcesPath : path.join(__dirname, 'src')
  const isSequential = !IS_PACKED && !!params.sequentialBuild
  const localBuild = !IS_PACKED && (!!params.localBuild || devLocalBuildEnabled)
  const localRemotePath = localBuild ? path.join(app.getAppPath(), 'Remote') : null
  if (!localBuild) ensureShareCredentials()

  const cacheRootSuffix = workflowType.toUpperCase()
  // LoneWolf + WIN-INSTALL run the proven local PowerShell builder (never the provisioner).
  // Every other workflow (MEDIA-CREATOR / BITRASER / DESTRUCTION) uses the C# provisioner when available.
  const lonewolf = isLoneWolfWorkflow(params.workflowType)
  const psBuilder = usesPsBuilder(params.workflowType)
  const useProvisioner = !psBuilder && !!getProvisionerExe()
  // PS-builder workflows (Architecture B): mount share ISO per build + overlay from payload — no EspCache.
  const cacheRoot = psBuilder ? null : path.join('C:\\ProgramData\\LoneWolf\\EspCache', cacheRootSuffix)
  // The builder derives arch via $WorkflowType.ToUpper() and globs *(AMD64)*.iso, so it must
  // receive the bare arch (AMD64/ARM64), never the QUICK-INSTALL-* id.
  const psWorkflowType = workflowType.replace(/^QUICK-INSTALL-/i, '')
  const launcherVersion = app.getVersion()
  const xref = await resolveDevVersionCrossRef()
  const isDevBuild = !!xref.isDevBuild
  const scriptVersion = xref.localScript || ''
  const shareLauncher = xref.shareLauncher || ''
  const shareScript = xref.shareScript || ''
  devLog('IPC', `build:start routing | lonewolf=${lonewolf} psBuilder=${psBuilder} useProvisioner=${useProvisioner} cacheRoot=${cacheRoot || '(temp)'} | launcher=${launcherVersion} script=${scriptVersion} shareLauncher=${shareLauncher} shareScript=${shareScript} devBuild=${isDevBuild}`)
  const buildMeta = {
    devBuild: isDevBuild,
    launcherVersion,
    scriptVersion,
    shareLauncherVersion: shareLauncher,
    shareScriptVersion: shareScript
  }

  function appendPsDevStampArgs(args) {
    args.push('-LauncherVersion', launcherVersion)
    if (scriptVersion) args.push('-ScriptVersion', scriptVersion)
    if (shareLauncher) args.push('-ShareLauncherVersion', shareLauncher)
    if (shareScript) args.push('-ShareScriptVersion', shareScript)
    if (isDevBuild) args.push('-DevBuild')
  }

  if (fullNums.length > 0) {
    if (useProvisioner) {
      const args = buildProvisionerCommonArgs(params, workflowType, appResPath, localRemotePath, buildMeta)
      args.push('--disks', fullNums.join(','))
      args.push('--cache-root', cacheRoot)
      if (params.sourcePath) args.push('--source', params.sourcePath)
      attachBuildProcess(spawnProvisioner(args))
    } else {
      const fullArgs = [
        '-WorkflowType', psWorkflowType,
        '-DiskNumbers', fullNums.join(','),
        '-AppResourcesPath', appResPath
      ]
      if (cacheRoot) fullArgs.push('-CacheRoot', cacheRoot)
      // LoneWolf: force pull + mount of the newest share ISO (replaces manual selection).
      if (lonewolf) fullArgs.push('-PreferIso')
      if (noPayload) fullArgs.push('-NoPayload')
      if (quickInstall) fullArgs.push('-QuickInstall')
      if (params.dataVolumeLabel) fullArgs.push('-DataVolumeLabel', String(params.dataVolumeLabel).slice(0, 11))
      if (localBuild) fullArgs.push('-LocalProjectRoot', localRemotePath)
      appendPsDevStampArgs(fullArgs)
      attachBuildProcess(spawnPS(BUILD_PS, fullArgs))
    }
  }

  for (const diskNum of overlayNums) {
    if (useProvisioner) {
      const args = buildProvisionerCommonArgs(params, workflowType, appResPath, localRemotePath, buildMeta)
      args.push('--disks', String(diskNum))
      args.push('--overlay-only')
      args.push('--cache-root', cacheRoot)
      if (params.sourcePath) args.push('--source', params.sourcePath)
      attachBuildProcess(spawnProvisioner(args))
    } else {
      // Overlay (Quick Update): no re-image, so no ISO is mounted — omit -PreferIso.
      const overlayArgs = [
        '-WorkflowType', psWorkflowType,
        '-DiskNumbers', String(diskNum),
        '-OverlayOnly',
        '-AppResourcesPath', appResPath
      ]
      if (cacheRoot) overlayArgs.push('-CacheRoot', cacheRoot)
      if (noPayload) overlayArgs.push('-NoPayload')
      if (quickInstall) overlayArgs.push('-QuickInstall')
      if (params.dataVolumeLabel) overlayArgs.push('-DataVolumeLabel', String(params.dataVolumeLabel).slice(0, 11))
      if (localBuild) overlayArgs.push('-LocalProjectRoot', localRemotePath)
      appendPsDevStampArgs(overlayArgs)
      attachBuildProcess(spawnPS(BUILD_PS, overlayArgs))
    }
  }

  return { started: true }
})

// ─── IPC: build cancel ───────────────────────────────────────────────────────
ipcMain.handle('build:cancel', () => {
  killAllBuildProcesses()
  // A hard-killed build never runs its finally, so a share ISO can stay mounted. Fire a
  // one-shot marker-based sweep to dismount it promptly (dummy Workflow/Disk satisfy the
  // mandatory params; -DismountOnly short-circuits before any disk/share work).
  try {
    const sweep = spawnPS(BUILD_PS, ['-WorkflowType', 'AMD64', '-DiskNumbers', '0', '-DismountOnly'])
    sweep.on('error', () => {})
    if (sweep.stdout) sweep.stdout.on('data', () => {})
    if (sweep.stderr) sweep.stderr.on('data', () => {})
  } catch (_) {}
  return { cancelled: true }
})

// ─── IPC: pre-split staging start (DEV-ONLY producer) ─────────────────────────
// Runs Stage-PreSplitImage.ps1, which pre-splits install.wim into an install*.swm
// set + manifest. It emits the SAME single-line JSON events as the builder, so its
// stdout is forwarded to the existing 'build:event' channel (tagged staging:true so
// the renderer can route it to the staging progress UI, mirroring precache:true).
ipcMain.handle('stage:start', async (event, opts) => {
  opts = opts || {}
  devLog('IPC', `stage:start called | workflowType=${opts.workflowType} force=${!!opts.force} isoPath=${opts.isoPath || '(newest)'}`)
  killAllBuildProcesses()

  const { arch } = resolveArch(opts.workflowType)
  // The producer derives arch via $WorkflowType.ToUpper() and globs *(AMD64)*.iso, so it
  // must receive the bare arch (AMD64/ARM64), never a QUICK-INSTALL-* id.
  const psWorkflowType = arch.replace(/^QUICK-INSTALL-/i, '')

  // In dev mode process.resourcesPath points to Electron's own resources folder, not the
  // project src tree — mirror build:start and use __dirname/src for the bundled payload.
  const appResPath = IS_PACKED ? process.resourcesPath : path.join(__dirname, 'src')
  // Stage ISO is a DEV-ONLY producer whose sole purpose is to stage the .swm set into the
  // project's LOCAL Remote\Staging tree ("staged for upload to share"). It must NOT depend on
  // the separate Local Build Mode toggle: without -LocalProjectRoot the producer defaults to the
  // read-only share and fails at stage-copy with "Access to the path 'PreSplit' is denied".
  // So in dev it always stages locally; an explicit opts.localBuild===false can opt back to share.
  const localBuild = !IS_PACKED && (opts.localBuild !== false)
  const localRemotePath = localBuild ? path.join(app.getAppPath(), 'Remote') : null
  if (!localBuild) ensureShareCredentials()

  const args = ['-WorkflowType', psWorkflowType, '-AppResourcesPath', appResPath]
  if (localBuild) args.push('-LocalProjectRoot', localRemotePath)
  if (opts.isoPath) args.push('-IsoPath', opts.isoPath)
  if (opts.force) args.push('-Force')

  const win = mainWindow
  let proc
  try {
    proc = spawnPS(STAGE_PS, args)
  } catch (err) {
    devLog('ERROR', `stage:start spawn failed: ${err.message}`)
    return { ok: false, error: err.message }
  }

  buildProcesses.push(proc)
  let lineBuffer = ''
  proc.stdout.on('data', (chunk) => {
    // Buffer across chunks so a JSON event split over two pipe reads is never fed
    // half-complete to JSON.parse (identical handling to attachBuildProcess).
    lineBuffer += chunk.toString()
    const lines = lineBuffer.split('\n')
    lineBuffer = lines.pop()
    for (const line of lines) {
      const trimmed = line.trim()
      if (!trimmed) continue
      devLog('STDOUT', trimmed)
      try {
        const ev = JSON.parse(trimmed)
        devLog('PARSE-OK', JSON.stringify(ev).slice(0, 300))
        if (win && !win.isDestroyed()) win.webContents.send('build:event', { ...ev, staging: true })
      } catch (parseErr) {
        devLog('ERROR', `JSON parse failed: ${parseErr.message} | raw: "${trimmed.slice(0, 200)}"`)
      }
    }
  })

  proc.stderr.on('data', (chunk) => {
    const msg = chunk.toString().trim()
    if (msg) {
      devLog('STDERR', msg)
      if (win && !win.isDestroyed()) {
        win.webContents.send('build:event', { event: 'error', disk: -1, message: msg, staging: true })
      }
    }
  })

  proc.on('close', (code) => {
    devLog('EXIT', `stage process code=${code}`)
    buildProcesses = buildProcesses.filter(p => p !== proc)
    if (win && !win.isDestroyed()) {
      win.webContents.send('build:event', { event: 'exit', code: code || 0, staging: true })
    }
  })

  proc.on('error', (err) => {
    devLog('ERROR', `stage:start process error: ${err.message}`)
    if (win && !win.isDestroyed()) {
      win.webContents.send('build:event', { event: 'error', disk: -1, message: err.message, staging: true })
    }
  })

  return { ok: true, started: true }
})

// ─── IPC: pre-split staging cancel ────────────────────────────────────────────
// Mirrors build:cancel's kill path. A stage run has no ISO-on-USB side effects, and
// the producer dismounts its own ISO in a finally block, so no dismount sweep here.
ipcMain.handle('stage:cancel', () => {
  killAllBuildProcesses()
  return { cancelled: true }
})

// ─── IPC: pre-cache start ────────────────────────────────────────────────────
ipcMain.handle('precache:start', async (event, opts) => {
  const rawWorkflowType = typeof opts === 'string' ? opts : (opts && opts.workflowType)
  const { arch: workflowType, noPayload: precacheNoPayload } = resolveArch(rawWorkflowType)
  const forceIsoMode  = (opts && typeof opts === 'object' && !!opts.forceIsoMode) || precacheNoPayload
  const wipePrecache  = opts && typeof opts === 'object' && !!opts.wipePrecache
  const verboseLog    = opts && typeof opts === 'object' && !!opts.verboseLog
  // Local build mode: dev-only — mirrors build:start so pre-caching never needs the share either.
  const localBuild    = !IS_PACKED && (!!(opts && typeof opts === 'object' && opts.localBuild) || devLocalBuildEnabled)
  devLog('IPC', `precache:start called | workflowType=${workflowType} noPayload=${precacheNoPayload} forceIsoMode=${forceIsoMode} wipePrecache=${wipePrecache} verboseLog=${verboseLog} localBuild=${localBuild}`)
  if (preCacheProcess) {
    try { preCacheProcess.kill() } catch (_) {}
    preCacheProcess = null
  }
  if (!localBuild) ensureShareCredentials()

  const win = mainWindow

  // Use the same INSTALL suffix as build:start so precache warms the correct cache folder.
  const precacheCacheRootSuffix = workflowType
  const precacheCacheRoot = path.join('C:\\ProgramData\\LoneWolf\\EspCache', precacheCacheRootSuffix)

  if (wipePrecache) {
    try {
      fs.rmSync(precacheCacheRoot, { recursive: true, force: true })
      devLog('IPC', `precache:start — wiped cache dir: ${precacheCacheRoot}`)
    } catch (err) {
      devLog('IPC', `precache:start — wipe failed: ${err.message}`)
    }
  }

  const appResPath = IS_PACKED ? process.resourcesPath : path.join(__dirname, 'src')
  const localRemotePath = localBuild ? path.join(app.getAppPath(), 'Remote') : null

  // LoneWolf builds directly from the mounted share ISO (per-disk boot-file copy), so the
  // shared ESP pre-cache step does not apply. Report done immediately so the UI's pre-cache
  // gate clears without copying a multi-GB ISO just to warm a cache the build never reads.
  if (isLoneWolfWorkflow(rawWorkflowType)) {
    devLog('IPC', 'precache:start — lonewolf: skipping ESP pre-cache (build mounts ISO directly)')
    if (win && !win.isDestroyed()) {
      win.webContents.send('build:event', { event: 'done', disk: 0, success: true, precache: true })
    }
    return { started: true, skipped: true }
  }

  const useProvisioner = !!getProvisionerExe()

  if (useProvisioner) {
    // Disk 0 is a sentinel (not a real USB) — mirrors PowerShell -DiskNumbers 0 -PreCacheOnly.
    const args = ['precache', '--workflow', workflowType, '--disks', '0', '--app-resources', appResPath, '--cache-root', precacheCacheRoot]
    if (localRemotePath) args.push('--local-project-root', localRemotePath)
    if (opts && typeof opts === 'object' && opts.sourcePath) args.push('--source', opts.sourcePath)
    preCacheProcess = spawnProvisioner(args)
  } else {
    const precacheArgs = [
      '-WorkflowType', workflowType,
      '-DiskNumbers', '0',
      '-PreCacheOnly',
      '-AppResourcesPath', appResPath,
      '-CacheRoot', precacheCacheRoot
    ]
    if (localBuild) precacheArgs.push('-LocalProjectRoot', localRemotePath)
    if (precacheNoPayload) precacheArgs.push('-NoPayload')
    preCacheProcess = spawnPS(BUILD_PS, precacheArgs)
  }

  let preCacheLineBuffer = ''
  preCacheProcess.stdout.on('data', (chunk) => {
    // Buffer incomplete lines so a JSON event split across pipe chunks is not dropped.
    preCacheLineBuffer += chunk.toString()
    const lines = preCacheLineBuffer.split('\n')
    preCacheLineBuffer = lines.pop() // retain trailing incomplete line
    for (const line of lines) {
      const trimmed = line.trim()
      if (!trimmed) continue
      devLog('STDOUT', trimmed)
      try {
        const ev = JSON.parse(trimmed)
        devLog('PARSE-OK', JSON.stringify(ev).slice(0, 300))
        if (win && !win.isDestroyed()) {
          win.webContents.send('build:event', { ...ev, precache: true })
        }
      } catch (parseErr) {
        devLog('ERROR', `JSON parse failed: ${parseErr.message} | raw: "${trimmed.slice(0, 200)}"`)
      }
    }
  })

  preCacheProcess.stderr.on('data', (chunk) => {
    const msg = chunk.toString().trim()
    if (msg) {
      devLog('STDERR', msg)
      if (win && !win.isDestroyed()) {
        win.webContents.send('build:event', { event: 'error', disk: -1, message: msg, precache: true })
      }
    }
  })

  preCacheProcess.on('close', (code) => {
    devLog('EXIT', `precache code=${code}`)
    preCacheProcess = null
  })

  return { started: true }
})

// ─── IPC: staging version ─────────────────────────────────────────────────────
ipcMain.handle('staging:version', async (event, workflowType) => {
  const { arch } = resolveArch(workflowType)
  // QUICK-INSTALL resolves staging against the bare arch — its source is the standard
  // *(AMD64)*.iso on the share, so strip the QUICK-INSTALL- prefix here.
  const wf = arch.replace(/^QUICK-INSTALL-/i, '')
  const useLocal = !IS_PACKED && devLocalBuildEnabled
  devLog('IPC', `staging:version called | workflowType=${workflowType} localBuild=${useLocal}`)
  if (getProvisionerExe()) {
    try {
      const args = ['staging', 'info', '--workflow', wf]
      if (useLocal) args.push('--local-project-root', path.join(app.getAppPath(), 'Remote'))
      else ensureShareCredentials()
      const raw = await runProvisionerCollect(args)
      return parseProvisionerJson(raw)
    } catch (err) {
      devLog('IPC', `staging:version provisioner error: ${err.message}`)
    }
  }
  const stagingArgs = ['-WorkflowType', wf]
  if (useLocal) {
    stagingArgs.push('-LocalProjectRoot', path.join(app.getAppPath(), 'Remote'))
  } else {
    ensureShareCredentials()
  }
  try {
    const raw = await runPSCollect(STAGING_PS, stagingArgs)
    const jsonLine = raw.split('\n').map(l => l.trim()).find(l => l.startsWith('{'))
    if (!jsonLine) throw new Error('No JSON object found in staging script output')
    return JSON.parse(jsonLine)
  } catch (err) {
    console.error('staging:version error:', err.message)
    return { version: 'unknown', buildDate: '', workflowType: wf, wimLastModified: '', changelog: [], architectures: { AMD64: { enabled: true }, ARM64: { enabled: false } }, buildMode: 'none' }
  }
})

// ─── IPC: source discovery (hybrid local + share) ────────────────────────────
// Local ISO discovery runs in-process (no provisioner spawn) in two phases:
//   1. Known folders (Desktop / Downloads / Documents / ISO dirs) — returned inline.
//   2. Full sweep of every fixed + removable drive, streamed to the renderer as it
//      finds hits, so the picker is usable immediately instead of waiting minutes.
const LOCAL_ISO_SKIP_DIRS = new Set([
  'node_modules', '.git', 'dist', 'windows', 'program files', 'program files (x86)',
  '$recycle.bin', 'system volume information', 'recovery', 'perflogs',
  'temp', 'tmp', 'cache', 'winsxs', 'msocache', '$windows.~bt', '$windows.~ws'
])

const FULL_SWEEP_TTL_MS = 5 * 60 * 1000
const FULL_SWEEP_BUDGET_MS = 3 * 60 * 1000
let fullSweepToken = 0
let fullSweepCache = null   // { ts, list }

function inferIsoArch(name) {
  const u = String(name || '').toUpperCase()
  if (u.includes('ARM64') || u.includes('SNAPDRAGON')) return 'ARM64'
  if (u.includes('AMD64') || u.includes('X64')) return 'AMD64'
  return null
}

function makeIsoEntry(full, name, st) {
  return {
    path: full,
    name,
    origin: 'local',
    kind: 'iso',
    arch: inferIsoArch(name),
    sizeBytes: st.size,
    lastModified: st.mtime.toISOString()
  }
}

function quickIsoRoots() {
  const home = app.getPath('home')
  const roots = []
  for (const id of ['desktop', 'downloads', 'documents']) {
    try { roots.push(app.getPath(id)) } catch (_) {}
  }
  roots.push(
    path.join(home, 'Downloads'),
    'C:\\ISO',
    'C:\\Repos',
    path.join(process.env.ProgramData || 'C:\\ProgramData', 'LoneWolf', 'Sources')
  )
  return [...new Set(roots.map(r => path.normalize(r)))]
}

// DriveType 3 = fixed, 2 = removable. Network drives are excluded so a mapped
// deployment share never shows up as a "local" ISO.
function scannableDriveRoots() {
  return new Promise((resolve) => {
    const psCmd = "(Get-CimInstance Win32_LogicalDisk -Filter 'DriveType=3 OR DriveType=2' " +
      '| Where-Object { $_.Size -gt 0 }).DeviceID -join ","'
    exec(`powershell.exe -NoProfile -NonInteractive -Command "${psCmd}"`,
      { timeout: 10000, windowsHide: true }, (err, stdout) => {
        const letters = String(stdout || '').trim().split(',')
          .map(s => s.trim()).filter(s => /^[A-Za-z]:$/.test(s))
          .map(s => s.toUpperCase() + '\\')
        if (!err && letters.length) return resolve(letters)
        const fallback = []
        for (let code = 67; code <= 90; code++) {
          const root = String.fromCharCode(code) + ':\\'
          try { if (fs.existsSync(root)) fallback.push(root) } catch (_) {}
        }
        resolve(fallback)
      })
  })
}

async function scanIsoDir(dir, depth, maxDepth, results, seen) {
  let entries
  try { entries = await fs.promises.readdir(dir, { withFileTypes: true }) } catch (_) { return }
  for (const ent of entries) {
    const full = path.join(dir, ent.name)
    if (ent.isFile()) {
      if (!ent.name.toLowerCase().endsWith('.iso')) continue
      const key = full.toLowerCase()
      if (seen.has(key)) continue
      seen.add(key)
      try { results.push(makeIsoEntry(full, ent.name, await fs.promises.stat(full))) } catch (_) {}
      continue
    }
    if (!ent.isDirectory() || ent.isSymbolicLink() || depth >= maxDepth) continue
    if (LOCAL_ISO_SKIP_DIRS.has(ent.name.toLowerCase())) continue
    await scanIsoDir(full, depth + 1, maxDepth, results, seen)
  }
}

async function quickScanLocalIsos(seen) {
  const results = []
  for (const root of quickIsoRoots()) {
    if (!fs.existsSync(root)) continue
    await scanIsoDir(root, 0, 3, results, seen)
  }
  results.sort((a, b) => String(b.lastModified).localeCompare(String(a.lastModified)))
  return results
}

// Walks whole drives breadth-first with a bounded queue, streaming each batch of
// hits to the renderer. Aborts as soon as a newer sweep starts or the budget ends.
async function fullSweepLocalIsos(sender, token, seen, alreadyFound) {
  const roots = await scannableDriveRoots()
  const started = Date.now()
  const all = alreadyFound.slice()
  let queue = roots.filter(r => { try { return fs.existsSync(r) } catch (_) { return false } })
  let pending = []
  let lastEmit = 0
  let dirsWalked = 0
  let currentDir = queue[0] || ''

  // Depth of the deepest queued path drives the progress estimate — a breadth-first
  // walk drains most of its queue near the end, so remaining/total tracks well enough
  // to move a bar without pretending to know the true file count.
  const emit = (force) => {
    const now = Date.now()
    if (!force && now - lastEmit < 350) return
    lastEmit = now
    if (sender.isDestroyed()) return
    if (pending.length) {
      sender.send('sources:localFound', { token, entries: pending })
      pending = []
    }
    sender.send('sources:localProgress', {
      token,
      found: all.length,
      dirs: dirsWalked,
      queued: queue.length,
      current: currentDir,
      elapsedMs: now - started
    })
  }

  emit(true)

  while (queue.length) {
    if (token !== fullSweepToken || Date.now() - started > FULL_SWEEP_BUDGET_MS) break
    const chunk = queue.splice(0, 8)
    currentDir = chunk[0] || currentDir
    const nextDirs = await Promise.all(chunk.map(async (dir) => {
      dirsWalked++
      let entries
      try { entries = await fs.promises.readdir(dir, { withFileTypes: true }) } catch (_) { return [] }
      const subs = []
      for (const ent of entries) {
        const full = path.join(dir, ent.name)
        if (ent.isFile()) {
          if (!ent.name.toLowerCase().endsWith('.iso')) continue
          const key = full.toLowerCase()
          if (seen.has(key)) continue
          seen.add(key)
          try {
            const entry = makeIsoEntry(full, ent.name, await fs.promises.stat(full))
            all.push(entry)
            pending.push(entry)
          } catch (_) {}
          continue
        }
        if (!ent.isDirectory() || ent.isSymbolicLink()) continue
        if (LOCAL_ISO_SKIP_DIRS.has(ent.name.toLowerCase())) continue
        subs.push(full)
      }
      return subs
    }))
    for (const subs of nextDirs) queue.push(...subs)
    emit(false)
  }

  emit(true)
  if (token !== fullSweepToken) return
  all.sort((a, b) => String(b.lastModified).localeCompare(String(a.lastModified)))
  fullSweepCache = { ts: Date.now(), list: all }
  devLog('IPC', `sources:scanLocal sweep done | found=${all.length} dirs=${dirsWalked} ms=${Date.now() - started}`)
  if (!sender.isDestroyed()) {
    sender.send('sources:localDone', { token, count: all.length, dirs: dirsWalked })
  }
}

ipcMain.handle('sources:scanLocal', async (event) => {
  try {
    if (fullSweepCache && (Date.now() - fullSweepCache.ts) < FULL_SWEEP_TTL_MS) {
      return fullSweepCache.list
    }
    const token = ++fullSweepToken
    const seen = new Set()
    const quick = await quickScanLocalIsos(seen)
    fullSweepLocalIsos(event.sender, token, seen, quick)
      .catch(err => devLog('IPC', `sources:scanLocal sweep failed: ${err.message}`))
    return quick
  } catch (err) {
    devLog('IPC', `sources:scanLocal failed: ${err.message}`)
    return []
  }
})

ipcMain.handle('sources:cancelLocalScan', async () => {
  fullSweepToken++
  return true
})

ipcMain.handle('sources:scanShare', async (_event, workflowType) => {
  try {
    if (!getProvisionerExe()) return []
    const { arch: wf } = resolveArch(workflowType || 'AMD64')
    const useLocal = !IS_PACKED && devLocalBuildEnabled
    const args = ['sources', 'scan-share', '--workflow', wf]
    if (useLocal) args.push('--local-project-root', path.join(app.getAppPath(), 'Remote'))
    else ensureShareCredentials()
    const raw = await runProvisionerCollect(args)
    return parseProvisionerJson(raw)
  } catch (err) {
    devLog('IPC', `sources:scanShare failed: ${err.message}`)
    return []
  }
})

// Metadata-only source check: extension + name + stat, no ISO mount. The deep
// provisioner analysis mounts the image, and a share ISO is copied to local temp
// first, so a multi-GB UNC ISO costs minutes — far too slow for picker selection.
// Callers opt into the deep check explicitly (deep: true).
function quickAnalyzeSource(sourcePath, origin) {
  let stat = null
  try { stat = fs.statSync(sourcePath) } catch (_) {}
  const lower = sourcePath.toLowerCase()
  let buildMode = 'none'
  if (stat && stat.isDirectory()) buildMode = 'folder'
  else if (stat && lower.endsWith('.wim')) buildMode = 'wim'
  else if (stat && lower.endsWith('.iso')) buildMode = 'iso'

  const upper = sourcePath.toUpperCase()
  const arch = (upper.includes('ARM64') || upper.includes('SNAPDRAGON')) ? 'ARM64'
    : (upper.includes('AMD64') || upper.includes('X64')) ? 'AMD64'
      : null

  return {
    path: sourcePath,
    origin: origin || (sourcePath.startsWith('\\\\') ? 'share' : 'local'),
    buildMode,
    arch,
    sizeBytes: stat && stat.isFile() ? stat.size : 0,
    secureBootReady: false,
    deepAnalyzed: false,
    warnings: buildMode === 'none' ? ['Path not found or unsupported type'] : []
  }
}

ipcMain.handle('sources:analyze', async (_event, { path: sourcePath, origin, deep }) => {
  try {
    if (!sourcePath) throw new Error('path required')
    if (!deep) return quickAnalyzeSource(sourcePath, origin)
    if (!getProvisionerExe()) return { path: sourcePath, buildMode: 'none', warnings: ['Provisioner not available'] }
    const args = ['sources', 'analyze', '--path', sourcePath]
    if (origin) args.push('--origin', origin)
    const raw = await runProvisionerCollect(args)
    return { ...parseProvisionerJson(raw), deepAnalyzed: true }
  } catch (err) {
    devLog('IPC', `sources:analyze failed: ${err.message}`)
    return { path: sourcePath, buildMode: 'none', warnings: [err.message] }
  }
})

ipcMain.handle('sources:browse', async (_event, { kind }) => {
  const filters = kind === 'folder'
    ? []
    : [{ name: 'ISO Images', extensions: ['iso', 'wim'] }]
  const props = kind === 'folder' ? ['openDirectory'] : ['openFile']
  const result = await dialog.showOpenDialog({
    title: kind === 'folder' ? 'Select Windows image folder' : 'Select ISO or WIM',
    properties: props,
    filters
  })
  if (result.canceled || !result.filePaths.length) return null
  return result.filePaths[0]
})

// ─── IPC: changelog get ───────────────────────────────────────────────────────
// Reads changelog entries using a two-source fallback chain:
//   1. Share VERSION.json — direct fs read with 8 s timeout (no PS, no admin needed)
//   2. Local bundled VERSION.json — always present, no network required
// Share credentials are registered lazily via ensureShareCredentials() (skipped
// entirely in local build mode — see registerShareCredentials() above).

function readLocalChangelog() {
  try {
    const data = JSON.parse(fs.readFileSync(LOCAL_VERSION_JSON, 'utf8'))
    if (Array.isArray(data.changelog) && data.changelog.length > 0) return data.changelog
  } catch (_) {}
  return null
}

ipcMain.handle('changelog:get', async () => {
  devLog('IPC', `changelog:get called | shareJson=${SHARE_VERSION_JSON} | localJson=${LOCAL_VERSION_JSON} | localBuild=${devLocalBuildEnabled}`)
  // Local build mode: skip the network attempt entirely and go straight to the
  // bundled copy — there is no point waiting out an 8s timeout against a share
  // this session was never meant to reach.
  if (!IS_PACKED && devLocalBuildEnabled) {
    const local = readLocalChangelog()
    devLog('IPC', `changelog:get local build mode — using bundled changelog (${local ? local.length : 0} entries)`)
    return local || []
  }
  ensureShareCredentials()
  try {
    const raw = await Promise.race([
      fs.promises.readFile(SHARE_VERSION_JSON, 'utf8'),
      new Promise((_, reject) => setTimeout(() => reject(new Error('share read timeout')), 8000))
    ])
    const data = JSON.parse(raw)
    if (Array.isArray(data.changelog) && data.changelog.length > 0) {
      devLog('IPC', `changelog:get share ok — ${data.changelog.length} entries`)
      return data.changelog
    }
    devLog('IPC', 'changelog:get share returned empty changelog — trying local fallback')
  } catch (err) {
    devLog('IPC', `changelog:get share failed: ${err.message}`)
  }
  const local = readLocalChangelog()
  if (local) {
    devLog('IPC', `changelog:get using local fallback — ${local.length} entries`)
    return local
  }
  devLog('IPC', 'changelog:get both sources failed — returning empty')
  return []
})

// ─── IPC: launcher update check ──────────────────────────────────────────────
let updateNotificationFired = false
ipcMain.handle('update:check', async () => {
  const version = app.getVersion()
  // Local build mode: a fully-local dev session has nothing meaningful to self-update
  // against — skip the network call rather than waiting on an unreachable share.
  if (!IS_PACKED && devLocalBuildEnabled) {
    devLog('IPC', 'update:check skipped — local build mode active')
    return { updateAvailable: false, reason: 'local-build-mode' }
  }
  ensureShareCredentials()
  devLog('IPC', `update:check called | currentVersion=${version} | script=${GET_UPDATE_PS} | exists=${fs.existsSync(GET_UPDATE_PS)}`)
  try {
    const raw = await runPSCollect(GET_UPDATE_PS, ['-CurrentVersion', version])
    devLog('IPC', `update:check raw output: ${raw.trim().substring(0, 200)}`)
    const jsonLine = raw.split('\n').map(l => l.trim()).find(l => l.startsWith('{'))
    if (!jsonLine) throw new Error('No JSON object found in update check output')
    const result = JSON.parse(jsonLine)
    devLog('IPC', `update:check result: updateAvailable=${result.updateAvailable} latestVersion=${result.latestVersion}`)
    if (result && result.updateAvailable && !updateNotificationFired) {
      updateNotificationFired = true
      const { Notification } = require('electron')
      if (Notification.isSupported()) {
        new Notification({
          title: 'LoneWolf Launcher \u2014 Update Available',
          body: 'A new version is ready. The app will update now.'
        }).show()
      }
    }
    return result
  } catch (e) {
    devLog('IPC', `update:check ERROR: ${e.message}`)
    return { updateAvailable: false, error: e.message }
  }
})

// ─── IPC: launcher update install ────────────────────────────────────────────
ipcMain.handle('update:install', async (event, { exePath }) => {
  devLog('IPC', `update:install called | exePath=${exePath} | IS_PACKED=${IS_PACKED}`)
  if (!IS_PACKED) return { ok: false, reason: 'dev-mode' }

  const tmpExe = path.join(os.tmpdir(), 'LoneWolf-update.exe')
  devLog('IPC', `update:install copying from share: ${exePath} -> ${tmpExe}`)
  try {
    // Use fs.promises.copyFile to reliably copy from a UNC path to a local temp file.
    // Credentials for the share are registered lazily via ensureShareCredentials() — this
    // path is unreachable in local build mode since update:check already returned early.
    await fs.promises.copyFile(exePath, tmpExe)
    devLog('IPC', `update:install copy succeeded`)
  } catch (err) {
    devLog('IPC', `update:install copy FAILED: ${err.message}`)
    return { ok: false, error: `Could not download update from share: ${err.message}` }
  }

  // Strip Zone.Identifier (Mark of the Web) from the downloaded temp exe.
  // Files copied from network shares inherit a security zone that blocks the
  // embedded requireAdministrator manifest from triggering UAC correctly.
  try {
    const zoneStream = tmpExe + ':Zone.Identifier'
    await fs.promises.unlink(zoneStream).catch(() => {})
    devLog('IPC', `update:install Zone.Identifier stripped from temp exe`)
  } catch (_) {}

  const currentExe = process.env.PORTABLE_EXECUTABLE_FILE || process.execPath
  const pid = process.pid

  // Ensure persistent log dir exists and write a JS-side diagnostic entry
  // so we can confirm this code path was reached even in packaged/elevated mode.
  const LONEWOLF_DATA_DIR = 'C:\\ProgramData\\LoneWolf'
  const installerLog = path.join(LONEWOLF_DATA_DIR, 'installer.log')
  try { fs.mkdirSync(LONEWOLF_DATA_DIR, { recursive: true }) } catch (_) {}
  try {
    fs.appendFileSync(installerLog,
      `[${new Date().toISOString()}] JS update:install: pid=${pid} tmpExe="${tmpExe}" PORTABLE_EXECUTABLE_FILE="${process.env.PORTABLE_EXECUTABLE_FILE}" currentExe="${currentExe}"\n`,
      'utf8')
  } catch (_) {}

  devLog('IPC', `update:install | PORTABLE_EXECUTABLE_FILE=${process.env.PORTABLE_EXECUTABLE_FILE} | using currentExe=${currentExe} | pid=${pid} | cmdLog=${installerLog}`)

  // Generate a self-contained .cmd installer file at runtime.
  // This is more reliable than a detached PS script: plain cmd built-ins,
  // no execution-policy concerns, no $env:TEMP elevation ambiguity, and
  // every step is logged to a fixed ProgramData path visible from any context.
  const cmdFilePath = path.join(os.tmpdir(), 'lonewolf-update.cmd')
  const cmdLines = [
    '@echo off',
    'setlocal',
    `set "LOG=${installerLog}"`,
    `set "SRC=${tmpExe}"`,
    `set "DST=${currentExe}"`,
    'echo [%DATE% %TIME%] CMD updater started >> "%LOG%"',
    'echo [%DATE% %TIME%] SRC=%SRC% >> "%LOG%"',
    'echo [%DATE% %TIME%] DST=%DST% >> "%LOG%"',
    'ping -n 4 127.0.0.1 > nul',
    'echo [%DATE% %TIME%] Waited ~3s for old process to exit >> "%LOG%"',
    'copy /Y "%SRC%" "%DST%"',
    'if errorlevel 1 (',
    '    echo [%DATE% %TIME%] ERROR: copy failed >> "%LOG%"',
    '    exit /b 1',
    ')',
    'echo [%DATE% %TIME%] Copy succeeded >> "%LOG%"',
    'start "" "%DST%"',
    'echo [%DATE% %TIME%] Relaunch launched >> "%LOG%"',
    'del "%SRC%" 2>nul',
    'endlocal',
  ]

  try {
    fs.writeFileSync(cmdFilePath, cmdLines.join('\r\n'), 'utf8')
    fs.appendFileSync(installerLog,
      `[${new Date().toISOString()}] JS: cmd file written: "${cmdFilePath}"\n`, 'utf8')
  } catch (err) {
    devLog('IPC', `update:install cmd write FAILED: ${err.message}`)
    return { ok: false, error: `Could not write update script: ${err.message}` }
  }

  // Write a VBScript wrapper so the .cmd runs with no visible window flash.
  // wscript.exe with windowStyle=0 is completely hidden; cmd.exe always shows briefly.
  const vbsPath = path.join(os.tmpdir(), 'lonewolf-update.vbs')
  const vbsContent = `Set oShell = CreateObject("WScript.Shell")\r\noShell.Run """${cmdFilePath}""", 0, False\r\n`
  let useVbs = true
  try {
    fs.writeFileSync(vbsPath, vbsContent, 'utf8')
    devLog('IPC', `update:install vbs written: ${vbsPath}`)
  } catch (vbsErr) {
    devLog('IPC', `update:install vbs write FAILED: ${vbsErr.message} — falling back to cmd.exe`)
    useVbs = false
  }

  if (useVbs) {
    devLog('IPC', `update:install spawning wscript: ${vbsPath}`)
    spawn('wscript.exe', [vbsPath], { detached: true, stdio: 'ignore' }).unref()
  } else {
    devLog('IPC', `update:install spawning cmd: ${cmdFilePath}`)
    spawn('cmd.exe', ['/c', cmdFilePath], { detached: true, stdio: 'ignore' }).unref()
  }

  setTimeout(() => app.quit(), 500)
  return { ok: true }
})

// ─── IPC: build check-update ─────────────────────────────────────────────────
ipcMain.handle('build:check-update', async (event, params) => {
  devLog('IPC', `build:check-update called | workflowType=${params && params.workflowType}`)
  const wf = (params && params.workflowType) || 'AMD64'
  try {
    const [disksRaw, stagingRaw] = await Promise.all([
      runPSCollect(GET_USB_PS, []),
      runPSCollect(STAGING_PS, ['-WorkflowType', wf])
    ])
    const disksJsonLine = disksRaw.split('\n').map(l => l.trim()).find(l => l.startsWith('[') || l.startsWith('{'))
    if (!disksJsonLine) throw new Error('No JSON found in USB disk script output')
    const stagingJsonLine = stagingRaw.split('\n').map(l => l.trim()).find(l => l.startsWith('{'))
    if (!stagingJsonLine) throw new Error('No JSON object found in staging script output')
    const disks   = JSON.parse(disksJsonLine)
    const staging = JSON.parse(stagingJsonLine)
    const stagingVersion = staging.version

    return disks.map(disk => {
      let recommendation = 'full'
      if (disk.isLoneWolfDisk === true) {
        recommendation = disk.lwVersion === stagingVersion ? 'current' : 'overlay'
      }
      return {
        disk:           disk.number,
        recommendation,
        currentVersion: disk.lwVersion || null,
        stagingVersion
      }
    })
  } catch (err) {
    console.error('build:check-update error:', err.message)
    return []
  }
})

// ─── IPC: dev info ────────────────────────────────────────────────────────────
ipcMain.handle('app:dev-info', () => ({
  isPackaged: IS_PACKED,
  devLogPath: IS_PACKED ? null : DEV_LOG
}))

// ─── IPC: is dev mode ─────────────────────────────────────────────────────────
ipcMain.handle('app:isDevMode', () => !IS_PACKED)

// ─── IPC: open dev log ───────────────────────────────────────────────────────
ipcMain.handle('log:open-dev-log', () => {
  if (!IS_PACKED) shell.openPath(DEV_LOG)
})

// ─── IPC: renderer error ─────────────────────────────────────────────────────
ipcMain.on('log:renderer-error', (_event, info) => {
  const msg = (info && (info.stack || info.message)) || String(info)
  devLog('RENDERER', msg)
})

// ─── IPC: USB stale-drive notification (debounced per serial per session) ─────
const notifiedStaleDriveSerials = new Set()
ipcMain.on('usb:stale-drive', (_event, info) => {
  const serial = info && info.serial
  if (!serial || notifiedStaleDriveSerials.has(serial)) return
  notifiedStaleDriveSerials.add(serial)
  const { Notification } = require('electron')
  if (Notification.isSupported()) {
    new Notification({
      title: 'USB Drive Needs Update',
      body: 'A connected USB stick is running an older workflow version.'
    }).show()
  }
})

// ─── IPC: dev test notifications ─────────────────────────────────────────────
ipcMain.on('dev:testNotification', (_event, { type } = {}) => {
  const { Notification } = require('electron')
  if (!Notification.isSupported()) return
  const win = mainWindow
  devLog('IPC', `dev:testNotification type=${type}`)
  if (type === 'update') {
    new Notification({
      title: 'LoneWolf Launcher \u2014 Update Available',
      body: 'A new version is ready. The app will update now.'
    }).show()
    if (win && !win.isDestroyed() && win.flashFrame) {
      win.flashFrame(true)
      setTimeout(() => { if (!win.isDestroyed()) win.flashFrame(false) }, 5000)
    }
  } else if (type === 'staleUsb') {
    new Notification({
      title: 'USB Drive Needs Update',
      body: 'A connected USB stick is running an older workflow version.'
    }).show()
    if (win && !win.isDestroyed() && win.flashFrame) {
      win.flashFrame(true)
      setTimeout(() => { if (!win.isDestroyed()) win.flashFrame(false) }, 5000)
    }
  } else if (type === 'buildComplete') {
    new Notification({
      title: 'Build Complete',
      body: 'USB drive build completed successfully.'
    }).show()
    if (win && !win.isDestroyed() && win.flashFrame) {
      win.flashFrame(true)
      setTimeout(() => { if (!win.isDestroyed()) win.flashFrame(false) }, 5000)
    }
  }
})

// ─── IPC: disk complete notification + taskbar flash ─────────────────────────
// Multiple sticks finishing close together coalesce into one notification.
let pendingReadyDisks = []
let readyNotifyTimer = null
let readyFlashArmed = false

function flushReadyNotification() {
  readyNotifyTimer = null
  const n = pendingReadyDisks.length
  pendingReadyDisks = []
  readyFlashArmed = false
  if (n <= 0) return
  const { Notification } = require('electron')
  if (!Notification.isSupported()) return
  if (n === 1) {
    new Notification({
      title: 'USB Ready',
      body: 'The USB drive has been built successfully.'
    }).show()
  } else {
    new Notification({
      title: 'USB Ready',
      body: `${n} USB drives have been built successfully.`
    }).show()
  }
}

ipcMain.on('build:diskComplete', (_event, info) => {
  const win = mainWindow
  if (!win || win.isDestroyed()) return

  if (!readyFlashArmed && win.flashFrame) {
    readyFlashArmed = true
    win.flashFrame(true)
    setTimeout(() => { if (!win.isDestroyed()) win.flashFrame(false) }, 5000)
  }

  pendingReadyDisks.push(info || {})
  if (readyNotifyTimer) clearTimeout(readyNotifyTimer)
  readyNotifyTimer = setTimeout(flushReadyNotification, 1500)
})
