'use strict'

// USB Builder default: Full Rebuild vs Quick Update (overlay).
// Image dates come from the share ISO (stick stamp vs current ISO LastWrite).
// Script/payload version is independent: a newer payload never requires a rebuild.

function parseImageDateYmd (value) {
  if (value == null) return null
  const raw = String(value).trim()
  if (!raw) return null
  const iso = raw.match(/^(\d{4})-(\d{2})-(\d{2})/)
  if (iso) {
    const n = Number(iso[1] + iso[2] + iso[3])
    return Number.isFinite(n) ? n : null
  }
  const digits = raw.replace(/[^0-9]/g, '')
  if (digits.length >= 8) {
    const n = Number(digits.slice(0, 8))
    return Number.isFinite(n) ? n : null
  }
  return null
}

function stickImageIsOlder (stickImageDate, currentImageDate) {
  const stick = parseImageDateYmd(stickImageDate)
  const current = parseImageDateYmd(currentImageDate)
  if (stick == null || current == null) return false
  return stick < current
}

/**
 * @param {object} opts
 * @param {boolean} [opts.isLoneWolfDisk]
 * @param {boolean} [opts.usesSourcePicker] Media Creator / vendor ISO: no overlay path
 * @param {string} [opts.stickImageDate]
 * @param {string} [opts.currentImageDate]
 * @returns {{ mode: 'full'|'overlay', overlayAllowed: boolean, imageOlder: boolean }}
 */
function recommendUsbBuildMode (opts) {
  const o = opts || {}
  if (o.usesSourcePicker) {
    return { mode: 'full', overlayAllowed: false, imageOlder: false }
  }
  if (!o.isLoneWolfDisk) {
    return { mode: 'full', overlayAllowed: false, imageOlder: false }
  }
  const imageOlder = stickImageIsOlder(o.stickImageDate, o.currentImageDate)
  return {
    mode: imageOlder ? 'full' : 'overlay',
    overlayAllowed: true,
    imageOlder
  }
}

const api = { parseImageDateYmd, stickImageIsOlder, recommendUsbBuildMode }
if (typeof module === 'object' && module.exports) {
  module.exports = api
}
if (typeof window !== 'undefined') {
  window.LoneWolfRecommendUsbBuildMode = recommendUsbBuildMode
  window.LoneWolfStickImageIsOlder = stickImageIsOlder
}
