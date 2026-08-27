'use strict'

const assert = require('assert')
const { evaluateHqNetwork, isHqLanHostIpv4, HQ_BLOCKED_MESSAGE } = require('../src/launcher/hqNetworkGuard')

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

failed += check('ethernet /22 host 192.168.92.37 passes without SSID', () => {
  const r = evaluateHqNetwork({
    ssid: '',
    ipv4: ['192.168.92.37'],
    gateways: ['192.168.94.1']
  })
  assert.strictEqual(r.ok, true)
  assert.strictEqual(r.ssidOk, false)
  assert.strictEqual(r.ethernetOk, true)
  assert.strictEqual(r.hostOk, true)
  assert.strictEqual(r.gwOk, true)
})

failed += check('ethernet gateway 192.168.94.1 passes without host 94/92 match', () => {
  const r = evaluateHqNetwork({
    ssid: '',
    ipv4: ['10.1.2.3'],
    gateways: ['192.168.94.1']
  })
  assert.strictEqual(r.ok, true)
  assert.strictEqual(r.ethernetOk, true)
  assert.strictEqual(r.gwOk, true)
})

failed += check('192.168.94.50/24 host passes without SSID', () => {
  const r = evaluateHqNetwork({ ssid: '', ipv4: ['192.168.94.50'], gateways: [] })
  assert.strictEqual(r.ok, true)
  assert.strictEqual(r.hostOk, true)
})

failed += check('wifi SSID FirstbaseHQ passes without ethernet IP', () => {
  const r = evaluateHqNetwork({ ssid: 'FirstbaseHQ', ipv4: ['10.0.0.8'], gateways: ['10.0.0.1'] })
  assert.strictEqual(r.ok, true)
  assert.strictEqual(r.ssidOk, true)
})

failed += check('wifi SSID firstbasehq is case-insensitive', () => {
  const r = evaluateHqNetwork({ ssid: 'firstbasehq', ipv4: [], gateways: [] })
  assert.strictEqual(r.ok, true)
})

failed += check('off-site home wifi fails closed', () => {
  const r = evaluateHqNetwork({
    ssid: 'HomeNet',
    ipv4: ['192.168.1.20'],
    gateways: ['192.168.1.1']
  })
  assert.strictEqual(r.ok, false)
  assert.strictEqual(r.message, HQ_BLOCKED_MESSAGE)
  assert.ok(!r.message.includes('\u2014'))
})

failed += check('random internet 8.8.8.8 host fails', () => {
  const r = evaluateHqNetwork({ ssid: '', ipv4: ['8.8.8.8'], gateways: ['1.1.1.1'] })
  assert.strictEqual(r.ok, false)
})

failed += check('92.0/22 includes 192.168.93.10 and excludes 192.168.96.1', () => {
  assert.strictEqual(isHqLanHostIpv4('192.168.93.10'), true)
  assert.strictEqual(isHqLanHostIpv4('192.168.95.254'), true)
  assert.strictEqual(isHqLanHostIpv4('192.168.96.1'), false)
  assert.strictEqual(isHqLanHostIpv4('192.168.91.1'), false)
})

process.exit(failed > 0 ? 1 : 0)
