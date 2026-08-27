'use strict'

const assert = require('assert')
const { ASCII, TITLE, looksLikeBlockedDownload } = require('../src/launcher/smartAppControlGuide')

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

failed += check('guide names Evaluation vs On and no Defender disable', () => {
  assert.ok(TITLE.includes('unsigned'))
  assert.ok(ASCII.includes('Evaluation'))
  assert.ok(ASCII.includes('On (enforcement)'))
  assert.ok(ASCII.includes('PC reset'))
  assert.ok(ASCII.includes('Windows Security'))
  assert.ok(ASCII.includes('App & browser control'))
  assert.ok(ASCII.includes('Smart App Control'))
  assert.ok(ASCII.includes('GitHub'))
  assert.ok(ASCII.includes('bin/LoneWolf-Launcher.exe'))
  assert.ok(/Do not (turn off|disable) Microsoft Defender/i.test(ASCII) || ASCII.includes('Do not disable Windows Defender'))
  assert.ok(!ASCII.includes('\u2014'))
  assert.ok(!ASCII.includes('\u2013'))
})

failed += check('blocked-download heuristic', () => {
  assert.strictEqual(looksLikeBlockedDownload('Smart App Control blocked this app'), true)
  assert.strictEqual(looksLikeBlockedDownload('Windows SmartScreen'), true)
  assert.strictEqual(looksLikeBlockedDownload('The request was aborted: Could not create SSL/TLS'), true)
  assert.strictEqual(looksLikeBlockedDownload('disk is full'), false)
})

process.exit(failed > 0 ? 1 : 0)
