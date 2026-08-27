'use strict'

// User-facing Smart App Control / SmartScreen help. Keep ASCII (no em dashes).

const TITLE = 'Windows blocked an unsigned LoneWolf file'

const ASCII = [
  'Why this started happening',
  'Install and update now download unsigned Windows programs from GitHub',
  '(raw bin/LoneWolf-Launcher.exe and the unversioned Setup). Smart App Control',
  'treats those as untrusted, so it can block Setup and the portable exe even',
  'when that did not happen before. Signing the files (Azure code signing, about',
  '$10/month) is the real fix. Do not turn off Microsoft Defender.',
  '',
  '1. Check Smart App Control mode first',
  '   Open Windows Security -> App & browser control -> Smart App Control.',
  '   That is the usual Windows 11 path.',
  '',
  '2. If the mode is Evaluation',
  '   You can usually turn Smart App Control Off from that page.',
  '',
  '3. If the mode is On (enforcement)',
  '   Off is often greyed out. Microsoft commonly requires a PC reset to turn it',
  '   off. This app cannot promise a one-click Off. If Off is unavailable, do not',
  '   hunt for a hidden switch. Use More info -> Run anyway on the block dialog',
  '   if Windows still offers it, or SmartScreen "Run anyway" when that dialog',
  '   appears instead.',
  '',
  '4. SmartScreen (separate from Smart App Control)',
  '   "Windows protected your PC" -> More info -> Run anyway, only if you trust',
  '   this installer. That does not disable Defender.',
  '',
  'Do not disable Windows Defender / Microsoft Defender Antivirus to get past this.'
].join('\n')

const HTML = `
  <p><strong>Why this started happening.</strong> Install and update now download
  <strong>unsigned</strong> Windows programs from GitHub (the portable
  <code>bin/LoneWolf-Launcher.exe</code> and the unversioned Setup). Smart App Control
  treats those as untrusted, so it can block Setup and the portable exe even when that
  did not happen before. Code signing (Azure, about $10/month) is the real fix.
  Do not turn off Microsoft Defender.</p>
  <ol>
    <li><strong>Check the mode first.</strong> Open
      <strong>Windows Security &rarr; App &amp; browser control &rarr; Smart App Control</strong>
      (usual Windows 11 path).</li>
    <li><strong>Evaluation:</strong> you can usually turn Smart App Control
      <strong>Off</strong> on that page.</li>
    <li><strong>On (enforcement):</strong> Off is often greyed out. Microsoft commonly
      requires a <strong>PC reset</strong> to turn it off. If Off is unavailable, that
      is expected. Use <strong>More info &rarr; Run anyway</strong> on the block dialog
      if Windows still offers it, or SmartScreen <strong>Run anyway</strong> when that
      is the dialog you see.</li>
    <li><strong>SmartScreen</strong> (&ldquo;Windows protected your PC&rdquo;) is separate.
      More info &rarr; Run anyway only if you trust this installer.</li>
  </ol>
  <p>Do <strong>not</strong> disable Windows Defender / Microsoft Defender Antivirus.</p>
`

function looksLikeBlockedDownload (msg) {
  const s = String(msg || '')
  if (!s) return false
  return /smart\s*app\s*control|smartscreen|wdac|app control|untrusted|could not be downloaded|the request was aborted|could not create ssl|winhttp|0x80072ee7|0x80070005|blocked by|virus|threat|unauthorized|403|webexception|i\/o error|being used by another process|operation was cancelled/i.test(s)
}

const api = { TITLE, ASCII, HTML, looksLikeBlockedDownload }

if (typeof module === 'object' && module.exports) {
  module.exports = api
}
if (typeof window !== 'undefined') {
  window.LoneWolfSmartAppControlGuide = api
}
