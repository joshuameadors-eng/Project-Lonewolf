'use strict'

const assert = require('assert')
const {
  recommendUsbBuildMode,
  stickImageIsOlder,
  parseImageDateYmd
} = require('../src/launcher/recommendUsbBuildMode')

function check (name, fn) {
  try {
    fn()
    console.log('PASS  ' + name)
    return 0
  } catch (e) {
    console.log('FAIL  ' + name + ': ' + e.message)
    return 1
  }
}

let failed = 0

failed += check('script-only (same image date) defaults to Quick Update', () => {
  const r = recommendUsbBuildMode({
    isLoneWolfDisk: true,
    stickImageDate: '2026-06-18',
    currentImageDate: '2026-06-18'
  })
  assert.strictEqual(r.mode, 'overlay')
  assert.strictEqual(r.overlayAllowed, true)
  assert.strictEqual(r.imageOlder, false)
})

failed += check('newer stick image still defaults to Quick Update', () => {
  const r = recommendUsbBuildMode({
    isLoneWolfDisk: true,
    stickImageDate: '2026-08-01',
    currentImageDate: '2026-06-18'
  })
  assert.strictEqual(r.mode, 'overlay')
  assert.strictEqual(r.overlayAllowed, true)
})

failed += check('older stick image defaults Full Rebuild but Quick Update stays allowed', () => {
  const r = recommendUsbBuildMode({
    isLoneWolfDisk: true,
    stickImageDate: '2026-05-01',
    currentImageDate: '2026-06-18'
  })
  assert.strictEqual(r.mode, 'full')
  assert.strictEqual(r.overlayAllowed, true)
  assert.strictEqual(r.imageOlder, true)
})

failed += check('ISO timestamp strings compare on calendar date only', () => {
  assert.strictEqual(stickImageIsOlder('2026-06-17T23:00:00Z', '2026-06-18'), true)
  assert.strictEqual(parseImageDateYmd('20260618'), 20260618)
})

failed += check('missing stick date does not force rebuild (legacy stamps)', () => {
  const r = recommendUsbBuildMode({
    isLoneWolfDisk: true,
    stickImageDate: '',
    currentImageDate: '2026-06-18'
  })
  assert.strictEqual(r.mode, 'overlay')
  assert.strictEqual(r.overlayAllowed, true)
  assert.strictEqual(r.imageOlder, false)
})

failed += check('non-LoneWolf and Media Creator cannot Quick Update', () => {
  const fresh = recommendUsbBuildMode({ isLoneWolfDisk: false, currentImageDate: '2026-06-18' })
  assert.strictEqual(fresh.mode, 'full')
  assert.strictEqual(fresh.overlayAllowed, false)
  const media = recommendUsbBuildMode({
    isLoneWolfDisk: true,
    usesSourcePicker: true,
    stickImageDate: '2026-06-18',
    currentImageDate: '2026-06-18'
  })
  assert.strictEqual(media.mode, 'full')
  assert.strictEqual(media.overlayAllowed, false)
})

if (failed) process.exit(1)
console.log('recommendUsbBuildMode: all checks passed')
process.exit(0)
