// Electron shell for Proof Writer: serves the Vite build from an app:// origin
// (file:// breaks module workers and wasm fetches) and exposes native file dialogs.
const { app, BrowserWindow, Menu, dialog, ipcMain, protocol, shell, net } = require('electron');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { pathToFileURL } = require('node:url');
const { watchFile } = require('./watch.cjs');

const DIST = path.join(__dirname, '..', 'dist');

protocol.registerSchemesAsPrivileged([
  { scheme: 'app', privileges: { standard: true, secure: true, supportFetchAPI: true, stream: true } },
]);

function serveDist() {
  protocol.handle('app', (req) => {
    const { pathname } = new URL(req.url);
    const file = path.normalize(path.join(DIST, decodeURIComponent(pathname)));
    if (!file.startsWith(DIST)) return new Response('Forbidden', { status: 403 });
    return net.fetch(pathToFileURL(file).toString());
  });
}

const JSON_FILTERS = [{ name: 'Proof Writer document', extensions: ['json'] }];
const OPEN_FILTERS = [{ name: 'Proof Writer document or Typst file', extensions: ['json', 'typ'] }, ...JSON_FILTERS, { name: 'Typst (import)', extensions: ['typ'] }];

function createWindow(fileToOpen) {
  const win = new BrowserWindow({
    width: 1500,
    height: 950,
    title: 'Proof Writer',
    backgroundColor: '#1b1d22',
    webPreferences: {
      preload: path.join(__dirname, 'preload.cjs'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
    },
  });
  // Links (e.g. in the README or diagnostics) open in the system browser.
  win.webContents.setWindowOpenHandler(({ url }) => {
    if (/^https?:/.test(url)) shell.openExternal(url);
    return { action: 'deny' };
  });
  win.webContents.on('will-navigate', (e, url) => {
    if (!url.startsWith('app://')) { e.preventDefault(); if (/^https?:/.test(url)) shell.openExternal(url); }
  });
  if (fileToOpen) pendingOpen.set(win.webContents.id, fileToOpen);
  win.loadURL('app://-/index.html');
  return win;
}

// A .json passed on the command line (or via "Open with") is opened on load.
const pendingOpen = new Map();

ipcMain.handle('pending-open', async (e) => {
  const p = pendingOpen.get(e.sender.id);
  pendingOpen.delete(e.sender.id);
  if (!p) return null;
  return { path: p, text: await fs.readFile(p, 'utf8') };
});

ipcMain.handle('open-document', async (e) => {
  const win = BrowserWindow.fromWebContents(e.sender);
  const r = await dialog.showOpenDialog(win, { properties: ['openFile'], filters: OPEN_FILTERS });
  if (r.canceled || !r.filePaths[0]) return null;
  const p = r.filePaths[0];
  app.addRecentDocument(p);
  return { path: p, text: await fs.readFile(p, 'utf8') };
});

ipcMain.handle('save-document', async (e, { path: p, text, suggestedName }) => {
  if (!p) {
    const win = BrowserWindow.fromWebContents(e.sender);
    const r = await dialog.showSaveDialog(win, { defaultPath: suggestedName, filters: JSON_FILTERS });
    if (r.canceled || !r.filePath) return null;
    p = r.filePath;
  }
  const w = watchers.get(e.sender.id);
  if (w?.path === p) w.stop.known(text);
  await fs.writeFile(p, text, 'utf8');
  app.addRecentDocument(p);
  return p;
});

// Each window watches the file behind its open document, so an edit made
// outside the app (another program, a git pull) reaches the editor.
const watchers = new Map();

ipcMain.handle('watch-document', (e, p) => {
  const sender = e.sender;
  const id = sender.id;
  const current = watchers.get(id);
  if (current?.path === p) return;
  if (current) current.stop();
  else sender.once('destroyed', () => { watchers.get(id)?.stop(); watchers.delete(id); });
  watchers.delete(id);
  if (!p) return;
  try {
    const stop = watchFile(p, (text) => { if (!sender.isDestroyed()) sender.send('document-changed', { path: p, text }); });
    watchers.set(id, { path: p, stop });
  } catch { /* the folder is gone; nothing to watch */ }
});

ipcMain.handle('save-file', async (e, { suggestedName, data, filters }) => {
  const win = BrowserWindow.fromWebContents(e.sender);
  const r = await dialog.showSaveDialog(win, { defaultPath: suggestedName, filters });
  if (r.canceled || !r.filePath) return null;
  await fs.writeFile(r.filePath, typeof data === 'string' ? data : Buffer.from(data));
  return r.filePath;
});

// "Open PDF": write to a temp file and hand it to the system viewer.
ipcMain.handle('open-pdf', async (_e, { name, data }) => {
  const p = path.join(os.tmpdir(), `${name || 'document'}.pdf`);
  await fs.writeFile(p, Buffer.from(data));
  const err = await shell.openPath(p);
  if (err) throw new Error(err);
  return p;
});

function buildMenu() {
  const send = (channel) => () => BrowserWindow.getFocusedWindow()?.webContents.send('menu', channel);
  const isMac = process.platform === 'darwin';
  Menu.setApplicationMenu(Menu.buildFromTemplate([
    ...(isMac ? [{ role: 'appMenu' }] : []),
    {
      label: 'File',
      submenu: [
        { label: 'New Window', accelerator: 'CmdOrCtrl+Shift+N', click: () => createWindow() },
        { label: 'Open…', accelerator: 'CmdOrCtrl+O', click: send('open') },
        { type: 'separator' },
        { label: 'Save', accelerator: 'CmdOrCtrl+S', click: send('save') },
        { label: 'Save As…', accelerator: 'CmdOrCtrl+Shift+S', click: send('save-as') },
        { type: 'separator' },
        isMac ? { role: 'close' } : { role: 'quit' },
      ],
    },
    // Undo/redo stay with the app's own handlers, so the Edit menu only carries clipboard roles.
    { label: 'Edit', submenu: [{ role: 'cut' }, { role: 'copy' }, { role: 'paste' }, { role: 'selectAll' }] },
    { label: 'View', submenu: [{ role: 'reload' }, { role: 'toggleDevTools' }, { type: 'separator' }, { role: 'resetZoom' }, { role: 'zoomIn' }, { role: 'zoomOut' }, { type: 'separator' }, { role: 'togglefullscreen' }] },
    { role: 'windowMenu' },
  ]));
}

const argFile = process.argv.slice(app.isPackaged ? 1 : 2).find((a) => /\.(json|typ)$/.test(a));

let pendingArg = argFile ? path.resolve(argFile) : null;
app.on('open-file', (e, p) => { e.preventDefault(); if (app.isReady()) createWindow(p); else pendingArg = p; });

app.whenReady().then(() => {
  serveDist();
  buildMenu();
  createWindow(pendingArg);
  app.on('activate', () => { if (BrowserWindow.getAllWindows().length === 0) createWindow(); });
});

app.on('window-all-closed', () => { if (process.platform !== 'darwin') app.quit(); });
