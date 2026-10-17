'use strict';

const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('snapHost', {
  // --- overlay ---
  ready: () => ipcRenderer.invoke('snap:ready'),
  firstFrame: () => ipcRenderer.send('snap:first-frame'),
  copy: (dataURL) => ipcRenderer.invoke('snap:copy', dataURL),
  save: (dataURL) => ipcRenderer.invoke('snap:save', dataURL),
  pin: (dataURL, at) => ipcRenderer.invoke('snap:pin', { dataURL, at }),
  cancel: () => ipcRenderer.invoke('snap:cancel'),
  claim: () => ipcRenderer.invoke('snap:claim'),
  release: () => ipcRenderer.invoke('snap:release'),
  hit: (x, y) => ipcRenderer.invoke('snap:hit', { x, y }),
  axTrusted: () => ipcRenderer.invoke('snap:ax-trusted'),
  openPermission: (which) => ipcRenderer.invoke('snap:open-permission', which),
  help: (reason) => ipcRenderer.invoke('snap:help', reason),
  capture: () => ipcRenderer.invoke('snap:capture'),
  log: (msg) => ipcRenderer.send('snap:log', msg),
  onOwner: (cb) => ipcRenderer.on('snap:owner', (_e, id) => cb(id)),

  // --- help window ---
  onHelpInit: (cb) => ipcRenderer.on('snap:help-init', (_e, data) => cb(data)),
  getSettings: () => ipcRenderer.invoke('snap:get-settings'),
  setSetting: (key, value) => ipcRenderer.invoke('snap:set-setting', { key, value }),
  openLoginItems: () => ipcRenderer.invoke('snap:open-login-items'),

  // --- api window ---
  apiSend: (spec) => ipcRenderer.invoke('snap:api-send', spec),

  // --- pin window ---
  onPinInit: (cb) => ipcRenderer.on('snap:pin-init', (_e, data) => cb(data)),
  pinClose: () => ipcRenderer.send('snap:pin-close'),
  pinZoom: (factor) => ipcRenderer.send('snap:pin-zoom', factor),
  pinOpacity: (delta) => ipcRenderer.send('snap:pin-opacity', delta),
  pinMenu: (dataURL) => ipcRenderer.send('snap:pin-menu', dataURL),
  pinCopy: (dataURL) => ipcRenderer.send('snap:pin-copy', dataURL),
  pinSave: (dataURL) => ipcRenderer.send('snap:pin-save', dataURL),
  pinDragStart: () => ipcRenderer.invoke('snap:pin-drag-start'),
  pinDragTo: (x, y) => ipcRenderer.send('snap:pin-drag-to', { x, y }),
});
