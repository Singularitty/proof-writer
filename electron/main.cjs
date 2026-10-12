// Electron shell for Proof Writer: serves the Vite build from an app:// origin
// (file:// breaks module workers and wasm fetches) and exposes native file dialogs.
const { app, BrowserWindow, Menu, dialog, ipcMain, protocol, shell, net } = require('electron');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { pathToFileURL } = require('node:url');
const { watchFile } = require('./watch.cjs');
const workspace = require('./workspace.cjs');
const lean = require('./lean.cjs');

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
  // The one window the app opens itself is the detached preview, which it fills in from this one.
  win.webContents.setWindowOpenHandler(({ url, frameName }) => {
    if (url === 'about:blank' && frameName === 'proof-writer-preview') {
      return { action: 'allow', overrideBrowserWindowOptions: { width: 820, height: 1000, title: 'Preview — Proof Writer', backgroundColor: '#1b1d22', autoHideMenuBar: true } };
    }
    if (/^https?:/.test(url)) shell.openExternal(url);
    return { action: 'deny' };
  });
  win.webContents.on('did-create-window', (child) => {
    previewOwner.set(child, win);
    child.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
    child.webContents.on('will-navigate', (e) => e.preventDefault());
    win.once('closed', () => { if (!child.isDestroyed()) child.close(); });
  });
  win.webContents.on('will-navigate', (e, url) => {
    if (!url.startsWith('app://')) { e.preventDefault(); if (/^https?:/.test(url)) shell.openExternal(url); }
  });
  if (fileToOpen) pendingOpen.set(win.webContents.id, fileToOpen);
  win.loadURL('app://-/index.html');
  return win;
}

/** The main window each detached preview belongs to; menu commands given to a preview go there. */
const previewOwner = new WeakMap();

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

// Answers with what the file holds now, so the window can tell whether its copy is behind.
ipcMain.handle('watch-document', async (e, p) => {
  const sender = e.sender;
  const id = sender.id;
  const current = watchers.get(id);
  if (current?.path === p) { try { return p ? await fs.readFile(p, 'utf8') : null; } catch { return null; } }
  if (current) current.stop();
  else sender.once('destroyed', () => { watchers.get(id)?.stop(); watchers.delete(id); });
  watchers.delete(id);
  if (!p) return null;
  try {
    const stop = watchFile(p, (text) => { if (!sender.isDestroyed()) sender.send('document-changed', { path: p, text }); });
    watchers.set(id, { path: p, stop });
    return stop.initial;
  } catch { return null; /* the folder is gone; nothing to watch */ }
});

ipcMain.handle('save-file', async (e, { suggestedName, data, filters }) => {
  const win = BrowserWindow.fromWebContents(e.sender);
  const r = await dialog.showSaveDialog(win, { defaultPath: suggestedName, filters });
  if (r.canceled || !r.filePath) return null;
  await fs.writeFile(r.filePath, typeof data === 'string' ? data : Buffer.from(data));
  return r.filePath;
});

// ---------- the folder a window works in ----------
// A window may list, read, create, rename and trash documents only inside the
// folder its user opened.
const roots = new Map();
const rootOf = (e) => roots.get(e.sender.id) ?? null;
function openFolder(e, dir) {
  const id = e.sender.id;
  if (!roots.has(id)) e.sender.once('destroyed', () => roots.delete(id));
  roots.set(id, dir);
  return workspace.listFolder(dir);
}

ipcMain.handle('workspace-pick', async (e) => {
  const win = BrowserWindow.fromWebContents(e.sender);
  const r = await dialog.showOpenDialog(win, { properties: ['openDirectory', 'createDirectory'], title: 'Open a folder of documents' });
  if (r.canceled || !r.filePaths[0]) return null;
  return openFolder(e, r.filePaths[0]);
});
// Reopens the folder from last time. It has to still be a folder.
ipcMain.handle('workspace-open', async (e, dir) => {
  try { if (!(await fs.stat(dir)).isDirectory()) return null; } catch { return null; }
  return openFolder(e, path.resolve(dir));
});
ipcMain.handle('workspace-list', (e, dir) => workspace.listFolder(rootOf(e), dir));
ipcMain.handle('workspace-read', async (e, p) => fs.readFile(workspace.mustBeInside(rootOf(e), p), 'utf8'));
ipcMain.handle('workspace-create', (e, { dir, name, text }) => workspace.createFile(rootOf(e), dir, name, text));
ipcMain.handle('workspace-rename', (e, { path: p, name }) => workspace.renameFile(rootOf(e), p, name));
// To the system's trash, where it can be recovered; never deleted outright.
ipcMain.handle('workspace-trash', (e, p) => shell.trashItem(workspace.mustBeInside(rootOf(e), p)));
ipcMain.handle('workspace-reveal', (e, p) => { shell.showItemInFolder(workspace.mustBeInside(rootOf(e), p)); });

// ---------- mechanization in Lean ----------
// A window may work only in the Lean folder of the document it has open, which
// is the one it is watching.
function leanFolder(e, docPath) {
  if (!docPath || watchers.get(e.sender.id)?.path !== docPath) throw new Error('That is not the document this window has open.');
  return lean.leanDir(docPath);
}
/** The job each window is running, if any. */
const leanRuns = new Map();

ipcMain.handle('lean-tools', () => lean.findTools());
ipcMain.handle('lean-open', async (e, docPath) => {
  const dir = leanFolder(e, docPath);
  return { dir, status: await lean.readStatus(dir) };
});
ipcMain.handle('lean-run', async (e, { docPath, prompt, snapshot, schema, model, effort }) => {
  const sender = e.sender;
  const id = sender.id;
  if (leanRuns.has(id)) throw new Error('A job is already running in this window.');
  const dir = leanFolder(e, docPath);
  const tools = await lean.findTools();
  if (!tools.claude || !tools.lake) throw new Error('Claude Code or Lean was not found.');
  const env = lean.childEnv(tools);
  const args = lean.claudeArgs({ model, effort, schema, instructions: '' });
  await lean.ensureProject(dir, tools.lake, env);
  await lean.writeSnapshot(dir, snapshot);
  args[args.length - 1] = await lean.writeInstructions(dir);
  const run = lean.runClaude({ claude: tools.claude, dir, prompt, args, env, onLine: (line) => { if (!sender.isDestroyed()) sender.send('lean-event', { line }); } });
  leanRuns.set(id, run);
  // a window closed mid-job takes its job with it
  sender.once('destroyed', run.cancel);
  try {
    return await run.done;
  } finally {
    leanRuns.delete(id);
    if (!sender.isDestroyed()) sender.removeListener('destroyed', run.cancel);
  }
});
ipcMain.handle('lean-cancel', (e) => { leanRuns.get(e.sender.id)?.cancel(); });
// Lean files of statements the document no longer has go to the system's trash, where they can be recovered.
ipcMain.handle('lean-build', async (e, { docPath, keep }) => {
  const dir = leanFolder(e, docPath);
  const tools = await lean.findTools();
  if (!tools.lake) return { started: false, code: null, output: 'lake was not found.', files: [], removed: [] };
  return lean.runBuild({
    dir, lake: tools.lake, env: lean.childEnv(tools),
    ...(Array.isArray(keep) && keep.every((k) => typeof k === 'string') ? { keep } : {}),
    remove: (p) => shell.trashItem(p),
  });
});
ipcMain.handle('lean-write-status', (e, { docPath, status }) => lean.writeStatus(leanFolder(e, docPath), status));
ipcMain.handle('lean-recreate', async (e, docPath) => {
  const dir = leanFolder(e, docPath);
  const tools = await lean.findTools();
  if (!tools.lake) throw new Error('lake was not found.');
  await lean.recreateProject(dir, tools.lake, lean.childEnv(tools));
});
ipcMain.handle('lean-reveal', async (e, docPath) => { await shell.openPath(leanFolder(e, docPath)); });

// "Open PDF": write to a temp file and hand it to the system viewer.
ipcMain.handle('open-pdf', async (_e, { name, data }) => {
  const p = path.join(os.tmpdir(), `${name || 'document'}.pdf`);
  await fs.writeFile(p, Buffer.from(data));
  const err = await shell.openPath(p);
  if (err) throw new Error(err);
  return p;
});

function buildMenu() {
  const send = (channel) => () => {
    const focused = BrowserWindow.getFocusedWindow();
    (previewOwner.get(focused) ?? focused)?.webContents.send('menu', channel);
  };
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
