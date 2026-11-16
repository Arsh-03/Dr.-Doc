// Inspects smoke-test outputs: node tests/verify.mjs <outDir>
import fs from 'node:fs';
import path from 'node:path';
import { PDFDocument } from '@cantoo/pdf-lib';
import mammoth from 'mammoth';
import JSZip from 'jszip';

const dir = process.argv[2];
for (const f of fs.readdirSync(dir).sort()) {
  const p = path.join(dir, f);
  const buf = fs.readFileSync(p);
  let info = '';
  try {
    if (f.endsWith('.pdf')) {
      const d = await PDFDocument.load(buf);
      info = `${d.getPageCount()} pages; title=${d.getTitle() ?? '-'}; rot=${d.getPages().map((x) => x.getRotation().angle).join(',')}`;
    } else if (f.endsWith('.docx')) {
      const zip = await JSZip.loadAsync(buf);
      const media = Object.keys(zip.files).filter((k) => k.startsWith('word/media/'));
      const text = (await mammoth.extractRawText({ buffer: buf })).value.replace(/\s+/g, ' ').trim();
      info = `media=${media.length}; text="${text.slice(0, 160)}${text.length > 160 ? '…' : ''}"`;
    } else if (/\.(txt|md|csv|html)$/.test(f)) {
      info = JSON.stringify(buf.toString('utf8').replace(/\s+/g, ' ').slice(0, 200));
    } else if (f.endsWith('.zip')) {
      info = Object.keys((await JSZip.loadAsync(buf)).files).join(', ');
    } else info = `${buf.length} bytes, magic=${buf.subarray(0, 4).toString('hex')}`;
  } catch (e) {
    info = `ERROR ${e.message}`;
  }
  console.log(`${f}: ${info}`);
}
