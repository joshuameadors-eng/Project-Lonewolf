/* Builder page — USB detection, confirm modal, per-disk progress */
;(function () {

  const USB_ICON_SVG = `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"
    stroke-linecap="round" stroke-linejoin="round" width="20" height="20" style="color:#22d3ee">
    <path d="M11 8v5l3 3"/><path d="M12 3v5"/>
    <rect x="8" y="8" width="8" height="10" rx="1"/>
    <path d="M8 12H4v5a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2v-5h-4"/>
    <circle cx="12" cy="3" r="1"/>
  </svg>`

  const PHASES = {
    'waiting':        { label: 'Waiting…',           pct: 0 },
    'starting':       { label: 'Starting…',          pct: 5 },
    'partitioning':   { label: 'Partitioning…',     pct: 10 },
    'esp-copy':       { label: 'ESP Copy…',          pct: 30 },
    'data-copy':      { label: 'Copying ISO Data…', pct: 60 },
    'wim-presplit':   { label: 'Copying split WIM…', pct: 60 },
    'wim-split':      { label: 'Splitting WIM…',      pct: 60 },
    'iso-dd':         { label: 'Writing ISO image…', pct: 50 },
    'dism':           { label: 'DISM Apply…',        pct: 60 },
    'winpe-inject':   { label: 'Injecting WinPE…',   pct: 0 },
    'overlay':        { label: 'Overlay Deploy…',    pct: 85 },
    'overlay-update': { label: 'Quick Update…',      pct: 50 },
    'done':           { label: 'Done ✓',             pct: 100 },
    'failed':         { label: 'Failed ✗',           pct: 100 }
  }

  // Phases whose bar is driven by live per-disk pct (progress events carry pct),
  // as opposed to static phase-based pct. Keep every pct-driven site using this one
  // set so a new streaming phase (e.g. wim-split / wim-presplit) shows up everywhere.
  const LIVE_PROGRESS_PHASES = new Set([
    'esp-copy', 'data-copy', 'iso-dd', 'wim-presplit', 'wim-split', 'dism', 'winpe-inject'
  ])

  // Full-pipeline 0–100 bands so overall progress never jumps backward when a
  // stick finishes one live phase (100) and starts the next (0).
  // wim-presplit / wim-split / dism share the Install band (mutually exclusive).
  const PHASE_RANGES = {
    'waiting':        { start: 0,  end: 0 },
    'starting':       { start: 0,  end: 5 },
    'partitioning':   { start: 5,  end: 12 },
    'esp-copy':       { start: 12, end: 28 },
    'data-copy':      { start: 28, end: 55 },
    'iso-dd':         { start: 12, end: 95 },
    'wim-presplit':   { start: 55, end: 82 },
    'wim-split':      { start: 55, end: 82 },
    'dism':           { start: 55, end: 82 },
    'winpe-inject':   { start: 82, end: 95 },
    'overlay':        { start: 95, end: 99 },
    'overlay-update': { start: 50, end: 99 },
    'done':           { start: 100, end: 100 },
    'failed':         { start: 100, end: 100 }
  }

  // Ordinal for stage-strip aggregation (higher = further along).
  const PHASE_ORDER = {
    'waiting': 0, 'starting': 1, 'partitioning': 2,
    'esp-copy': 3, 'data-copy': 4, 'iso-dd': 4,
    'wim-presplit': 5, 'wim-split': 5, 'dism': 5,
    'winpe-inject': 6, 'overlay': 7, 'overlay-update': 7,
    'done': 8, 'failed': 8
  }

  // Compact multi-disk stage strip under the overall bar.
  const OVERALL_STAGES = [
    { id: 'partition', label: 'Partition', order: 2 },
    { id: 'esp',       label: 'ESP',       order: 3 },
    { id: 'data',      label: 'Data',      order: 4 },
    { id: 'install',   label: 'Install',   order: 5 },
    { id: 'winpe',     label: 'WinPE',     order: 6 },
    { id: 'finish',    label: 'Finish',    order: 7 }
  ]

  // Write-back flush tail (wim-presplit / esp-copy): dest sizes often look
  // "complete" minutes before FAT32 USB write-back finishes. Climb asymptotically
  // toward a soft cap — never show 99% until the phase truly ends.
  const FLUSH_FAKE_TAU_MS = 240000  // ~4 min time-constant; ~10+ min near soft-cap
  const FLUSH_FAKE_SOFT_CAP = 93
  const STALL_MS = 1800

  // Friendly labels for the pre-split producer's phases (Stage-PreSplitImage.ps1).
  // Stage events arrive on build:event tagged staging:true and drive the pre-cache bar.
  const STAGE_PHASE_LABELS = {
    'stage-mount':    'Mounting ISO…',
    'stage-split':    'Splitting image…',
    'stage-copy':     'Copying .swm…',
    'stage-manifest': 'Writing manifest…',
    'stage-verify':   'Verifying…'
  }

  // Phases that mean a disk has its own pipeline underway — never overwrite
  // these labels with global/disk-0 prep or WinPE status from another stick.
  const DISK_OWNED_PHASES = new Set([
    'partitioning', 'esp-copy', 'data-copy', 'iso-dd', 'wim-presplit', 'wim-split', 'dism',
    'winpe-inject', 'overlay', 'overlay-update', 'done', 'failed'
  ])

  // A source scan walks the share plus every local scan root, so it costs seconds.
  // The merged list survives page navigation for this window; Refresh forces a rescan.
  const SOURCE_CACHE_TTL_MS = 5 * 60 * 1000
  let sourceCache = null      // { key, ts, list }

  // ─── State ──────────────────────────────────────────────────────────────
  let disks = []
  let selected = new Set()
  let building = false
  let isLoadingDisks = false   // true while detectDisks() is running
  let preCachePct = null
  let preCacheRunning = false
  let preCacheDone = false       // true once pre-cache completes (or errors, or ISO mode)
  let preCacheDialogShown = false // dialog shown during pre-cache
  let autoStartOnComplete = false // user chose "yes" in the pre-cache dialog
  let destroyConfirmed = false    // user clicked Confirm in the destruction warning modal
  let diskStates = {}    // disk number -> { phase, pct, done, failed, error }
  let diskModes  = {}    // disk number -> 'full' | 'overlay'
  let currentBuildDisks = []  // disk numbers in the active build (drives the overall-progress bar)
  let stagingVersion = null
  let stagingWimBuildDate = null
  let buildMode = null        // 'wim' | 'iso' | 'none' | null (auto-detected)
  let forceBuildMode = null   // 'wim' | 'iso' | null (dev override)
  let sources = []            // unified local + share source list
  let selectedSource = null   // { path, origin, kind, ... }
  let sourceAnalysis = null
  let isoMountedLetter = null
  let sourceFolder = null     // folder the picker is drilled into (null = top view)
  let sourceScanning = false
  let sweepRunning = false    // full-system ISO sweep still streaming results
  let sweepStats = { found: 0, dirs: 0, current: '' }
  let sweepHideTimer = null
  const freshSourcePaths = new Set()  // tiles to animate in on the next render
  // Share ISOs are opt-in — local disks are the default view for Media Creator.
  let showShareSources = localStorage.getItem('lw_media.showShare') === 'true'
  let fixedShareIsoFile = null
  // Pre-split staging (DEV-ONLY, LoneWolf workflows) — fed by staging:version.
  let staging = false                 // true while a Stage ISO run is underway
  let preSplitAvailable = false       // a pre-split set exists for this arch
  let preSplitMatchesIso = false      // that set matches the newest ISO
  let preSplitImageVersion = null     // its image-version string (or null)
  let flushAnimTimer = null           // interval while any disk is Finalizing…
  let stallTimer = null               // stalled-bar spinner after 1.8s with no pct/phase change

  // ─── DOM refs ────────────────────────────────────────────────────────────
  let root = null
  let wfType = 'AMD64'
  let navigate = null

  // ─── Pipeline / flush progress helpers ───────────────────────────────────
  function flushFakePhasePct(st) {
    const base = (st.flushBasePct != null) ? st.flushBasePct : 85
    const started = st.flushStartedAt || Date.now()
    const elapsed = Math.max(0, Date.now() - started)
    // Asymptotic 1 - e^(-t/τ): keeps climbing slowly for long USB flush tails
    // without slamming into 99% a minute in.
    const progressed = 1 - Math.exp(-elapsed / FLUSH_FAKE_TAU_MS)
    const cap = FLUSH_FAKE_SOFT_CAP
    return Math.min(cap, base + (cap - base) * progressed)
  }

  function diskPhaseLocalPct(st) {
    if (st.done) return 100
    if (st.failed) return 100
    if (st.flushing) return flushFakePhasePct(st)
    if (LIVE_PROGRESS_PHASES.has(st.phase)) return Math.max(0, Math.min(100, st.pct || 0))
    return PHASES[st.phase]?.pct || 0
  }

  // Full-pipeline 0–100 for multi-disk overall averaging.
  function diskPipelinePct(st) {
    if (st.done || st.failed) return 100
    const range = PHASE_RANGES[st.phase] || { start: 0, end: 0 }
    if (!LIVE_PROGRESS_PHASES.has(st.phase) && !st.flushing) return range.start
    const local = diskPhaseLocalPct(st)
    return range.start + (range.end - range.start) * (local / 100)
  }

  function clearFlushFields() {
    return { flushing: false, flushStartedAt: null, flushBasePct: null, label: null }
  }

  function ensureFlushAnim() {
    if (flushAnimTimer) return
    flushAnimTimer = setInterval(() => {
      let any = false
      currentBuildDisks.forEach(num => {
        const st = diskStates[num]
        if (st && st.flushing && !st.done && !st.failed) {
          any = true
          refreshProgressCard(num)
        }
      })
      updateOverallProgress()
      if (!any) stopFlushAnim()
    }, 250)
  }

  function stopFlushAnim() {
    if (flushAnimTimer) {
      clearInterval(flushAnimTimer)
      flushAnimTimer = null
    }
  }

  function motionKey(st) {
    return `${st.phase || ''}:${st.flushing ? 'f' : 'n'}:${Math.round(diskPhaseLocalPct(st))}`
  }

  function noteMotion(st) {
    if (!st || st.done || st.failed) {
      if (st) st.stalled = false
      return
    }
    const key = motionKey(st)
    if (st._motionKey !== key) {
      st._motionKey = key
      st._motionAt = Date.now()
      st.stalled = false
    } else if (Date.now() - (st._motionAt || Date.now()) >= STALL_MS) {
      st.stalled = true
    }
  }

  function stallSpinHtml(st) {
    if (st && st.stalled && !st.done && !st.failed) {
      return '<span class="prog-stalled-spin" title="Still working…" aria-hidden="true"></span>'
    }
    return ''
  }

  // Keep the spinner node in the DOM. Replacing innerHTML on every pct tick
  // restarts the CSS rotation from 0deg and makes the ring look like it stutters.
  function syncStallSpin(hostEl, stalled) {
    if (!hostEl) return
    let spin = hostEl.querySelector('.prog-stalled-spin')
    if (stalled) {
      if (!spin) {
        spin = document.createElement('span')
        spin.className = 'prog-stalled-spin'
        spin.title = 'Still working…'
        spin.setAttribute('aria-hidden', 'true')
        hostEl.appendChild(spin)
      }
    } else if (spin) {
      spin.remove()
    }
  }

  function setPctAndStallSpin(statusEl, pct, stalled) {
    if (!statusEl) return
    let pctEl = statusEl.querySelector('.progress-pct')
    if (!pctEl) {
      statusEl.textContent = ''
      pctEl = document.createElement('span')
      pctEl.className = 'progress-pct'
      statusEl.appendChild(pctEl)
    }
    const next = `${pct}%`
    if (pctEl.textContent !== next) pctEl.textContent = next
    syncStallSpin(statusEl, stalled)
  }

  function tickStall() {
    let anyBuilding = false
    currentBuildDisks.forEach(num => {
      const st = diskStates[num]
      if (!st || st.done || st.failed) return
      anyBuilding = true
      const was = !!st.stalled
      noteMotion(st)
      if (was !== !!st.stalled) refreshProgressCard(num)
    })
    if (anyBuilding) updateOverallProgress()
    if (!anyBuilding) stopStallWatch()
  }

  function ensureStallWatch() {
    if (stallTimer) return
    stallTimer = setInterval(tickStall, 400)
  }

  function stopStallWatch() {
    if (stallTimer) {
      clearInterval(stallTimer)
      stallTimer = null
    }
  }

  // ─── Build-state helpers ─────────────────────────────────────────────────────
  // Keeps the global flag in sync so the router can inspect it without importing
  // this module directly, and triggers the nav badge update.
  function setBuilding(val) {
    building = val
    window.__builderBuildActive = val
    if (typeof window.__updateBuildBadge === 'function') window.__updateBuildBadge()
  }

  // Update phase labels only on disks that have not yet received their own
  // pipeline phase. Used for shared prep (ESP cache) that arrives on disk 0
  // before per-disk jobs start. Never touch cards already in DISM / WinPE / etc.
  function updateWaitingCardsOnly(label) {
    Object.keys(diskStates).forEach(n => {
      const num = parseInt(n)
      const st = diskStates[num]
      if (!st || st.done || st.failed) return
      if (DISK_OWNED_PHASES.has(st.phase)) return
      const phaseEl = document.getElementById(`phase-label-${num}`)
      if (phaseEl) phaseEl.textContent = label
    })
  }

  // ─── Render helpers ──────────────────────────────────────────────────────
  function escHtml(s) {
    return String(s).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;')
  }

  function compareSemVer(a, b) {
    const parse = (s) => String(s || '').replace(/[^0-9.]/g, '').split('.').map(n => parseInt(n, 10) || 0)
    const aa = parse(a), bb = parse(b)
    const len = Math.max(aa.length, bb.length)
    for (let i = 0; i < len; i++) {
      const d = (aa[i] || 0) - (bb[i] || 0)
      if (d !== 0) return d
    }
    return 0
  }

  let officialVersions = { launcher: null, script: null }

  function isStickDevBuild(disk, stagingVer) {
    if (disk && disk.lwDevBuild) return true
    if (disk && disk.lwLauncherVersion && officialVersions.launcher &&
        compareSemVer(disk.lwLauncherVersion, officialVersions.launcher) > 0) return true
    if (disk && disk.lwScriptVersion && officialVersions.script &&
        compareSemVer(disk.lwScriptVersion, officialVersions.script) > 0) return true
    if (disk && disk.lwVersion && stagingVer && compareSemVer(disk.lwVersion, stagingVer) > 0) return true
    return false
  }

  async function refreshOfficialVersions() {
    try {
      const st = await window.api.getVersionStatus()
      if (st) {
        officialVersions.launcher = st.official || null
        officialVersions.script = st.officialScript || null
      }
    } catch (_) {}
  }

  function renderLwBadge(disk) {
    if (disk.isLoneWolfDisk === true) {
      if (isStickDevBuild(disk, stagingVersion)) {
        const ver = disk.lwLauncherVersion || disk.lwVersion || ''
        const verLabel = ver ? ` v${escHtml(ver)}` : ''
        return `<span class="usb-lw-badge lw-badge-dev" title="Dev destage: launcher/script ahead of GitHub latest.json">DEV${verLabel}</span>`
      }
      if (stickImageIsOlderThanCurrent(disk)) {
        const from = disk.lwImageBuildDate || disk.lwWimBuildDate || '?'
        const to = stagingBuildDate() || '?'
        return `<span class="usb-lw-badge lw-badge-warn" title="Share ISO is newer than the image on this stick. Full Rebuild is selected by default; Quick Update is still allowed.">&#9888; Image older (${escHtml(from)} &#8594; ${escHtml(to)})</span>`
      }
      if (stagingVersion && (disk.lwScriptVersion || disk.lwVersion) === stagingVersion) {
        return `<span class="usb-lw-badge lw-badge-ok">&#10003; Up to Date</span>`
      }
      const from = disk.lwScriptVersion || disk.lwVersion || '?'
      const to   = stagingVersion || '?'
      return `<span class="usb-lw-badge lw-badge-warn">&#9888; Scripts behind (v${escHtml(from)} &#8594; v${escHtml(to)})</span>`
    }
    return `<span class="usb-lw-badge lw-badge-gray">Unformatted</span>`
  }

  function renderBuildModeChip() {
    if (isInstallOnlyWorkflow()) {
      return `<span class="build-mode-chip chip-iso" title="Windows Installation always builds from ISO">&#9711; ISO Mode</span>`
    }
    if (wfType && wfType.toUpperCase() === 'MEDIA-CREATOR') {
      return `<span class="build-mode-chip chip-iso" title="Bootable media from selected ISO">&#9711; Media ISO</span>`
    }
    if (wfType && wfType.toUpperCase() === 'BITRASER') {
      return `<span class="build-mode-chip chip-iso" title="Vendor ISO provisioning">&#9711; Bitraser ISO</span>`
    }
    if (wfType && wfType.toUpperCase() === 'DESTRUCTION') {
      return `<span class="build-mode-chip chip-iso" title="Vendor wipe ISO">&#9711; Wipe ISO</span>`
    }
    if (isLoneWolfWorkflow()) {
      // Pre-split status takes precedence over the plain ISO-mode chip: a staged
      // install*.swm set matching the newest ISO means the next build fast-copies
      // instead of running dism /Split-Image.
      if (preSplitAvailable && preSplitMatchesIso) {
        return `<span class="build-mode-chip chip-ready"
          title="A pre-split install.swm set matching the newest ISO is staged — the next build takes the fast copy path.">&#9889; Pre-split ready</span>`
      }
      if (preSplitAvailable && !preSplitMatchesIso) {
        return `<span class="build-mode-chip chip-none"
          title="A pre-split set exists but does not match the newest ISO. Press Stage ISO to re-stage.">&#9888; Pre-split stale</span>`
      }
      return `<span class="build-mode-chip chip-iso" title="LoneWolf builds from the newest share ISO, mounted automatically. No pre-split set staged yet.">&#9711; ISO Mode</span>`
    }
    switch (buildMode) {
      case 'wim':
        return `<span class="build-mode-chip chip-wim">&#10003; WIM Ready</span>`
      case 'iso':
        return `<span class="build-mode-chip chip-iso"
          title="No pre-staged WIM found. Building directly from ISO is slower but functional.">&#9711; ISO Mode</span>`
      case 'none':
        return `<span class="build-mode-chip chip-none">&#9888; Not Staged</span>`
      default:
        return ''
    }
  }

  function isFixedShareWorkflow() {
    const t = (wfType || '').toUpperCase()
    return t === 'BITRASER' || t === 'DESTRUCTION'
  }

  function usesSourcePicker() {
    return (wfType || '').toUpperCase() === 'MEDIA-CREATOR'
  }

  function isVendorWorkflow() {
    return isFixedShareWorkflow() || usesSourcePicker()
  }

  // LoneWolf (Intel/AMD + Snapdragon) now always builds from the newest share ISO,
  // mounted per-build by Invoke-LoneWolfBuild.ps1 — so there is no shared ESP pre-cache.
  function isLoneWolfWorkflow() {
    const t = (wfType || '').toUpperCase()
    return t === 'AMD64' || t === 'ARM64'
  }

  // The minimal QUICK-INSTALL ("No Updates") is a payload-free install that always
  // builds directly from ISO (Architecture B) with no shared ESP pre-cache.
  function isInstallOnlyWorkflow() {
    const t = (wfType || '').toUpperCase()
    return t.startsWith('QUICK-INSTALL')
  }

  // FAT32 volume labels are 11 chars. Prefer YYYY-MM-DD from staging wimBuildDate.
  function fat32LabelFromBuildDate(dateStr) {
    const raw = String(dateStr || '').trim()
    if (/^\d{4}-\d{2}-\d{2}$/.test(raw)) return raw
    const digits = raw.replace(/[^0-9]/g, '')
    if (digits.length >= 8) {
      return `${digits.slice(0, 4)}-${digits.slice(4, 6)}-${digits.slice(6, 8)}`
    }
    return 'WINDOWS'
  }

  function stagingArchKey() {
    const t = String(wfType || '').toUpperCase()
    if (t.startsWith('QUICK-INSTALL-')) return t.slice('QUICK-INSTALL-'.length)
    return t
  }

  // Prefer architectures[arch].wimBuildDate (Windows image date). staging:version from
  // the C# provisioner returns VERSION.json buildDate, which is the staging stamp.
  function wimBuildDateFromStaging(sv) {
    if (!sv || typeof sv !== 'object') return ''
    const arch = stagingArchKey()
    const block = sv.architectures
    let archDate = ''
    if (block && typeof block === 'object') {
      const entry = block[arch] || block[String(arch).toLowerCase()]
      if (entry && entry.wimBuildDate) archDate = String(entry.wimBuildDate).trim()
    }
    return archDate || String(sv.buildDate || '').trim()
  }

  function stagingBuildDate() {
    return stagingWimBuildDate || ''
  }

  function stickImageDate(disk) {
    if (!disk) return ''
    return String(disk.lwImageBuildDate || disk.lwWimBuildDate || '').trim()
  }

  function stickImageIsOlderThanCurrent(disk) {
    const fn = window.LoneWolfStickImageIsOlder
    if (typeof fn !== 'function') return false
    return !!fn(stickImageDate(disk), stagingBuildDate())
  }

  function recommendModeForDisk(disk) {
    const fn = window.LoneWolfRecommendUsbBuildMode
    if (typeof fn === 'function') {
      return fn({
        isLoneWolfDisk: disk && disk.isLoneWolfDisk === true,
        usesSourcePicker: usesSourcePicker(),
        stickImageDate: stickImageDate(disk),
        currentImageDate: stagingBuildDate()
      })
    }
    if (usesSourcePicker() || !(disk && disk.isLoneWolfDisk === true)) {
      return { mode: 'full', overlayAllowed: false, imageOlder: false }
    }
    return { mode: 'overlay', overlayAllowed: true, imageOlder: false }
  }

  function fixedShareSubpath() {
    const t = (wfType || '').toUpperCase()
    if (t === 'BITRASER') return 'Remote\\Staging\\Bitraser\\'
    if (t === 'DESTRUCTION') return 'Remote\\Staging\\Destruction\\'
    return ''
  }

  function effectiveBuildMode() {
    if (isFixedShareWorkflow()) {
      return buildMode || 'none'
    }
    if (usesSourcePicker()) {
      return sourceAnalysis?.buildMode || (selectedSource ? 'iso' : 'none')
    }
    if (isInstallOnlyWorkflow()) {
      return buildMode || 'iso'
    }
    // LoneWolf always mounts the newest share ISO per build (Architecture B).
    if (isLoneWolfWorkflow()) {
      return 'iso'
    }
    if (buildMode === 'none' && selectedSource && sourceAnalysis?.buildMode && sourceAnalysis.buildMode !== 'none') {
      return sourceAnalysis.buildMode
    }
    return buildMode
  }

  function formatSize(bytes) {
    if (!bytes) return ''
    const gb = bytes / (1024 * 1024 * 1024)
    return gb >= 1 ? `${gb.toFixed(1)} GB` : `${Math.round(bytes / (1024 * 1024))} MB`
  }

  function renderFixedSharePanel() {
    const panel = document.getElementById('fixed-share-panel')
    if (!panel || !isFixedShareWorkflow()) return

    const subpath = fixedShareSubpath()
    const isoName = fixedShareIsoFile || ''

    if (buildMode === 'iso') {
      const fileLabel = isoName ? escHtml(isoName) : 'newest *.iso'
      panel.innerHTML = `
        <div class="fixed-share-info">
          <span class="fixed-share-path">${escHtml(subpath)}${fileLabel}</span>
          <span class="fixed-share-note">IT-managed share path — no manual source selection.</span>
        </div>`
    } else {
      panel.innerHTML = `
        <div class="fixed-share-info fixed-share-missing">
          <span class="fixed-share-path">${escHtml(subpath)}*.iso</span>
          <span class="fixed-share-note">No staged ISO found on the share. Contact IT to stage the required image.</span>
        </div>`
    }
  }

  function sourceDir(p) {
    const s = String(p || '')
    const i = Math.max(s.lastIndexOf('\\'), s.lastIndexOf('/'))
    return i > 0 ? s.slice(0, i) : s
  }

  function sourceDirLabel(dir) {
    const s = String(dir || '').replace(/[\\/]+$/, '')
    const i = Math.max(s.lastIndexOf('\\'), s.lastIndexOf('/'))
    return i >= 0 ? s.slice(i + 1) || s : s
  }

  // UNC paths have no break opportunities and blow past the tile width, so drop
  // middle segments and keep the server/drive plus the deepest folders. The tile
  // title attribute still carries the full path.
  function shortPath(p, max = 34) {
    const s = String(p || '')
    if (s.length <= max) return s
    const sep = s.includes('\\') ? '\\' : '/'
    const parts = s.split(sep).filter(Boolean)
    if (parts.length < 3) return '…' + s.slice(-(max - 1))
    const head = s.startsWith('\\\\') ? sep + sep + parts[0] : parts[0]
    let tail = parts[parts.length - 1]
    for (let i = parts.length - 2; i > 0; i--) {
      const next = parts[i] + sep + tail
      if (head.length + next.length + 3 > max) break
      tail = next
    }
    return `${head}${sep}…${sep}${tail}`
  }

  // Media Creator writes a whole ISO to the stick — WIMs and image folders are
  // not usable here, so they never reach the picker.
  function isIsoSource(s) {
    return !!s && String(s.path || '').toLowerCase().endsWith('.iso')
  }

  // Sources are grouped by containing folder so a folder holding several images
  // collapses to one tile the operator drills into, instead of a long flat list.
  function groupSourcesByDir(list) {
    const groups = new Map()
    for (const s of list) {
      const dir = sourceDir(s.path)
      if (!groups.has(dir)) groups.set(dir, [])
      groups.get(dir).push(s)
    }
    return groups
  }

  function originLabel(origin) {
    return origin === 'share' ? 'Share' : origin === 'manual' ? 'Manual' : 'Local'
  }

  function renderSourceTile(s) {
    const sel = selectedSource && selectedSource.path === s.path ? ' selected' : ''
    const fresh = freshSourcePaths.has(s.path) ? ' source-tile-new' : ''
    const dir = sourceDir(s.path)
    return `<button type="button" class="source-tile${sel}${fresh}" data-path="${escHtml(s.path)}" title="${escHtml(s.path)}">
      <span class="source-tile-head">
        <span class="source-origin chip-${s.origin || 'local'}">${originLabel(s.origin)}</span>
      </span>
      <span class="source-name">${escHtml(s.name || s.path)}</span>
      <span class="source-meta">${escHtml(formatSize(s.sizeBytes) || '—')}</span>
      <span class="source-loc">${escHtml(shortPath(dir))}</span>
    </button>`
  }

  function renderSourceFolderTile(dir, items) {
    const total = items.reduce((sum, s) => sum + (s.sizeBytes || 0), 0)
    const origin = items[0]?.origin || 'local'
    const holdsSelected = selectedSource && sourceDir(selectedSource.path) === dir
    const fresh = items.some(s => freshSourcePaths.has(s.path)) ? ' source-tile-new' : ''
    return `<button type="button" class="source-tile source-tile-folder${holdsSelected ? ' selected' : ''}${fresh}"
        data-folder="${escHtml(dir)}" title="${escHtml(dir)}">
      <span class="source-tile-head">
        <span class="source-origin chip-${origin}">${originLabel(origin)}</span>
        <span class="source-count">${items.length} images</span>
      </span>
      <span class="source-name">&#128193; ${escHtml(sourceDirLabel(dir))}</span>
      <span class="source-meta">${escHtml(formatSize(total) || '—')}</span>
      <span class="source-loc">${escHtml(shortPath(dir))}</span>
    </button>`
  }

  function sweepBarHtml() {
    const label = sweepStats.found
      ? `Scanning all drives — ${sweepStats.found} ISO${sweepStats.found === 1 ? '' : 's'} found`
      : 'Scanning all drives for ISO images…'
    return `<div class="source-scan${sweepRunning ? '' : ' hiding'}" id="source-scan-bar">
      <div class="source-scan-row">
        <span id="source-scan-label">${escHtml(label)}</span>
        <span class="source-scan-dirs" id="source-scan-dirs">${sweepStats.dirs ? escHtml(sweepStats.dirs.toLocaleString() + ' folders') : ''}</span>
      </div>
      <div class="source-scan-track"><div class="source-scan-fill"></div></div>
    </div>`
  }

  // Progress ticks arrive several times a second — patch the two text nodes rather
  // than re-rendering the grid, so tiles never flicker mid-animation.
  function updateSweepBarText() {
    const labelEl = document.getElementById('source-scan-label')
    const dirsEl = document.getElementById('source-scan-dirs')
    if (labelEl) {
      labelEl.textContent = sweepStats.found
        ? `Scanning all drives — ${sweepStats.found} ISO${sweepStats.found === 1 ? '' : 's'} found`
        : 'Scanning all drives for ISO images…'
    }
    if (dirsEl) {
      dirsEl.textContent = sweepStats.dirs ? `${sweepStats.dirs.toLocaleString()} folders` : ''
    }
  }

  function renderSourcePanel() {
    if (!usesSourcePicker()) return
    const panel = document.getElementById('source-panel')
    if (!panel) return

    if (sourceScanning) {
      panel.innerHTML = '<div class="detect-spinner"><div class="spin"></div><span>Scanning image sources…</span></div>'
      return
    }

    if (!sources.length) {
      panel.innerHTML = `
        <div class="source-panel-empty">
          <span>${sweepRunning
            ? 'Scanning all drives for ISO images…'
            : `No ISO images found on this PC${showShareSources ? ' or the share' : ''}.`}</span>
          <div class="source-actions" style="margin:0">
            <button class="btn btn-sm btn-out" id="browse-source-btn">Browse for an ISO…</button>
            <button class="btn btn-sm btn-ghost" id="refresh-sources-btn">Refresh</button>
            <button type="button" class="btn btn-sm ${showShareSources ? 'btn-out' : 'btn-ghost'}"
              id="toggle-share-sources-btn"
              title="${showShareSources ? 'Hide share ISOs' : 'Show ISOs from the deployment share'}">
              ${showShareSources ? 'Hide share' : 'Show share'}
            </button>
          </div>
        </div>
        ${sweepBarHtml()}`
      panel.querySelector('#browse-source-btn')?.addEventListener('click', browseSource)
      panel.querySelector('#refresh-sources-btn')?.addEventListener('click', () => loadSources({ force: true }))
      panel.querySelector('#toggle-share-sources-btn')?.addEventListener('click', () => {
        showShareSources = !showShareSources
        localStorage.setItem('lw_media.showShare', showShareSources ? 'true' : 'false')
        loadSources({ force: true })
      })
      return
    }

    const groups = groupSourcesByDir(sources)
    if (sourceFolder && !groups.has(sourceFolder)) sourceFolder = null

    let headerHtml = ''
    let tiles

    if (sourceFolder) {
      headerHtml = `<div class="source-crumb">
        <button type="button" class="btn btn-sm btn-ghost" id="source-back-btn">&#8592; All sources</button>
        <span class="source-crumb-path">${escHtml(sourceFolder)}</span>
      </div>`
      tiles = groups.get(sourceFolder).map(renderSourceTile)
    } else {
      tiles = []
      for (const [dir, items] of groups) {
        tiles.push(items.length > 1 ? renderSourceFolderTile(dir, items) : renderSourceTile(items[0]))
      }
    }

    panel.innerHTML = `
      ${headerHtml}
      <div class="source-grid">${tiles.join('')}</div>
      <div class="source-actions">
        <button class="btn btn-sm btn-out" id="browse-source-btn">Browse…</button>
        <button class="btn btn-sm btn-ghost" id="refresh-sources-btn">Refresh</button>
        ${selectedSource && String(selectedSource.path || '').toLowerCase().endsWith('.iso')
          ? (isoMountedLetter
            ? `<button type="button" class="btn btn-sm btn-out" id="eject-iso-btn-bar">Eject ISO</button>`
            : `<button type="button" class="btn btn-sm btn-out" id="mount-iso-btn-bar">Mount ISO</button>`)
          : ''}
        <button type="button" class="btn btn-sm ${showShareSources ? 'btn-out' : 'btn-ghost'}"
          id="toggle-share-sources-btn"
          title="${showShareSources ? 'Hide share ISOs' : 'Show ISOs from the deployment share'}">
          ${showShareSources ? 'Hide share' : 'Show share'}
        </button>
      </div>
      ${sweepBarHtml()}
      <div class="source-analysis" id="source-analysis"></div>`

    panel.querySelectorAll('.source-tile[data-path]').forEach(btn => {
      btn.addEventListener('click', () => selectSource(btn.getAttribute('data-path')))
    })
    panel.querySelectorAll('.source-tile[data-folder]').forEach(btn => {
      btn.addEventListener('click', () => {
        sourceFolder = btn.getAttribute('data-folder')
        renderSourcePanel()
      })
    })
    panel.querySelector('#source-back-btn')?.addEventListener('click', () => {
      sourceFolder = null
      renderSourcePanel()
    })
    panel.querySelector('#browse-source-btn')?.addEventListener('click', browseSource)
    panel.querySelector('#refresh-sources-btn')?.addEventListener('click', () => loadSources({ force: true }))
    panel.querySelector('#mount-iso-btn-bar')?.addEventListener('click', mountSelectedIso)
    panel.querySelector('#eject-iso-btn-bar')?.addEventListener('click', ejectSelectedIso)
    panel.querySelector('#toggle-share-sources-btn')?.addEventListener('click', () => {
      showShareSources = !showShareSources
      localStorage.setItem('lw_media.showShare', showShareSources ? 'true' : 'false')
      loadSources({ force: true })
    })
    renderSourceAnalysis()
  }

  // A deep check has to mount the ISO, and a share ISO has to be copied local
  // first — minutes of wait. Only offer it where the mount is cheap.
  function canDeepVerify(s) {
    if (!s || !s.path) return false
    if (sourceAnalysis && sourceAnalysis.deepAnalyzed) return false
    return !(String(s.path).startsWith('\\\\') && s.kind !== 'folder')
  }

  function renderSourceAnalysis() {
    const el = document.getElementById('source-analysis')
    if (!el) return
    if (!sourceAnalysis) { el.innerHTML = ''; return }
    const sb = sourceAnalysis.deepAnalyzed
      ? (sourceAnalysis.secureBootReady
          ? '<span class="sb-chip sb-ok">Secure Boot ready</span>'
          : '<span class="sb-chip sb-warn">No EFI boot loader</span>')
      : ''
    const mode = sourceAnalysis.buildMode ? `<span class="sb-chip">${escHtml(sourceAnalysis.buildMode)}</span>` : ''
    const writeMode = sourceAnalysis.writeMode ? `<span class="sb-chip">${escHtml(sourceAnalysis.writeMode)}</span>` : ''
    const arch = sourceAnalysis.arch ? `<span class="sb-chip">${escHtml(sourceAnalysis.arch)}</span>` : ''
    const verify = canDeepVerify(selectedSource)
      ? '<button type="button" class="btn btn-sm btn-ghost" id="verify-source-btn" title="Mount the image and check its EFI boot files">Verify boot files</button>'
      : ''
    const mountBtn = selectedSource && String(selectedSource.path || '').toLowerCase().endsWith('.iso')
      ? (isoMountedLetter
        ? `<button type="button" class="btn btn-sm btn-out" id="eject-iso-btn">Eject ISO (${escHtml(isoMountedLetter)})</button>`
        : '<button type="button" class="btn btn-sm btn-out" id="mount-iso-btn" title="Mount this ISO in Windows Explorer">Mount ISO</button>')
      : ''
    const warns = (sourceAnalysis.warnings || []).map(w => `<div class="source-warn">${escHtml(w)}</div>`).join('')
    el.innerHTML = `<div class="source-chips">${sb}${mode}${writeMode}${arch}${verify}${mountBtn}</div>${warns}`
    el.querySelector('#verify-source-btn')?.addEventListener('click', verifySelectedSource)
    el.querySelector('#mount-iso-btn')?.addEventListener('click', mountSelectedIso)
    el.querySelector('#eject-iso-btn')?.addEventListener('click', ejectSelectedIso)
  }

  async function mountSelectedIso() {
    const s = selectedSource
    if (!s) return
    const btn = document.getElementById('mount-iso-btn')
    if (btn) { btn.disabled = true; btn.textContent = 'Mounting…' }
    try {
      const res = await window.api.mountIso({ path: s.path })
      if (res && res.hqBlocked) {
        window.toast(res.error || 'Share ISOs need FirstbaseHQ.', 'error', 8000)
        return
      }
      if (!res || !res.ok) {
        window.toast((res && res.error) || 'Could not mount ISO', 'error', 8000)
        return
      }
      isoMountedLetter = res.letter
      window.toast('ISO mounted at ' + res.letter, 'ok')
    } catch (err) {
      window.toast('Mount failed: ' + err.message, 'error')
    } finally {
      renderSourceAnalysis()
    }
  }

  async function ejectSelectedIso() {
    const s = selectedSource
    if (!s) return
    try {
      await window.api.dismountIso({ path: s.path })
      isoMountedLetter = null
      window.toast('ISO ejected', 'ok')
    } catch (err) {
      window.toast('Eject failed: ' + err.message, 'error')
    }
    renderSourceAnalysis()
  }

  async function verifySelectedSource() {
    const s = selectedSource
    if (!s) return
    const btn = document.getElementById('verify-source-btn')
    if (btn) { btn.disabled = true; btn.textContent = 'Verifying…' }
    try {
      sourceAnalysis = await window.api.analyzeSource({ path: s.path, origin: s.origin, deep: true })
    } catch (err) {
      window.toast('Verify failed: ' + err.message, 'error')
    }
    renderSourceAnalysis()
  }

  async function selectSource(pathOrSource) {
    const s = typeof pathOrSource === 'string'
      ? sources.find(x => x.path === pathOrSource)
      : pathOrSource
    if (!s) return
    selectedSource = s
    sourceAnalysis = null
    isoMountedLetter = null
    renderSourcePanel()
    updateStartButton()
    // Metadata-only check — no mount, no share copy, so this returns instantly.
    try {
      sourceAnalysis = await window.api.analyzeSource({ path: s.path, origin: s.origin })
    } catch (_) {
      sourceAnalysis = null
    }
    if (selectedSource !== s) return
    renderSourceAnalysis()
    updateStartButton()
  }

  async function browseSource() {
    const path = await window.api.browseSource({ kind: 'iso' })
    if (!path) return
    const entry = {
      path,
      name: path.split(/[/\\]/).pop(),
      origin: 'manual',
      kind: path.toLowerCase().endsWith('.wim') ? 'wim' : 'iso'
    }
    sources = [entry, ...sources.filter(s => s.path !== path)]
    sourceFolder = null
    await selectSource(entry)
  }

  async function loadSources(opts) {
    if (!usesSourcePicker()) return
    const force = !!(opts && opts.force)
    const cacheKey = `${(wfType || '').toUpperCase()}|share=${showShareSources ? 1 : 0}`

    if (!force && sourceCache && sourceCache.key === cacheKey &&
        (Date.now() - sourceCache.ts) < SOURCE_CACHE_TTL_MS) {
      applySources(sourceCache.list)
      return
    }

    sourceScanning = true
    renderSourcePanel()
    try {
      const localPromise = window.api.scanLocalSources().catch(() => [])
      const sharePromise = showShareSources
        ? window.api.scanShareSources(wfType).catch(() => [])
        : Promise.resolve([])
      const [local, shareRaw] = await Promise.all([localPromise, sharePromise])
      if (shareRaw && !Array.isArray(shareRaw) && shareRaw.hqBlocked) {
        window.toast(shareRaw.error || 'Not on FirstbaseHQ. Share ISOs are blocked off-site.', 'error', 8000)
      }
      const share = Array.isArray(shareRaw)
        ? shareRaw
        : (shareRaw && Array.isArray(shareRaw.entries) ? shareRaw.entries : [])
      // Local disks first. Share ISOs only appear when Show share is on.
      const merged = []
      const seen = new Set()
      for (const s of [...local, ...share]) {
        if (!s || !s.path || seen.has(s.path) || !isIsoSource(s)) continue
        if (!showShareSources && s.origin === 'share') continue
        seen.add(s.path)
        merged.push(s)
      }
      sourceCache = { key: cacheKey, ts: Date.now(), list: merged }
      sourceScanning = false
      sweepRunning = true
      sweepStats = { found: merged.filter(s => s.origin !== 'share').length, dirs: 0, current: '' }
      applySources(merged)
    } catch (err) {
      sourceScanning = false
      sweepRunning = false
      sources = []
      window.toast('Source scan failed: ' + err.message, 'error')
      renderSourcePanel()
      updateStartButton()
    }
  }

  // The full-system sweep streams hits after the initial known-folder pass, so new
  // ISOs are folded in without disturbing the operator's current view or selection.
  function onSweepBatch(payload) {
    if (!usesSourcePicker()) return
    const entries = (payload && payload.entries) || []
    if (!entries.length) return
    const known = new Set(sources.map(s => String(s.path).toLowerCase()))
    const added = []
    for (const e of entries) {
      if (!e || !e.path || !isIsoSource(e)) continue
      const key = String(e.path).toLowerCase()
      if (known.has(key)) continue
      known.add(key)
      added.push(e)
    }
    if (!added.length) return
    // Keep share entries last so local disks stay at the top of the grid.
    const localOnes = sources.filter(s => s.origin !== 'share')
    const shareOnes = sources.filter(s => s.origin === 'share')
    sources = [...localOnes, ...added, ...shareOnes]
    if (sourceCache) sourceCache.list = sources
    freshSourcePaths.clear()
    added.forEach(e => freshSourcePaths.add(e.path))
    renderSourcePanel()
    // One-shot: the class only animates the tiles from this batch.
    freshSourcePaths.clear()
    if (!selectedSource) {
      const def = sources.find(s => s.origin === 'local') || sources[0]
      if (def) selectSource(def)
    }
  }

  function onSweepProgress(payload) {
    if (!usesSourcePicker() || !payload) return
    sweepStats = {
      found: payload.found || 0,
      dirs: payload.dirs || 0,
      current: payload.current || ''
    }
    if (!sweepRunning) {
      sweepRunning = true
      renderSourcePanel()
      return
    }
    updateSweepBarText()
  }

  function onSweepDone() {
    if (!sweepRunning) return
    sweepRunning = false
    // Let the bar fade/collapse via CSS before it leaves the DOM.
    const bar = document.getElementById('source-scan-bar')
    if (!bar) return
    bar.classList.add('hiding')
    clearTimeout(sweepHideTimer)
    sweepHideTimer = setTimeout(() => {
      if (usesSourcePicker()) renderSourcePanel()
    }, 400)
  }

  function applySources(list) {
    sources = list
    sourceFolder = null
    sourceAnalysis = null
    selectedSource = null
    const def = list.find(s => s.origin === 'local') || list.find(s => s.isDefault) || list[0] || null
    if (def) {
      selectSource(def)
    } else {
      renderSourcePanel()
      updateStartButton()
    }
  }

  // LoneWolf sticks: Full Rebuild vs Quick Update on packaged and npm start.
  // Media Creator has no overlay path.
  function effectiveDiskMode(disk) {
    if (usesSourcePicker()) return 'full'
    const rec = recommendModeForDisk(disk)
    if (!rec.overlayAllowed) return 'full'
    return diskModes[disk.number] || rec.mode || 'full'
  }

  function renderModeToggle(disk) {
    // Media Creator writes a whole vendor ISO to the stick — there is no overlay
    // to refresh, so every disk is a full rebuild and the toggle is hidden.
    if (usesSourcePicker()) return ''
    const rec = recommendModeForDisk(disk)
    if (!rec.overlayAllowed) return ''
    const mode = diskModes[disk.number] || rec.mode || 'full'
    const hint = rec.imageOlder
      ? '<div class="usb-mode-hint">Share ISO is newer than this stick. Full Rebuild is selected; Quick Update is still allowed.</div>'
      : ''
    return `
      <div class="usb-mode-toggle">
        <button class="mode-btn${mode === 'full'    ? ' active' : ''}" data-disk="${disk.number}" data-mode="full">Full Rebuild</button>
        <button class="mode-btn${mode === 'overlay' ? ' active' : ''}" data-disk="${disk.number}" data-mode="overlay">Quick Update</button>
      </div>${hint}`
  }

  function renderUsbCard(disk) {
    const sel = selected.has(disk.number) ? ' selected' : ''
    return `
      <div class="usb-card${sel}" data-disk="${disk.number}" role="checkbox"
           aria-checked="${selected.has(disk.number)}" tabindex="0">
        <div class="usb-card-top">
          <div class="usb-icon">${USB_ICON_SVG}</div>
          <div>
            <div class="usb-card-name">${escHtml(disk.friendlyName || `Disk ${disk.number}`)}</div>
            <div class="usb-card-meta">Disk ${disk.number} &nbsp;·&nbsp; ${(disk.sizeGB || 0).toFixed(1)} GB</div>
          </div>
        </div>
        ${renderLwBadge(disk)}
        <div class="usb-card-detail">${escHtml(disk.busType || 'USB')}</div>
        <div class="usb-card-serial">${escHtml(disk.serial || '—')}</div>
        ${renderModeToggle(disk)}
      </div>
    `
  }

  function renderProgressCard(disk) {
    const st = diskStates[disk.number] || { phase: 'waiting', pct: 0 }
    const phaseInfo = PHASES[st.phase] || { label: st.phase || 'Waiting…', pct: st.pct || 0 }
    const isLive = LIVE_PROGRESS_PHASES.has(st.phase) || !!st.flushing
    const pct = Math.round(diskPhaseLocalPct(st))
    let cardClass = 'usb-progress-card building'
    let barClass = 'prog-bar indeterminate'
    let statusHtml = `<span class="progress-pct">${pct}%</span>${stallSpinHtml(st)}`

    if (st.done) {
      cardClass = 'usb-progress-card done'
      barClass = 'prog-bar done-bar'
      statusHtml = '<span class="done-label">✓ Complete</span>'
    } else if (st.failed) {
      cardClass = 'usb-progress-card failed'
      barClass = 'prog-bar fail-bar'
      statusHtml = '<span class="fail-label">✗ Failed</span>'
    } else if (isLive) {
      barClass = 'prog-bar'
      statusHtml = `<span class="progress-pct">${pct}%</span>${stallSpinHtml(st)}`
    }

    const barStyle = (!st.done && !st.failed && isLive)
      ? ` style="width:${pct}%"` : ''

    const phaseText = (!st.done && !st.failed && st.flushing)
      ? 'Finalizing…'
      : ((!st.done && !st.failed && st.label) ? st.label : phaseInfo.label)

    return `
      <div class="${cardClass}" id="progress-card-${disk.number}">
        <div class="progress-card-top">
          <div class="usb-icon" style="width:30px;height:30px">${USB_ICON_SVG}</div>
          <div style="flex:1">
            <div class="progress-card-name">${escHtml(disk.friendlyName || `Disk ${disk.number}`)}</div>
            <div class="progress-card-phase" id="phase-label-${disk.number}">${escHtml(phaseText)}</div>
          </div>
          <div id="status-${disk.number}">${statusHtml}</div>
        </div>
        <div class="prog-bar-wrap">
          <div class="${barClass}" id="prog-bar-${disk.number}"${barStyle}></div>
        </div>
        ${st.error ? `<div class="progress-error">${escHtml(st.error)}</div>` : ''}
      </div>
    `
  }

  // ─── Disk detection ───────────────────────────────────────────────────────
  async function detectDisks() {
    isLoadingDisks = true
    const grid = document.getElementById('usb-grid-area')
    if (!grid) { isLoadingDisks = false; return }

    grid.innerHTML = `
      <div class="detect-spinner">
        <div class="spin"></div>
        <span>Scanning for USB drives…</span>
      </div>
    `

    try {
      const [disksResult, stagingResult] = await Promise.allSettled([
        window.api.getUsbDisks(),
        window.api.getStagingVersion(wfType.toUpperCase()),
        refreshOfficialVersions()
      ])

      disks = (disksResult.status === 'fulfilled' && Array.isArray(disksResult.value))
        ? disksResult.value : []

      if (stagingResult.status === 'fulfilled' && stagingResult.value) {
        stagingVersion = stagingResult.value.version || null
        stagingWimBuildDate = wimBuildDateFromStaging(stagingResult.value) || null
        buildMode = stagingResult.value.buildMode || null
        fixedShareIsoFile = stagingResult.value.isoFile || null
        // Pre-split availability for the current ISO (added by Get-StagingVersion.ps1).
        preSplitAvailable = !!stagingResult.value.preSplitAvailable
        preSplitMatchesIso = !!stagingResult.value.preSplitMatchesIso
        preSplitImageVersion = stagingResult.value.preSplitImageVersion || null
      }
    } catch (err) {
      disks = []
      window.toast('USB detection failed: ' + err.message, 'error')
    }

    isLoadingDisks = false

    // Update build-mode chip in toolbar
    const chipEl = document.getElementById('build-mode-chip')
    if (chipEl) chipEl.innerHTML = renderBuildModeChip()

    if (isFixedShareWorkflow()) renderFixedSharePanel()

    // Hide pre-cache bar when in ISO mode
    updatePreCacheBarVisibility()

    // Auto-select all drives and auto-detect per-disk build mode
    disks.forEach(d => {
      // All drives start checked; user can deselect individually
      selected.add(d.number)

      if (diskModes[d.number] === undefined) {
        // Script-only destage → Quick Update. Stick image older than share ISO → Full Rebuild default.
        diskModes[d.number] = recommendModeForDisk(d).mode
      }
    })

    renderDiskGrid()
  }

  function renderDiskGrid() {
    const grid = document.getElementById('usb-grid-area')
    if (!grid) return

    if (disks.length === 0) {
      grid.innerHTML = `
        <div class="no-disks">
          <h4>No USB drives detected</h4>
          <p>Plug in USB sticks — they will appear automatically.</p>
        </div>
      `
      updateStartButton()
      return
    }

    grid.innerHTML = `<div class="usb-grid">${disks.map(renderUsbCard).join('')}</div>`

    grid.querySelectorAll('.usb-card').forEach(card => {
      card.addEventListener('click', () => toggleDisk(parseInt(card.getAttribute('data-disk'))))
      card.addEventListener('keydown', (e) => {
        if (e.key === 'Enter' || e.key === ' ') {
          e.preventDefault()
          toggleDisk(parseInt(card.getAttribute('data-disk')))
        }
      })
    })

    grid.querySelectorAll('.mode-btn').forEach(btn => {
      btn.addEventListener('click', (e) => {
        e.stopPropagation()
        const diskNum = parseInt(btn.getAttribute('data-disk'))
        diskModes[diskNum] = btn.getAttribute('data-mode')
        renderDiskGrid()
      })
    })

    // Hide bulk-selection buttons when only one disk is detected
    const selAllBtn = document.getElementById('sel-all-btn')
    const deselBtn  = document.getElementById('desel-btn')
    const showBulk  = disks.length >= 2
    if (selAllBtn) selAllBtn.style.display = showBulk ? '' : 'none'
    if (deselBtn)  deselBtn.style.display  = showBulk ? '' : 'none'

    updateStartButton()
  }

  function toggleDisk(num) {
    if (selected.has(num)) selected.delete(num)
    else selected.add(num)
    renderDiskGrid()
  }

  function selectAll()   { disks.forEach(d => selected.add(d.number)); renderDiskGrid() }
  function deselectAll() { selected.clear(); renderDiskGrid() }

  function updateStartButton() {
    const btn = document.getElementById('start-build-btn')
    if (!btn) return
    const waitingOnCache = preCacheRunning && !preCacheDone
    const mode = effectiveBuildMode()
    const needsSource = usesSourcePicker()
    const noSource = needsSource && !selectedSource
    btn.disabled = selected.size === 0 || building || staging || mode === 'none' || noSource || (preCacheRunning && !preCacheDone)
    btn.innerHTML = waitingOnCache ? 'Pre-caching&hellip;' : '&#9654; Start Build'
    updateStageButton()
  }

  // ─── Pre-split staging (DEV-ONLY) ─────────────────────────────────────────
  function updateStageButton() {
    const btn = document.getElementById('stage-iso-btn')
    if (!btn) return
    btn.disabled = building || staging
    btn.innerHTML = staging ? '&#9881; Staging&hellip;' : '&#9881; Stage ISO'
  }

  // Kick off a one-click pre-split of the newest ISO. Shift-click forces a re-stage.
  function startStaging(force) {
    if (staging || building) return
    staging = true
    updateStageButton()
    updateStartButton()
    const bar = document.getElementById('precache-bar')
    const label = document.getElementById('precache-label')
    const fill = document.getElementById('precache-fill')
    if (bar) bar.style.display = ''
    if (label) label.textContent = force ? 'Staging ISO (force re-stage)…' : 'Staging ISO…'
    if (fill) { fill.classList.add('indeterminate'); fill.style.width = ''; fill.style.background = '' }
    window.api.startStaging({ workflowType: wfType.toUpperCase(), force: !!force })
      .catch(err => {
        window.toast('Stage ISO failed: ' + err.message, 'error')
        staging = false
        updateStageButton()
        updateStartButton()
      })
  }

  // Re-query staging:version after a stage run so the build-mode chip flips to
  // "Pre-split ready" without a full disk re-detect.
  async function refreshStagingVersion() {
    try {
      const sv = await window.api.getStagingVersion(wfType.toUpperCase())
      if (sv) {
        stagingVersion = sv.version || stagingVersion
        stagingWimBuildDate = wimBuildDateFromStaging(sv) || stagingWimBuildDate
        preSplitAvailable = !!sv.preSplitAvailable
        preSplitMatchesIso = !!sv.preSplitMatchesIso
        preSplitImageVersion = sv.preSplitImageVersion || null
      }
    } catch (_) {}
    const chipEl = document.getElementById('build-mode-chip')
    if (chipEl) chipEl.innerHTML = renderBuildModeChip()
  }

  // Drives the pre-cache bar from the producer's stage-* events (staging:true).
  function handleStageEvent(ev) {
    const bar   = document.getElementById('precache-bar')
    const fill  = document.getElementById('precache-fill')
    const label = document.getElementById('precache-label')
    if (bar) bar.style.display = ''

    switch (ev.event) {
      case 'phase': {
        staging = true
        const lbl = STAGE_PHASE_LABELS[ev.phase] || ev.phase || 'Staging…'
        if (label) label.textContent = lbl
        if (fill) { fill.classList.add('indeterminate'); fill.style.width = ''; fill.style.background = '' }
        updateStageButton()
        break
      }
      case 'progress': {
        const pct = (ev.pct != null) ? ev.pct : null
        const base = STAGE_PHASE_LABELS[ev.phase] || 'Staging…'
        if (label) label.textContent = (pct != null) ? `${base} ${pct}%` : base
        if (fill && pct != null) { fill.classList.remove('indeterminate'); fill.style.width = pct + '%' }
        break
      }
      case 'log':
        if (ev.message && label) label.textContent = ev.message
        break
      case 'done':
        if (fill) { fill.classList.remove('indeterminate'); fill.style.width = '100%'; fill.style.background = '' }
        if (label) label.textContent = 'Pre-split staged \u2713'
        staging = false
        updateStageButton()
        updateStartButton()
        refreshStagingVersion()
        break
      case 'error': {
        if (fill) { fill.classList.remove('indeterminate'); fill.style.width = '100%'; fill.style.background = '#ef4444' }
        if (label) label.textContent = 'Staging error'
        window.toast('Stage ISO: ' + (ev.message || 'Unknown error'), 'error')
        staging = false
        updateStageButton()
        updateStartButton()
        break
      }
      case 'exit':
        // Producer process closed — clear the in-progress flag if a done/error
        // event did not already do so.
        if (staging) {
          staging = false
          updateStageButton()
          updateStartButton()
        }
        break
      default:
        break
    }
  }

  // ─── Pre-cache ────────────────────────────────────────────────────────────
  function startPreCache() {
    // WIN-INSTALL and ISO mode: no ESP pre-cache — boot files come from the mounted ISO
    // per-build (Architecture B). A staged AMD64.wim must not trigger WIM-mode precache.
    const isWinInstall = isInstallOnlyWorkflow()
    if (buildMode === 'iso' || isWinInstall || isVendorWorkflow() || isLoneWolfWorkflow()) {
      preCacheDone = true
      updateStartButton()
      updatePreCacheBarVisibility()
      return
    }
    if (preCacheRunning) return
    preCacheRunning = true
    updateStartButton()
    updatePreCacheBarVisibility()
    // Show auto-start prompt as soon as precache begins (do not wait for first progress event).
    if (disks.length > 0 && !preCacheDialogShown) {
      if (window.__tutorial && window.__tutorial.isActive()) {
        const fullRebuildIdx = window.__tutorial.indexOf('fullRebuild')
        if (window.__tutorial.currentIndex() > fullRebuildIdx) {
          preCacheDialogShown = true
          window.__tutorial.goTo('precache')
        }
      } else {
        showPreCacheDialog()
      }
    }
    const localBuild = localStorage.getItem('lw_dev.localBuild') === 'true'
    const wipePrecache = localStorage.getItem('lw_dev.wipePrecache') === 'true'
    if (wipePrecache) localStorage.removeItem('lw_dev.wipePrecache')
    window.api.startPreCache({
      workflowType: wfType.toUpperCase(),
      forceIsoMode: forceBuildMode === 'iso',
      wipePrecache,
      verboseLog: localStorage.getItem('lw_dev.verboseLog') === 'true',
      localBuild,
      sourcePath: usesSourcePicker() ? (selectedSource?.path || undefined) : undefined
    })
  }

  function updatePreCacheBarVisibility() {
    // The precache-bar element is now used ONLY for Stage ISO (dev) staging
    // progress. ESP pre-cache no longer drives or shows this bar; it is visible
    // only while a Stage ISO run is underway.
    const bar = document.getElementById('precache-bar')
    if (!bar) return
    bar.style.display = staging ? '' : 'none'
  }

  function showPreCacheDialog() {
    if (preCacheDialogShown) return
    preCacheDialogShown = true
    const overlay = document.getElementById('precache-question-overlay')
    if (overlay) overlay.classList.add('open')
  }

  function hidePreCacheDialog() {
    const overlay = document.getElementById('precache-question-overlay')
    if (overlay) overlay.classList.remove('open')
  }

  // WinPE injection no longer uses a dedicated global bar. Its progress is shown
  // per-disk (the winpe-inject phase drives each progress card) and aggregated into
  // the overall-progress bar, mirroring the ESP pre-cache change. These remain as
  // no-ops that keep #startnet-status hidden so existing callers stay valid.
  function updateStartnetStatus(text, done) {
    const el = document.getElementById('startnet-status')
    if (el) el.style.display = 'none'
  }

  function updateStartnetProgress(text, pct) {
    const el = document.getElementById('startnet-status')
    if (el) el.style.display = 'none'
  }

  // ESP pre-cache progress/done handler. State-only: the precache-bar element is
  // now Stage-ISO-only, so this no longer writes to #precache-fill/#precache-label.
  // Start-button gating and the auto-start dialog flow are preserved.
  function updatePreCache(pct, done) {
    preCachePct = done ? 100 : pct

    if (done) {
      preCacheDone = true
      preCacheRunning = false
      updateStartButton()
      updatePreCacheBarVisibility()
      hidePreCacheDialog()
      if (autoStartOnComplete && selected.size > 0) {
        // Show destruction warning before the USB write even on auto-start path.
        // If the user already confirmed (destroyConfirmed) go straight to build.
        if (destroyConfirmed) {
          startBuild()
        } else {
          showConfirmModal()
        }
      }
    } else if (pct != null) {
      if (!preCacheDialogShown && disks.length > 0) {
        if (window.__tutorial && window.__tutorial.isActive()) {
          preCacheDialogShown = true
          const fullRebuildIdx = window.__tutorial.indexOf('fullRebuild')
          if (window.__tutorial.currentIndex() > fullRebuildIdx) {
            window.__tutorial.goTo('precache')
            return
          }
        } else {
          showPreCacheDialog()
        }
      }
    }
  }

  // ─── Modal ────────────────────────────────────────────────────────────────
  function showConfirmModal() {
    const overlay  = document.getElementById('confirm-overlay')
    const diskList = document.getElementById('modal-disk-list')
    const warnEl   = document.getElementById('modal-warn-text')
    if (!overlay || !diskList) return

    const selDisks       = disks.filter(d => selected.has(d.number))
    const hasFullRebuild = selDisks.some(d => effectiveDiskMode(d) === 'full')

    const titleEl = overlay.querySelector('h3')
    if (titleEl) {
      titleEl.innerHTML = hasFullRebuild
        ? '&#9888; Confirm &mdash; Irreversible'
        : '&#9888; Confirm &mdash; Quick Update'
    }

    if (warnEl) {
      if (usesSourcePicker()) {
        warnEl.innerHTML = 'This will <strong>permanently erase</strong> the USB stick(s) you confirmed below. Hybrid and many Linux ISOs are written as a raw disk image. Windows installer ISOs use a FAT32 + NTFS layout. Confirm the disk number matches the stick in your hand.'
      } else if (hasFullRebuild) {
        warnEl.innerHTML = '&#9888;&nbsp; This will <strong>permanently and irreversibly ERASE all data</strong> on the following drive(s). This cannot be undone.'
      } else {
        warnEl.innerHTML = 'Quick Update &mdash; the existing data partition will be updated in place. No reformatting. No data loss.'
      }
    }

    diskList.innerHTML = selDisks.map(d => {
      const mode      = effectiveDiskMode(d)
      const modeLabel = mode === 'overlay' ? 'Quick Update' : 'Full Rebuild'
      // Only dev builds can choose a mode, so only they need it named per disk.
      const modeSuffix = usesSourcePicker() ? '' : ` &nbsp;·&nbsp; ${modeLabel}`
      return `<div class="modal-disk-item">
        Disk ${d.number} — ${escHtml(d.friendlyName || 'Unknown')} (${(d.sizeGB||0).toFixed(1)} GB)${modeSuffix}
      </div>`
    }).join('')

    overlay.classList.add('open')
  }

  function hideConfirmModal() {
    const overlay = document.getElementById('confirm-overlay')
    if (overlay) overlay.classList.remove('open')
  }

  // ─── Build ────────────────────────────────────────────────────────────────
  function setBuildInProgress(_inProgress) {}

  async function startBuild() {
    hideConfirmModal()
    setBuilding(true)
    setBuildInProgress(true)

    const selectedDisks = disks.filter(d => selected.has(d.number))
    selectedDisks.forEach(d => {
      diskStates[d.number] = { phase: 'waiting', pct: 0, done: false, failed: false }
      noteMotion(diskStates[d.number])
    })

    showProgressView(selectedDisks)
    updateStartButton()

    // WinPE injection status is shown per-disk (winpe-inject phase) and in the overall
    // bar; keep the legacy global #startnet-status bar hidden.
    const startnetEl = document.getElementById('startnet-status')
    if (startnetEl) startnetEl.style.display = 'none'

    try {
      const isWinInstall = isInstallOnlyWorkflow()
      // sequentialBuild is a DEV-ONLY opt-in. Packaged builds must never request it —
      // sticky lw_dev.sequentialBuild from a prior npm-start session would serialize DISM.
      // main.js also ignores the flag when IS_PACKED; this keeps the IPC params honest.
      let sequentialBuild = false
      try {
        const info = await window.api.getDevInfo()
        sequentialBuild = !info.isPackaged && localStorage.getItem('lw_dev.sequentialBuild') === 'true'
      } catch (_) {
        sequentialBuild = localStorage.getItem('lw_dev.sequentialBuild') === 'true'
      }
      const started = await window.api.startBuild({
        workflowType: wfType.toUpperCase(),
        disks: selectedDisks.map(d => ({ number: d.number, mode: effectiveDiskMode(d) })),
        // WIN-INSTALL always builds from ISO (Architecture B); ignore staged WIM.
        forceIsoMode: forceBuildMode === 'iso' || isWinInstall,
        verboseLog: localStorage.getItem('lw_dev.verboseLog') === 'true',
        sequentialBuild,
        localBuild: localStorage.getItem('lw_dev.localBuild') === 'true',
        sourcePath: usesSourcePicker() ? (selectedSource?.path || undefined) : undefined,
        dataVolumeLabel: isWinInstall ? fat32LabelFromBuildDate(stagingBuildDate()) : undefined
      })
      if (started && started.started === false) {
        if (started.hqBlocked) {
          window.toast(started.error || 'Share ISOs need FirstbaseHQ. A local ISO file you picked still works off-site.', 'error', 8000)
        } else {
          window.toast(started.error || 'Build start failed', 'error', 8000)
        }
        setBuilding(false)
        setBuildInProgress(false)
      }
    } catch (err) {
      window.toast('Build start failed: ' + err.message, 'error')
      setBuilding(false)
    }
  }

  function handleBuildEvent(ev) {
    if (!ev || !ev.event) return

    // Pre-split staging events (Stage ISO producer) — routed to the pre-cache bar.
    if (ev.staging) {
      handleStageEvent(ev)
      return
    }

    // Pre-cache events
    if (ev.precache) {
      if (ev.event === 'progress' && ev.phase === 'esp-copy') {
        updatePreCache(ev.pct, false)
      } else if (ev.event === 'done') {
        updatePreCache(100, true)
      } else if (ev.event === 'error') {
        window.toast('Pre-cache: ' + (ev.message || 'Unknown error'), 'error')
        preCacheDone = true
        preCacheRunning = false
        updateStartButton()
      } else if (ev.event === 'log' && ev.message) {
        const msg = ev.message.toLowerCase()
        if (msg.includes('startnet inject') || msg.includes('startnet-inject')) {
          if (msg.includes('complete')) {
            updateStartnetStatus('WinPE injection complete', true)
          } else {
            const detail = ev.message.replace(/^startnet inject[:\s-]*/i, '').trim()
            updateStartnetStatus(detail || 'Injecting WinPE boot files...', false)
          }
        }
      }
      return
    }

    const disk = ev.disk
    if (disk == null && ev.event !== 'summary' && ev.event !== 'exit' && ev.event !== 'init') return

    // disk 0 = shared prep (ESP cache / cache-time WinPE inject), not a USB stick.
    // Never paint WinPE onto cards that already have their own DISM/phase events.
    if (disk === 0 && building) {
      if (ev.event === 'progress' && ev.phase === 'esp-copy') {
        const espPct = ev.pct || 0
        Object.keys(diskStates).forEach(n => {
          const num = parseInt(n)
          const st = diskStates[num]
          if (!st || st.done || st.failed || DISK_OWNED_PHASES.has(st.phase)) return
          const phaseEl = document.getElementById('phase-label-' + num)
          if (phaseEl) phaseEl.textContent = 'Preparing ESP cache\u2026'
          const statusEl = document.getElementById('status-' + num)
          if (statusEl) statusEl.innerHTML = '<span class="progress-pct">' + espPct + '%</span>'
          const bar = document.getElementById('prog-bar-' + num)
          if (bar) { bar.className = 'prog-bar'; bar.style.width = espPct + '%' }
        })
      } else if (ev.event === 'progress' && ev.phase === 'winpe-inject') {
        updateStartnetProgress('Preparing WinPE boot cache\u2026', ev.pct || 0)
        updateWaitingCardsOnly('Preparing WinPE boot cache\u2026')
      } else if (ev.event === 'log' && ev.message) {
        const msg0 = ev.message.toLowerCase()
        if (msg0.includes('startnet inject') || msg0.includes('startnet-inject')) {
          // Global bar only — do NOT overwrite per-disk card labels.
          if (msg0.includes('complete') || msg0.includes('pre-injected') || msg0.includes('skipping')) {
            updateStartnetStatus('WinPE cache ready', true)
          } else {
            updateStartnetStatus('Preparing WinPE boot cache…', false)
          }
          updateWaitingCardsOnly('Preparing WinPE boot cache\u2026')
        }
      }
      return
    }

    switch (ev.event) {
      case 'start':
        updateDiskState(disk, { phase: 'starting', pct: 0, ...clearFlushFields() })
        break

      case 'phase':
        updateDiskState(disk, {
          phase: ev.phase,
          pct: PHASES[ev.phase]?.pct || 0,
          ...clearFlushFields()
        })
        break

      case 'progress':
        if (LIVE_PROGRESS_PHASES.has(ev.phase)) {
          const prev = diskStates[disk] || {}
          const isFlush = !!ev.flushing || /finaliz|flush/i.test(String(ev.label || ''))
          const update = {
            phase: ev.phase,
            pct: ev.pct || 0,
            label: isFlush ? 'Finalizing…' : (ev.label || null),
            flushing: isFlush
          }
          if (isFlush && !prev.flushing) {
            update.flushStartedAt = Date.now()
            // Enter Finalizing from the live-copy soft ceiling (not 95/99) so the
            // fake bar has room to climb during a long USB write-back.
            const prevPct = (prev.pct != null) ? prev.pct : 85
            update.flushBasePct = Math.min(Math.max(prevPct, 70), 88)
            update.pct = update.flushBasePct
          }
          if (!isFlush) {
            update.flushing = false
            update.flushStartedAt = null
            update.flushBasePct = null
          }
          updateDiskState(disk, update)
          if (isFlush) ensureFlushAnim()
        }
        break

      case 'done':
        if (ev.success) {
          updateDiskState(disk, { phase: 'done', pct: 100, done: true, ...clearFlushFields() })
          const doneDisk = disks.find(d => d.number === disk)
          window.api.notifyDiskComplete({
            diskNum: disk,
            friendlyName: doneDisk ? (doneDisk.friendlyName || `Disk ${disk}`) : `Disk ${disk}`
          })
        } else {
          updateDiskState(disk, {
            phase: 'failed', pct: 0, failed: true,
            error: ev.message || 'Build failed',
            ...clearFlushFields()
          })
        }
        break

      case 'error':
        if (disk != null && disk > 0) {
          updateDiskState(disk, {
            phase: 'failed', pct: 0, failed: true,
            error: ev.message || 'Unknown error',
            ...clearFlushFields()
          })
        } else {
          // Global error (disk === -1 or 0): surface as toast and mark every still-building disk failed
          const msg = ev.message || 'Build error'
          window.toast(msg, 'error')
          Object.keys(diskStates).forEach(n => {
            const num = parseInt(n)
            if (diskStates[num] && !diskStates[num].done && !diskStates[num].failed) {
              updateDiskState(num, {
                phase: 'failed', pct: 0, failed: true, error: msg,
                ...clearFlushFields()
              })
            }
          })
        }
        break

      case 'summary':
        setBuilding(false)
        setBuildInProgress(false)
        stopFlushAnim()
        stopStallWatch()
        window.api.offBuildEvent()
        // Only show summary when at least one disk was processed; an empty summary
        // means the script exited before starting any disk (errors already surfaced above).
        if ((ev.succeeded || []).length > 0 || (ev.failed || []).length > 0) {
          showSummary(ev.succeeded || [], ev.failed || [])
        }
        break

      case 'exit':
        setBuilding(false)
        setBuildInProgress(false)
        stopFlushAnim()
        stopStallWatch()
        window.api.offBuildEvent()
        break

      case 'init':
      case 'info':
      case 'iso-mode':
        console.log('[build:event]', ev.event, ev)
        break

      case 'log':
        if (ev.message && disk != null && disk > 0) {
          const msg = ev.message.toLowerCase()
          const isStartnet = msg.includes('startnet-inject') || msg.includes('startnet inject')
          if (isStartnet) {
            // Per-disk only: update THIS card + name the disk on the global bar.
            // Never overwrite sibling cards.
            if (msg.includes('complete') || msg.includes('pre-injected') || msg.includes('skipping')) {
              updateStartnetStatus(`\u2713 WinPE ready (Disk ${disk})`, true)
            } else {
              updateStartnetStatus(`Injecting WinPE (Disk ${disk})\u2026`, false)
            }
            const cur = diskStates[disk]?.phase
            if (!cur || !['overlay', 'overlay-update', 'done', 'failed'].includes(cur)) {
              if (cur !== 'winpe-inject') {
                // Phase not yet set — transition to winpe-inject; progress events manage pct
                updateDiskState(disk, { phase: 'winpe-inject', pct: 0, label: null })
              }
              // When already in winpe-inject, pct is owned by progress events — do not overwrite
            }
          }
        }
        console.log('[build:event]', ev.event, ev)
        break

      default:
        console.log('[build:event] unhandled:', ev.event, ev)
        break
    }
  }

  function updateDiskState(diskNum, update) {
    diskStates[diskNum] = { ...(diskStates[diskNum] || {}), ...update }
    noteMotion(diskStates[diskNum])
    refreshProgressCard(diskNum)
    updateOverallProgress()
    ensureStallWatch()
  }

  // Overall multi-USB progress: average of each stick's full-pipeline %, plus
  // an "X of N done" label and a stage strip. Only when MORE THAN ONE USB is
  // building — a single-USB build relies on its per-disk card.
  function updateOverallProgress() {
    const bar = document.getElementById('overall-bar')
    if (!bar) return
    const nums = currentBuildDisks
    const N = nums.length
    if (N <= 1) { bar.style.display = 'none'; return }

    let sum = 0
    nums.forEach(num => {
      sum += diskPipelinePct(diskStates[num] || {})
    })
    const avg = Math.round(sum / N)
    const doneCount = nums.filter(n => (diskStates[n] || {}).done).length

    bar.style.display = ''
    const fill = document.getElementById('overall-fill')
    if (fill) fill.style.width = `${avg}%`
    const count = document.getElementById('overall-count')
    const anyStalled = nums.some(n => {
      const st = diskStates[n] || {}
      return st.stalled && !st.done && !st.failed
    })
    if (count) {
      let text = count.querySelector('.overall-count-text')
      if (!text) {
        count.textContent = ''
        text = document.createElement('span')
        text.className = 'overall-count-text'
        count.appendChild(text)
      }
      const next = `${doneCount} of ${N} done \u00b7 ${avg}%`
      if (text.textContent !== next) text.textContent = next
      syncStallSpin(count, anyStalled)
    }
    updateOverallStages(nums)
  }

  function updateOverallStages(nums) {
    const el = document.getElementById('overall-stages')
    if (!el) return
    const orders = nums.map(n => {
      const st = diskStates[n] || {}
      if (st.failed) return null
      if (st.done) return 8
      return PHASE_ORDER[st.phase] != null ? PHASE_ORDER[st.phase] : 0
    })
    const nonFailed = orders.filter(o => o != null)
    el.innerHTML = OVERALL_STAGES.map(stage => {
      let cls = 'overall-stage pending'
      if (nonFailed.length > 0 && nonFailed.every(o => o > stage.order)) {
        cls = 'overall-stage done'
      } else if (nonFailed.some(o => o === stage.order)) {
        cls = 'overall-stage active'
      }
      return `<span class="${cls}" data-stage="${stage.id}">${escHtml(stage.label)}</span>`
    }).join('')
  }

  function refreshProgressCard(diskNum) {
    const cardEl = document.getElementById(`progress-card-${diskNum}`)
    if (!cardEl) return

    const st = diskStates[diskNum] || {}
    const phaseInfo = PHASES[st.phase] || { label: st.phase || 'Working…', pct: st.pct || 0 }
    const isLive = LIVE_PROGRESS_PHASES.has(st.phase) || !!st.flushing
    const pct = Math.round(diskPhaseLocalPct(st))

    const phaseLabel = document.getElementById(`phase-label-${diskNum}`)
    const bar = document.getElementById(`prog-bar-${diskNum}`)
    const statusEl = document.getElementById(`status-${diskNum}`)

    if (phaseLabel) {
      phaseLabel.textContent = (!st.done && !st.failed && st.flushing)
        ? 'Finalizing…'
        : ((!st.done && !st.failed && st.label) ? st.label : phaseInfo.label)
    }

    if (bar) {
      let nextClass = 'prog-bar indeterminate'
      let nextWidth = ''
      if (st.done) {
        nextClass = 'prog-bar done-bar'
        nextWidth = '100%'
      } else if (st.failed) {
        nextClass = 'prog-bar fail-bar'
        nextWidth = '100%'
      } else if (isLive) {
        nextClass = 'prog-bar'
        nextWidth = `${pct}%`
      }
      if (bar.className !== nextClass) bar.className = nextClass
      if (bar.style.width !== nextWidth) bar.style.width = nextWidth
    }

    if (statusEl) {
      if (st.done) {
        statusEl.innerHTML = '<span class="done-label">✓ Complete</span>'
      } else if (st.failed) {
        statusEl.innerHTML = '<span class="fail-label">✗ Failed</span>'
      } else {
        setPctAndStallSpin(statusEl, pct, !!st.stalled)
      }
    }

    const nextCardClass = st.done
      ? 'usb-progress-card done'
      : (st.failed ? 'usb-progress-card failed' : 'usb-progress-card building')
    if (cardEl.className !== nextCardClass) cardEl.className = nextCardClass
    if (st.failed && st.error && !cardEl.querySelector('.progress-error')) {
      const errEl = document.createElement('div')
      errEl.className = 'progress-error'
      errEl.textContent = st.error
      cardEl.appendChild(errEl)
    }
  }

  function showProgressView(selectedDisks) {
    const progressSection = document.getElementById('progress-section')
    const selectionSection = document.getElementById('selection-section')
    if (!progressSection || !selectionSection) return

    selectionSection.style.display = 'none'
    progressSection.style.display = ''

    const grid = document.getElementById('progress-grid')
    if (grid) {
      grid.innerHTML = selectedDisks.map(d => renderProgressCard(d)).join('')
    }

    currentBuildDisks = selectedDisks.map(d => d.number)
    ensureStallWatch()

    const cancelBtn = document.getElementById('cancel-build-btn')
    if (cancelBtn) cancelBtn.style.display = ''

    const newBuildBtn = document.getElementById('new-build-btn')
    if (newBuildBtn) newBuildBtn.style.display = 'none'

    updateOverallProgress()
  }

  function showSummary(succeeded, failed) {
    const summaryEl = document.getElementById('build-summary')
    if (!summaryEl) return
    summaryEl.style.display = ''
    const total = succeeded.length + failed.length
    if (failed.length === 0) {
      summaryEl.className = 'summary-line success'
      summaryEl.innerHTML = `&#10003; All ${total} stick${total !== 1 ? 's' : ''} completed successfully.`
    } else if (succeeded.length > 0) {
      summaryEl.className = 'summary-line partial'
      summaryEl.innerHTML = `&#9888; ${succeeded.length}/${total} sticks completed — ${failed.length} failed. Re-run for failed disks.`
      window.toast(`${failed.length} disk(s) failed — see progress cards`, 'warn')
    } else {
      summaryEl.className = 'summary-line'
      summaryEl.innerHTML = `&#10005; All ${total} sticks failed. Check errors above.`
      window.toast('Build failed for all disks', 'error')
    }

    const cancelBtn = document.getElementById('cancel-build-btn')
    if (cancelBtn) cancelBtn.style.display = 'none'

    const newBuildBtn = document.getElementById('new-build-btn')
    if (newBuildBtn) newBuildBtn.style.display = ''

    updateOverallProgress()
  }

  // ─── Page init ────────────────────────────────────────────────────────────
  function init(rootEl, params, nav) {
    root = rootEl
    navigate = nav
    wfType = (params.type || 'amd64').toUpperCase()
    selected.clear()
    disks = []
    diskStates = {}
    diskModes  = {}
    currentBuildDisks = []
    stopFlushAnim()
    stopStallWatch()
    { const ob = document.getElementById('overall-bar'); if (ob) ob.style.display = 'none' }
    setBuilding(false)
    isLoadingDisks = false
    preCachePct = null
    preCacheRunning = false
    preCacheDone = false
    preCacheDialogShown = false
    autoStartOnComplete = false
    destroyConfirmed = false
    stagingVersion = null
    stagingWimBuildDate = null
    buildMode = null
    sources = []
    selectedSource = null
    sourceAnalysis = null
    sourceFolder = null
    sourceScanning = false
    sweepRunning = false
    sweepStats = { found: 0, dirs: 0, current: '' }
    freshSourcePaths.clear()
    fixedShareIsoFile = null
    staging = false
    preSplitAvailable = false
    preSplitMatchesIso = false
    preSplitImageVersion = null
    // Seed from the persisted dev setting so the mode carries across page navigations.
    forceBuildMode = localStorage.getItem('lw_dev.buildMode') || null

    let wfLabel, wfDesc = null
    if (wfType === 'QUICK-INSTALL-AMD64') {
      wfLabel = 'Quick Install — Intel/AMD'
      wfDesc = 'Minimal install — no payload, no menus · Boots to OOBE · Builds directly from ISO'
    } else if (wfType === 'QUICK-INSTALL-ARM64') {
      wfLabel = 'Quick Install — Snapdragon'
      wfDesc = 'Minimal install — no payload, no menus · Boots to OOBE · Builds directly from ISO'
    } else if (wfType === 'ARM64') {
      wfLabel = 'Windows Updates — Snapdragon'
    } else if (wfType === 'MEDIA-CREATOR') {
      wfLabel = 'Media Creator'
      wfDesc = 'Mount any ISO, or write bootable USB from Linux, Windows, or other ISO images you pick locally (share ISOs still need FirstbaseHQ)'
    } else if (wfType === 'BITRASER') {
      wfLabel = 'Bitraser USB'
      wfDesc = 'IT-staged vendor ISO from Remote\\Staging\\Bitraser\\ · No Windows payload'
    } else if (wfType === 'DESTRUCTION') {
      wfLabel = 'Data Destruction — Secure Wipe USB'
      wfDesc = 'IT-staged wipe ISO from Remote\\Staging\\Destruction\\ · No manual source selection'
    } else {
      wfLabel = 'Windows Updates — Intel/AMD'
    }

    const showSourcePicker = usesSourcePicker()
    const showFixedShare = isFixedShareWorkflow()
    const mediaSourceBlock = showSourcePicker
      ? `
          <div class="sl">Image Source</div>
          <div class="source-panel" id="source-panel">
            <div class="detect-spinner">
              <div class="spin"></div>
              <span>Scanning image sources…</span>
            </div>
          </div>`
      : showFixedShare
        ? `
          <div class="sl">Share Image</div>
          <div class="fixed-share-panel source-panel" id="fixed-share-panel">
            <div class="detect-spinner">
              <div class="spin"></div>
              <span>Checking share staging…</span>
            </div>
          </div>`
        : ''

    const page = document.createElement('div')
    page.className = 'page'
    page.innerHTML = `
      <div class="wrap">

        <!-- Toolbar -->
        <div class="builder-toolbar">
          <button class="btn btn-ghost" id="back-btn">&#8592; Back</button>
          <div class="workflow-badge">${escHtml(wfLabel)}${wfDesc ? `<span style="display:block;font-size:.72rem;font-weight:400;opacity:.72;margin-top:.1rem">${escHtml(wfDesc)}</span>` : ''}</div>
          <div id="build-mode-chip"></div>
          <div id="build-mode-override" style="display:none;gap:.25rem;align-items:center;margin-left:.5rem">
            <span id="force-mode-label" style="font-size:.75rem;color:var(--t3)">Force: Auto</span>
            <button class="btn btn-sm btn-ghost" id="force-wim-btn" title="Force WIM mode">WIM</button>
            <button class="btn btn-sm btn-ghost" id="force-iso-btn" title="Force ISO mode">ISO</button>
          </div>
          <button class="btn btn-sm btn-out" id="stage-iso-btn" style="display:none;margin-left:.5rem"
            title="DEV: pre-split the newest ISO's install.wim into an install*.swm set and stage it (Shift-click to force a re-stage)">&#9881; Stage ISO</button>
        </div>

        <!-- Local Build Mode indicator (dev-only, shown when lw_dev.localBuild=true) -->
        <div class="local-build-banner" id="local-build-banner" style="display:none">
          <span class="local-build-banner-icon">&#9432;</span>
          Local Build Mode &mdash; using the bundled Remote\ folder, network share not required.
        </div>

        <!-- Pre-cache bar -->
        <div class="precache-bar" id="precache-bar">
          <span class="precache-label" id="precache-label">Preparing…</span>
          <div class="precache-prog">
            <div class="precache-fill indeterminate" id="precache-fill"></div>
          </div>
        </div>

        <!-- Startnet inject status -->
        <div class="precache-bar" id="startnet-status" style="display:none">
          <span class="precache-label" id="startnet-label">WinPE injection pending...</span>
          <div class="precache-prog">
            <div class="precache-fill indeterminate" id="startnet-fill"></div>
          </div>
        </div>

        <!-- Selection section -->
        <div id="selection-section">
          ${mediaSourceBlock}

          <div class="sl" style="margin-top:${mediaSourceBlock ? '1.25rem' : '0'}">Detected USB Drives</div>
          <div id="usb-grid-area">
            <div class="detect-spinner">
              <div class="spin"></div>
              <span>Scanning for USB drives…</span>
            </div>
          </div>

          <div class="action-bar">
            <button class="btn btn-ghost" style="font-size:.8rem" id="sel-all-btn">Select All</button>
            <button class="btn btn-ghost" style="font-size:.8rem" id="desel-btn">Deselect All</button>
            <button class="btn btn-pri" id="start-build-btn" disabled style="margin-left:auto">
              &#9654; Start Build
            </button>
          </div>
        </div>

        <!-- Progress section (hidden initially) -->
        <div id="progress-section" style="display:none">
          <div class="sl">Build Progress</div>
          <div class="overall-bar" id="overall-bar" style="display:none">
            <div class="overall-bar-head">
              <span class="overall-label" id="overall-label">Overall Progress</span>
              <span class="overall-count" id="overall-count"></span>
            </div>
            <div class="overall-prog"><div class="overall-fill" id="overall-fill"></div></div>
            <div class="overall-stages" id="overall-stages"></div>
          </div>
          <div class="usb-grid" id="progress-grid"></div>
          <div id="build-summary" class="summary-line" style="display:none"></div>
          <div style="margin-top:1rem">
            <button class="btn btn-danger" id="cancel-build-btn" style="display:none">
              &#9632; Cancel Build
            </button>
            <button class="btn btn-out" id="new-build-btn" style="margin-left:.75rem">
              &#8592; New Build
            </button>
          </div>
        </div>


      </div>
    `

    // Pre-cache "start automatically?" dialog (shown during pre-cache after first progress event)
    const preCacheDialog = document.createElement('div')
    preCacheDialog.className = 'modal-overlay'
    preCacheDialog.id = 'precache-question-overlay'
    preCacheDialog.innerHTML = `
      <div class="modal" style="max-width:440px;text-align:center">
        <h3 style="margin-bottom:.65rem">Pre-cache Running</h3>
        <p style="color:var(--t2);font-size:.9rem;margin-bottom:.9rem;line-height:1.65">
          Start building automatically when pre-cache finishes?
        </p>
        <div class="modal-warn" style="margin-bottom:1.4rem;text-align:left">
          Clicking <strong>Yes</strong> will <strong>permanently erase</strong> the selected
          drives and write the Windows image when pre-cache completes.
          This action cannot be undone.
        </div>
        <div class="modal-actions" style="justify-content:center;gap:.75rem">
          <button class="btn btn-danger" id="pcq-yes-btn">Yes, auto-start &amp; wipe drives</button>
          <button class="btn btn-ghost" id="pcq-no-btn">No, I'll start manually</button>
        </div>
      </div>
    `
    document.body.appendChild(preCacheDialog)
    preCacheDialog.querySelector('#pcq-yes-btn').addEventListener('click', () => {
      autoStartOnComplete = true
      destroyConfirmed = true   // wipe warning already shown inline — skip separate modal
      hidePreCacheDialog()
    })
    preCacheDialog.querySelector('#pcq-no-btn').addEventListener('click', () => {
      autoStartOnComplete = false
      hidePreCacheDialog()
    })

    const overlay = document.createElement('div')
    overlay.className = 'modal-overlay'
    overlay.id = 'confirm-overlay'
    overlay.innerHTML = `
      <div class="modal">
        <h3>&#9888; Confirm — Irreversible</h3>
        <div class="modal-warn" id="modal-warn-text">
          You are about to <strong>permanently erase</strong> the following drives.
          All data will be destroyed.
        </div>
        <div class="modal-disk-list" id="modal-disk-list"></div>
        <div class="modal-actions">
          <button class="btn btn-ghost" id="modal-cancel-btn">Cancel</button>
          <button class="btn btn-danger" id="modal-confirm-btn">Confirm &amp; Proceed</button>
        </div>
      </div>
    `
    document.body.appendChild(overlay)
    rootEl.appendChild(page)

    page.querySelector('#back-btn').addEventListener('click', () => {
      hidePreCacheDialog()
      navigate('#home')
    })


    // Auto-poll for USB changes every 3 s (matches global sidebar rate).
    // Only triggers a full re-detect when the drive set actually changes.
    let diskPollTimer = null
    async function silentPoll() {
      if (building) return
      try {
        const latest = await window.api.getUsbDisks().catch(() => null)
        if (!latest) return
        const oldNums = new Set(disks.map(d => d.number))
        const newNums = new Set(latest.map(d => d.number))
        const changed = oldNums.size !== newNums.size || latest.some(d => !oldNums.has(d.number))
        if (changed) detectDisks()
      } catch (_) {}
    }
    diskPollTimer = setInterval(silentPoll, 1000)

    // Dev-only: force build-mode override buttons
    const overrideEl  = page.querySelector('#build-mode-override')
    const forceWimBtn = page.querySelector('#force-wim-btn')
    const forceIsoBtn = page.querySelector('#force-iso-btn')
    function syncForceButtons() {
      if (forceWimBtn) forceWimBtn.classList.toggle('active', forceBuildMode === 'wim')
      if (forceIsoBtn) forceIsoBtn.classList.toggle('active', forceBuildMode === 'iso')
      const lbl = page.querySelector('#force-mode-label')
      if (lbl) {
        if (forceBuildMode === 'wim')      lbl.textContent = 'Force: WIM [on]'
        else if (forceBuildMode === 'iso') lbl.textContent = 'Force: ISO [on]'
        else                               lbl.textContent = 'Force: Auto'
      }
    }
    if (forceWimBtn) forceWimBtn.addEventListener('click', () => {
      forceBuildMode = forceBuildMode === 'wim' ? null : 'wim'
      syncForceButtons()
    })
    if (forceIsoBtn) forceIsoBtn.addEventListener('click', () => {
      forceBuildMode = forceBuildMode === 'iso' ? null : 'iso'
      syncForceButtons()
    })
    const stageBtn = page.querySelector('#stage-iso-btn')
    if (stageBtn) stageBtn.addEventListener('click', (e) => startStaging(e.shiftKey))
    window.api.getDevInfo().then(info => {
      // Assume release until proven otherwise, so the per-disk mode toggle never
      // flashes into a packaged build during the async dev-info round-trip.
      if (overrideEl && !info.isPackaged) overrideEl.style.display = 'flex'
      // Stage ISO is DEV-MODE-ONLY and only meaningful for LoneWolf (AMD64/ARM64)
      // workflows, which pre-split install.wim for FAT32.
      if (stageBtn && !info.isPackaged && isLoneWolfWorkflow()) stageBtn.style.display = ''
      if (!info.isPackaged && localStorage.getItem('lw_dev.localBuild') === 'true') {
        const banner = page.querySelector('#local-build-banner')
        if (banner) banner.style.display = 'flex'
      }
      if (disks.length) renderDiskGrid()
    }).catch(() => {})
    page.querySelector('#sel-all-btn').addEventListener('click', selectAll)
    page.querySelector('#desel-btn').addEventListener('click', deselectAll)
    page.querySelector('#start-build-btn').addEventListener('click', () => {
      hidePreCacheDialog()
      if (destroyConfirmed) {
        // User already confirmed data destruction before pre-cache ran; go straight to build.
        startBuild()
      } else {
        showConfirmModal()
      }
    })
    overlay.querySelector('#modal-cancel-btn').addEventListener('click', hideConfirmModal)
    overlay.querySelector('#modal-confirm-btn').addEventListener('click', () => {
      const selDisks = disks.filter(d => selected.has(d.number))
      const hasFullRebuild = selDisks.some(d => effectiveDiskMode(d) === 'full')
      if (hasFullRebuild) {
        // Destruction confirmed. Pre-cache is already running (started on page load).
        // If it's done go straight to build; if still running, set the flag so the
        // auto-start path (updatePreCache) fires startBuild() when it finishes.
        destroyConfirmed = true
        hideConfirmModal()
        if (preCacheDone && !preCacheRunning) {
          startBuild()
        }
        // else: updatePreCache will call startBuild() when pre-cache completes
        // (autoStartOnComplete path or the user will click Start Build).
      } else {
        // Quick Update — no pre-cache needed; go straight to build.
        startBuild()
      }
    })
    page.querySelector('#cancel-build-btn').addEventListener('click', async () => {
      await window.api.cancelBuild()
      setBuilding(false)
      setBuildInProgress(false)
      window.toast('Build cancelled', 'warn')
      const cancelBtn = page.querySelector('#cancel-build-btn')
      if (cancelBtn) cancelBtn.style.display = 'none'
      const newBuildBtn = page.querySelector('#new-build-btn')
      if (newBuildBtn) newBuildBtn.style.display = ''
    })
    page.querySelector('#new-build-btn').addEventListener('click', () => {
      // Reset build state in-place so the page re-initialises cleanly without
      // relying on navigation (same-hash navigate may be a no-op in the SPA router).
      setBuilding(false)
      isLoadingDisks = false
      diskStates = {}
      diskModes  = {}
      currentBuildDisks = []
      stopFlushAnim()
      { const ob = document.getElementById('overall-bar'); if (ob) ob.style.display = 'none' }
      selected.clear()
      preCacheDialogShown = false
      autoStartOnComplete = false
      destroyConfirmed = false
      preCacheRunning = false
      preCacheDone = false
      preCachePct = null
      staging = false
      buildMode = null
      forceBuildMode = null
      sources = []
      selectedSource = null
      sourceAnalysis = null
      sourceFolder = null
      sourceScanning = false
      sweepRunning = false
      sweepStats = { found: 0, dirs: 0, current: '' }
      freshSourcePaths.clear()
      fixedShareIsoFile = null
      window.api.offBuildEvent()
      // Re-register so the next build's events are received. offBuildEvent() removes
      // ALL listeners; without this the second build stays frozen at "Waiting 0%".
      window.api.onBuildEvent(handleBuildEvent)

      const progressSection  = document.getElementById('progress-section')
      const selectionSection = document.getElementById('selection-section')
      const summaryEl        = document.getElementById('build-summary')
      const cancelBtn        = document.getElementById('cancel-build-btn')
      if (progressSection)  progressSection.style.display  = 'none'
      if (selectionSection) selectionSection.style.display = ''
      if (summaryEl)        { summaryEl.style.display = 'none'; summaryEl.className = 'summary-line' }
      if (cancelBtn)        cancelBtn.style.display = 'none'

      const startnetReset = document.getElementById('startnet-status')
      if (startnetReset) { startnetReset.style.display = 'none'; startnetReset.style.borderColor = '' }
      hidePreCacheDialog()

      detectDisks()
      if (usesSourcePicker()) loadSources()
    })

    overlay.addEventListener('click', (e) => {
      if (e.target === e.currentTarget) hideConfirmModal()
    })

    // Register build event listener now so precache progress events are captured
    // before the user starts a build (precache runs immediately on page load).
    window.api.onBuildEvent(handleBuildEvent)

    if (usesSourcePicker()) {
      window.api.offLocalScanEvents()
      window.api.onLocalSourceFound(onSweepBatch)
      window.api.onLocalScanProgress(onSweepProgress)
      window.api.onLocalScanDone(onSweepDone)
    }

    // detectDisks() sets buildMode before returning, then pre-cache starts
    // automatically — it is non-destructive (writes to a local cache only).
    const initTasks = [detectDisks()]
    if (usesSourcePicker()) initTasks.push(loadSources())
    Promise.all(initTasks)
      .then(() => startPreCache())
      .catch(() => {})

    return () => {
      clearInterval(diskPollTimer)
      clearTimeout(sweepHideTimer)
      window.api.offBuildEvent()
      window.api.offLocalScanEvents()
      window.api.cancelLocalScan()
      if (building) window.api.cancelBuild()
      if (preCacheDialog.parentNode) preCacheDialog.parentNode.removeChild(preCacheDialog)
      if (overlay.parentNode) overlay.parentNode.removeChild(overlay)
    }
  }

  // Called by the router when a stashed builder page is restored after navigation.
  // Re-renders all progress cards from diskStates so CSS animations restart and
  // any events that arrived while hidden are reflected immediately.
  function resume() {
    Object.keys(diskStates).forEach(n => refreshProgressCard(parseInt(n)))
    updateStartButton()
  }

  window.__pages.builder = { init, resume }
})()
