// Dr.Doc desktop shell. Serves the built web app from dist/ over a private app:// scheme
// (so workers & storage behave like on the web) and adds native file-system access.
const { app, BrowserWindow, ipcMain, protocol, net, shell, dialog } = require('electron');
const path = require('node:path');
const fs = require('node:fs');
const { pathToFileURL } = require('node:url');

const DIST = path.join(__dirname, '..', 'dist');
const DEV_URL = process.env.DRDOC_DEV_URL; // e.g. http://localhost:5173 while developing

protocol.registerSchemesAsPrivileged([
  { scheme: 'app', privileges: { standard: true, secure: true, supportFetchAPI: true, stream: true } },
]);

const outputDir = () => {
  const dir = path.join(app.getPath('documents'), 'Dr.Doc');
  fs.mkdirSync(dir, { recursive: true });
  return dir;
};

function uniquePath(dir, name) {
  const ext = path.extname(name);
  const stem = path.basename(name, ext);
  let candidate = path.join(dir, name);
  for (let i = 1; fs.existsSync(candidate); i++) candidate = path.join(dir, `${stem} (${i})${ext}`);
  return candidate;
}

const safeName = (n) => path.basename(String(n)).replace(/[\\/:*?"<>|]/g, '_') || 'file';

// Only allow file operations on files inside the Dr.Doc output folder.
function guard(p) {
  const resolved = path.resolve(p);
  if (!resolved.startsWith(outputDir() + path.sep)) throw new Error('Access denied');
  return resolved;
}

let win;
const pendingFiles = [];

function filesFromArgs(argv) {
  return argv
    .slice(app.isPackaged ? 1 : 2)
    .filter((a) => !a.startsWith('-') && fs.existsSync(a) && fs.statSync(a).isFile());
}

function sendFiles(paths) {
  const files = paths.map((p) => ({ name: path.basename(p), data: fs.readFileSync(p).buffer }));
  if (!files.length) return;
  if (win && !win.webContents.isLoading()) win.webContents.send('open-files', files);
  else pendingFiles.push(...files);
}

function createWindow() {
  win = new BrowserWindow({
    width: 1100,
    height: 800,
    minWidth: 380,
    minHeight: 560,
    title: 'Dr.Doc',
    backgroundColor: '#f4f6fb',
    autoHideMenuBar: true,
    icon: path.join(DIST, 'icon-512.png'),
    webPreferences: {
      preload: path.join(__dirname, 'preload.cjs'),
      contextIsolation: true,
      sandbox: true,
    },
  });
  win.webContents.on('did-finish-load', () => {
    if (pendingFiles.length) win.webContents.send('open-files', pendingFiles.splice(0));
  });
  // External links open in the system browser.
  win.webContents.setWindowOpenHandler(({ url }) => {
    if (url.startsWith('http')) {
      shell.openExternal(url);
      return { action: 'deny' };
    }
    return { action: 'allow' };
  });
  win.loadURL(DEV_URL || 'app://drdoc/index.html');
}

if (!app.requestSingleInstanceLock()) {
  app.quit();
} else {
  app.on('second-instance', (_e, argv) => {
    sendFiles(filesFromArgs(argv));
    if (win) {
      if (win.isMinimized()) win.restore();
      win.focus();
    }
  });

  app.whenReady().then(() => {
    protocol.handle('app', (req) => {
      const { pathname } = new URL(req.url);
      const file = path.normalize(path.join(DIST, decodeURIComponent(pathname)));
      if (!file.startsWith(DIST)) return new Response('Not found', { status: 404 });
      return net.fetch(pathToFileURL(file).toString());
    });

    ipcMain.handle('output-dir', () => outputDir());
    ipcMain.handle('save', (_e, name, data) => {
      const p = uniquePath(outputDir(), safeName(name));
      fs.writeFileSync(p, Buffer.from(data));
      return { path: p, name: path.basename(p) };
    });
    ipcMain.handle('open', (_e, p) => shell.openPath(guard(p)));
    ipcMain.handle('reveal', (_e, p) => shell.showItemInFolder(guard(p)));
    ipcMain.handle('rename', (_e, p, newName) => {
      const from = guard(p);
      const to = path.join(path.dirname(from), safeName(newName));
      if (fs.existsSync(to)) throw new Error('A file with that name already exists');
      fs.renameSync(from, to);
      return to;
    });
    ipcMain.handle('remove', (_e, p) => {
      const f = guard(p);
      if (fs.existsSync(f)) shell.trashItem(f).catch(() => fs.unlinkSync(f));
    });
    ipcMain.handle('save-as', async (_e, name, data) => {
      const res = await dialog.showSaveDialog(win, { defaultPath: path.join(app.getPath('downloads'), safeName(name)) });
      if (res.canceled || !res.filePath) return null;
      fs.writeFileSync(res.filePath, Buffer.from(data));
      return res.filePath;
    });
    // Vector-quality HTML → PDF using Chromium's print engine.
    ipcMain.handle('html-to-pdf', async (_e, html, pageSize) => {
      const tmp = path.join(app.getPath('temp'), `drdoc-${Date.now()}.html`);
      fs.writeFileSync(tmp, html, 'utf8');
      const w = new BrowserWindow({ show: false, webPreferences: { sandbox: true, javascript: false } });
      try {
        await w.loadFile(tmp);
        const pdf = await w.webContents.printToPDF({
          pageSize: pageSize === 'letter' ? 'Letter' : 'A4',
          printBackground: true,
          preferCSSPageSize: true,
        });
        return new Uint8Array(pdf);
      } finally {
        w.destroy();
        fs.rm(tmp, () => {});
      }
    });

    createWindow();
    sendFiles(filesFromArgs(process.argv));
    app.on('activate', () => BrowserWindow.getAllWindows().length === 0 && createWindow());
  });

  app.on('window-all-closed', () => {
    if (process.platform !== 'darwin') app.quit();
  });
}
