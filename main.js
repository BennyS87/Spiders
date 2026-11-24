// Spiders - Electron main process
const { app, BrowserWindow, Menu, dialog, ipcMain, shell, session } = require('electron');
const path = require('path');
const fs = require('fs');

let win = null;
let isDirty = false;
let forceClose = false;
let pendingOpenPath = null; // file passed on launch / via Finder

const AUDIO_EXT = ['wav', 'mp3', 'aif', 'aiff', 'flac', 'ogg', 'm4a', 'aac', 'mid', 'midi'];

function createWindow() {
  win = new BrowserWindow({
    width: 1480,
    height: 920,
    minWidth: 1180,
    minHeight: 740,
    backgroundColor: '#07080b',
    title: 'Spiders',
    show: false,
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      autoplayPolicy: 'no-user-gesture-required'
    }
  });

  win.loadFile(path.join(__dirname, 'src', 'index.html'));
  win.once('ready-to-show', () => win.show());

  win.webContents.on('did-finish-load', () => {
    if (pendingOpenPath) { openProjectPath(pendingOpenPath); pendingOpenPath = null; }
  });

  win.on('close', (e) => {
    if (!isDirty || forceClose) return;
    const choice = dialog.showMessageBoxSync(win, {
      type: 'question',
      buttons: ['Save', "Don't Save", 'Cancel'],
      defaultId: 0, cancelId: 2,
      message: 'Save changes to your Spiders project before closing?'
    });
    if (choice === 2) { e.preventDefault(); return; }
    if (choice === 0) {
      e.preventDefault();
      win.webContents.send('menu', 'save-then-close');
    }
  });

  win.on('closed', () => { win = null; });
  win.webContents.setWindowOpenHandler(({ url }) => { shell.openExternal(url); return { action: 'deny' }; });
  buildMenu();
}

function send(cmd) { if (win) win.webContents.send('menu', cmd); }

function buildMenu() {
  const isMac = process.platform === 'darwin';
  const template = [
    ...(isMac ? [{ role: 'appMenu' }] : []),
    {
      label: 'File',
      submenu: [
        { label: 'New Project', accelerator: 'CmdOrCtrl+N', click: () => send('new') },
        { label: 'Open Project…', accelerator: 'CmdOrCtrl+O', click: () => send('open') },
        { type: 'separator' },
        { label: 'Import Sound…', accelerator: 'CmdOrCtrl+I', click: () => send('import') },
        { type: 'separator' },
        { label: 'Save Project', accelerator: 'CmdOrCtrl+S', click: () => send('save') },
        { label: 'Save Project As…', accelerator: 'CmdOrCtrl+Shift+S', click: () => send('save-as') },
        { type: 'separator' },
        { label: 'Export…', accelerator: 'CmdOrCtrl+E', click: () => send('export') },
        { type: 'separator' },
        isMac ? { role: 'close' } : { role: 'quit' }
      ]
    },
    {
      label: 'Edit',
      submenu: [
        { label: 'Undo', accelerator: 'CmdOrCtrl+Z', click: () => send('undo') },
        { label: 'Redo', accelerator: 'CmdOrCtrl+Shift+Z', click: () => send('redo') },
        { type: 'separator' },
        { role: 'cut' }, { role: 'copy' }, { role: 'paste' },
        { type: 'separator' },
        { label: 'Duplicate Selected Notes', accelerator: 'CmdOrCtrl+D', click: () => send('duplicate') },
        { label: 'Quantize Selected Track', accelerator: 'CmdOrCtrl+U', click: () => send('quantize') },
        { label: 'Select All Notes on Track', accelerator: 'CmdOrCtrl+A', click: () => send('select-all') }
      ]
    },
    {
      label: 'Transport',
      submenu: [
        { label: 'Play / Stop', accelerator: 'Space', registerAccelerator: false, click: () => send('toggle-play') },
        { label: 'Record', accelerator: 'CmdOrCtrl+R', click: () => send('record') },
        { label: 'Back to Start', accelerator: 'Enter', registerAccelerator: false, click: () => send('home') },
        { label: 'Loop On / Off', accelerator: 'CmdOrCtrl+L', click: () => send('loop') },
        { label: 'Metronome On / Off', accelerator: 'CmdOrCtrl+K', click: () => send('metronome') }
      ]
    },
    {
      label: 'Track',
      submenu: [
        { label: 'New Track', accelerator: 'CmdOrCtrl+T', click: () => send('add-track') },
        { label: 'Duplicate Track', click: () => send('duplicate-track') },
        { label: 'Delete Track', click: () => send('delete-track') }
      ]
    },
    {
      label: 'View',
      submenu: [
        { role: 'toggleDevTools' }, { type: 'separator' },
        { role: 'resetZoom' }, { role: 'zoomIn' }, { role: 'zoomOut' }, { type: 'separator' },
        { role: 'togglefullscreen' }
      ]
    },
    { role: 'windowMenu' }
  ];
  Menu.setApplicationMenu(Menu.buildFromTemplate(template));
}

function openProjectPath(p) {
  try {
    const content = fs.readFileSync(p, 'utf8');
    if (win) win.webContents.send('open-project', { path: p, content });
  } catch (err) {
    dialog.showErrorBox('Could not open project', String(err));
  }
}

// ---------- IPC ----------
ipcMain.handle('save-file', async (_e, { defaultPath, filters, data, encoding, path: knownPath }) => {
  let target = knownPath;
  if (!target) {
    const res = await dialog.showSaveDialog(win, { defaultPath, filters });
    if (res.canceled || !res.filePath) return null;
    target = res.filePath;
  }
  const buf = encoding === 'binary' ? Buffer.from(data) : data;
  fs.writeFileSync(target, buf);
  return target;
});

ipcMain.handle('choose-folder', async (_e, { title }) => {
  const res = await dialog.showOpenDialog(win, { title, properties: ['openDirectory', 'createDirectory'] });
  if (res.canceled || !res.filePaths.length) return null;
  return res.filePaths[0];
});

ipcMain.handle('write-in-folder', async (_e, { folder, name, data }) => {
  const safe = String(name).replace(/[\\/:*?"<>|]+/g, '-');
  let target = path.join(folder, safe);
  const ext = path.extname(safe), base = safe.slice(0, safe.length - ext.length);
  let n = 2;
  while (fs.existsSync(target)) target = path.join(folder, `${base} ${n++}${ext}`);
  fs.writeFileSync(target, Buffer.from(data));
  return target;
});

ipcMain.handle('open-file', async (_e, { filters }) => {
  const res = await dialog.showOpenDialog(win, { properties: ['openFile'], filters });
  if (res.canceled || !res.filePaths.length) return null;
  const p = res.filePaths[0];
  return { path: p, content: fs.readFileSync(p, 'utf8') };
});

ipcMain.handle('open-audio', async () => {
  const res = await dialog.showOpenDialog(win, {
    title: 'Import sounds',
    properties: ['openFile', 'multiSelections'],
    filters: [{ name: 'Sound or MIDI', extensions: AUDIO_EXT }, { name: 'All files', extensions: ['*'] }]
  });
  if (res.canceled) return [];
  return res.filePaths.map(p => ({ name: path.basename(p), data: new Uint8Array(fs.readFileSync(p)) }));
});

ipcMain.handle('confirm', async (_e, { message, detail, buttons }) => {
  const b = buttons || ['OK', 'Cancel'];
  const r = await dialog.showMessageBox(win, { type: 'question', message, detail, buttons: b, defaultId: 0, cancelId: b.length - 1 });
  return r.response;
});

ipcMain.on('set-dirty', (_e, dirty) => { isDirty = !!dirty; });
ipcMain.on('set-title', (_e, title) => { if (win) win.setTitle(title); });
ipcMain.on('close-now', () => { forceClose = true; if (win) win.close(); });
ipcMain.on('reveal', (_e, p) => { shell.showItemInFolder(p); });

// ---------- App lifecycle ----------
app.on('open-file', (e, p) => { // macOS double-click .spiders
  e.preventDefault();
  if (win && !win.webContents.isLoading()) openProjectPath(p); else pendingOpenPath = p;
});

const argFile = process.argv.find(a => a.endsWith('.spiders'));
if (argFile) pendingOpenPath = argFile;

app.whenReady().then(() => {
  // Allow Web MIDI (MIDI keyboards) without a prompt
  const allow = new Set(['midi', 'midiSysex']);
  session.defaultSession.setPermissionRequestHandler((_wc, permission, cb) => cb(allow.has(permission)));
  session.defaultSession.setPermissionCheckHandler((_wc, permission) => allow.has(permission));
  createWindow();
  app.on('activate', () => { if (BrowserWindow.getAllWindows().length === 0) createWindow(); });
});

app.on('window-all-closed', () => { app.quit(); });
