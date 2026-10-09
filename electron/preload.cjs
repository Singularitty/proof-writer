const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('desktop', {
  platform: process.platform,
  openDocument: () => ipcRenderer.invoke('open-document'),
  pendingOpen: () => ipcRenderer.invoke('pending-open'),
  saveDocument: (path, text, suggestedName) => ipcRenderer.invoke('save-document', { path, text, suggestedName }),
  saveFile: (suggestedName, data, filters) => ipcRenderer.invoke('save-file', { suggestedName, data, filters }),
  openPdf: (name, data) => ipcRenderer.invoke('open-pdf', { name, data }),
  watchDocument: (path) => ipcRenderer.invoke('watch-document', path),
  onDocumentChanged: (cb) => {
    const h = (_e, f) => cb(f);
    ipcRenderer.on('document-changed', h);
    return () => ipcRenderer.removeListener('document-changed', h);
  },
  onMenu: (cb) => {
    const h = (_e, channel) => cb(channel);
    ipcRenderer.on('menu', h);
    return () => ipcRenderer.removeListener('menu', h);
  },
});
