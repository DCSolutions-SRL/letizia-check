const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('api', {
  selectCaptureDir: () => ipcRenderer.invoke('select-capture-dir'),
  botInit: (opts) => ipcRenderer.invoke('bot-init', opts),
  botStartSchedule: () => ipcRenderer.invoke('bot-start-schedule'),
  botStopSchedule: () => ipcRenderer.invoke('bot-stop-schedule'),
  botRunOnce: () => ipcRenderer.invoke('bot-run-once'),
  onStatus: (cb) => ipcRenderer.on('status', (_e, data) => cb(data)),
  onError: (cb) => ipcRenderer.on('error', (_e, data) => cb(data)),
  onSuccess: (cb) => ipcRenderer.on('success', (_e, data) => cb(data)),
  onMessage: (cb) => ipcRenderer.on('message', (_e, data) => cb(data)),
  onQr: (cb) => ipcRenderer.on('qr', (_e, data) => cb(data)),
});
