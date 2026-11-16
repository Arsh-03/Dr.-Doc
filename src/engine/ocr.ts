// Offline text recognition (Tesseract). Engine + language files are bundled under ./ocr/.
import { createWorker, OEM, type Worker } from 'tesseract.js';
import type { PDFFont, PDFPage } from '@cantoo/pdf-lib';
import { escapeHtml } from '../lib/files';
import { drawFitted, encodable } from './pdfText';

export type OcrLang = 'eng' | 'hin' | 'eng+hin';
export const OCR_LANG_CHOICES: [string, string][] = [['eng', 'English'], ['hin', 'Hindi'], ['eng+hin', 'English + Hindi']];

export interface OcrWord { text: string; x0: number; y0: number; x1: number; y1: number }
export interface OcrLine { text: string; words: OcrWord[]; x0: number; y0: number; x1: number; y1: number }
export interface OcrPage { width: number; height: number; paragraphs: OcrLine[][]; confidence: number }

let cached: { lang: string; worker: Promise<Worker> } | null = null;
const asset = (p: string) => new URL(`./ocr/${p}`, document.baseURI).href;

async function getWorker(lang: OcrLang): Promise<Worker> {
  if (cached?.lang === lang) return cached.worker;
  if (cached) (await cached.worker).terminate().catch(() => undefined);
  const worker = createWorker(lang.split('+'), OEM.LSTM_ONLY, {
    workerPath: asset('worker.min.js'),
    corePath: asset('core'),
    langPath: asset('lang'),
    gzip: true,
    cacheMethod: 'none',
    workerBlobURL: false,
  });
  cached = { lang, worker };
  worker.catch(() => { cached = null; });
  return worker;
}

/** Recognise text in an image (canvas or image blob). Coordinates are in image pixels. */
export async function ocrImage(image: HTMLCanvasElement | Blob, lang: OcrLang, progress: (m: string) => void): Promise<OcrPage> {
  progress('Loading text recognition…');
  const worker = await getWorker(lang);
  progress('Recognising text…');
  let width: number, height: number;
  if (image instanceof HTMLCanvasElement) {
    ({ width, height } = image);
  } else {
    const bmp = await createImageBitmap(image);
    ({ width, height } = bmp);
    bmp.close();
  }
  const { data } = await worker.recognize(image, {}, { blocks: true, text: true });
  const paragraphs: OcrLine[][] = [];
  for (const block of data.blocks ?? []) {
    for (const para of block.paragraphs) {
      const lines = para.lines
        .map((l): OcrLine => ({
          text: l.words.map((w) => w.text).join(' ').trim(),
          words: l.words.filter((w) => w.text.trim()).map((w) => ({ text: w.text, ...w.bbox })),
          ...l.bbox,
        }))
        .filter((l) => l.text);
      if (lines.length) paragraphs.push(lines);
    }
  }
  return { width, height, paragraphs, confidence: data.confidence };
}

export function ocrToHtml(page: OcrPage): string {
  const heights = page.paragraphs.flat().map((l) => l.y1 - l.y0).sort((a, b) => a - b);
  const median = heights[Math.floor(heights.length / 2)] || 1;
  return page.paragraphs
    .map((lines) => {
      const text = lines.map((l) => l.text).join('\n').replace(/(\w)-\n(?=[a-z])/g, '$1').replace(/\s+/g, ' ').trim();
      const h = lines.reduce((s, l) => s + (l.y1 - l.y0), 0) / lines.length;
      return lines.length <= 2 && h > median * 1.5 && text.length < 120 ? `<h2>${escapeHtml(text)}</h2>` : `<p>${escapeHtml(text)}</p>`;
    })
    .join('\n');
}

/** Add an invisible, selectable text layer over a scanned page image. Returns false if nothing was encodable. */
export function addTextLayer(pdfPage: PDFPage, ocr: OcrPage, font: PDFFont): boolean {
  const { width: pw, height: ph } = pdfPage.getSize();
  const sx = pw / ocr.width;
  const sy = ph / ocr.height;
  let any = false;
  for (const line of ocr.paragraphs.flat()) {
    const text = encodable(line.text, font);
    if (!text) continue;
    const h = (line.y1 - line.y0) * sy;
    drawFitted(pdfPage, text, font, { x: line.x0 * sx, y: ph - line.y1 * sy + h * 0.2, size: h * 0.95, width: (line.x1 - line.x0) * sx, invisible: true });
    any = true;
  }
  return any;
}
