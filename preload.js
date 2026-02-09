// preload.js
const { contextBridge, ipcRenderer } = require('electron');
const { pathToFileURL } = require('url');
const path = require('path');

contextBridge.exposeInMainWorld('api', {
  selectAudios: () => ipcRenderer.invoke('select-audios'),
  selectImage: () => ipcRenderer.invoke('select-image'),
  selectFolder: () => ipcRenderer.invoke('select-folder'),

  ensureDir: (dirPath) => ipcRenderer.invoke('ensure-dir', dirPath),
  openFolder: (folderPath) => ipcRenderer.invoke('open-folder', folderPath),

  readMetadata: (filePath) => ipcRenderer.invoke('read-metadata', filePath),
  probeAudio: (filePath) => ipcRenderer.invoke('probe-audio', filePath),

  renderAlbum: (payload) => ipcRenderer.invoke('render-album', payload),
  cancelRender: () => ipcRenderer.invoke('cancel-render'),

  onRenderProgress: (handler) => {
    const listener = (_evt, data) => handler(data);
    ipcRenderer.on('render-progress', listener);
    return () => ipcRenderer.off('render-progress', listener);
  },

  fileUrl: (p) => pathToFileURL(p).toString(),
  pathBasename: (p) => path.basename(p),
  pathBasenameNoExt: (p) => path.parse(p).name,
  pathJoin: (...parts) => path.join(...parts),
});
