// Runs every tool against fixtures in a real browser engine. Driven by tests/run-smoke.cjs.
import { TOOLS, defaultOpts, type Opts } from '../src/engine/tools';
import type { BucketFile } from '../src/lib/db';
import { mimeFor } from '../src/lib/files';

const CASES: Record<string, { files: string[]; opts?: Opts }> = {
  'merge-pdf': { files: ['alpha.pdf', 'beta.pdf'] },
  'merge-docx': { files: ['report.docx', 'notes.docx'] },
  'combine-pdf': { files: ['alpha.pdf', 'report.docx', 'icon.png', 'readme.md', 'data.csv', 'slides.pptx', 'legacy.doc'] },
  'ocr-pdf': { files: ['scanned.pdf', 'scan.png'], opts: { dpi: '200' } },
  'ocr-text': { files: ['scanned.pdf', 'scan.png'], opts: { format: 'txt' } },
  'unlock-pdf': { files: ['locked.pdf'], opts: { password: 'secret' } },
  'protect-pdf': { files: ['alpha.pdf'], opts: { password: 'abcd1234', confirm: 'abcd1234' } },
  'doc-pdf': { files: ['legacy.doc'] },
  'doc-docx': { files: ['legacy.doc'] },
  'doc-txt': { files: ['legacy.doc'] },
  'pptx-pdf': { files: ['slides.pptx'] },
  'pptx-docx': { files: ['slides.pptx'] },
  'pptx-txt': { files: ['slides.pptx'] },
  'pptx-md': { files: ['slides.pptx'] },
  'pptx-png': { files: ['slides.pptx'] },
  'pptx-jpg': { files: ['slides.pptx'], opts: { zip: false } },
  'combine-docx': { files: ['alpha.pdf', 'report.docx', 'plain.txt', 'icon.png'], opts: { titles: true } },
  'images-pdf': { files: ['icon.png', 'icon.png'] },
  'split-pdf': { files: ['alpha.pdf'] },
  'extract-pages': { files: ['alpha.pdf'], opts: { ranges: '1, 3' } },
  'delete-pages': { files: ['alpha.pdf'], opts: { ranges: '2' } },
  'reorder-pages': { files: ['alpha.pdf'], opts: { order: '3,1,2' } },
  'rotate-pdf': { files: ['alpha.pdf'] },
  'compress-pdf': { files: ['alpha.pdf'] },
  'page-numbers': { files: ['alpha.pdf'], opts: { format: 'n-of-total' } },
  watermark: { files: ['alpha.pdf'] },
  'pdf-metadata': { files: ['alpha.pdf'], opts: { title: 'T', author: 'A' } },
  'pdf-docx': { files: ['alpha.pdf', 'twocol.pdf'] },
  'pdf-txt': { files: ['alpha.pdf', 'twocol.pdf', 'scanned.pdf'] },
  'pdf-md': { files: ['alpha.pdf'] },
  'pdf-html': { files: ['alpha.pdf'] },
  'pdf-png': { files: ['beta.pdf'] },
  'pdf-jpg': { files: ['beta.pdf'], opts: { zip: false } },
  'docx-pdf': { files: ['report.docx'] },
  'txt-pdf': { files: ['plain.txt'] },
  'md-pdf': { files: ['readme.md'] },
  'html-pdf': { files: ['page.html'] },
  'sheet-pdf': { files: ['data.csv'] },
  'docx-txt': { files: ['report.docx'] },
  'docx-html': { files: ['report.docx'] },
  'docx-md': { files: ['report.docx'] },
  'txt-docx': { files: ['plain.txt'] },
  'md-docx': { files: ['readme.md'] },
  'html-docx': { files: ['page.html'] },
  'md-html': { files: ['readme.md'] },
  'html-md': { files: ['page.html'] },
  'html-txt': { files: ['page.html'] },
  'img-png': { files: ['icon.png'] },
  'img-jpg': { files: ['icon.png'] },
  'img-webp': { files: ['icon.png'] },
  'img-docx': { files: ['icon.png', 'icon.png'] },
  'sheet-xlsx': { files: ['data.csv'] },
  'sheet-csv': { files: ['data.csv'] },
  'sheet-html': { files: ['data.csv'] },
  'sheet-docx': { files: ['data.csv'] },
};

async function toB64(blob: Blob) {
  const buf = new Uint8Array(await blob.arrayBuffer());
  let s = '';
  for (let i = 0; i < buf.length; i += 0x8000) s += String.fromCharCode(...buf.subarray(i, i + 0x8000));
  return btoa(s);
}

const results: { tool: string; ok: boolean; ms: number; error?: string; outputs: { name: string; size: number; b64: string }[] }[] = [];

for (const tool of TOOLS) {
  const c = CASES[tool.id];
  if (!c) {
    results.push({ tool: tool.id, ok: false, ms: 0, error: 'NO TEST CASE', outputs: [] });
    continue;
  }
  const files: BucketFile[] = [];
  for (const name of c.files) {
    const blob = await (await fetch(`/tests/fixtures/${name}`)).blob();
    files.push({ id: name, name, type: mimeFor(name), size: blob.size, blob, addedAt: 0, source: 'picked' });
  }
  const t0 = performance.now();
  try {
    const outs = await tool.run(files, { ...defaultOpts(tool), ...c.opts }, () => {});
    results.push({
      tool: tool.id, ok: true, ms: Math.round(performance.now() - t0),
      outputs: await Promise.all(outs.map(async (o) => ({ name: o.name, size: o.blob.size, b64: await toB64(o.blob) }))),
    });
  } catch (e) {
    results.push({ tool: tool.id, ok: false, ms: Math.round(performance.now() - t0), error: String((e as Error).stack || e), outputs: [] });
  }
}

(window as unknown as { __results: unknown }).__results = results;
document.getElementById('log')!.textContent = 'done';
