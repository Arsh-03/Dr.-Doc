import { PDFDict, PDFDocument, PDFName, PDFStream, StandardFonts, degrees, rgb } from '@cantoo/pdf-lib';
import * as pdfjs from 'pdfjs-dist';
import workerUrl from 'pdfjs-dist/build/pdf.worker.min.mjs?url';
import { escapeHtml, parseRanges } from '../lib/files';
import { addTextLayer, ocrImage, ocrToHtml, type OcrLang } from './ocr';
import { PAGE_BREAK_HTML } from './constants';

pdfjs.GlobalWorkerOptions.workerSrc = workerUrl;

export type Progress = (msg: string) => void;

const LOCKED = 'This PDF is password-protected. Use “Unlock PDF” first (you need its password).';

export async function loadPdf(blob: Blob): Promise<PDFDocument> {
  const bytes = await blob.arrayBuffer();
  let doc: PDFDocument;
  try {
    doc = await PDFDocument.load(bytes);
  } catch (e) {
    if (/encrypt|password/i.test(String(e))) throw new Error(LOCKED);
    throw new Error('This file could not be read as a PDF. It may be damaged.');
  }
  if (doc.isEncrypted) throw new Error(LOCKED);
  return doc;
}

export const pdfBlob = (bytes: Uint8Array) => new Blob([bytes], { type: 'application/pdf' });

export async function mergePdfs(blobs: Blob[], progress: Progress): Promise<Uint8Array> {
  const out = await PDFDocument.create();
  for (let i = 0; i < blobs.length; i++) {
    progress(`Adding file ${i + 1} of ${blobs.length}…`);
    const src = await loadPdf(blobs[i]);
    const pages = await out.copyPages(src, src.getPageIndices());
    pages.forEach((p) => out.addPage(p));
  }
  return out.save();
}

export async function pickPages(blob: Blob, indices: number[]): Promise<Uint8Array> {
  const src = await loadPdf(blob);
  const out = await PDFDocument.create();
  const pages = await out.copyPages(src, indices);
  pages.forEach((p) => out.addPage(p));
  return out.save();
}

export async function pageCount(blob: Blob): Promise<number> {
  return (await loadPdf(blob)).getPageCount();
}

export async function splitPdf(
  blob: Blob,
  mode: 'each' | 'every' | 'ranges',
  every: number,
  ranges: string,
): Promise<{ label: string; bytes: Uint8Array }[]> {
  const total = await pageCount(blob);
  const groups: { label: string; idx: number[] }[] = [];
  if (mode === 'each') {
    for (let i = 0; i < total; i++) groups.push({ label: `page-${i + 1}`, idx: [i] });
  } else if (mode === 'every') {
    const n = Math.max(1, Math.floor(every) || 1);
    for (let i = 0; i < total; i += n) {
      const idx = Array.from({ length: Math.min(n, total - i) }, (_, k) => i + k);
      groups.push({ label: `pages-${i + 1}-${idx[idx.length - 1] + 1}`, idx });
    }
  } else {
    for (const part of ranges.split(/[;,]/).map((s) => s.trim()).filter(Boolean)) {
      groups.push({ label: `pages-${part.replace(/\s/g, '')}`, idx: parseRanges(part, total) });
    }
    if (!groups.length) throw new Error('Enter at least one range, e.g. 1-3, 4-6');
  }
  const res = [];
  for (const g of groups) res.push({ label: g.label, bytes: await pickPages(blob, g.idx) });
  return res;
}

export async function rotatePdf(blob: Blob, angle: number, ranges: string): Promise<Uint8Array> {
  const doc = await loadPdf(blob);
  const idx = ranges.trim() ? parseRanges(ranges, doc.getPageCount()) : doc.getPageIndices();
  for (const i of new Set(idx)) {
    const p = doc.getPage(i);
    p.setRotation(degrees((p.getRotation().angle + angle) % 360));
  }
  return doc.save();
}

export async function deletePages(blob: Blob, ranges: string): Promise<Uint8Array> {
  const total = await pageCount(blob);
  const drop = new Set(parseRanges(ranges, total));
  const keep = Array.from({ length: total }, (_, i) => i).filter((i) => !drop.has(i));
  if (!keep.length) throw new Error('That would delete every page.');
  return pickPages(blob, keep);
}

export async function addPageNumbers(
  blob: Blob,
  opts: { position: string; format: string; start: number; size: number },
): Promise<Uint8Array> {
  const doc = await loadPdf(blob);
  const font = await doc.embedFont(StandardFonts.Helvetica);
  const total = doc.getPageCount();
  doc.getPages().forEach((page, i) => {
    const n = i + opts.start;
    const label = opts.format === 'n-of-total' ? `${n} of ${total + opts.start - 1}` : opts.format === 'page-n' ? `Page ${n}` : `${n}`;
    const { width, height } = page.getSize();
    const w = font.widthOfTextAtSize(label, opts.size);
    const [v, h] = opts.position.split('-');
    const x = h === 'left' ? 36 : h === 'right' ? width - 36 - w : (width - w) / 2;
    const y = v === 'top' ? height - 28 - opts.size : 24;
    page.drawText(label, { x, y, size: opts.size, font, color: rgb(0.2, 0.2, 0.2) });
  });
  return doc.save();
}

export async function addWatermark(
  blob: Blob,
  opts: { text: string; opacity: number; size: number; diagonal: boolean },
): Promise<Uint8Array> {
  const doc = await loadPdf(blob);
  const font = await doc.embedFont(StandardFonts.HelveticaBold);
  let width: number;
  try {
    width = font.widthOfTextAtSize(opts.text, opts.size);
  } catch {
    throw new Error('Watermark text supports Latin letters, numbers and common symbols only.');
  }
  for (const page of doc.getPages()) {
    const { width: pw, height: ph } = page.getSize();
    const angle = opts.diagonal ? Math.atan2(ph, pw) : 0;
    const cx = pw / 2 - (Math.cos(angle) * width) / 2 + (Math.sin(angle) * opts.size) / 3;
    const cy = ph / 2 - (Math.sin(angle) * width) / 2 - (Math.cos(angle) * opts.size) / 3;
    page.drawText(opts.text, {
      x: cx, y: cy, size: opts.size, font,
      color: rgb(0.55, 0.55, 0.55),
      opacity: opts.opacity,
      rotate: degrees((angle * 180) / Math.PI),
    });
  }
  return doc.save();
}

export async function setMetadata(blob: Blob, meta: { title: string; author: string; subject: string; keywords: string }) {
  const doc = await loadPdf(blob);
  if (meta.title) doc.setTitle(meta.title);
  if (meta.author) doc.setAuthor(meta.author);
  if (meta.subject) doc.setSubject(meta.subject);
  if (meta.keywords) doc.setKeywords(meta.keywords.split(',').map((k) => k.trim()));
  doc.setProducer('Dr.Doc');
  return doc.save();
}

// ---------- passwords ----------

export async function unlockPdf(blob: Blob, password: string): Promise<Uint8Array> {
  const bytes = await blob.arrayBuffer();
  let doc: PDFDocument;
  try {
    doc = await PDFDocument.load(bytes, { password });
  } catch (e) {
    if (/password|decrypt|encrypt/i.test(String(e))) throw new Error('Wrong password, or this kind of PDF encryption is not supported.');
    throw new Error('This file could not be read as a PDF.');
  }
  // Decrypted documents still carry the old encryption dictionary and cross-reference stream as
  // loose objects; readers would treat the saved file as locked again, so drop them.
  for (const [ref, obj] of doc.context.enumerateIndirectObjects()) {
    const dict = obj instanceof PDFDict ? obj : obj instanceof PDFStream ? obj.dict : null;
    if (!dict) continue;
    const isEncryptDict = dict.has(PDFName.of('O')) && dict.has(PDFName.of('U')) && dict.has(PDFName.of('Filter'));
    if (isEncryptDict || dict.has(PDFName.of('Encrypt')) || dict.get(PDFName.of('Type')) === PDFName.of('XRef')) doc.context.delete(ref);
  }
  return doc.save();
}

export async function protectPdf(
  blob: Blob,
  opts: { password: string; allowPrint: boolean; allowCopy: boolean; allowEdit: boolean },
): Promise<Uint8Array> {
  if (opts.password.length < 4) throw new Error('Use a password of at least 4 characters.');
  const doc = await loadPdf(blob);
  // A separate random owner password prevents bypassing the restrictions with the open password.
  const owner = Array.from(crypto.getRandomValues(new Uint8Array(18)), (b) => b.toString(16).padStart(2, '0')).join('');
  doc.encrypt({
    userPassword: opts.password,
    ownerPassword: owner,
    permissions: {
      printing: opts.allowPrint ? 'highResolution' : false,
      copying: opts.allowCopy,
      modifying: opts.allowEdit,
      annotating: opts.allowEdit,
      fillingForms: true,
      contentAccessibility: true,
      documentAssembly: opts.allowEdit,
    },
  });
  return doc.save();
}

// ---------- pdf.js powered (rendering / text) ----------

async function openPdfjs(blob: Blob) {
  const data = new Uint8Array(await blob.arrayBuffer());
  try {
    return await pdfjs.getDocument({ data, isEvalSupported: false }).promise;
  } catch (e) {
    if ((e as { name?: string }).name === 'PasswordException') throw new Error(LOCKED);
    throw new Error('This file could not be read as a PDF.');
  }
}

type PdfjsPage = Awaited<ReturnType<Awaited<ReturnType<typeof openPdfjs>>['getPage']>>;

async function renderCanvas(page: PdfjsPage, dpi: number): Promise<HTMLCanvasElement> {
  const viewport = page.getViewport({ scale: dpi / 72 });
  const canvas = document.createElement('canvas');
  canvas.width = Math.ceil(viewport.width);
  canvas.height = Math.ceil(viewport.height);
  const ctx = canvas.getContext('2d')!;
  ctx.fillStyle = '#fff';
  ctx.fillRect(0, 0, canvas.width, canvas.height);
  await page.render({ canvasContext: ctx, viewport }).promise;
  return canvas;
}

const toBlob = (canvas: HTMLCanvasElement, type: string, quality?: number) =>
  new Promise<Blob>((res, rej) => canvas.toBlob((b) => (b ? res(b) : rej(new Error('Image encoding failed'))), type, quality));

export async function renderPages(
  blob: Blob,
  opts: { dpi: number; format: 'image/png' | 'image/jpeg'; quality?: number; pages?: number[] },
  progress: Progress,
  onPage: (index: number, image: Blob, widthPt: number, heightPt: number) => Promise<void>,
) {
  const pdf = await openPdfjs(blob);
  const list = opts.pages ?? Array.from({ length: pdf.numPages }, (_, i) => i);
  for (const i of list) {
    progress(`Rendering page ${i + 1} of ${pdf.numPages}…`);
    const page = await pdf.getPage(i + 1);
    const base = page.getViewport({ scale: 1 });
    const canvas = await renderCanvas(page, opts.dpi);
    const img = await toBlob(canvas, opts.format, opts.quality);
    canvas.width = canvas.height = 0;
    await onPage(i, img, base.width, base.height);
    page.cleanup();
  }
  await pdf.destroy();
}

export async function compressPdf(blob: Blob, mode: string, progress: Progress): Promise<Uint8Array> {
  if (mode === 'lossless') {
    const doc = await loadPdf(blob);
    return doc.save({ useObjectStreams: true });
  }
  const preset = { strong: { dpi: 72, q: 0.5 }, medium: { dpi: 110, q: 0.65 }, light: { dpi: 150, q: 0.8 } }[mode] ?? { dpi: 110, q: 0.65 };
  const out = await PDFDocument.create();
  await renderPages(blob, { dpi: preset.dpi, format: 'image/jpeg', quality: preset.q }, progress, async (_i, img, w, h) => {
    const jpg = await out.embedJpg(await img.arrayBuffer());
    out.addPage([w, h]).drawImage(jpg, { x: 0, y: 0, width: w, height: h });
  });
  return out.save({ useObjectStreams: true });
}

const MIN_TEXT_CHARS = 20; // fewer characters than this on a page = treat it as scanned

async function pageText(page: PdfjsPage) {
  const content = await page.getTextContent();
  const chars = content.items.reduce((n, it) => n + ('str' in it ? it.str.trim().length : 0), 0);
  return { content, chars };
}

/** Make a searchable PDF: scanned pages get an invisible OCR text layer; pages with real text are kept as-is. */
export async function ocrPdf(blob: Blob, lang: OcrLang, dpi: number, progress: Progress): Promise<{ bytes: Uint8Array; ocrPages: number }> {
  const src = await loadPdf(blob);
  const out = await PDFDocument.create();
  const font = await out.embedFont(StandardFonts.Helvetica);
  const pdf = await openPdfjs(blob);
  let ocrPages = 0;
  for (let i = 0; i < pdf.numPages; i++) {
    const page = await pdf.getPage(i + 1);
    const { chars } = await pageText(page);
    if (chars >= MIN_TEXT_CHARS) {
      const [copy] = await out.copyPages(src, [i]);
      out.addPage(copy);
    } else {
      progress(`Page ${i + 1} of ${pdf.numPages}: rendering…`);
      const viewport = page.getViewport({ scale: 1 });
      const canvas = await renderCanvas(page, dpi);
      const ocr = await ocrImage(canvas, lang, (m) => progress(`Page ${i + 1} of ${pdf.numPages}: ${m}`));
      const jpg = await out.embedJpg(await (await toBlob(canvas, 'image/jpeg', 0.8)).arrayBuffer());
      canvas.width = canvas.height = 0;
      const p = out.addPage([viewport.width, viewport.height]);
      p.drawImage(jpg, { x: 0, y: 0, width: viewport.width, height: viewport.height });
      addTextLayer(p, ocr, font);
      ocrPages++;
    }
    page.cleanup();
  }
  await pdf.destroy();
  return { bytes: await out.save({ useObjectStreams: true }), ocrPages };
}

// ---------- PDF → HTML (text, styles, images, columns, OCR fallback) ----------

interface Item { str: string; x: number; y: number; w: number; size: number; bold: boolean; italic: boolean }
interface Seg { text: string; bold: boolean; italic: boolean }
interface Line { y: number; x: number; xEnd: number; size: number; segs: Seg[] }
interface Block { top: number; html: string; col?: 'L' | 'R' }

function fontStyle(page: PdfjsPage, fontName: string, family: string) {
  let name = family;
  let bold = false;
  let italic = false;
  try {
    const f = page.commonObjs.get(fontName) as { name?: string; bold?: boolean; black?: boolean; italic?: boolean } | undefined;
    if (f) {
      name = `${f.name ?? ''} ${family}`;
      bold = !!(f.bold || f.black);
      italic = !!f.italic;
    }
  } catch {
    /* font object not resolved: fall back to name heuristics */
  }
  return {
    bold: bold || /bold|black|heavy|semibold|demi/i.test(name),
    italic: italic || /italic|oblique/i.test(name),
  };
}

/** Find a vertical gutter separating two text columns, or null for single-column pages. */
function findGutter(items: Item[], width: number): number | null {
  const real = items.filter((i) => i.str.trim());
  if (real.length < 30) return null;
  let best: { g: number; cross: number } | null = null;
  for (let g = width * 0.3; g <= width * 0.7; g += width / 100) {
    const cross = real.filter((i) => i.x < g - 2 && i.x + i.w > g + 2).length;
    if (!best || cross < best.cross || (cross === best.cross && Math.abs(g - width / 2) < Math.abs(best.g - width / 2))) best = { g, cross };
  }
  if (!best || best.cross > Math.max(2, real.length * 0.06)) return null;
  const left = real.filter((i) => i.x + i.w <= best!.g);
  const right = real.filter((i) => i.x >= best!.g);
  if (left.length < real.length * 0.2 || right.length < real.length * 0.2) return null;
  const span = (list: Item[]) => [Math.min(...list.map((i) => i.y)), Math.max(...list.map((i) => i.y))];
  const [l0, l1] = span(left);
  const [r0, r1] = span(right);
  const overlap = Math.min(l1, r1) - Math.max(l0, r0);
  return overlap > 0.3 * Math.min(l1 - l0, r1 - r0) ? best.g : null;
}

function buildLines(items: Item[]): Line[] {
  const lines: Line[] = [];
  for (const it of items) {
    const last = lines[lines.length - 1];
    const seg = { text: it.str, bold: it.bold, italic: it.italic };
    if (last && Math.abs(last.y - it.y) < it.size * 0.5 && it.x > last.x - it.size) {
      const gap = it.x - last.xEnd;
      const lastSeg = last.segs[last.segs.length - 1];
      if (gap > it.size * 0.15 && !lastSeg.text.endsWith(' ') && !it.str.startsWith(' ')) lastSeg.text += ' ';
      last.segs.push(seg);
      last.xEnd = Math.max(last.xEnd, it.x + it.w);
      last.size = Math.max(last.size, it.size);
    } else if (it.str.trim()) {
      lines.push({ y: it.y, x: it.x, xEnd: it.x + it.w, size: it.size, segs: [seg] });
    }
  }
  return lines;
}

function segsToHtml(segs: Seg[]): string {
  const merged: Seg[] = [];
  for (const s of segs) {
    const last = merged[merged.length - 1];
    if (last && last.bold === s.bold && last.italic === s.italic) last.text += s.text;
    else merged.push({ ...s });
  }
  return merged
    .map((s) => {
      let h = escapeHtml(s.text);
      if (s.text.trim()) {
        if (s.italic) h = `<i>${h}</i>`;
        if (s.bold) h = `<b>${h}</b>`;
      }
      return h;
    })
    .join('')
    .replace(/\s+/g, ' ')
    .trim();
}

function linesToBlocks(lines: Line[], bodySize: number): Block[] {
  const blocks: Block[] = [];
  let para: Line[] = [];
  const flush = () => {
    if (!para.length) return;
    // Join lines, re-joining words hyphenated at line ends.
    const segs: Seg[] = [];
    para.forEach((l, i) => {
      const lineSegs = l.segs.map((s) => ({ ...s }));
      if (i > 0) {
        const prev = segs[segs.length - 1];
        const next = lineSegs[0];
        if (/\w-$/.test(prev.text.trimEnd()) && /^[a-z]/.test(next.text.trimStart())) {
          prev.text = prev.text.trimEnd().slice(0, -1);
          next.text = next.text.trimStart();
        } else prev.text += ' ';
      }
      segs.push(...lineSegs);
    });
    const html = segsToHtml(segs);
    if (html) blocks.push({ top: para[0].y + para[0].size, html: `<p>${html}</p>` });
    para = [];
  };
  let prevY: number | null = null;
  for (const l of lines) {
    const text = l.segs.map((s) => s.text).join('').trim();
    const gap = prevY === null ? 0 : prevY - l.y;
    if (l.size > bodySize * 1.25 && text.length < 120) {
      flush();
      const level = l.size > bodySize * 1.7 ? 1 : 2;
      const plain = l.segs.map((s) => ({ ...s, bold: false }));
      blocks.push({ top: l.y + l.size, html: `<h${level}>${segsToHtml(plain)}</h${level}>` });
    } else {
      if (gap > l.size * 1.8 || gap < -l.size || /^\s*([•\-–▪●◦]|\d+[.)])\s/.test(text)) flush();
      para.push(l);
    }
    prevY = l.y;
  }
  flush();
  return blocks;
}

interface PdfImageObj { width: number; height: number; kind?: number; data?: Uint8ClampedArray | Uint8Array; bitmap?: ImageBitmap }

function imageToDataUrl(img: PdfImageObj): string | null {
  const { width: w, height: h } = img;
  if (!w || !h || w * h > 16_000_000) return null;
  const canvas = document.createElement('canvas');
  canvas.width = w;
  canvas.height = h;
  const ctx = canvas.getContext('2d')!;
  if (img.bitmap) ctx.drawImage(img.bitmap, 0, 0);
  else if (img.data) {
    const out = ctx.createImageData(w, h);
    const d = img.data;
    if (img.kind === 3) out.data.set(d.subarray(0, w * h * 4));
    else if (img.kind === 2) {
      for (let i = 0, j = 0; i < w * h; i++, j += 3) {
        out.data[i * 4] = d[j]; out.data[i * 4 + 1] = d[j + 1]; out.data[i * 4 + 2] = d[j + 2]; out.data[i * 4 + 3] = 255;
      }
    } else {
      const rowBytes = Math.ceil(w / 8);
      for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
        const v = (d[y * rowBytes + (x >> 3)] >> (7 - (x & 7))) & 1 ? 255 : 0;
        const k = (y * w + x) * 4;
        out.data[k] = out.data[k + 1] = out.data[k + 2] = v; out.data[k + 3] = 255;
      }
    }
    ctx.putImageData(out, 0, 0);
  } else return null;
  return canvas.toDataURL('image/jpeg', 0.85);
}

/** Pull embedded pictures (with their position) out of a page. */
async function pageImages(page: PdfjsPage): Promise<{ top: number; x: number; w: number; h: number; src: string }[]> {
  const ops = await page.getOperatorList();
  const OPS = pdfjs.OPS;
  const stack: number[][] = [];
  let ctm = [1, 0, 0, 1, 0, 0];
  const found: { top: number; x: number; w: number; h: number; name: string }[] = [];
  for (let i = 0; i < ops.fnArray.length; i++) {
    const fn = ops.fnArray[i];
    const args = ops.argsArray[i];
    if (fn === OPS.save) stack.push(ctm);
    else if (fn === OPS.restore) ctm = stack.pop() ?? [1, 0, 0, 1, 0, 0];
    else if (fn === OPS.transform) {
      const [a, b, c, d, e, f] = args as number[];
      const [A, B, C, D, E, F] = ctm;
      ctm = [a * A + b * C, a * B + b * D, c * A + d * C, c * B + d * D, e * A + f * C + E, e * B + f * D + F];
    } else if (fn === OPS.paintImageXObject || fn === OPS.paintInlineImageXObject) {
      const w = Math.hypot(ctm[0], ctm[1]);
      const h = Math.hypot(ctm[2], ctm[3]);
      if (w > 40 && h > 40 && typeof args[0] === 'string') {
        found.push({ name: args[0], x: ctm[4], w, h, top: ctm[5] + Math.max(0, ctm[3]) });
      }
    }
  }
  const out = [];
  for (const f of found) {
    try {
      const obj = await new Promise<PdfImageObj>((res, rej) => {
        const t = setTimeout(() => rej(new Error('timeout')), 3000);
        const objs = f.name.startsWith('g_') ? page.commonObjs : page.objs;
        objs.get(f.name, (o: PdfImageObj) => { clearTimeout(t); res(o); });
      });
      const src = imageToDataUrl(obj);
      if (src) out.push({ top: f.top, x: f.x, w: f.w, h: f.h, src });
    } catch {
      /* skip images we can't decode */
    }
  }
  return out;
}

export interface PdfTextOptions { ocr?: boolean; lang?: OcrLang; images?: boolean }

/** Convert a PDF to simple semantic HTML: headings, paragraphs with bold/italic, images, page breaks. */
export async function pdfToHtml(blob: Blob, progress: Progress, opts: PdfTextOptions = {}): Promise<string> {
  const pdf = await openPdfjs(blob);
  const htmlPages: string[] = [];
  let anyText = false;
  let scanned = 0;

  for (let p = 1; p <= pdf.numPages; p++) {
    progress(`Reading page ${p} of ${pdf.numPages}…`);
    const page = await pdf.getPage(p);
    const { width } = page.getViewport({ scale: 1 });
    const { content, chars } = await pageText(page);

    if (chars < MIN_TEXT_CHARS) {
      if (opts.ocr) {
        const canvas = await renderCanvas(page, 250);
        const ocr = await ocrImage(canvas, opts.lang ?? 'eng', (m) => progress(`Page ${p} of ${pdf.numPages}: ${m}`));
        canvas.width = canvas.height = 0;
        const html = ocrToHtml(ocr);
        if (html) anyText = true;
        htmlPages.push(html);
        scanned++;
      } else htmlPages.push('');
      page.cleanup();
      continue;
    }
    anyText = true;

    const images = opts.images === false ? [] : await pageImages(page).catch(() => []);
    const styles = content.styles as Record<string, { fontFamily: string }>;
    const items: Item[] = [];
    for (const it of content.items) {
      if (!('str' in it)) continue;
      const [a, b, , d, x, y] = it.transform as number[];
      const size = Math.hypot(a, b) || Math.abs(d) || it.height || 10;
      const st = fontStyle(page, it.fontName, styles[it.fontName]?.fontFamily ?? '');
      items.push({ str: it.str, x, y, w: it.width || 0, size, ...st });
    }

    const sizes = items.filter((i) => i.str.trim()).map((i) => i.size).sort((a, b) => a - b);
    const body = sizes[Math.floor(sizes.length / 2)] || 10;

    // Two-column pages: read the left column, then the right; full-width items stay in place.
    const gutter = findGutter(items, width);
    const groups: Item[][] = gutter === null
      ? [items]
      : [
          items.filter((i) => !(i.x + i.w <= gutter) && !(i.x >= gutter)),
          items.filter((i) => i.x + i.w <= gutter),
          items.filter((i) => i.x >= gutter),
        ];
    let blocks: Block[] = [];
    if (gutter === null) blocks = linesToBlocks(buildLines(items), body);
    else {
      const [full, left, right] = groups.map((g) => linesToBlocks(buildLines(g), body));
      left.forEach((b) => (b.col = 'L'));
      right.forEach((b) => (b.col = 'R'));
      const colTop = Math.max(...[...left, ...right].map((b) => b.top), -Infinity);
      blocks = [...full.filter((b) => b.top > colTop), ...left, ...right, ...full.filter((b) => b.top <= colTop)];
    }

    // Place images before the first text block that sits below them (in the same column).
    for (const img of images.sort((a, b) => b.top - a.top)) {
      const html = `<p><img src="${img.src}" style="width:${Math.round(Math.min(img.w, width) * (96 / 72))}px"></p>`;
      const col = gutter === null ? null : img.x + img.w / 2 < gutter ? 'L' : 'R';
      const idx = blocks.findIndex((b) => b.top < img.top - 1 && (col === null || !b.col || b.col === col));
      if (idx === -1) blocks.push({ top: img.top, html });
      else blocks.splice(idx, 0, { top: img.top, html });
    }
    htmlPages.push(blocks.map((b) => b.html).join('\n'));
    page.cleanup();
  }
  await pdf.destroy();

  if (!anyText) {
    throw new Error(
      opts.ocr === false || !scanned
        ? 'No text found. This looks like a scanned PDF — turn on “Recognise scanned pages (OCR)” or use the “Scan to text (OCR)” tool.'
        : 'No text could be recognised in this PDF.',
    );
  }
  return htmlPages.join(`\n${PAGE_BREAK_HTML}\n`);
}
