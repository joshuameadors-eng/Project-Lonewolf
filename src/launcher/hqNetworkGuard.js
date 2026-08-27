'use strict'

// FirstbaseHQ gate for launcher GitHub updates and UNC share ISO list/copy.
// Pure functions so e2e can evaluate snapshots without live NICs.

const HQ_SSID = 'firstbasehq'
const HQ_GATEWAY = '192.168.94.1'
const HQ_BLOCKED_MESSAGE =
  'Not on FirstbaseHQ. Connect to Wi-Fi SSID FirstbaseHQ, or use a wired HQ LAN ' +
  '(IPv4 192.168.94.0/24 or 192.168.92.0/22, or gateway 192.168.94.1). ' +
  'GitHub updates and share ISOs are blocked off-site.'

function parseIpv4 (ip) {
  const m = String(ip || '').trim().match(/^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/)
  if (!m) return null
  const oct = [Number(m[1]), Number(m[2]), Number(m[3]), Number(m[4])]
  if (oct.some((n) => n > 255)) return null
  return ((oct[0] << 24) >>> 0) + (oct[1] << 16) + (oct[2] << 8) + oct[3]
}

function inPrefix (ip, network, prefixLen) {
  const addr = parseIpv4(ip)
  const net = parseIpv4(network)
  if (addr == null || net == null) return false
  const mask = prefixLen === 0 ? 0 : ((0xFFFFFFFF << (32 - prefixLen)) >>> 0)
  return (addr & mask) === (net & mask)
}

function isHqLanHostIpv4 (ip) {
  return inPrefix(ip, '192.168.94.0', 24) || inPrefix(ip, '192.168.92.0', 22)
}

function evaluateHqNetwork (snapshot) {
  const snap = snapshot || {}
  const ssid = String(snap.ssid || '').trim()
  const ssidOk = ssid.toLowerCase() === HQ_SSID
  const ipv4 = [].concat(snap.ipv4 || [])
  const gateways = [].concat(snap.gateways || [])
  const hostOk = ipv4.some(isHqLanHostIpv4)
  const gwOk = gateways.some((g) => String(g).trim() === HQ_GATEWAY)
  const ethernetOk = hostOk || gwOk
  const ok = ssidOk || ethernetOk
  return {
    ok,
    ssidOk,
    ethernetOk,
    hostOk,
    gwOk,
    ssid,
    message: ok
      ? (ssidOk ? 'On Wi-Fi FirstbaseHQ.' : 'On wired HQ LAN.')
      : HQ_BLOCKED_MESSAGE
  }
}

module.exports = {
  HQ_SSID,
  HQ_GATEWAY,
  HQ_BLOCKED_MESSAGE,
  parseIpv4,
  inPrefix,
  isHqLanHostIpv4,
  evaluateHqNetwork
}
