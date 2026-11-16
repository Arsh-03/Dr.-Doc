// End-to-end UI walkthrough of the desktop build with screenshots.
// Usage: npm run build && npx electron tests/ui-tour.cjs <scratchDir>
const path = require('node:path');
const fs = require('node:fs');
const { app, BrowserWindow } = require('electron');

const scratch = path.resolve(process.argv[2] || path.join(__dirname, 'out', 'tour'));
fs.mkdirSync(scratch, { recursive: true });
app.setPath('userData', path.join(scratch, 'profile'));
app.setPath('documents', path.join(scratch, 'documents'));

const fx = (n) => path.join(__dirname, 'fixtures', n);
// main.cjs treats trailing CLI args as files opened with the app (index 2+ when unpackaged).
process.argv = [process.argv[0], 'main', ...['alpha.pdf', 'beta.pdf', 'report.docx', 'icon.png'].map(fx)];
require('../electron/main.cjs');

const wait = (ms) => new Promise((r) => setTimeout(r, ms));

app.on('browser-window-created', async (_e, win) => {
  if (win.isVisible() === false && win.getTitle() !== 'Dr.Doc') return; // skip hidden print windows
  if (win.__tour) return;
  win.__tour = true;
  await new Promise((r) => win.webContents.once('did-finish-load', r));
  win.setSize(420, 880);
  const js = (code) => win.webContents.executeJavaScript(code);
  const shot = async (name) => {
    await wait(400);
    fs.writeFileSync(path.join(scratch, `${name}.png`), (await win.webContents.capturePage()).toPNG());
    console.log('shot', name);
  };
  const click = (text, sel = 'button') =>
    js(`(() => { const el = [...document.querySelectorAll(${JSON.stringify(sel)})].find(e => e.textContent.trim().includes(${JSON.stringify(text)})); if (!el) return false; el.click(); return true; })()`);
  const until = async (code, ms = 30000) => {
    for (let t = 0; t < ms; t += 250) { if (await js(code)) return true; await wait(250); }
    throw new Error('timeout waiting for ' + code);
  };

  try {
    await until(`document.querySelectorAll('.row').length >= 4`);
    await shot('1-files');
    // keep only the two PDFs selected
    await js(`[...document.querySelectorAll('.row.on')].filter(r => !r.textContent.includes('.pdf')).forEach(r => r.click())`);
    await click('Choose action');
    await shot('2-choose-action');
    await click('Merge PDFs', '.tool-item');
    await shot('3-merge-runner');
    await click('Merge PDFs', '.runner-foot button');
    await until(`document.querySelector('.result-title')`);
    await shot('4-merge-done');
    await click('Done');
    await click('Tools', '.tabs button');
    await shot('5-tools');
    await click('Word → PDF', '.tool-card');
    await click('From my files');
    await js(`[...document.querySelectorAll('.sheet .row')].find(r => r.textContent.includes('report.docx')).click()`);
    await js(`document.querySelector('.sheet-foot .btn').click()`);
    await click('Word → PDF', '.runner-foot button');
    await until(`document.querySelector('.result-title') || document.querySelector('.error')`);
    await shot('6-word-to-pdf-done');
    await click('Done');
    await click('History', '.tabs button');
    await js(`document.querySelector('.row .icon-btn').click()`);
    await shot('7-history-menu');
    await js(`[...document.querySelectorAll('.menu button')].find(b => b.textContent.includes('File info')).click()`);
    await shot('8-file-info');
    win.setSize(1100, 800);
    await js(`document.dispatchEvent(new KeyboardEvent('keydown', {key: 'Escape'}))`);
    await click('Tools', '.tabs button');
    await shot('9-desktop-tools');
    console.log('saved files:', fs.readdirSync(path.join(scratch, 'documents', 'Dr.Doc')).join(', '));
  } catch (e) {
    console.log('TOUR ERROR', e.message);
    await shot('error');
  }
  app.exit(0);
});
