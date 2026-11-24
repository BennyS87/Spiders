// Spiders - preload bridge (safe, minimal API for the renderer)
const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('spidersNative', {
  platform: process.platform,
  saveFile: (opts) => ipcRenderer.invoke('save-file', opts),
  openFile: (opts) => ipcRenderer.invoke('open-file', opts),
  openAudio: () => ipcRenderer.invoke('open-audio'),
  chooseFolder: (opts) => ipcRenderer.invoke('choose-folder', opts || {}),
  writeInFolder: (opts) => ipcRenderer.invoke('write-in-folder', opts),
  confirm: (opts) => ipcRenderer.invoke('confirm', opts),
  setDirty: (d) => ipcRenderer.send('set-dirty', d),
  setTitle: (t) => ipcRenderer.send('set-title', t),
  closeNow: () => ipcRenderer.send('close-now'),
  reveal: (p) => ipcRenderer.send('reveal', p),
  onMenu: (cb) => ipcRenderer.on('menu', (_e, cmd) => cb(cmd)),
  onOpenProject: (cb) => ipcRenderer.on('open-project', (_e, payload) => cb(payload))
});
