/* Splash page — wolf logo with glow animation */
;(function () {
  const SPLASH_DURATION = 2600

  async function init(root, _params, navigate) {
    let versionStr = 'Launcher'
    try {
      const v = await window.api.getVersion()
      if (v) versionStr = `Launcher v${v}`
      try {
        const packed = await window.api.getDevInfo()
        if (!(packed && packed.isPackaged)) {
          const st = await window.api.getVersionStatus()
          if (st && st.isDevBuild && !st.isPackaged && v) versionStr = `Launcher v${v} DEV`
        }
      } catch (_) {}
    } catch (_) {}

    const page = document.createElement('div')
    page.className = 'splash-page'
    page.innerHTML = `
      <div class="splash-logo-wrap">
        <div class="splash-glow"></div>
        <div class="splash-wolf-ring">
          <img src="assets/wolf-logo-base.png" alt="LoneWolf" class="splash-wolf-img-inner">
        </div>
      </div>
      <div>
        <div class="splash-title">Project <span>LoneWolf</span></div>
        <div class="splash-sub">${versionStr}</div>
      </div>
      <div class="splash-loader"><div class="splash-loader-bar"></div></div>
    `
    root.appendChild(page)

    // Navigate to home after SPLASH_DURATION
    const timer = setTimeout(() => {
      page.classList.add('fade-out')
      setTimeout(() => navigate('#home'), 580)
    }, SPLASH_DURATION)

    // Click-to-skip
    page.addEventListener('click', () => {
      clearTimeout(timer)
      page.classList.add('fade-out')
      setTimeout(() => navigate('#home'), 300)
    })

    return () => clearTimeout(timer)
  }

  window.__pages.splash = { init }
})()
