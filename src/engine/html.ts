// Universal HTML pipeline: every text-like source becomes HTML, and HTML can be
// written out as PDF, DOCX, TXT, Markdown or a standalone HTML file.
import mammoth from 'mammoth';
import { marked } from 'marked';
import TurndownService from 'turndown';
import * as XLSX from 'xlsx';
import html2canvas from 'html2canvas';
import { PDFDocument, PDFImage, PDFPage, rgb } from '@cantoo/pdf-lib';
import { escapeHtml, kindOf, blobToDataUrl } from '../lib/files';
import { pdfToHtml, type PdfTextOptions, type Progress } from './pdf';
import { platform } from '../lib/platform';
import { PAGE_BREAK_HTML } from './constants';
import { docToHtml } from './doc';
import { deckToFlowHtml, readPptx, SLIDE_CSS } from './pptx';
import { drawFitted, encodable, standardFonts, type FontSet } from './pdfText';
import { ocrImage, ocrToHtml } from './ocr';

export const PAGE_BREAK = PAGE_BREAK_HTML;

// Arial/Helvetica-like fonts keep on-screen layout close to the PDF's built-in Helvetica.
export const DOC_CSS = `
.dd-doc{font-family:Arial,Helvetica,"Liberation Sans",Roboto,"Noto Sans",sans-serif;font-size:11pt;line-height:1.45;color:#111;word-wrap:break-word}
.dd-doc h1{font-size:20pt;margin:0 0 10pt}.dd-doc h2{font-size:16pt;margin:14pt 0 8pt}.dd-doc h3{font-size:13pt;margin:12pt 0 6pt}
.dd-doc h4,.dd-doc h5,.dd-doc h6{font-size:11pt;margin:10pt 0 4pt}
.dd-doc p{margin:0 0 8pt}.dd-doc ul,.dd-doc ol{margin:0 0 8pt;padding-left:22pt}.dd-doc li{margin:0 0 3pt}
.dd-doc img{max-width:100%;height:auto}
.dd-doc table{border-collapse:collapse;margin:0 0 10pt;max-width:100%}
.dd-doc td,.dd-doc th{border:1px solid #999;padding:3pt 5pt;vertical-align:top;font-size:10pt}
.dd-doc th{background:#eef1f6}.dd-doc td>p,.dd-doc th>p{margin:0}
.dd-doc pre,.dd-doc code{font-family:"Courier New",Courier,monospace;font-size:9.5pt}
.dd-doc pre{background:#f4f4f4;padding:6pt;white-space:pre-wrap}
.dd-doc blockquote{border-left:3pt solid #ccc;margin:0 0 8pt;padding-left:10pt;color:#444}
.dd-doc .dd-pagebreak{page-break-after:always;break-after:page;height:0}
`;

// ---------------- sources → HTML ----------------

function textToHtml(text: string): string {
  return text
    .replace(/\r\n?/g, '\n')
    .split(/\n{2,}/)
    .map((block) => `<p>${escapeHtml(block).replace(/\n/g, '<br>')}</p>`)
    .join('\n');
}

function sanitize(html: string): string {
  const doc = new DOMParser().parseFromString(html, 'text/html');
  doc.querySelectorAll('script,style,link,meta,iframe,object,embed,noscript').forEach((n) => n.remove());
  doc.querySelectorAll('*').forEach((el) => {
    for (const attr of Array.from(el.attributes)) {
      if (attr.name.startsWith('on') || (attr.name === 'href' && /^\s*javascript:/i.test(attr.value))) el.removeAttribute(attr.name);
    }
  });
  return doc.body.innerHTML;
}

async function sheetToHtml(blob: Blob): Promise<string> {
  const wb = XLSX.read(await blob.arrayBuffer(), { type: 'array' });
  return wb.SheetNames.map((name, i) => {
    const full = XLSX.utils.sheet_to_html(wb.Sheets[name], { header: '', footer: '' });
    const table = new DOMParser().parseFromString(full, 'text/html').querySelector('table')?.outerHTML ?? '<p>(empty sheet)</p>';
    return `${i ? PAGE_BREAK : ''}${wb.SheetNames.length > 1 ? `<h2>${escapeHtml(name)}</h2>` : ''}${table}`;
  }).join('\n');
}

export interface SourceOptions extends PdfTextOptions {
  /** Recognise text in images instead of embedding the picture. */
  ocrImages?: boolean;
}

export async function toHtml(file: { name: string; type: string; blob: Blob }, progress: Progress, opts: SourceOptions = {}): Promise<string> {
  const kind = kindOf(file.name, file.type);
  switch (kind) {
    case 'docx': {
      progress(`Reading ${file.name}…`);
      const res = await mammoth.convertToHtml({ arrayBuffer: await file.blob.arrayBuffer() });
      return res.value || '<p></p>';
    }
    case 'doc':
      progress(`Reading ${file.name}…`);
      return docToHtml(await file.blob.arrayBuffer());
    case 'pptx':
      progress(`Reading ${file.name}…`);
      return deckToFlowHtml(await readPptx(file.blob));
    case 'md':
      return sanitize(await marked.parse(await file.blob.text()));
    case 'text':
      return textToHtml(await file.blob.text());
    case 'html':
      return sanitize(await file.blob.text());
    case 'sheet':
      progress(`Reading ${file.name}…`);
      return sheetToHtml(file.blob);
    case 'pdf':
      return pdfToHtml(file.blob, progress, opts);
    case 'image':
      if (opts.ocrImages) {
        const html = ocrToHtml(await ocrImage(file.blob, opts.lang ?? 'eng', progress));
        if (!html) throw new Error(`No text could be recognised in ${file.name}.`);
        return html;
      }
      return `<p><img src="${await blobToDataUrl(file.blob)}" alt="${escapeHtml(file.name)}"></p>`;
    default:
      throw new Error(`${file.name}: this file type isn't supported.`);
  }
}

// ---------------- HTML → simple outputs ----------------

export function htmlDocument(html: string, title: string): string {
  return `<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${escapeHtml(title)}</title><style>body{margin:0;padding:24px;background:#fff}.dd-doc{max-width:800px;margin:auto}${DOC_CSS}</style></head><body><div class="dd-doc">${html}</div></body></html>`;
}

function mount(html: string, widthPx: number): HTMLDivElement {
  const host = document.createElement('div');
  host.style.cssText = `position:fixed;left:-20000px;top:0;width:${widthPx}px;background:#fff;`;
  host.innerHTML = `<style>${DOC_CSS}</style><div class="dd-doc">${html}</div>`;
  document.body.appendChild(host);
  return host;
}

export function htmlToText(html: string): string {
  const host = mount(html, 800);
  host.querySelectorAll('.dd-pagebreak').forEach((el) => el.replaceWith('\n\f\n'));
  host.querySelectorAll('td,th').forEach((el) => el.append('\t'));
  const text = (host.querySelector('.dd-doc') as HTMLElement).innerText;
  host.remove();
  return text.replace(/\n{3,}/g, '\n\n').trim() + '\n';
}

export function htmlToMarkdown(html: string): string {
  const td = new TurndownService({ headingStyle: 'atx', bulletListMarker: '-', codeBlockStyle: 'fenced' });
  td.addRule('pagebreak', { filter: (n) => (n as HTMLElement).classList?.contains('dd-pagebreak'), replacement: () => '\n\n---\n\n' });
  return td.turndown(html);
}

async function waitImages(root: HTMLElement) {
  await Promise.all(
    Array.from(root.querySelectorAll('img')).map((img) =>
      img.complete ? Promise.resolve() : new Promise((r) => { img.onload = img.onerror = () => r(null); }),
    ),
  );
}

// ---------------- DOM → PDF page painters ----------------

const PX = 0.75; // CSS px → PDF pt

function parseColor(c: string): [number, number, number, number] | null {
  const m = /rgba?\(([\d.]+),\s*([\d.]+),\s*([\d.]+)(?:,\s*([\d.]+))?\)/.exec(c);
  if (!m) return null;
  const a = m[4] === undefined ? 1 : Number(m[4]);
  return a === 0 ? null : [Number(m[1]) / 255, Number(m[2]) / 255, Number(m[3]) / 255, a];
}

class Unencodable extends Error {}

/**
 * Paint a laid-out DOM element onto a PDF page as real vector content: selectable text,
 * backgrounds, borders, images and list markers. Throws Unencodable if the page contains text
 * the built-in PDF fonts can't represent (the caller then falls back to an image page).
 */
async function paintVector(root: HTMLElement, doc: PDFDocument, fonts: FontSet, images: Map<string, PDFImage>): Promise<void> {
  const origin = root.getBoundingClientRect();
  const W = origin.width * PX;
  const H = origin.height * PX;
  const page = doc.addPage([W, H]);
  const X = (px: number) => (px - origin.left) * PX;
  const Y = (px: number) => H - (px - origin.top) * PX;
  try {
    await paintNode(root, page, X, Y, fonts, images, doc, true);
  } catch (e) {
    doc.removePage(doc.getPageCount() - 1);
    throw e;
  }
}

async function embedImage(img: HTMLImageElement, doc: PDFDocument, cache: Map<string, PDFImage>): Promise<PDFImage | null> {
  const src = img.currentSrc || img.src;
  if (cache.has(src)) return cache.get(src)!;
  let embedded: PDFImage | null = null;
  try {
    if (/^data:image\/jpe?g/.test(src)) embedded = await doc.embedJpg(await (await fetch(src)).arrayBuffer());
    else if (/^data:image\/png/.test(src)) embedded = await doc.embedPng(await (await fetch(src)).arrayBuffer());
    else {
      const c = document.createElement('canvas');
      c.width = img.naturalWidth;
      c.height = img.naturalHeight;
      c.getContext('2d')!.drawImage(img, 0, 0);
      const blob = await new Promise<Blob | null>((r) => c.toBlob(r, 'image/png'));
      if (blob) embedded = await doc.embedPng(await blob.arrayBuffer());
    }
  } catch {
    embedded = null;
  }
  if (embedded) cache.set(src, embedded);
  return embedded;
}

function pickFont(cs: CSSStyleDeclaration, fonts: FontSet) {
  const bold = Number(cs.fontWeight) >= 600 || cs.fontWeight === 'bold';
  const italic = cs.fontStyle === 'italic' || cs.fontStyle === 'oblique';
  if (/mono|courier|consolas/i.test(cs.fontFamily)) return bold ? fonts.monoBold : fonts.mono;
  return bold ? (italic ? fonts.boldItalic : fonts.bold) : italic ? fonts.italic : fonts.regular;
}

async function paintNode(
  el: HTMLElement, page: PDFPage, X: (n: number) => number, Y: (n: number) => number,
  fonts: FontSet, images: Map<string, PDFImage>, doc: PDFDocument, isRoot = false,
) {
  const cs = getComputedStyle(el);
  if (cs.display === 'none' || cs.visibility === 'hidden') return;
  const r = el.getBoundingClientRect();
  const opacity = Number(cs.opacity);

  if (!isRoot) {
    const bg = parseColor(cs.backgroundColor);
    if (bg && r.width && r.height) {
      page.drawRectangle({ x: X(r.left), y: Y(r.bottom), width: r.width * PX, height: r.height * PX, color: rgb(bg[0], bg[1], bg[2]), opacity: bg[3] * opacity });
    }
  }
  // Borders, side by side
  for (const side of ['Top', 'Right', 'Bottom', 'Left'] as const) {
    const w = parseFloat(cs.getPropertyValue(`border-${side.toLowerCase()}-width`));
    const style = cs.getPropertyValue(`border-${side.toLowerCase()}-style`);
    const col = parseColor(cs.getPropertyValue(`border-${side.toLowerCase()}-color`));
    if (!w || style === 'none' || style === 'hidden' || !col) continue;
    const color = rgb(col[0], col[1], col[2]);
    const t = w * PX;
    if (side === 'Top') page.drawRectangle({ x: X(r.left), y: Y(r.top) - t, width: r.width * PX, height: t, color });
    if (side === 'Bottom') page.drawRectangle({ x: X(r.left), y: Y(r.bottom), width: r.width * PX, height: t, color });
    if (side === 'Left') page.drawRectangle({ x: X(r.left), y: Y(r.bottom), width: t, height: r.height * PX, color });
    if (side === 'Right') page.drawRectangle({ x: X(r.right) - t, y: Y(r.bottom), width: t, height: r.height * PX, color });
  }

  if (el.tagName === 'IMG') {
    const img = await embedImage(el as HTMLImageElement, doc, images);
    if (img && r.width && r.height) page.drawImage(img, { x: X(r.left), y: Y(r.bottom), width: r.width * PX, height: r.height * PX, opacity });
    return;
  }

  if (el.tagName === 'LI' && cs.listStyleType !== 'none') {
    const parent = el.parentElement;
    const range = document.createRange();
    range.selectNodeContents(el);
    const first = range.getClientRects()[0];
    if (first && parent) {
      const size = parseFloat(cs.fontSize);
      const ordered = parent.tagName === 'OL';
      const n = ordered ? Array.from(parent.children).indexOf(el) + Number(parent.getAttribute('start') ?? 1) : 0;
      const marker = ordered ? `${n}.` : '•';
      const font = fonts.regular;
      const w = font.widthOfTextAtSize(marker, size * PX);
      const col = parseColor(cs.color) ?? [0, 0, 0, 1];
      page.drawText(marker, { x: X(r.left) - w - size * 0.4 * PX, y: Y(first.bottom) + size * 0.24 * PX, size: size * PX, font, color: rgb(col[0], col[1], col[2]) });
    }
  }

  for (const child of Array.from(el.childNodes)) {
    if (child.nodeType === Node.ELEMENT_NODE) {
      await paintNode(child as HTMLElement, page, X, Y, fonts, images, doc);
    } else if (child.nodeType === Node.TEXT_NODE) {
      paintText(child as Text, cs, page, X, Y, fonts);
    }
  }
}

function paintText(node: Text, cs: CSSStyleDeclaration, page: PDFPage, X: (n: number) => number, Y: (n: number) => number, fonts: FontSet) {
  const data = node.data;
  if (!data.trim()) return;
  const font = pickFont(cs, fonts);
  const size = parseFloat(cs.fontSize);
  const col = parseColor(cs.color) ?? [0, 0, 0, 1];
  const underline = cs.textDecorationLine.includes('underline');
  const range = document.createRange();

  // Group words into visual lines, then draw each line as one stretched text run.
  type L = { top: number; bottom: number; left: number; right: number; words: string[] };
  const lines: L[] = [];
  const re = /\S+/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(data))) {
    range.setStart(node, m.index);
    range.setEnd(node, m.index + m[0].length);
    const rects = range.getClientRects();
    if (!rects.length) continue;
    const rc = rects[0];
    const last = lines[lines.length - 1];
    if (last && Math.abs(last.top - rc.top) < size * 0.4 && rc.left >= last.right - 1) {
      last.words.push(m[0]);
      last.right = Math.max(last.right, rects[rects.length - 1].right);
      last.bottom = Math.max(last.bottom, rc.bottom);
    } else {
      lines.push({ top: rc.top, bottom: rc.bottom, left: rc.left, right: rects[rects.length - 1].right, words: [m[0]] });
    }
  }
  for (const l of lines) {
    const text = encodable(l.words.join(' '), font);
    if (text === null) throw new Unencodable();
    const baseline = l.bottom - (l.bottom - l.top - size) / 2 - size * 0.215;
    drawFitted(page, text, font, { x: X(l.left), y: Y(baseline), size: size * PX, width: (l.right - l.left) * PX, color: [col[0], col[1], col[2]] });
    if (underline) page.drawRectangle({ x: X(l.left), y: Y(baseline) - size * 0.12 * PX, width: (l.right - l.left) * PX, height: Math.max(0.5, size * 0.06 * PX), color: rgb(col[0], col[1], col[2]) });
  }
}

async function paintRaster(el: HTMLElement, doc: PDFDocument, scale: number) {
  const canvas = await html2canvas(el, { scale, backgroundColor: '#ffffff', logging: false, useCORS: true });
  const jpg = await doc.embedJpg(await (await fetch(canvas.toDataURL('image/jpeg', 0.92))).arrayBuffer());
  const w = el.offsetWidth * PX;
  const h = el.offsetHeight * PX;
  doc.addPage([w, h]).drawImage(jpg, { x: 0, y: 0, width: w, height: h });
  canvas.width = canvas.height = 0;
}

/** Render a list of laid-out page elements into one PDF, vector where possible. */
async function pagesToPdf(pages: HTMLElement[], opts: PdfOptions, progress: Progress): Promise<Uint8Array> {
  const out = await PDFDocument.create();
  const fonts = await standardFonts(out);
  const images = new Map<string, PDFImage>();
  for (let i = 0; i < pages.length; i++) {
    progress(`Creating PDF page ${i + 1} of ${pages.length}…`);
    if (opts.render !== 'image') {
      try {
        await paintVector(pages[i], out, fonts, images);
        continue;
      } catch (e) {
        if (!(e instanceof Unencodable)) console.warn('Vector painting failed, using image page', e);
      }
    }
    await paintRaster(pages[i], out, opts.scale);
  }
  return out.save({ useObjectStreams: true });
}

// ---------------- pagination ----------------

const PAGE_SIZES = { a4: [794, 1123], letter: [816, 1056] } as const; // CSS px @96dpi

/** Flow HTML onto fixed-size page elements (tables and lists split across pages). */
async function paginate(html: string, opts: PdfOptions, host: HTMLElement): Promise<HTMLDivElement[]> {
  const [W, H] = PAGE_SIZES[opts.pageSize];
  const M = opts.margin;
  host.innerHTML = `<style>${DOC_CSS}.dd-page{width:${W}px;height:${H}px;padding:${M}px;box-sizing:border-box;background:#fff;overflow:hidden}.dd-page>.dd-doc{height:100%;overflow:hidden}</style>`;

  const source = document.createElement('div');
  source.className = 'dd-doc';
  source.style.width = `${W - 2 * M}px`;
  source.innerHTML = html;
  host.appendChild(source);
  await waitImages(source);

  const pages: HTMLDivElement[] = [];
  let content!: HTMLDivElement;
  const newPage = () => {
    const page = document.createElement('div');
    page.className = 'dd-page';
    content = document.createElement('div');
    content.className = 'dd-doc';
    page.appendChild(content);
    host.appendChild(page);
    pages.push(page);
  };
  const overflows = () => content.scrollHeight > content.clientHeight + 1;

  const placeSplittable = (el: HTMLElement) => {
    const isTable = el.tagName === 'TABLE';
    const rows = isTable ? Array.from(el.querySelectorAll(':scope > tbody > tr, :scope > tr')) : Array.from(el.children);
    const thead = isTable ? el.querySelector(':scope > thead') : null;
    const shell = () => {
      const s = el.cloneNode(false) as HTMLElement;
      if (thead) s.appendChild(thead.cloneNode(true));
      const body = isTable ? document.createElement('tbody') : s;
      if (isTable) s.appendChild(body);
      content.appendChild(s);
      return body;
    };
    let target = shell();
    let count = 0;
    // Ordered lists continue their numbering on the next page.
    let start = Number(el.getAttribute('start') ?? 1);
    for (const row of rows) {
      target.appendChild(row);
      if (overflows() && (count > 0 || content.childNodes.length > 1)) {
        row.remove();
        if (count === 0) (isTable ? target.parentElement! : target).remove();
        newPage();
        target = shell();
        if (el.tagName === 'OL') target.setAttribute('start', String(start));
        target.appendChild(row);
        count = 0;
      }
      count++;
      start++;
    }
  };

  newPage();
  for (const node of Array.from(source.childNodes)) {
    if (node.nodeType === Node.TEXT_NODE && !node.textContent?.trim()) continue;
    let el: HTMLElement;
    if (node.nodeType !== Node.ELEMENT_NODE) {
      el = document.createElement('p');
      el.appendChild(node);
    } else el = node as HTMLElement;

    if (el.classList.contains('dd-pagebreak')) {
      if (content.childNodes.length) newPage();
      continue;
    }
    content.appendChild(el);
    if (!overflows()) continue;

    if (['TABLE', 'UL', 'OL'].includes(el.tagName) && el.children.length > 1) {
      el.remove();
      placeSplittable(el);
      continue;
    }
    if (content.childNodes.length > 1) {
      el.remove();
      newPage();
      content.appendChild(el);
    }
    if (overflows()) {
      // A single block taller than a page: give it an extra-tall page rather than cut it.
      const page = content.parentElement as HTMLDivElement;
      page.style.height = 'auto';
      content.style.height = 'auto';
      newPage();
    }
  }
  source.remove();
  return pages.filter((p) => p.querySelector('.dd-doc')!.childNodes.length > 0);
}

export interface PdfOptions {
  pageSize: 'a4' | 'letter';
  margin: number;
  scale: number;
  /** 'text' = selectable text (default); 'image' = pixel-exact page snapshots. */
  render?: 'text' | 'image';
}

function offscreenHost() {
  const host = document.createElement('div');
  host.style.cssText = 'position:fixed;left:-20000px;top:0;';
  document.body.appendChild(host);
  return host;
}

export async function htmlToPdf(html: string, opts: PdfOptions, progress: Progress): Promise<Uint8Array> {
  if (platform.htmlToPdf && opts.render !== 'image') {
    progress('Creating PDF…');
    const doc = `<!doctype html><html><head><meta charset="utf-8"><style>@page{size:${opts.pageSize === 'a4' ? 'A4' : 'Letter'};margin:${opts.margin * 0.75}pt}body{margin:0}${DOC_CSS}</style></head><body><div class="dd-doc">${html}</div></body></html>`;
    return platform.htmlToPdf(doc, opts.pageSize);
  }
  const host = offscreenHost();
  try {
    const pages = await paginate(html, opts, host);
    if (!pages.length) {
      const empty = await PDFDocument.create();
      const [W, H] = PAGE_SIZES[opts.pageSize];
      empty.addPage([W * PX, H * PX]);
      return await empty.save();
    }
    return await pagesToPdf(pages, opts, progress);
  } finally {
    host.remove();
  }
}

// ---------------- PowerPoint slides ----------------

async function mountSlides(blob: Blob, progress: Progress) {
  progress('Reading slides…');
  const deck = await readPptx(blob);
  const host = offscreenHost();
  host.innerHTML = `<style>${SLIDE_CSS}</style>${deck.slides.map((s) => s.html).join('')}`;
  await waitImages(host);
  return { host, slides: Array.from(host.querySelectorAll<HTMLElement>('.pptx-slide')) };
}

export async function pptxToPdf(blob: Blob, opts: Pick<PdfOptions, 'scale' | 'render'>, progress: Progress): Promise<Uint8Array> {
  const { host, slides } = await mountSlides(blob, progress);
  try {
    return await pagesToPdf(slides, { pageSize: 'a4', margin: 0, ...opts }, progress);
  } finally {
    host.remove();
  }
}

export async function pptxToImages(blob: Blob, mime: string, scale: number, progress: Progress): Promise<Blob[]> {
  const { host, slides } = await mountSlides(blob, progress);
  try {
    const out: Blob[] = [];
    for (let i = 0; i < slides.length; i++) {
      progress(`Rendering slide ${i + 1} of ${slides.length}…`);
      const canvas = await html2canvas(slides[i], { scale, backgroundColor: '#ffffff', logging: false });
      out.push(await new Promise<Blob>((res, rej) => canvas.toBlob((b) => (b ? res(b) : rej(new Error('Image encoding failed'))), mime, 0.9)));
      canvas.width = canvas.height = 0;
    }
    return out;
  } finally {
    host.remove();
  }
}
