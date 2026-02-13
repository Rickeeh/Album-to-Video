// preload.js
const { contextBridge, ipcRenderer } = require('electron');

function payloadKeys(payload) {
  if (!payload || typeof payload !== 'object' || Array.isArray(payload)) return [];
  return Object.keys(payload);
}

async function invokeWithDebug(name, payload) {
  try {
    return await ipcRenderer.invoke(name, payload);
  } catch (err) {
    console.error('[IPC_INVOKE_FAILED]', {
      name,
      payloadKeys: payloadKeys(payload),
      stack: String(err?.stack || err),
    });
    throw err;
  }
}

contextBridge.exposeInMainWorld('api', {
  selectAudios: () => invokeWithDebug('select-audios'),
  selectImage: () => invokeWithDebug('select-image'),
  selectFolder: () => invokeWithDebug('select-folder'),

  ensureDir: (payload) => invokeWithDebug('ensure-dir', payload),
  openFolder: (folderPath) => invokeWithDebug('open-folder', folderPath),

  readMetadata: (filePath) => invokeWithDebug('read-metadata', filePath),
  probeAudio: (filePath) => invokeWithDebug('probe-audio', filePath),
  listPresets: () => invokeWithDebug('list-presets'),
  dpiProbe: (payload) => invokeWithDebug('dpi-probe', payload),
  perfMark: (mark) => ipcRenderer.send('perf-mark', { mark }),

  renderAlbum: (payload) => invokeWithDebug('render-album', payload),
  cancelRender: () => invokeWithDebug('cancel-render'),
  exportDiagnostics: (payload) => invokeWithDebug('export-diagnostics', payload),

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
