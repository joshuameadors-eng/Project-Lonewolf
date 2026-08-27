/* ================================================================
   Project LoneWolf Launcher — Renderer Entry Point
   Router, IPC wrappers, toast system, nav management
================================================================ */

'use strict'

// ─── Page registry ────────────────────────────────────────────────────────────
const PAGE_SCRIPTS = {
  splash:    './pages/splash.js',
  home:      './pages/home.js',
  builder:   './pages/builder.js',
  guides:    './pages/guides.js',
  changelog: './pages/changelog.js'
}

let currentPage = null
let currentCleanup = null

// Cached app version fetched once in initVersion(); used in update overlays
// to ensure the displayed "current version" always comes from app.getVersion(),
// not from whatever the remote update script returns.
let _cachedAppVersion = null

// ─── Background-build stash ───────────────────────────────────────────────────
// When a build is active and the user navigates away from the builder page we
// keep the builder DOM alive (hidden) and restore it on the next visit.
let storedBuilderEl = null
let storedBuilderCleanup = null

// ─── Router ───────────────────────────────────────────────────────────────────
function getRoute() {
  const hash = window.location.hash.replace(/^#/, '') || 'splash'
  const [page, qs] = hash.split('?')
  const params = {}
  if (qs) {
    qs.split('&').forEach(part => {
      const [k, v] = part.split('=')
      params[decodeURIComponent(k)] = decodeURIComponent(v || '')
    })
  }
  return { page, params }
}

function navigate(hash) {
  window.location.hash = hash
}

// ─── Build-running badge ──────────────────────────────────────────────────────
function updateBuildBadge() {
  const nav = document.getElementById('main-nav')
  if (!nav) return
  let badge = document.getElementById('build-running-badge')
  if (window.__builderBuildActive) {
    if (!badge) {
      badge = document.createElement('div')
      badge.id = 'build-running-badge'
      badge.style.cssText = [
        'font-size:.72rem', 'color:#f59e0b',
        'background:rgba(245,158,11,.13)',
        'border:1px solid rgba(245,158,11,.35)',
        'border-radius:3px', 'padding:2px 9px',
        'margin-left:auto', 'cursor:pointer',
        'user-select:none', 'align-self:center',
        'white-space:nowrap'
      ].join(';')
      badge.title = 'Build in progress \u2014 click to return to Builder'
      badge.textContent = '\u2699 Building\u2026'
      badge.addEventListener('click', () => navigate('#builder'))
      nav.appendChild(badge)
    }
  } else {
    if (badge) badge.remove()
  }
}
window.__updateBuildBadge = updateBuildBadge

async function renderPage() {
  const { page, params } = getRoute()
  if (currentPage === page && page !== 'builder') return

  // Whether we're about to restore a live stashed builder
  const isRestoringBuilder = page === 'builder' && storedBuilderEl !== null

  // If a stash exists but the build is done and we're going somewhere other than
  // builder, clean it up now rather than leaving a ghost element on <body>.
  if (storedBuilderEl && !window.__builderBuildActive && !isRestoringBuilder) {
    if (storedBuilderCleanup) {
      try { storedBuilderCleanup() } catch (_) {}
      storedBuilderCleanup = null
    }
    if (storedBuilderEl.parentNode) storedBuilderEl.parentNode.removeChild(storedBuilderEl)
    storedBuilderEl = null
  }

  // Navigating away from builder while a build is active — stash rather than destroy
  const isStashingBuilder = currentPage === 'builder' && window.__builderBuildActive && page !== 'builder'

  if (isStashingBuilder) {
    const stashRoot = document.getElementById('app-root')
    const pageEl = stashRoot ? stashRoot.querySelector('.page') : null
    if (pageEl) {
      pageEl.style.display = 'none'
      document.body.appendChild(pageEl) // detach from root, keep alive on body
      storedBuilderEl = pageEl
    }
    storedBuilderCleanup = currentCleanup
    currentCleanup = null
    // Keep the build event listener alive — do NOT call offBuildEvent here
  } else {
    if (currentCleanup) {
      try { currentCleanup() } catch (_) {}
      currentCleanup = null
    }
    // Don't kill the event listener when restoring the live builder, or when a
    // build is active in the stashed builder (navigating between non-builder pages).
    if (!isRestoringBuilder && !window.__builderBuildActive) {
      window.api.offBuildEvent()
    }
  }

  currentPage = page
  updateBuildBadge()
  updateParallaxBackdrop(page)

  const nav = document.getElementById('main-nav')
  if (page === 'splash') {
    nav.classList.add('hidden')
  } else {
    nav.classList.remove('hidden')
    updateNavActive(page)
  }

  const root = document.getElementById('app-root')
  root.innerHTML = ''

  // Restore a stashed builder instead of mounting a fresh one
  if (isRestoringBuilder) {
    storedBuilderEl.style.display = ''
    root.appendChild(storedBuilderEl)
    currentCleanup = storedBuilderCleanup
    storedBuilderEl = null
    storedBuilderCleanup = null
    // Re-render progress cards — CSS animations freeze during display:none
    if (window.__pages && window.__pages.builder && window.__pages.builder.resume) {
      window.__pages.builder.resume()
    }
    return
  }

  // Dynamic import via script tag since we're in a renderer with no bundler
  const mod = await loadPageModule(page)
  if (mod && mod.init) {
    currentCleanup = mod.init(root, params, navigate) || null
  }
}

// Script-tag based module loader (no bundler / require)
const loadedModules = {}
async function loadPageModule(page) {
  if (loadedModules[page]) return loadedModules[page]
  return new Promise((resolve) => {
    const existing = document.querySelector(`script[data-page="${page}"]`)
    if (existing) { resolve(window.__pages[page]); return }

    const s = document.createElement('script')
    s.src = `./pages/${page}.js`
    s.setAttribute('data-page', page)
    s.onload = () => resolve(window.__pages && window.__pages[page])
    s.onerror = () => {
      console.error(`Failed to load page module: ${page}`)
      resolve(null)
    }
    document.head.appendChild(s)
  })
}

// ─── Nav active state ─────────────────────────────────────────────────────────
function updateNavActive(page) {
  document.querySelectorAll('.nav-links a').forEach(a => {
    a.classList.toggle('active', a.getAttribute('data-page') === page)
  })
}

// ─── Version in nav ───────────────────────────────────────────────────────────
async function initVersion() {
  try {
    const v = await window.api.getVersion()
    _cachedAppVersion = v
    const el = document.getElementById('nav-version')
    if (!el) return
    el.textContent = `v${v}`
    el.classList.remove('nav-version-dev')
    el.removeAttribute('title')
    try {
      const packed = await window.api.getDevInfo()
      if (packed && packed.isPackaged) return
      const st = await window.api.getVersionStatus()
      if (st && st.isDevBuild && !st.isPackaged) {
        el.innerHTML = `v${v} <span class="nav-dev-pill">DEV</span>`
        el.classList.add('nav-version-dev')
        const bits = []
        if (st.official) bits.push(`launcher GitHub v${st.official}`)
        if (st.officialScript) bits.push(`payload GitHub v${st.officialScript}`)
        const off = bits.length ? ` (${bits.join(', ')})` : ''
        const why = []
        if (st.launcherAhead) why.push('launcher ahead')
        if (st.scriptAhead) why.push('script ahead')
        el.title = `Dev build${why.length ? ': ' + why.join(' + ') : ''}${off}`
      }
    } catch (_) {}
  } catch (_) {}
}

// ─── Toast system ─────────────────────────────────────────────────────────────
window.toast = function toast(message, type = 'info', duration = 4500) {
  const icons = { info: 'ℹ', warn: '⚠', error: '✕', ok: '✓' }
  const container = document.getElementById('toast-container')
  if (!container) return

  const el = document.createElement('div')
  el.className = `toast ${type}`
  el.innerHTML = `<span class="toast-icon">${icons[type] || 'ℹ'}</span><span>${message}</span>`
  container.appendChild(el)

  setTimeout(() => {
    el.classList.add('fade-out')
    setTimeout(() => el.remove(), 320)
  }, duration)
}

// ─── Page modules namespace ───────────────────────────────────────────────────
window.__pages = {}

// ─── Settings helpers ─────────────────────────────────────────────────────────
function getLwSettings() {
  try { return JSON.parse(localStorage.getItem('lw_settings') || '{}') } catch (_) { return {} }
}
function setLwSettings(obj) {
  try { localStorage.setItem('lw_settings', JSON.stringify(obj)) } catch (_) {}
}

// ─── Dev flag helpers ─────────────────────────────────────────────────────────
function getLwDevFlag(key) {
  try { return localStorage.getItem(`lw_dev.${key}`) } catch (_) { return null }
}
function setLwDevFlag(key, value) {
  try {
    if (value === null || value === undefined) localStorage.removeItem(`lw_dev.${key}`)
    else localStorage.setItem(`lw_dev.${key}`, String(value))
  } catch (_) {}
}

// ─── Tutorial — pointer / spotlight tooltip system ────────────────────────────
const tutorial = (() => {
  // Step definitions (0-indexed internally; displayed as 1-of-N)
  const STEPS = [
    // 0 — Welcome (centered modal, no target)
    {
      target: null, page: null, centered: true,
      title: 'Welcome to LoneWolf Launcher',
      body:  'This quick guide will walk you through building your first Windows deployment USB. It only takes a couple of minutes. You can relaunch this guide anytime from Settings.'
    },
    // 1 — Home: workflow tiles
    {
      target: '#tools-grid', page: 'home',
      title: 'Choose Your Workflow',
      body:  'Select the type of deployment you want to build. Windows Updates prepares a USB for the full deployment and update pipeline.'
    },
    // 2 — Home: connected drives panel
    {
      target: '.home-drive-panel', page: 'home',
      title: 'Connected Drives',
      body:  'Plug in a USB drive (16 GB or larger). It will appear here automatically. Drives already labeled LoneWolf show their version so you can tell if they\u2019re up to date.',
      extraNote: function () {
        const list = document.getElementById('home-drive-list')
        return (list && list.querySelector('.usb-panel-empty'))
          ? 'No drives detected yet \u2014 plug one in to continue, or press Next to skip.'
          : 'USB drive detected! You can see it in the panel. Press Next to continue.'
      },
      dynamicNote: true,
      preferredPlacement: 'left'
    },
    // 3 — Home: open builder (auto-advances when user navigates to builder)
    // Tooltip placed to the RIGHT so it doesn't cover the tile the user must click
    {
      target: '.tool-card[data-id="amd64"]', page: 'home',
      title: 'Open the Builder',
      body:  'Click \u2018Project LoneWolf\u2019 to open the builder and start preparing your USB.',
      autoAdvance: 'builder',
      preferredPlacement: 'right'
    },
    // 4 — Builder: Full Rebuild vs Quick Update
    {
      name: 'fullRebuild',
      // Try mode-toggle buttons first; fall back to the whole grid area
      target: ['.usb-mode-toggle', '#usb-grid-area'], page: 'builder',
      title: 'Full Rebuild vs Quick Update',
      body:  'Full Rebuild (red) performs a complete wipe and fresh installation \u2014 use this for new or old drives. Quick Update (green) copies only the latest scripts to an existing LoneWolf drive \u2014 much faster.'
    },
    // 5 — Builder: pre-cache bar (jumped to programmatically from builder.js)
    {
      name: 'precache',
      target: '.precache-bar', page: 'builder',
      title: 'Pre-Caching Boot Files',
      body:  'The launcher is loading boot files in the background. This only happens once \u2014 future builds start immediately. Press Next when you\u2019re ready to continue.'
    },
    // 6 — Builder: drive selection
    {
      name: 'selectDrive',
      target: '#usb-grid-area', page: 'builder',
      title: 'Select Your Drive',
      body:  'Your connected USB drives appear here. Click a drive card to select it \u2014 selected drives are highlighted. You can select multiple drives at once for batch building.',
      spotlightPad: 8
    },
    // 7 — Builder: start button
    {
      target: '#start-build-btn', page: 'builder',
      title: 'Start Building',
      body:  'Once your drive is selected, click Start Building. You\u2019ll see live progress for each USB. You can plug in multiple drives and build them all at once.'
    },
    // 8 — Done (centered modal, no target)
    {
      target: null, page: null, centered: true,
      title: 'You\u2019re Ready',
      body:  'That\u2019s everything. If you run into any issues, check the Help page or contact Joshua Meadors. You can relaunch this guide from Settings \u2192 Show Guide.'
    }
  ]

  const TOTAL = STEPS.length
  let step           = 0
  let active         = false
  let spotlightEl    = null
  let backdropEl     = null
  let tooltipEl      = null
  let navWatcher      = null
  let resizeCleanup   = null
  let rainCleanup     = null
  let lightningCleanup = null
  let drivesPollTimer = null

  // ── Element lifecycle ──────────────────────────────────────────────────────
  function mount() {
    if (!spotlightEl) {
      spotlightEl = document.createElement('div')
      document.body.appendChild(spotlightEl)
    }
    if (!backdropEl) {
      backdropEl = document.createElement('div')
      backdropEl.className = 'tutorial-backdrop'
      document.body.appendChild(backdropEl)
      rainCleanup = startRainCanvas(backdropEl)
      lightningCleanup = startLightningCanvas(backdropEl)
    }
    if (!tooltipEl) {
      tooltipEl = document.createElement('div')
      document.body.appendChild(tooltipEl)
    }
  }

  function unmount() {
    clearResizeListeners()
    clearDrivesPoll()
    if (rainCleanup) { rainCleanup(); rainCleanup = null }
    if (lightningCleanup) { lightningCleanup(); lightningCleanup = null }
    if (spotlightEl) { spotlightEl.remove(); spotlightEl = null }
    if (backdropEl)  { backdropEl.remove();  backdropEl  = null }
    if (tooltipEl)   { tooltipEl.remove();   tooltipEl   = null }
  }

  function clearResizeListeners() {
    if (resizeCleanup) { resizeCleanup(); resizeCleanup = null }
  }

  function clearDrivesPoll() {
    if (drivesPollTimer) { clearInterval(drivesPollTimer); drivesPollTimer = null }
  }

  function clearNavWatcher() {
    if (navWatcher) { window.removeEventListener('hashchange', navWatcher); navWatcher = null }
  }

  // ── Backdrop clip helpers ──────────────────────────────────────────────────
  // clip-path evenodd punches a hole so backdrop-filter never samples the
  // spotlight area — fixes Chromium blur-bleed through SVG mask-image.
  function updateBackdropClip(spotX, spotY, spotW, spotH, pad) {
    if (!backdropEl) return
    const vw = window.innerWidth
    const vh = window.innerHeight
    const x = Math.round(spotX - pad)
    const y = Math.round(spotY - pad)
    const w = Math.round(spotW + pad * 2)
    const h = Math.round(spotH + pad * 2)
    // evenodd: outer rect (CW) + inner rect (CCW) = hole punched out of the backdrop
    const clip = [
      'polygon(evenodd,',
      `0px 0px, ${vw}px 0px, ${vw}px ${vh}px, 0px ${vh}px, 0px 0px,`,
      `${x}px ${y}px, ${x}px ${y + h}px, ${x + w}px ${y + h}px, ${x + w}px ${y}px, ${x}px ${y}px`,
      ')'
    ].join(' ')
    backdropEl.style.clipPath = clip
    backdropEl.style.webkitClipPath = clip
  }

  // ── Rain canvas effect (drawn inside backdrop, masked out of spotlight hole) ─
  function startRainCanvas(container) {
    const canvas = document.createElement('canvas')
    canvas.style.cssText = 'position:absolute;inset:0;width:100%;height:100%;pointer-events:none;opacity:0.18;'
    container.appendChild(canvas)

    const ctx = canvas.getContext('2d')
    let raf

    const drops = Array.from({ length: 120 }, () => ({
      x: Math.random() * window.innerWidth,
      y: Math.random() * window.innerHeight,
      len: 8 + Math.random() * 18,
      speed: 4 + Math.random() * 8,
      opacity: 0.3 + Math.random() * 0.5,
      width: 0.5 + Math.random() * 0.8
    }))

    function resize() {
      canvas.width = window.innerWidth
      canvas.height = window.innerHeight
    }

    function draw() {
      ctx.clearRect(0, 0, canvas.width, canvas.height)
      ctx.strokeStyle = 'rgba(180, 220, 255, 1)'
      drops.forEach(d => {
        ctx.globalAlpha = d.opacity
        ctx.lineWidth = d.width
        ctx.beginPath()
        ctx.moveTo(d.x, d.y)
        ctx.lineTo(d.x - d.len * 0.15, d.y + d.len)
        ctx.stroke()
        d.y += d.speed
        d.x -= d.speed * 0.15
        if (d.y > canvas.height + 20) {
          d.y = -20
          d.x = Math.random() * canvas.width
        }
      })
      raf = requestAnimationFrame(draw)
    }

    resize()
    window.addEventListener('resize', resize, { passive: true })
    draw()

    return () => {
      cancelAnimationFrame(raf)
      window.removeEventListener('resize', resize)
      canvas.remove()
    }
  }

  // ── Lightning bolt canvas effect ───────────────────────────────────────────
  function startLightningCanvas(container) {
    const canvas = document.createElement('canvas')
    canvas.style.cssText = 'position:absolute;inset:0;width:100%;height:100%;pointer-events:none;z-index:1;'
    container.appendChild(canvas)

    const ctx = canvas.getContext('2d')
    let raf
    let bolts = []
    let nextStrike = Date.now() + 4800

    function resize() {
      canvas.width = window.innerWidth
      canvas.height = window.innerHeight
    }

    function generateBolt(x1, y1, x2, y2, roughness, depth) {
      if (depth === 0 || Math.hypot(x2 - x1, y2 - y1) < 4) {
        return [{ x1, y1, x2, y2, alpha: 1, width: Math.max(0.5, depth * 0.4) }]
      }
      const mx = (x1 + x2) / 2 + (Math.random() - 0.5) * roughness
      const my = (y1 + y2) / 2 + (Math.random() - 0.5) * roughness
      const segs = [
        ...generateBolt(x1, y1, mx, my, roughness * 0.6, depth - 1),
        ...generateBolt(mx, my, x2, y2, roughness * 0.6, depth - 1)
      ]
      if (depth > 2 && Math.random() < 0.35) {
        const bx = mx + (Math.random() - 0.3) * roughness * 1.5
        const by = my + Math.random() * roughness * 1.5
        const branchSegs = generateBolt(mx, my, bx, by, roughness * 0.5, depth - 2)
        branchSegs.forEach(s => { s.width *= 0.5 })
        segs.push(...branchSegs)
      }
      return segs
    }

    function spawnStrike() {
      const startX = Math.random() * canvas.width
      const endX   = startX + (Math.random() - 0.5) * canvas.width * 0.4
      const endY   = canvas.height * (0.4 + Math.random() * 0.45)
      const segs   = generateBolt(startX, 0, endX, endY, 120, 8)
      bolts.push({ segs, life: 1.0, decay: 0.04 + Math.random() * 0.03 })
      if (Math.random() < 0.4) {
        setTimeout(() => {
          const segs2 = generateBolt(
            startX + (Math.random() - 0.5) * 80, 0,
            endX   + (Math.random() - 0.5) * 60, endY * (0.7 + Math.random() * 0.3),
            90, 7
          )
          bolts.push({ segs: segs2, life: 0.8, decay: 0.05 })
        }, 60 + Math.random() * 80)
      }
      nextStrike = Date.now() + 4600 + Math.random() * 800
    }

    function draw() {
      ctx.clearRect(0, 0, canvas.width, canvas.height)

      if (Date.now() >= nextStrike) spawnStrike()

      bolts = bolts.filter(b => b.life > 0)
      for (const bolt of bolts) {
        for (const seg of bolt.segs) {
          const alpha = bolt.life * seg.alpha
          ctx.beginPath()
          ctx.moveTo(seg.x1, seg.y1)
          ctx.lineTo(seg.x2, seg.y2)
          ctx.strokeStyle = `rgba(255,255,255,${alpha * 0.95})`
          ctx.lineWidth   = seg.width + 0.5
          ctx.shadowBlur  = 0
          ctx.stroke()
          ctx.beginPath()
          ctx.moveTo(seg.x1, seg.y1)
          ctx.lineTo(seg.x2, seg.y2)
          ctx.strokeStyle = `rgba(120,200,255,${alpha * 0.6})`
          ctx.lineWidth   = seg.width + 3
          ctx.shadowColor = 'rgba(100,180,255,0.8)'
          ctx.shadowBlur  = 8
          ctx.stroke()
        }
        bolt.life -= bolt.decay
      }

      ctx.shadowBlur = 0
      raf = requestAnimationFrame(draw)
    }

    resize()
    const onResize = () => resize()
    window.addEventListener('resize', onResize, { passive: true })
    draw()

    return () => {
      cancelAnimationFrame(raf)
      window.removeEventListener('resize', onResize)
      canvas.remove()
    }
  }

  // ── Spotlight helpers ──────────────────────────────────────────────────────
  function repositionSpotlight(target, el, pad) {
    const r = target.getBoundingClientRect()
    el.style.top    = (r.top    - pad) + 'px'
    el.style.left   = (r.left   - pad) + 'px'
    el.style.width  = (r.width  + pad * 2) + 'px'
    el.style.height = (r.height + pad * 2) + 'px'
    updateBackdropClip(r.left, r.top, r.width, r.height, pad)
  }

  // ── Dynamic note poll (Fix 4 — connected drives step) ─────────────────────
  function startDrivesPoll(s) {
    clearDrivesPoll()
    drivesPollTimer = setInterval(() => {
      if (!tooltipEl) return
      const noteEl = tooltipEl.querySelector('.tutorial-body-note')
      if (!noteEl || typeof s.extraNote !== 'function') return
      const text = s.extraNote()
      if (text && text !== noteEl.textContent) noteEl.textContent = text
    }, 1500)
  }

  // ── Target resolution ──────────────────────────────────────────────────────
  // Tries each selector in order; skips elements that are not visible (display:none)
  function findTarget(spec) {
    if (!spec) return null
    const sels = Array.isArray(spec) ? spec : [spec]
    for (const sel of sels) {
      const el = document.querySelector(sel)
      if (!el) continue
      const r = el.getBoundingClientRect()
      if (r.width > 0 && r.height > 0) return el
    }
    return null
  }

  // ── Tooltip HTML builder ───────────────────────────────────────────────────
  function buildHTML(s) {
    const isFirst = step === 0
    const isLast  = step === TOTAL - 1

    const counter = (!isFirst && !isLast)
      ? `<div class="tutorial-step-counter">${step + 1} of ${TOTAL}</div>` : ''

    let bodyHtml = s.body
    if (typeof s.extraNote === 'function') {
      const note = s.extraNote()
      if (note) bodyHtml += `<span class="tutorial-body-note">${note}</span>`
    }

    const backBtn = (step > 0 && !isFirst)
      ? `<button class="tutorial-back">\u2190 Back</button>` : `<div></div>`

    const nextLabel = isFirst ? 'Start Guide \u2192' : isLast ? 'Close' : 'Next \u2192'
    const nextCls   = (isFirst || isLast)
      ? 'tutorial-next tutorial-next-primary' : 'tutorial-next'
    const skipBtn = (!isFirst && !isLast)
      ? `<button class="tutorial-skip">Skip</button>` : ''

    return `
      <button class="tutorial-close" title="Close guide">\u2715</button>
      ${counter}
      <h3 class="tutorial-title">${s.title}</h3>
      <p class="tutorial-body">${bodyHtml}</p>
      <div class="tutorial-nav">
        ${backBtn}
        <div class="tutorial-nav-right">
          ${skipBtn}
          <button class="${nextCls}">${nextLabel}</button>
        </div>
      </div>`
  }

  function wireEvents() {
    if (!tooltipEl) return
    tooltipEl.querySelector('.tutorial-close').addEventListener('click', stop)
    const back = tooltipEl.querySelector('.tutorial-back')
    if (back) back.addEventListener('click', () => goTo(step - 1))
    const skip = tooltipEl.querySelector('.tutorial-skip')
    if (skip) skip.addEventListener('click', stop)
    const next = tooltipEl.querySelector('.tutorial-next')
    if (next) next.addEventListener('click', () => step >= TOTAL - 1 ? stop() : goTo(step + 1))
  }

  // ── Tooltip positioning ────────────────────────────────────────────────────
  // preferredPlacement: 'right' | 'left' places tooltip beside the target;
  // default (undefined) places above or below based on vertical position.
  function placeTooltip(rect, preferredPlacement) {
    if (!tooltipEl) return
    const vw = window.innerWidth, vh = window.innerHeight
    const W  = Math.min(340, vw - 28)
    const H  = tooltipEl.getBoundingClientRect().height || 240
    const gap = 14, arrowH = 11
    let top, left, arrowDir

    if (preferredPlacement === 'right' || preferredPlacement === 'left') {
      const spaceRight = vw - rect.right - gap
      const spaceLeft  = rect.left - gap
      // For 'left': always prefer left; only fall back to right if tooltip won't fit.
      // For 'right': prefer right; fall back to left if less space on right.
      const useRight   = preferredPlacement === 'right'
        ? (spaceRight >= W + gap || spaceRight >= spaceLeft)
        : (spaceLeft < W && spaceRight > spaceLeft)
      if (useRight) {
        left     = rect.right + gap
        arrowDir = 'left'
      } else {
        left     = rect.left - W - gap
        arrowDir = 'right'
      }
      top  = rect.top + rect.height / 2 - H / 2
      top  = Math.max(14, Math.min(top,  vh - H - 14))
      left = Math.max(14, Math.min(left, vw - W - 14))
      tooltipEl.style.left  = left + 'px'
      tooltipEl.style.top   = top  + 'px'
      tooltipEl.style.width = W    + 'px'
      tooltipEl.style.transform = ''
      tooltipEl.setAttribute('data-arrow', arrowDir)
      return
    }

    const inTopHalf = (rect.top + rect.height / 2) < vh / 2
    if (inTopHalf) {
      top      = rect.bottom + gap + arrowH
      arrowDir = 'top'
    } else {
      top      = rect.top - gap - arrowH - H
      arrowDir = 'bottom'
    }

    left = rect.left + rect.width / 2 - W / 2
    left = Math.max(14, Math.min(left, vw - W - 14))
    top  = Math.max(14, Math.min(top,  vh - H - 14))

    tooltipEl.style.left  = left + 'px'
    tooltipEl.style.top   = top  + 'px'
    tooltipEl.style.width = W    + 'px'
    tooltipEl.style.transform = ''
    tooltipEl.setAttribute('data-arrow', arrowDir)
  }

  // ── Render ────────────────────────────────────────────────────────────────
  function render() {
    if (!active) return
    mount()
    const s = STEPS[step]

    // ── Centered step (Welcome / Done, or target not found) ──────────────────
    function renderCentered() {
      if (spotlightEl) {
        spotlightEl.className = ''
        spotlightEl.style.cssText = 'display:none'
      }
      // Backdrop: solid blur/dim with no hole, block pointer events to prevent
      // clicks through to the underlying page behind the centered modal.
      if (backdropEl) {
        backdropEl.style.clipPath = 'none'
        backdropEl.style.webkitClipPath = 'none'
        backdropEl.style.pointerEvents = 'all'
      }

      tooltipEl.className     = 'tutorial-tooltip tutorial-tooltip--centered'
      tooltipEl.removeAttribute('data-arrow')
      tooltipEl.style.cssText =
        'position:fixed;left:50%;top:50%;transform:translate(-50%,-50%);' +
        'width:520px;max-width:92vw;z-index:9001'
      tooltipEl.innerHTML = buildHTML(s)
      wireEvents()
    }

    if (s.centered || !s.target) {
      renderCentered()
      return
    }

    // Navigate to the correct page first if needed
    if (s.page && currentPage !== s.page) {
      navigate('#' + s.page)
      setTimeout(render, 440)
      return
    }

    const targetEl = findTarget(s.target)
    if (!targetEl) {
      renderCentered()   // graceful fallback
      return
    }

    // Render tooltip HTML immediately so its height is measurable in the second rAF
    tooltipEl.className     = 'tutorial-tooltip'
    tooltipEl.style.cssText = 'position:fixed;z-index:9001;width:340px;max-width:90vw'
    tooltipEl.removeAttribute('data-arrow')
    tooltipEl.innerHTML     = buildHTML(s)
    wireEvents()

    if (s.dynamicNote) startDrivesPoll(s)

    // Position spotlight after a rAF so getBoundingClientRect() reflects the
    // fully-painted DOM, then wire resize/observer/scroll listeners to keep it locked.
    if (backdropEl) backdropEl.style.pointerEvents = 'none'
    spotlightEl.className     = 'tutorial-spotlight'
    spotlightEl.style.cssText = ''
    clearResizeListeners()

    requestAnimationFrame(() => {
      const pad = s.spotlightPad || 6
      repositionSpotlight(targetEl, spotlightEl, pad)

      const onResize = () => repositionSpotlight(targetEl, spotlightEl, pad)
      const onScroll = () => repositionSpotlight(targetEl, spotlightEl, pad)
      window.addEventListener('resize', onResize)
      window.addEventListener('scroll', onScroll, { passive: true, capture: true })
      let ro = null
      if (window.ResizeObserver) {
        ro = new ResizeObserver(() => repositionSpotlight(targetEl, spotlightEl, pad))
        ro.observe(targetEl)
      }
      resizeCleanup = () => {
        window.removeEventListener('resize', onResize)
        window.removeEventListener('scroll', onScroll, { capture: true })
        if (ro) ro.disconnect()
      }

      requestAnimationFrame(() => placeTooltip(targetEl.getBoundingClientRect(), s.preferredPlacement))
    })
  }

  // ── Step navigation ───────────────────────────────────────────────────────
  // nOrName: step index (number) OR step name string (e.g. 'precache')
  function goTo(nOrName) {
    if (!active) return
    clearNavWatcher()
    clearResizeListeners()
    clearDrivesPoll()

    let n
    if (typeof nOrName === 'string') {
      n = STEPS.findIndex(s => s.name === nOrName)
      if (n === -1) { console.warn('[tutorial] named step not found:', nOrName); return }
    } else {
      n = nOrName
    }

    step = Math.max(0, Math.min(n, TOTAL - 1))
    const s = STEPS[step]

    // If this step auto-advances on navigation and we're already on that page → skip ahead
    if (s.autoAdvance && currentPage === s.autoAdvance) {
      goTo(step + 1)
      return
    }

    // Register a hashchange watcher to auto-advance when user navigates to the target page
    if (s.autoAdvance) {
      navWatcher = () => {
        const p = window.location.hash.replace(/^#/, '').split('?')[0]
        if (p === s.autoAdvance) {
          clearNavWatcher()
          setTimeout(() => goTo(step + 1), 440)
        }
      }
      window.addEventListener('hashchange', navWatcher)
    }

    render()
  }

  // ── Public API ────────────────────────────────────────────────────────────
  function start() {
    if (active) stop()
    active = true
    step   = 0
    mount()
    goTo(0)
  }

  function stop() {
    active = false
    clearNavWatcher()
    clearResizeListeners()
    clearDrivesPoll()
    unmount()
    const cfg = getLwSettings()
    cfg.tutorialComplete = 'true'
    cfg.showGuideOnStartup = false
    setLwSettings(cfg)
  }

  function isActive() { return active }

  function currentIndex() { return step }

  function indexOf(nameOrStep) {
    if (typeof nameOrStep === 'number') return nameOrStep
    return STEPS.findIndex(s => s.name === nameOrStep)
  }

  function shouldShow() {
    const cfg = getLwSettings()
    if (cfg.showGuideOnStartup === true) return true   // explicit opt-in
    if (cfg.showGuideOnStartup === false) return false  // explicit opt-out
    return cfg.tutorialComplete !== 'true'              // first-launch default
  }

  // show / close are aliases for backward-compat with existing settings modal code
  return { start, stop, goTo, show: start, close: stop, shouldShow, isActive, currentIndex, indexOf }
})()
window.__tutorial = tutorial

// ─── Theme ─────────────────────────────────────────────────────────────────────
const PARALLAX_THEME = 'parallax-blur'
let parallaxBound = false

function updateParallaxBackdrop(page) {
  const onHome = page === 'home'
  const theme = document.documentElement.getAttribute('data-theme')
  const showParallax = onHome || theme === PARALLAX_THEME
  document.body.classList.toggle('home-active', onHome)
  document.body.classList.toggle('parallax-active', showParallax)
  if (showParallax) initParallaxMotion()
}

function applyTheme(name) {
  const theme = name || 'dark'
  document.documentElement.setAttribute('data-theme', theme)
  updateParallaxBackdrop(currentPage)
}

function initParallaxMotion() {
  if (parallaxBound) return
  const bg = document.getElementById('parallax-bg')
  const root = document.getElementById('app-root')
  if (!bg) return

  const orbs = bg.querySelectorAll('.parallax-orb')
  const mesh = bg.querySelector('.parallax-mesh')
  const reduceMotion = window.matchMedia('(prefers-reduced-motion: reduce)').matches
  if (reduceMotion) return

  let mx = 0
  let my = 0
  let sy = 0
  let raf = 0

  function paint() {
    raf = 0
    orbs.forEach((orb, i) => {
      const depth = (i + 1) * 0.012
      orb.style.transform = `translate3d(${mx * depth * 28}px, ${my * depth * 22 + sy * depth * 18}px, 0)`
    })
    if (mesh) {
      mesh.style.transform = `translate3d(${mx * 6}px, ${my * 4 + sy * 8}px, 0)`
    }
  }

  function schedule() {
    if (!raf) raf = requestAnimationFrame(paint)
  }

  document.addEventListener('mousemove', (e) => {
    mx = (e.clientX / window.innerWidth - 0.5) * 2
    my = (e.clientY / window.innerHeight - 0.5) * 2
    schedule()
  }, { passive: true })

  if (root) {
    root.addEventListener('scroll', () => {
      sy = Math.min(root.scrollTop / 400, 1)
      schedule()
    }, { passive: true })
  }

  parallaxBound = true
}

// ─── Settings modal ───────────────────────────────────────────────────────────
const settingsModal = (() => {
  let el = null

  async function build() {
    let isDevMode = false
    try { isDevMode = await window.api.isDevMode() } catch (_) {}

    el = document.createElement('div')
    el.id = 'settings-modal-overlay'
    el.className = 'modal-overlay'
    el.innerHTML = `
      <div class="modal settings-modal">
        <button class="tutorial-close" id="settings-close" title="Close">&times;</button>
        <h3>Settings</h3>
        <div class="settings-modal-inner">

          <div class="settings-tabs" id="settings-tabs">
            <button class="settings-tab active" data-panel="general">General</button>
            ${isDevMode ? '<button class="settings-tab" data-panel="dev">Developer</button>' : ''}
          </div>

          <div class="settings-panel" id="settings-panel-general">

            <div class="settings-section">
              <div class="settings-section-title">Appearance</div>
              <div class="settings-row">
                <label for="settings-theme-select">Theme</label>
                <select id="settings-theme-select">
                  <option value="dark">Dark (Default)</option>
                  <option value="parallax-blur">Parallax Blur</option>
                  <option value="light">Light</option>
                  <option value="midnight">Midnight Blue</option>
                  <option value="sunset">Sunset Gradient</option>
                  <option value="aurora">Aurora</option>
                  <option value="sapphire">Sapphire</option>
                  <option value="cobalt">Cobalt</option>
                  <option value="violet">Violet</option>
                  <option value="amethyst">Amethyst</option>
                  <option value="nebula">Nebula</option>
                  <option value="deep-sea">Deep Sea</option>
                </select>
              </div>
            </div>

            <div class="settings-section">
              <div class="settings-section-title">Updates</div>
              <p class="settings-help">Quick Update pulls scripts/payload from the public GitHub source tree (not Setup.exe). Launcher Update installs a new exe from GitHub Releases. They are separate. The ISO share is not used for launcher versioning.</p>
              <div class="settings-row settings-row--btns">
                <button class="btn-dev-sm" id="settings-quick-update" title="Payload and scripts only; does not replace LoneWolf-Launcher.exe">Quick Update</button>
                <button class="btn-dev-sm" id="settings-launcher-update" title="Download installer/exe from public Releases">Launcher Update</button>
              </div>
            </div>

            <div class="settings-section">
              <div class="settings-section-title">Guide</div>
              <div class="settings-row">
                <label for="settings-show-guide-toggle">Show Getting Started on startup</label>
                <label class="toggle">
                  <input type="checkbox" id="settings-show-guide-toggle"${getLwSettings().showGuideOnStartup === true ? ' checked' : ''}>
                  <span class="slider"></span>
                </label>
              </div>
            </div>

          </div>

          ${isDevMode ? `<div class="settings-panel" id="settings-panel-dev" style="display:none">

            <div class="settings-dev-group">
              <h4>Guide &amp; Tutorial</h4>
              <div class="settings-row settings-row--btns">
                <button class="btn-dev-sm" id="settings-launch-tutorial">Re-launch Guide</button>
                <button class="btn-dev-sm" id="settings-reset-guide">Reset Guide Flag</button>
              </div>
              <div class="settings-row">
                <label for="settings-override-tutorial">Override tutorialComplete (force show on startup)</label>
                <label class="toggle">
                  <input type="checkbox" id="settings-override-tutorial"${getLwSettings().showGuideOnStartup === true ? ' checked' : ''}>
                  <span class="slider"></span>
                </label>
              </div>
            </div>

            <div class="settings-dev-group">
              <h4>Build</h4>
              <div class="settings-row">
                <label for="settings-wipe-precache">Wipe Pre-cache on Next Build</label>
                <label class="toggle"><input type="checkbox" id="settings-wipe-precache"${getLwDevFlag('wipePrecache') === 'true' ? ' checked' : ''}><span class="slider"></span></label>
              </div>
              <div class="settings-row">
                <label for="settings-sequential-build">Sequential Build Mode</label>
                <label class="toggle"><input type="checkbox" id="settings-sequential-build"${getLwDevFlag('sequentialBuild') === 'true' ? ' checked' : ''}><span class="slider"></span></label>
              </div>
              <div class="settings-row">
                <label for="settings-local-build" id="settings-local-build-label"${getLwDevFlag('localBuild') === 'true' ? ' class="settings-label-text--active-warn"' : ''}>Local Build Mode</label>
                <label class="toggle"><input type="checkbox" id="settings-local-build"${getLwDevFlag('localBuild') === 'true' ? ' checked' : ''}><span class="slider"></span></label>
              </div>
              <div class="settings-row" id="settings-build-mode-row">
                <label>Build Mode Override</label>
                <div class="radio-group">
                  <label><input type="radio" name="dev-build-mode" value="auto"${!getLwDevFlag('buildMode') ? ' checked' : ''}> Auto</label>
                  <label><input type="radio" name="dev-build-mode" value="wim"${getLwDevFlag('buildMode') === 'wim' ? ' checked' : ''}> WIM</label>
                  <label><input type="radio" name="dev-build-mode" value="iso"${getLwDevFlag('buildMode') === 'iso' ? ' checked' : ''}> ISO</label>
                </div>
              </div>
            </div>

            <div class="settings-dev-group">
              <h4>Logging</h4>
              <div class="settings-row">
                <label for="settings-verbose-log">Verbose Dev Logging</label>
                <label class="toggle"><input type="checkbox" id="settings-verbose-log"${getLwDevFlag('verboseLog') === 'true' ? ' checked' : ''}><span class="slider"></span></label>
              </div>
            </div>

            <div class="settings-dev-group">
              <h4>Test Notifications</h4>
              <div class="settings-row settings-row--btns">
                <button class="btn-dev-sm" id="settings-test-update">App Update</button>
                <button class="btn-dev-sm" id="settings-test-stale">Stale USB</button>
                <button class="btn-dev-sm" id="settings-test-build">Build Complete</button>
              </div>
            </div>
          </div>` : ''}

        </div>
      </div>
    `
    document.body.appendChild(el)

    el.querySelector('#settings-close').addEventListener('click', close)
    el.addEventListener('click', (e) => { if (e.target === el) close() })

    const tabs = el.querySelectorAll('.settings-tab')
    tabs.forEach(tab => {
      tab.addEventListener('click', () => {
        tabs.forEach(t => t.classList.remove('active'))
        tab.classList.add('active')
        el.querySelectorAll('.settings-panel').forEach(p => { p.style.display = 'none' })
        const panel = el.querySelector(`#settings-panel-${tab.dataset.panel}`)
        if (panel) panel.style.display = ''
      })
    })

    el.querySelector('#settings-show-guide-toggle').addEventListener('change', function () {
      const s = getLwSettings()
      s.showGuideOnStartup = this.checked
      setLwSettings(s)
      const devOverride = el.querySelector('#settings-override-tutorial')
      if (devOverride) devOverride.checked = this.checked
    })

    el.querySelector('#settings-quick-update').addEventListener('click', async () => {
      const btn = el.querySelector('#settings-quick-update')
      btn.disabled = true
      try {
        const res = await window.api.applyQuickUpdate()
        if (res && res.ok && res.skippedDownload) {
          window.toast(res.message || 'Using local src/ for destage (dev). No GitHub payload pull.', 'info')
        } else if (res && res.ok) {
          window.toast('Quick Update applied (scripts/payload only). Restart the launcher if a running script looks stale.', 'ok')
        } else {
          window.toast((res && res.error) ? res.error : 'Quick Update failed', 'error')
        }
      } catch (e) {
        window.toast(e.message, 'error')
      } finally {
        btn.disabled = false
      }
    })

    el.querySelector('#settings-launcher-update').addEventListener('click', async () => {
      const btn = el.querySelector('#settings-launcher-update')
      btn.disabled = true
      try {
        const res = await window.api.installUpdate({})
        if (res && res.reason === 'dev-mode') {
          window.toast('Launcher Update skipped — npm start / destage uses this checkout, not a new exe.', 'info')
        } else if (!res || !res.ok) {
          window.toast((res && res.error) ? res.error : 'Launcher Update failed', 'error')
        }
      } catch (e) {
        window.toast(e.message, 'error')
      } finally {
        btn.disabled = false
      }
    })

    const themeSelect = el.querySelector('#settings-theme-select')
    themeSelect.value = getLwSettings().theme || 'dark'
    themeSelect.addEventListener('change', function () {
      const s = getLwSettings()
      s.theme = this.value
      setLwSettings(s)
      applyTheme(this.value)
    })

    if (isDevMode) {
      el.querySelector('#settings-launch-tutorial').addEventListener('click', () => {
        close()
        tutorial.show()
      })

      el.querySelector('#settings-override-tutorial').addEventListener('change', function () {
        const s = getLwSettings()
        if (this.checked) {
          s.showGuideOnStartup = true
        } else {
          delete s.showGuideOnStartup
        }
        setLwSettings(s)
        const generalToggle = el.querySelector('#settings-show-guide-toggle')
        if (generalToggle) generalToggle.checked = this.checked
      })

      el.querySelector('#settings-wipe-precache').addEventListener('change', function () {
        setLwDevFlag('wipePrecache', this.checked ? 'true' : null)
      })

      el.querySelector('#settings-test-update').addEventListener('click', () => {
        window.api.testNotification('update')
        window.toast('Fired: Update Available notification', 'info')
      })

      el.querySelector('#settings-test-stale').addEventListener('click', () => {
        window.api.testNotification('staleUsb')
        window.toast('Fired: Stale USB Drive notification', 'info')
      })

      el.querySelector('#settings-test-build').addEventListener('click', () => {
        window.api.testNotification('buildComplete')
        window.toast('Fired: Build Complete notification', 'info')
      })

      el.querySelectorAll('input[name="dev-build-mode"]').forEach(radio => {
        radio.addEventListener('change', function () {
          setLwDevFlag('buildMode', this.value === 'auto' ? null : this.value)
        })
      })

      el.querySelector('#settings-verbose-log').addEventListener('change', function () {
        setLwDevFlag('verboseLog', this.checked ? 'true' : null)
      })

      el.querySelector('#settings-sequential-build').addEventListener('change', function () {
        setLwDevFlag('sequentialBuild', this.checked ? 'true' : null)
      })

      el.querySelector('#settings-local-build').addEventListener('change', function () {
        setLwDevFlag('localBuild', this.checked ? 'true' : null)
        const labelText = el.querySelector('#settings-local-build-label')
        if (labelText) labelText.classList.toggle('settings-label-text--active-warn', this.checked)
        try { window.api.setLocalBuild(this.checked) } catch (_) {}
      })

      el.querySelector('#settings-reset-guide').addEventListener('click', () => {
        const cfg = getLwSettings()
        delete cfg.tutorialComplete
        delete cfg.showGuideOnStartup
        setLwSettings(cfg)
        window.toast('Guide will show on next launch', 'ok')
      })
    }

    requestAnimationFrame(() => el.classList.add('open'))
  }

  function close() {
    if (el) {
      el.classList.remove('open')
      setTimeout(() => { if (el) { el.remove(); el = null } }, 250)
    }
  }

  function toggle() {
    if (el) { close() } else { build() }
  }

  return { toggle, close }
})()
window.__settingsModal = settingsModal

// ─── Update banner ────────────────────────────────────────────────────────────
let updateBannerDismissed = false
let pendingUpdateInfo = null

function showUpdateBanner(result) {
  const existing = document.getElementById('update-banner')
  if (existing) existing.remove()

  const launcher = !!(result && result.launcherUpdateAvailable)
  const payload = !!(result && result.payloadUpdateAvailable)
  if (!launcher && !payload) return

  const banner = document.createElement('div')
  banner.id = 'update-banner'
  banner.className = 'update-banner'
  const bits = []
  if (launcher) {
    bits.push('Launcher <strong>v' + (_cachedAppVersion || result.currentVersion || '?') + '</strong> &#8594; <strong>v' + (result.latestLauncherVersion || result.latestVersion || '?') + '</strong>')
  }
  if (payload) {
    bits.push('Payload/scripts <strong>v' + (result.currentPayloadVersion || '?') + '</strong> &#8594; <strong>v' + (result.latestPayloadVersion || '?') + '</strong> (Quick Update, no new exe)')
  }
  banner.innerHTML =
    '<span class="ub-icon">&#9632;</span>' +
    '<span class="ub-msg">' + bits.join(' &middot; ') + '</span>' +
    (payload ? '<button class="ub-btn-quick btn" type="button">Quick Update</button>' : '') +
    (launcher ? '<button class="ub-btn-update btn" type="button">Launcher Update</button>' : '') +
    '<button class="ub-btn-dismiss" title="Dismiss">&#215;</button>'

  document.body.appendChild(banner)

  const quickBtn = banner.querySelector('.ub-btn-quick')
  if (quickBtn) {
    quickBtn.addEventListener('click', async () => {
      quickBtn.disabled = true
      quickBtn.textContent = 'Updating\u2026'
      try {
        const res = await window.api.applyQuickUpdate()
        if (res && res.ok) {
          window.toast('Quick Update applied. The launcher exe was not replaced.', 'ok')
          banner.remove()
        } else {
          window.toast((res && (res.error || res.message)) || 'Quick Update failed', 'error')
          quickBtn.disabled = false
          quickBtn.textContent = 'Quick Update'
        }
      } catch (e) {
        window.toast(e.message, 'error')
        quickBtn.disabled = false
        quickBtn.textContent = 'Quick Update'
      }
    })
  }

  const launchBtn = banner.querySelector('.ub-btn-update')
  if (launchBtn) {
    launchBtn.addEventListener('click', async () => {
      launchBtn.disabled = true
      launchBtn.textContent = 'Updating\u2026'
      try {
        const res = await window.api.installUpdate({})
        if (!res || !res.ok) {
          if (res && res.reason === 'dev-mode') {
            window.toast('Launcher Update skipped — destage from src/ in this checkout.', 'info')
          } else {
            window.toast((res && res.error) ? res.error : 'Unknown error', 'error')
          }
          launchBtn.disabled = false
          launchBtn.textContent = 'Launcher Update'
          return
        }
      } catch (e) {
        window.toast('Update failed: ' + e.message, 'error')
        launchBtn.disabled = false
        launchBtn.textContent = 'Launcher Update'
      }
    })
  }

  banner.querySelector('.ub-btn-dismiss').addEventListener('click', () => {
    banner.remove()
    updateBannerDismissed = true
  })
}

function toastHqBlocked(result) {
  if (!result || !result.hqBlocked) return false
  const msg = result.error || result.message ||
    'Not on FirstbaseHQ. GitHub updates and share ISOs are blocked off-site.'
  window.toast(msg, 'error', 8000)
  return true
}

async function checkForUpdate() {
  try {
    const result = await window.api.checkForUpdate()
    if (toastHqBlocked(result)) return
    if (result && (result.launcherUpdateAvailable || result.payloadUpdateAvailable) && !updateBannerDismissed) {
      pendingUpdateInfo = result
      showUpdateBanner(result)
    }
  } catch (_) {}
}

// ─── Startup blocking update check ───────────────────────────────────────────
async function runStartupUpdateCheck() {
  const overlay = document.createElement('div')
  overlay.id = 'startup-check-overlay'
  overlay.style.cssText = [
    'position:fixed', 'inset:0', 'z-index:99999',
    'background:rgba(1,3,8,.97)',
    'display:flex', 'flex-direction:column',
    'align-items:center', 'justify-content:center',
    'gap:1rem', 'font-family:inherit'
  ].join(';')
  overlay.innerHTML = `
    <div class="spin" style="width:28px;height:28px;border-width:3px"></div>
    <p style="color:var(--t2);font-size:.9rem;margin:0">Checking for updates...</p>
    <div class="loading-bar" style="width:220px;margin-top:.25rem"></div>
  `
  document.body.appendChild(overlay)

  let result = null
  try {
    result = await Promise.race([
      window.api.checkForUpdate(),
      new Promise(res => setTimeout(() => res(null), 8000))
    ])
  } catch (_) {}

  overlay.remove()
  if (toastHqBlocked(result)) return
  // Never block the app for payload/script updates. Launcher updates are offered
  // on the banner — they are not applied as a side effect of Quick Update.
  if (result && (result.launcherUpdateAvailable || result.payloadUpdateAvailable) && !updateBannerDismissed) {
    pendingUpdateInfo = result
    showUpdateBanner(result)
  }
}

// ─── MDM / Intune USB policy warning ──────────────────────────────────────────
function showUsbPolicyModal(reasons) {
  const overlay = document.createElement('div')
  overlay.className = 'modal-overlay'
  overlay.id = 'usb-policy-modal-overlay'
  const reasonItems = (reasons && reasons.length)
    ? reasons.map(r => `<li>${r}</li>`).join('')
    : '<li>A device management policy is restricting removable storage.</li>'
  overlay.innerHTML = `
    <div class="modal">
      <h3>&#9888; USB Access Restricted</h3>
      <div class="modal-warn">
        This device appears to have an organization management policy (MDM/Intune or Group Policy)
        that blocks or restricts USB removable storage:
        <ul style="margin:.6rem 0 0 1.1rem;padding:0">${reasonItems}</ul>
        <br>The launcher may not be able to see or build to USB drives on this device.
        Contact Joshua Meadors if you need this resolved.
      </div>
      <div class="modal-actions">
        <button class="btn" id="usb-policy-modal-ok">Understood</button>
      </div>
    </div>
  `
  document.body.appendChild(overlay)
  requestAnimationFrame(() => overlay.classList.add('open'))

  const closeModal = () => {
    overlay.classList.remove('open')
    setTimeout(() => overlay.remove(), 250)
  }
  overlay.querySelector('#usb-policy-modal-ok').addEventListener('click', closeModal)
  overlay.addEventListener('click', (e) => { if (e.target === overlay) closeModal() })
}

async function runStartupUsbPolicyCheck() {
  try {
    const result = await Promise.race([
      window.api.checkUsbPolicy(),
      new Promise(res => setTimeout(() => res(null), 8000))
    ])
    if (result && result.blocked) {
      showUsbPolicyModal(result.reasons)
    }
  } catch (_) {}
}

// ─── Init ─────────────────────────────────────────────────────────────────────
window.addEventListener('hashchange', renderPage)

// Polls until the tutorial object is ready, then starts it.
// Called after the initial renderPage() resolves so the page DOM exists first.
function maybeStartTutorial() {
  if (!tutorial.shouldShow()) return
  let attempts = 0
  const poll = setInterval(() => {
    attempts++
    if (window.__tutorial && typeof window.__tutorial.start === 'function') {
      clearInterval(poll)
      setTimeout(() => window.__tutorial.start(), 2000)
    } else if (attempts > 20) {
      clearInterval(poll) // give up after ~2 s
    }
  }, 100)
}

document.addEventListener('DOMContentLoaded', async () => {
  applyTheme(getLwSettings().theme || 'dark')
  await initVersion()
  // Sync the persisted Local Build Mode flag to main.js BEFORE any share-touching
  // startup call runs, so a fully-local dev session never reaches the network,
  // not even for the update check that happens next.
  try { await window.api.setLocalBuild(getLwDevFlag('localBuild') === 'true') } catch (_) {}
  await runStartupUpdateCheck()
  await renderPage()
  runStartupUsbPolicyCheck()

  // Wire up gear icon → settings modal
  const navSettingsBtn = document.getElementById('nav-settings-btn')
  if (navSettingsBtn) {
    navSettingsBtn.addEventListener('click', () => settingsModal.toggle())
  }

  // Show tutorial on first launch (after update check and initial page render)
  maybeStartTutorial()

  // Inject a clickable "Dev Log" badge in the bottom-right corner when running
  // in dev mode (npm start). Clicking it opens the log file in Notepad.
  try {
    const devInfo = await window.api.getDevInfo()
    if (devInfo && !devInfo.isPackaged) {
      const badge = document.createElement('div')
      badge.id = 'dev-log-badge'
      badge.title = devInfo.devLogPath || 'Dev log'
      badge.textContent = 'Dev Log'
      badge.style.cssText = [
        'position:fixed', 'bottom:8px', 'right:12px',
        'font-size:.68rem', 'font-family:monospace',
        'color:#22d3ee', 'opacity:.5', 'cursor:pointer',
        'z-index:9999', 'padding:2px 7px',
        'border:1px solid rgba(34,211,238,.25)', 'border-radius:3px',
        'background:rgba(1,3,8,.75)', 'user-select:none',
        'transition:opacity .15s'
      ].join(';')
      badge.addEventListener('click', () => window.api.openDevLog())
      badge.addEventListener('mouseenter', () => { badge.style.opacity = '1' })
      badge.addEventListener('mouseleave', () => { badge.style.opacity = '.5' })
      document.body.appendChild(badge)
    }
  } catch (_) {}

})

// Expose navigate globally so page modules can call it
window.navigate = navigate
