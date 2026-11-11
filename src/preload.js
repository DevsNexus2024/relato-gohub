'use strict';

const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('desk', {
  info: () => ipcRenderer.invoke('app:info'),
  switchTab: (id) => ipcRenderer.send('tab:switch', id),
  reload: () => ipcRenderer.send('tab:reload'),
  onTabState: (cb) => ipcRenderer.on('tab:state', (_e, s) => cb(s)),
  onActiveTab: (cb) => ipcRenderer.on('tab:active', (_e, id) => cb(id)),
  notes: {
    load: () => ipcRenderer.invoke('notes:load'),
    save: (data) => ipcRenderer.invoke('notes:save', data),
    saveSync: (data) => ipcRenderer.sendSync('notes:save-sync', data),
    exportAll: (data) => ipcRenderer.invoke('notes:export', data),
    importFile: () => ipcRenderer.invoke('notes:import'),
  },
});
