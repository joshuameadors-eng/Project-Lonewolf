'use strict'

const assert = require('assert')
const fs = require('fs')
const os = require('os')
const path = require('path')
const {
  detectIsoMediaKindFromBuffer,
  looksLikeWindowsInstallerLayout,
  planIsoWriteMode
} = require('../src/launcher/isoMediaKind')

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

failed += check('hybrid: CD001 + MBR 55AA', () => {
  const buf = Buffer.alloc(0x8800, 0)
  buf[510] = 0x55
  buf[511] = 0xAA
  buf.write('CD001', 0x8001, 'ascii')
  const r = detectIsoMediaKindFromBuffer(buf)
  assert.strictEqual(r.iso9660, true)
  assert.strictEqual(r.mbr, true)
  assert.strictEqual(r.hybrid, true)
  assert.strictEqual(r.kind, 'hybrid-dd')
  assert.strictEqual(planIsoWriteMode(r, false).writeMode, 'hybrid-dd')
})

failed += check('hybrid: CD001 + GPT EFI PART', () => {
  const buf = Buffer.alloc(0x8800, 0)
  buf.write('EFI PART', 512, 'ascii')
  buf.write('CD001', 0x8001, 'ascii')
  const r = detectIsoMediaKindFromBuffer(buf)
  assert.strictEqual(r.gpt, true)
  assert.strictEqual(r.hybrid, true)
  assert.strictEqual(r.kind, 'hybrid-dd')
})

failed += check('Windows layout wins over hybrid header', () => {
  const buf = Buffer.alloc(0x8800, 0)
  buf[510] = 0x55
  buf[511] = 0xAA
  buf.write('CD001', 0x8001, 'ascii')
  const r = detectIsoMediaKindFromBuffer(buf)
  assert.strictEqual(planIsoWriteMode(r, true).writeMode, 'windows-extract')
})

failed += check('ISO 9660 without MBR/GPT is iso9660 then raw-dd', () => {
  const buf = Buffer.alloc(0x8800, 0)
  buf.write('CD001', 0x8001, 'ascii')
  const r = detectIsoMediaKindFromBuffer(buf)
  assert.strictEqual(r.kind, 'iso9660')
  assert.strictEqual(r.hybrid, false)
  assert.strictEqual(planIsoWriteMode(r, false).writeMode, 'raw-dd')
})

failed += check('empty buffer is unknown', () => {
  const r = detectIsoMediaKindFromBuffer(Buffer.alloc(64, 0))
  assert.strictEqual(r.kind, 'unknown')
  assert.strictEqual(r.iso9660, false)
})

failed += check('windows layout helper finds install.wim', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'lw-iso-'))
  try {
    fs.mkdirSync(path.join(dir, 'sources'))
    fs.writeFileSync(path.join(dir, 'sources', 'install.wim'), 'x')
    assert.strictEqual(looksLikeWindowsInstallerLayout(dir), true)
    assert.strictEqual(looksLikeWindowsInstallerLayout(path.join(dir, 'missing')), false)
  } finally {
    fs.rmSync(dir, { recursive: true, force: true })
  }
})

failed += check('windows layout helper finds install.esd', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'lw-iso-'))
  try {
    fs.mkdirSync(path.join(dir, 'sources'))
    fs.writeFileSync(path.join(dir, 'sources', 'install.esd'), 'x')
    assert.strictEqual(looksLikeWindowsInstallerLayout(dir), true)
  } finally {
    fs.rmSync(dir, { recursive: true, force: true })
  }
})

process.exit(failed > 0 ? 1 : 0)
