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
  workspace: {
    pick: () => ipcRenderer.invoke('workspace-pick'),
    open: (dir) => ipcRenderer.invoke('workspace-open', dir),
    list: (dir) => ipcRenderer.invoke('workspace-list', dir),
    read: (path) => ipcRenderer.invoke('workspace-read', path),
    create: (dir, name, text) => ipcRenderer.invoke('workspace-create', { dir, name, text }),
    rename: (path, name) => ipcRenderer.invoke('workspace-rename', { path, name }),
    trash: (path) => ipcRenderer.invoke('workspace-trash', path),
    reveal: (path) => ipcRenderer.invoke('workspace-reveal', path),
  },
  github: {
    signIn: (clientId) => ipcRenderer.invoke('github-sign-in', clientId),
    cancel: () => ipcRenderer.invoke('github-cancel'),
    token: () => ipcRenderer.invoke('github-token'),
    signOut: () => ipcRenderer.invoke('github-sign-out'),
    onCode: (cb) => {
      const h = (_e, c) => cb(c);
      ipcRenderer.on('github-code', h);
      return () => ipcRenderer.removeListener('github-code', h);
    },
  },
  onMenu: (cb) => {
    const h = (_e, channel) => cb(channel);
    ipcRenderer.on('menu', h);
    return () => ipcRenderer.removeListener('menu', h);
  },
});
