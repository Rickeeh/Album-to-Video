// preload.js
const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('api', {
  selectAudios: () => ipcRenderer.invoke('select-audios'),
  selectImage: () => ipcRenderer.invoke('select-image'),
  selectFolder: () => ipcRenderer.invoke('select-folder'),

  ensureDir: (dirPath) => ipcRenderer.invoke('ensure-dir', dirPath),
  openFolder: (folderPath) => ipcRenderer.invoke('open-folder', folderPath),

  readMetadata: (filePath) => ipcRenderer.invoke('read-metadata', filePath),
  probeAudio: (filePath) => ipcRenderer.invoke('probe-audio', filePath),
  listPresets: () => ipcRenderer.invoke('list-presets'),

  renderAlbum: (payload) => ipcRenderer.invoke('render-album', payload),
  cancelRender: () => ipcRenderer.invoke('cancel-render'),

  onRenderProgress: (handler) => {
    const listener = (_evt, data) => handler(data);
    ipcRenderer.on('render-progress', listener);
    return () => ipcRenderer.off('render-progress', listener);
  },
  onRenderStatus: (handler) => {
    const listener = (_evt, data) => handler(data);
    ipcRenderer.on('render-status', listener);
    return () => ipcRenderer.off('render-status', listener);
  },
});
