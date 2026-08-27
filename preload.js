const { contextBridge, ipcRenderer } = require('electron')

contextBridge.exposeInMainWorld('api', {
  getUsbDisks:       () => ipcRenderer.invoke('usb:detect'),
  checkUsbPolicy:    () => ipcRenderer.invoke('system:checkUsbPolicy'),
  registerShare:     () => ipcRenderer.invoke('share:register'),
  startBuild:        (params) => ipcRenderer.invoke('build:start', params),
  cancelBuild:       () => ipcRenderer.invoke('build:cancel'),
  startStaging:      (opts) => ipcRenderer.invoke('stage:start', opts),
  cancelStaging:     () => ipcRenderer.invoke('stage:cancel'),
  startPreCache:     (opts) => ipcRenderer.invoke('precache:start', opts),
  scanLocalSources:  () => ipcRenderer.invoke('sources:scanLocal'),
  cancelLocalScan:   () => ipcRenderer.invoke('sources:cancelLocalScan'),
  onLocalSourceFound: (cb) => ipcRenderer.on('sources:localFound', (_, p) => cb(p)),
  onLocalScanProgress: (cb) => ipcRenderer.on('sources:localProgress', (_, p) => cb(p)),
  onLocalScanDone:    (cb) => ipcRenderer.on('sources:localDone', (_, p) => cb(p)),
  offLocalScanEvents: () => {
    ipcRenderer.removeAllListeners('sources:localFound')
    ipcRenderer.removeAllListeners('sources:localProgress')
    ipcRenderer.removeAllListeners('sources:localDone')
  },
  scanShareSources:  (workflowType) => ipcRenderer.invoke('sources:scanShare', workflowType),
  analyzeSource:     (params) => ipcRenderer.invoke('sources:analyze', params),
  browseSource:      (opts) => ipcRenderer.invoke('sources:browse', opts),
  onBuildEvent:      (cb) => ipcRenderer.on('build:event', (_, ev) => cb(ev)),
  offBuildEvent:     () => ipcRenderer.removeAllListeners('build:event'),
  getVersion:        () => ipcRenderer.invoke('app:version'),
  getVersionStatus:  () => ipcRenderer.invoke('app:versionStatus'),
  getStagingVersion: (workflowType) => ipcRenderer.invoke('staging:version', workflowType),
  getChangelog:      () => ipcRenderer.invoke('changelog:get'),
  checkUpdate:       (params) => ipcRenderer.invoke('build:check-update', params),
  checkForUpdate:    () => ipcRenderer.invoke('update:check'),
  getHqStatus:       () => ipcRenderer.invoke('hq:status'),
  installUpdate:     (params) => ipcRenderer.invoke('update:install', params || {}),
  applyQuickUpdate:  () => ipcRenderer.invoke('update:quick'),
  onAutoUpdateCheck: (cb) => ipcRenderer.on('update:auto-check', cb),
  getDevInfo:        () => ipcRenderer.invoke('app:dev-info'),
  openDevLog:        () => ipcRenderer.invoke('log:open-dev-log'),
  notifyDiskComplete:  (info) => ipcRenderer.send('build:diskComplete', info),
  notifyStaleDrive:    (info) => ipcRenderer.send('usb:stale-drive', info),
  isDevMode:           () => ipcRenderer.invoke('app:isDevMode'),
  setLocalBuild:       (enabled) => ipcRenderer.invoke('dev:setLocalBuild', enabled),
  testNotification:    (type) => ipcRenderer.send('dev:testNotification', { type })
})

// Forward uncaught renderer errors to main so they are captured in the dev log
window.addEventListener('error', (e) => {
  ipcRenderer.send('log:renderer-error', {
    type: 'error',
    message: e.message,
    source: e.filename,
    lineno: e.lineno,
    colno: e.colno,
    stack: e.error && e.error.stack
  })
})

window.addEventListener('unhandledrejection', (e) => {
  ipcRenderer.send('log:renderer-error', {
    type: 'unhandledrejection',
    message: String(e.reason),
    stack: e.reason && e.reason.stack
  })
})
