// Usage: start `npm run dev`, then: npx electron tests/run-smoke.cjs [outDir]
const { app, BrowserWindow } = require('electron');
const fs = require('node:fs');
const path = require('node:path');

const outDir = process.argv[2] || path.join(__dirname, 'out');
const url = process.env.SMOKE_URL || 'http://localhost:5173/tests/smoke.html';

app.whenReady().then(async () => {
  const win = new BrowserWindow({ show: false, width: 1000, height: 800 });
  win.webContents.on('console-message', (_e, level, msg) => level >= 2 && console.log('[page]', msg));
  await win.loadURL(url);
  let results;
  for (let i = 0; i < 600 && !results; i++) {
    await new Promise((r) => setTimeout(r, 500));
    results = await win.webContents.executeJavaScript('window.__results');
  }
  if (!results) {
    console.log('TIMEOUT');
    app.exit(1);
  }
  fs.mkdirSync(outDir, { recursive: true });
  let failed = 0;
  for (const r of results) {
    const outs = r.outputs.map((o) => `${o.name} (${o.size}b)`).join(', ');
    console.log(`${r.ok ? 'PASS' : 'FAIL'} ${r.tool.padEnd(15)} ${String(r.ms).padStart(5)}ms  ${r.ok ? outs : r.error}`);
    if (!r.ok) failed++;
    for (const o of r.outputs) fs.writeFileSync(path.join(outDir, `${r.tool}__${o.name}`), Buffer.from(o.b64, 'base64'));
  }
  console.log(`\n${results.length - failed}/${results.length} passed. Outputs in ${outDir}`);
  app.exit(failed ? 1 : 0);
});
