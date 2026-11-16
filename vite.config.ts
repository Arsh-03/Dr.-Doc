import fs from 'node:fs';
import path from 'node:path';
import { defineConfig, type Plugin } from 'vite';
import react from '@vitejs/plugin-react';

function listFiles(dir: string, base = dir): string[] {
  return fs.readdirSync(dir, { withFileTypes: true }).flatMap((e) =>
    e.isDirectory() ? listFiles(path.join(dir, e.name), base) : [path.relative(base, path.join(dir, e.name)).replace(/\\/g, '/')],
  );
}

// Emits precache.json listing every built file (incl. public/ and the OCR engine), so the
// service worker can cache the whole app on first visit and run fully offline afterwards.
function precacheManifest(): Plugin {
  return {
    name: 'drdoc-precache',
    apply: 'build',
    generateBundle(_opts, bundle) {
      const files = Object.keys(bundle).filter((f) => !f.endsWith('.map'));
      files.push('./', 'index.html', ...listFiles(path.resolve('public')).filter((f) => f !== 'sw.js'));
      this.emitFile({
        type: 'asset',
        fileName: 'precache.json',
        source: JSON.stringify({ version: Date.now(), files: [...new Set(files)] }),
      });
    },
  };
}

export default defineConfig({
  base: './',
  plugins: [react(), precacheManifest()],
  build: {
    target: 'es2022',
    chunkSizeWarningLimit: 4000,
  },
  optimizeDeps: {
    esbuildOptions: { target: 'es2022' },
  },
});
