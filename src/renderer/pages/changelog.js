/* Changelog page — timeline of version entries from bundled VERSION.json */
;(function () {

  function escHtml(s) {
    return String(s).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;')
  }

  function renderEntry(entry, isLatest) {
    const changes = Array.isArray(entry.changes) ? entry.changes : []
    const currentBadge = isLatest
      ? `<span class="cl-current-badge">Current</span>` : ''
    return `
      <div class="cl-entry">
        <div class="cl-entry-header">
          <span class="cl-version-badge">v${escHtml(String(entry.version || '?'))}</span>
          ${currentBadge}
          <span class="cl-date">${escHtml(String(entry.date || ''))}</span>
        </div>
        <ul class="cl-changes">
          ${changes.map(c => `<li>${escHtml(String(c))}</li>`).join('')}
        </ul>
      </div>
    `
  }

  function semverDesc(a, b) {
    const va = String(a.version || '').split('.').map(n => parseInt(n) || 0)
    const vb = String(b.version || '').split('.').map(n => parseInt(n) || 0)
    for (let i = 0; i < 3; i++) {
      const diff = (vb[i] || 0) - (va[i] || 0)
      if (diff !== 0) return diff
    }
    return 0
  }

  function init(rootEl, params, navigate) {
    const page = document.createElement('div')
    page.className = 'page'
    page.innerHTML = `
      <div class="wrap">
        <div style="margin-bottom:1.5rem">
          <button class="btn btn-ghost" id="cl-back-btn">&#8592; Back</button>
        </div>
        <div class="sl">Release History</div>
        <h2 class="sh">Changelog</h2>
        <p class="sd">Version history for Project LoneWolf Launcher and staging content.</p>
        <div id="cl-list">
          <div class="detect-spinner">
            <div class="spin"></div>
            <span>Loading changelog…</span>
          </div>
        </div>
      </div>
    `
    rootEl.appendChild(page)
    page.querySelector('#cl-back-btn').addEventListener('click', () => navigate('#home'))

    window.api.getChangelog().then(result => {
      const entries = [...(Array.isArray(result) ? result : [])].sort(semverDesc)
      const list = page.querySelector('#cl-list')
      if (!list) return
      if (entries.length === 0) {
        list.innerHTML = `<div class="empty-state">No changelog entries found. Make sure the app is connected to the network share.</div>`
      } else {
        list.innerHTML = `<div class="cl-timeline">${entries.map((e, i) => renderEntry(e, i === 0)).join('')}</div>`
      }
    }).catch(() => {
      const list = page.querySelector('#cl-list')
      if (list) list.innerHTML = `<div class="empty-state">Could not load changelog. Make sure the app is connected to the network share.</div>`
    })
  }

  window.__pages.changelog = { init }
})()
