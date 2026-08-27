'use strict'

// Detect how Media Creator should write an ISO. Header-only: no USB, no DISM.
// hybrid-dd: ISO 9660 plus MBR (0x55AA) and/or GPT ("EFI PART") at the start
//   (isohybrid Linux and many "any OS" images).
// windows-layout: sources\install.wim / install.esd / install.swm on a mounted tree.
// iso9660 / unknown: caller should try raw dd after a Windows-layout miss.

const ISO9660_OFFSET = 0x8001
const MBR_SIG_OFF = 510
const GPT_OFFSET = 512

function asciiAt (buf, offset, len) {
  if (!buf || buf.length < offset + len) return ''
  let s = ''
  for (let i = 0; i < len; i++) {
    const c = buf[offset + i]
    if (c < 32 || c > 126) s += '.'
    else s += String.fromCharCode(c)
  }
  return s
}

function inspectIsoHeader (buf) {
  const iso9660 = asciiAt(buf, ISO9660_OFFSET, 5) === 'CD001'
  const mbr = !!(buf && buf.length > 511 && buf[MBR_SIG_OFF] === 0x55 && buf[MBR_SIG_OFF + 1] === 0xAA)
  const gpt = asciiAt(buf, GPT_OFFSET, 8) === 'EFI PART'
  const hybrid = iso9660 && (mbr || gpt)
  let kind = 'unknown'
  if (hybrid) kind = 'hybrid-dd'
  else if (iso9660) kind = 'iso9660'
  return { kind, iso9660, mbr, gpt, hybrid }
}

function detectIsoMediaKindFromBuffer (buf) {
  return inspectIsoHeader(buf)
}

function detectIsoMediaKindFromFile (filePath) {
  const fs = require('fs')
  const fd = fs.openSync(filePath, 'r')
  try {
    const buf = Buffer.alloc(0x8800)
    const n = fs.readSync(fd, buf, 0, buf.length, 0)
    return inspectIsoHeader(n < buf.length ? buf.subarray(0, n) : buf)
  } finally {
    fs.closeSync(fd)
  }
}

function looksLikeWindowsInstallerLayout (root) {
  const fs = require('fs')
  const path = require('path')
  if (!root) return false
  const sources = path.join(root, 'sources')
  const names = ['install.wim', 'install.esd', 'install.swm']
  for (const n of names) {
    try {
      if (fs.existsSync(path.join(sources, n))) return true
    } catch (_) {}
  }
  return false
}

function planIsoWriteMode (header, windowsLayout) {
  if (windowsLayout) {
    return {
      writeMode: 'windows-extract',
      note: 'Windows installer layout (sources\\install.wim/esd). FAT32 ESP + NTFS data.'
    }
  }
  if (header && header.hybrid) {
    return {
      writeMode: 'hybrid-dd',
      note: 'Hybrid ISO (ISO 9660 + MBR/GPT). Raw image write to the USB disk.'
    }
  }
  return {
    writeMode: 'raw-dd',
    note: 'Not a Windows installer layout. Raw image write to the USB disk.'
  }
}

const api = {
  inspectIsoHeader,
  detectIsoMediaKindFromBuffer,
  detectIsoMediaKindFromFile,
  looksLikeWindowsInstallerLayout,
  planIsoWriteMode
}

if (typeof module === 'object' && module.exports) {
  module.exports = api
}
if (typeof window !== 'undefined') {
  window.LoneWolfIsoMediaKind = api
}
