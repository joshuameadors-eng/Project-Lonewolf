/* Home page — hero + workflow cards + connected drives sidebar */
;(function () {
  const USB_ICON = `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"
      stroke-linecap="round" stroke-linejoin="round" style="color:#22d3ee">
    <path d="M11 8v5l3 3"/>
    <path d="M12 3v5"/>
    <rect x="8" y="8" width="8" height="10" rx="1"/>
    <path d="M8 12H4v5a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2v-5h-4"/>
    <circle cx="12" cy="3" r="1"/>
  </svg>`

  const SHIELD_ICON = `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"
      stroke-linecap="round" stroke-linejoin="round" style="color:#22d3ee">
    <path d="M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10z"/>
    <line x1="12" y1="8" x2="12" y2="12"/>
    <line x1="12" y1="16" x2="12.01" y2="16"/>
  </svg>`

  const MONITOR_ICON = `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"
      stroke-linecap="round" stroke-linejoin="round" style="color:#a78bfa">
    <rect x="2" y="3" width="20" height="14" rx="2"/>
    <polyline points="8 21 12 17 16 21"/>
    <line x1="12" y1="17" x2="12" y2="17"/>
  </svg>`

  const TOOLS = [
    {
      id: 'amd64',
      icon: USB_ICON,
      title: 'Intel/AMD Windows',
      desc: 'WinPE automated install with Windows Update payload and QA workflow.',
      status: 'active',
      statusLabel: 'Active',
      route: '#builder?type=amd64'
    },
    {
      id: 'arm64',
      icon: USB_ICON,
      title: 'Snapdragon Windows',
      desc: 'Deployment USB for ARM-based Snapdragon devices.',
      status: 'soon',
      statusLabel: 'Not Available',
      disabled: true,
      tooltip: 'Snapdragon imaging is not currently available',
      route: '#builder?type=arm64'
    },
    {
      id: 'quick-install-amd64',
      icon: MONITOR_ICON,
      title: 'Quick Install — Intel/AMD',
      desc: 'Minimal WinPE Windows install — no payload, no menus; boots to OOBE.',
      status: 'active',
      statusLabel: 'Active',
      route: '#builder?type=quick-install-amd64'
    },
    {
      id: 'quick-install-arm64',
      icon: MONITOR_ICON,
      title: 'Quick Install — Snapdragon',
      desc: 'Minimal WinPE Windows install for ARM — no payload, no menus.',
      status: 'soon',
      statusLabel: 'Not Available',
      disabled: true,
      tooltip: 'Snapdragon staging is not currently available',
      route: '#builder?type=quick-install-arm64'
    },
    {
      id: 'media-creator',
      icon: USB_ICON,
      title: 'Bootable Media',
      desc: 'Bootable USB from share-staged or local ISO images.',
      status: 'active',
      statusLabel: 'Active',
      route: '#builder?type=media-creator'
    },
    {
      id: 'bitraser',
      icon: SHIELD_ICON,
      title: 'Bitraser USB',
      desc: 'Vendor Bitraser bootable USB from IT-staged share ISO.',
      status: 'soon',
      statusLabel: 'Coming Soon',
      disabled: true,
      tooltip: 'Bitraser USB is coming soon',
      route: '#builder?type=bitraser'
    },
    {
      id: 'destruction',
      icon: SHIELD_ICON,
      title: 'Secure Wipe USB',
      desc: 'Secure wipe ISO for devices that cannot boot Bitraser.',
      status: 'soon',
      statusLabel: 'Coming Soon',
      disabled: true,
      tooltip: 'Secure Wipe USB is coming soon',
      route: '#builder?type=destruction'
    }
  ]

  // ─── USB polling state (module-level so notified serials persist across visits) ──
  let pollTimer = null
  let isLoadingDrives = true   // true until the first poll result arrives
  let stagingCache = { AMD64: null, ARM64: null, fetchedAt: 0 }
  const notifiedStaleDriveSerials = new Set()
  let officialVersions = { launcher: null, script: null }

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

  function isStickDevBuild(disk, stagingVer) {
    if (disk && disk.lwDevBuild) return true
    // Live cross-ref vs GitHub latest.json (unpackaged destage): stick ahead of public official.
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

  // ─── Sidebar collapse state ───────────────────────────────────────────────────
  let sidebarManuallyCollapsed = false
  let sidebarInitialStateApplied = false

  function getSidebarCollapsed() {
    return localStorage.getItem('lw_sidebar_collapsed') === 'true'
  }
  function setSidebarCollapsed(val) {
    localStorage.setItem('lw_sidebar_collapsed', val ? 'true' : 'false')
  }
  function applySidebarState(panel, collapsed) {
    if (!panel) return
    const btn = panel.querySelector('#sidebar-toggle-btn') ||
                document.getElementById('sidebar-toggle-btn')
    if (collapsed) {
      panel.classList.add('collapsed')
      if (btn) { btn.textContent = '\u203a'; btn.title = 'Expand sidebar' }
    } else {
      panel.classList.remove('collapsed')
      if (btn) { btn.textContent = '\u2039'; btn.title = 'Collapse sidebar' }
    }
  }

  async function getStagingVersionsCached() {
    const age = Date.now() - stagingCache.fetchedAt
    if (age < 60000 && (stagingCache.AMD64 || stagingCache.ARM64)) {
      return stagingCache
    }
    try {
      const [a64, a32] = await Promise.all([
        window.api.getStagingVersion('AMD64').catch(() => null),
        window.api.getStagingVersion('ARM64').catch(() => null)
      ])
      stagingCache = {
        AMD64: a64 && a64.version !== 'unknown' ? a64.version : null,
        ARM64: a32 && a32.version !== 'unknown' ? a32.version : null,
        fetchedAt: Date.now()
      }
    } catch (_) {}
    return stagingCache
  }

  async function refreshDrives() {
    const list    = document.getElementById('home-drive-list')
    const countEl = document.getElementById('home-drive-count')
    if (!list) return
    if (!window.api || !window.api.getUsbDisks) {
      if (isLoadingDrives) {
        isLoadingDrives = false
        list.innerHTML = '<div class="usb-panel-empty">No drives connected</div>'
      }
      return
    }

    try {
      const [disks, staging] = await Promise.all([
        window.api.getUsbDisks().catch(() => []),
        getStagingVersionsCached(),
        refreshOfficialVersions()
      ])
      // refreshOfficialVersions resolves to undefined; disks/staging are index 0/1
      // (third Promise.all slot intentionally ignored)
      isLoadingDrives = false   // first real result received

      // ─── Sidebar auto-collapse / expand ──────────────────────────────────────
      const panel = document.getElementById('home-drive-panel')
      const hasDevices = Array.isArray(disks) && disks.length > 0

      if (!sidebarInitialStateApplied) {
        sidebarInitialStateApplied = true
        if (hasDevices) {
          // Devices present on load → always expand, ignore saved preference
          sidebarManuallyCollapsed = false
          applySidebarState(panel, false)
        }
        // No devices on load → keep initial state that was set from localStorage in init()
      } else if (!hasDevices) {
        // Drives disconnected → auto-collapse and reset manual flag
        sidebarManuallyCollapsed = false
        applySidebarState(panel, true)
      } else if (!sidebarManuallyCollapsed) {
        // Drives reconnected and user hasn't manually collapsed → auto-expand
        applySidebarState(panel, false)
      }

      // ─── Stats row update ─────────────────────────────────────────────────────
      const statConnected     = document.getElementById('stat-connected')
      const statOutdated      = document.getElementById('stat-outdated')
      const statUnprovisioned = document.getElementById('stat-unprovisioned')
      const sidebarColCount   = document.getElementById('sidebar-collapsed-count')

      if (statConnected) {
        if (!hasDevices) {
          statConnected.textContent = '0'
          if (statOutdated)      statOutdated.textContent = '0'
          if (statUnprovisioned) statUnprovisioned.textContent = '0'
          if (sidebarColCount)   sidebarColCount.textContent = ''
        } else {
          const outdated = disks.filter(d => {
            if (!d.isLoneWolfDisk || !d.lwVersion) return false
            const arch = d.lwWorkflowType || 'AMD64'
            if (!staging[arch]) return false
            if (isStickDevBuild(d, staging[arch])) return false
            return d.lwVersion !== staging[arch]
          }).length
          const unprovisioned = disks.filter(d => !d.isLoneWolfDisk).length
          statConnected.textContent     = String(disks.length)
          if (statOutdated)      statOutdated.textContent      = String(outdated)
          if (statUnprovisioned) statUnprovisioned.textContent = String(unprovisioned)
          if (sidebarColCount)   sidebarColCount.textContent   = String(disks.length)
        }
      }

      // Notify stale drives (once per serial per app session)
      if (Array.isArray(disks) && window.api.notifyStaleDrive) {
        disks.forEach(disk => {
          if (disk.isLoneWolfDisk && disk.lwVersion && disk.serial) {
            const arch = disk.lwWorkflowType || 'AMD64'
            const stagingVer = staging[arch]
            if (stagingVer && disk.lwVersion !== stagingVer &&
                !isStickDevBuild(disk, stagingVer) &&
                !notifiedStaleDriveSerials.has(disk.serial)) {
              notifiedStaleDriveSerials.add(disk.serial)
              window.api.notifyStaleDrive({
                serial: disk.serial,
                label: disk.friendlyName || disk.label || ''
              })
            }
          }
        })
      }

      if (!Array.isArray(disks) || disks.length === 0) {
        if (countEl) countEl.textContent = ''
        list.innerHTML = '<div class="usb-panel-empty">No drives connected</div>'
        return
      }

      if (countEl) countEl.textContent = String(disks.length)

      list.innerHTML = disks.map(disk => {
        const arch = disk.lwWorkflowType || 'AMD64'
        const stagingVer = staging[arch]

        let statusClass = 'fresh'
        let statusLabel = 'Unformatted'

        if (disk.isLoneWolfDisk && disk.lwVersion) {
          if (isStickDevBuild(disk, stagingVer)) {
            statusClass = 'dev-build'
            statusLabel = 'DEV'
          } else if (stagingVer && disk.lwVersion === stagingVer) {
            statusClass = 'up-to-date'
            statusLabel = 'Up to date'
          } else if (stagingVer) {
            statusClass = 'update-avail'
            statusLabel = 'Needs update'
          } else {
            statusClass = 'lw-disk'
            statusLabel = 'LoneWolf'
          }
        }

        const letterBadge = disk.driveLetter
          ? `<span class="drive-letter-badge">${disk.driveLetter}</span>`
          : ''
        const sizeLabel    = disk.sizeGB ? `${parseFloat(disk.sizeGB).toFixed(0)} GB` : ''
        const versionLabel = disk.lwVersion ? ` &bull; v${disk.lwVersion}` : ''
        const pillTitle = statusClass === 'dev-build'
          ? ' title="Dev destage: launcher or script version ahead of GitHub latest.json"'
          : ''

        return `
          <div class="home-drive-card">
            <div class="home-drive-card-top">
              ${letterBadge}
              <div class="home-drive-card-info">
                <div class="home-drive-card-name">${disk.friendlyName || 'Disk ' + disk.number}</div>
                <div class="home-drive-card-meta">${sizeLabel}${versionLabel}</div>
              </div>
            </div>
            <span class="usb-pill ${statusClass}"${pillTitle}>${statusLabel}</span>
          </div>
        `
      }).join('')
    } catch (_) {
      if (isLoadingDrives) {
        isLoadingDrives = false
        if (list) list.innerHTML = '<div class="usb-panel-empty">No drives connected</div>'
      }
    }
  }

  function renderCard(tool) {
    const dis = tool.disabled ? ' disabled' : ''
    const tip = tool.tooltip ? ` title="${tool.tooltip}"` : ''
    const cta = tool.disabled ? '' : `<span class="card-launch">Launch &#8594;</span>`

    return `
      <div class="tool-card${dis}" data-route="${tool.route || ''}" data-id="${tool.id}"${tip}
           role="${tool.disabled ? 'presentation' : 'button'}" tabindex="${tool.disabled ? '-1' : '0'}"
           aria-label="${tool.title}">
        <div class="tool-card-head">
          <div class="tool-card-icon">${tool.icon}</div>
          <div class="tool-card-head-text">
            <h3>${tool.title}</h3>
          </div>
          <span class="status-badge ${tool.status}">${tool.statusLabel}</span>
        </div>
        <p class="tool-card-desc" id="card-desc-${tool.id}">${tool.desc}</p>
        <div class="tool-card-footer">
          <div class="tool-card-footer-meta">
            <span class="card-build-date" id="card-build-date-${tool.id}" style="display:none"></span>
            <span class="card-staging-version" id="card-version-${tool.id}" style="display:none"></span>
          </div>
          ${cta}
        </div>
      </div>
    `
  }

  // ─── Init ────────────────────────────────────────────────────────────────
  function init(root, _params, navigate) {
    isLoadingDrives = true   // reset on every page visit so skeleton shows again

    // Reset sidebar state for this page visit
    sidebarManuallyCollapsed = getSidebarCollapsed()
    sidebarInitialStateApplied = false

    const page = document.createElement('div')
    page.className = 'page home-page'
    page.innerHTML = `
      <div class="home-layout">

        <!-- Left: workflow tiles -->
        <div class="home-main">
          <h1 class="home-title">Select a Workflow</h1>
          <div class="local-build-banner" id="home-local-banner" style="display:none;margin:0 2rem .75rem">
            <span class="local-build-banner-icon">&#9432;</span>
            Local Build Mode &mdash; using the bundled Remote\ folder, network share not required.
          </div>
          <div class="home-grid workflow-grid" id="tools-grid">
            ${TOOLS.map(renderCard).join('')}
          </div>
        </div>

        <!-- Right: connected drives panel -->
        <aside class="home-drive-panel" id="home-drive-panel">
          <div class="home-drive-panel-hdr">
            <span class="home-drive-panel-title">Connected Drives</span>
            <span id="home-drive-count" class="usb-panel-count"></span>
            <button class="sidebar-toggle-btn" id="sidebar-toggle-btn" title="Collapse sidebar">&#8249;</button>
          </div>
          <div class="sidebar-collapsed-tab" id="sidebar-collapsed-tab">
            <span class="sidebar-collapsed-count" id="sidebar-collapsed-count"></span>
            <span class="sidebar-collapsed-label">USB</span>
          </div>
          <div class="usb-stats-row" id="usb-stats-row">
            <span class="usb-stat">
              <span class="usb-stat-num" id="stat-connected">0</span>
              <span class="usb-stat-label">Connected</span>
            </span>
            <span class="usb-stat">
              <span class="usb-stat-num usb-stat-warn" id="stat-outdated">0</span>
              <span class="usb-stat-label">Out of Date</span>
            </span>
            <span class="usb-stat">
              <span class="usb-stat-num usb-stat-muted" id="stat-unprovisioned">0</span>
              <span class="usb-stat-label">Not Provisioned</span>
            </span>
          </div>
          <div id="home-drive-list" class="home-drive-list">
            <div class="skeleton-row"></div>
            <div class="skeleton-row"></div>
            <div class="loading-text">Scanning...</div>
          </div>
        </aside>

      </div>
    `
    root.appendChild(page)

    // Show local-build banner on home page when dev flag is active
    if (window.api && window.api.getDevInfo) {
      window.api.getDevInfo().then(info => {
        if (!info.isPackaged && localStorage.getItem('lw_dev.localBuild') === 'true') {
          const banner = page.querySelector('#home-local-banner')
          if (banner) banner.style.display = 'flex'
        }
      }).catch(() => {})
    }

    // Apply initial sidebar state from localStorage (before first poll result)
    const drivePanel = page.querySelector('#home-drive-panel')
    applySidebarState(drivePanel, sidebarManuallyCollapsed)

    // Wire sidebar toggle button
    const toggleBtn = page.querySelector('#sidebar-toggle-btn')
    if (toggleBtn) {
      toggleBtn.addEventListener('click', () => {
        const p = document.getElementById('home-drive-panel')
        if (!p) return
        const newCollapsed = !p.classList.contains('collapsed')
        sidebarManuallyCollapsed = newCollapsed
        setSidebarCollapsed(newCollapsed)
        applySidebarState(p, newCollapsed)
      })
    }

    // Animate active cards in
    requestAnimationFrame(() => {
      page.querySelectorAll('.tool-card:not(.disabled)').forEach(c => c.classList.add('visible'))
    })

    // Click / keyboard handlers for workflow tiles (Coming Soon stays inert)
    page.querySelectorAll('.tool-card[data-route]').forEach(card => {
      const route = card.getAttribute('data-route')
      if (!route) return
      const go = () => {
        if (card.classList.contains('disabled')) return
        navigate(route)
      }
      card.addEventListener('click', go)
      card.addEventListener('keydown', (e) => {
        if (e.key === 'Enter' || e.key === ' ') {
          e.preventDefault()
          go()
        }
      })
    })

    // Dynamically update cards from staging version data
    if (window.api && window.api.getStagingVersion) {
      // Show skeleton on all status badges while the staging fetch is in-flight
      page.querySelectorAll('.status-badge').forEach(b => b.classList.add('loading-badge'))

      window.api.getStagingVersion('AMD64').then(staging => {
        // Remove skeleton badges as soon as we have a result (even a negative one)
        page.querySelectorAll('.status-badge').forEach(b => b.classList.remove('loading-badge'))
        if (!staging) return

        const version = staging.version
        if (version && version !== 'unknown') {
          const amd64VerEl = page.querySelector('#card-version-amd64')
          if (amd64VerEl) {
            amd64VerEl.textContent = `Staging v${version}`
            amd64VerEl.style.display = ''
          }
        }

        // Show build date on each workflow card
        const amd64WimDate = (staging.architectures && staging.architectures.AMD64 && staging.architectures.AMD64.wimBuildDate)
          || staging.buildDate || null
        const arm64WimDate = (staging.architectures && staging.architectures.ARM64 && staging.architectures.ARM64.wimBuildDate)
          || staging.buildDate || null

        const amd64DateEl = page.querySelector('#card-build-date-amd64')
        if (amd64DateEl && amd64WimDate) {
          amd64DateEl.textContent = `Built: ${amd64WimDate}`
          amd64DateEl.style.display = ''
        }

        const arm64DateEl = page.querySelector('#card-build-date-arm64')
        if (arm64DateEl && arm64WimDate) {
          arm64DateEl.textContent = `Built: ${arm64WimDate}`
          arm64DateEl.style.display = ''
        }

        const arm64Data         = staging.architectures && staging.architectures.ARM64
        const arm64EnabledByFlag = arm64Data ? arm64Data.enabled !== false : false  // safe default: false

        // Check actual ARM64 file availability on share
        window.api.getStagingVersion('ARM64').then(arm64Staging => {
          const arm64FilesPresent = arm64Staging && (arm64Staging.wimAvailable || arm64Staging.isoAvailable)
          const arm64Enabled = arm64EnabledByFlag && arm64FilesPresent

          if (arm64Enabled) {
            const arm64Card = page.querySelector('.tool-card[data-id="arm64"]')
            if (arm64Card) {
              arm64Card.classList.remove('disabled')
              arm64Card.setAttribute('tabindex', '0')
              arm64Card.setAttribute('role', 'button')
              arm64Card.setAttribute('data-route', '#builder?type=arm64')
              arm64Card.removeAttribute('title')
              const badge = arm64Card.querySelector('.status-badge')
              if (badge) { badge.className = 'status-badge active'; badge.textContent = 'Active' }
              const footer = arm64Card.querySelector('.tool-card-footer')
              if (footer && !footer.querySelector('.card-launch')) {
                const cta = document.createElement('span')
                cta.className = 'card-launch'
                cta.innerHTML = 'Launch &#8594;'
                footer.appendChild(cta)
              }
              arm64Card.addEventListener('click', () => navigate('#builder?type=arm64'))
            }
          }
          // If not enabled, cards stay disabled (already their default state)
        }).catch(() => {
          // ARM64 staging fetch failed — cards remain Not Available (safe default)
        })
      }).catch(() => {
        page.querySelectorAll('.status-badge').forEach(b => b.classList.remove('loading-badge'))
      })
    }

    // Start USB polling for the drives sidebar
    if (window.api && window.api.getUsbDisks) {
      refreshDrives()
      pollTimer = setInterval(refreshDrives, 1000)
    }

    // Cleanup: stop polling when navigating away
    return () => {
      if (pollTimer) { clearInterval(pollTimer); pollTimer = null }
    }
  }

  window.__pages.home = { init }
})()
