// Registry of every action the app can perform. The UI is generated from this list.
import JSZip from 'jszip';
import * as XLSX from 'xlsx';
import { baseName, kindOf, parseRanges, type Kind, MIME } from '../lib/files';
import type { BucketFile } from '../lib/db';
import * as pdf from './pdf';
import { htmlDocument, htmlToMarkdown, htmlToPdf, htmlToText, pptxToImages, pptxToPdf, toHtml, PAGE_BREAK, type PdfOptions, type SourceOptions } from './html';
import { OCR_LANG_CHOICES, type OcrLang } from './ocr';
import { htmlToDocx } from './docx';
import { mergeDocx } from './docxMerge';
import { convertImage, imagesToPdf } from './images';
import { escapeHtml } from '../lib/files';

export type Progress = (msg: string) => void;
export interface Output { name: string; blob: Blob }
export type OptValue = string | number | boolean;
export type Opts = Record<string, OptValue>;

export type OptionDef =
  | { key: string; label: string; type: 'select'; choices: [string, string][]; default: string; help?: string; showIf?: (o: Opts) => boolean }
  | { key: string; label: string; type: 'text' | 'password'; default: string; placeholder?: string; help?: string; showIf?: (o: Opts) => boolean }
  | { key: string; label: string; type: 'number'; default: number; min?: number; max?: number; help?: string; showIf?: (o: Opts) => boolean }
  | { key: string; label: string; type: 'checkbox'; default: boolean; help?: string; showIf?: (o: Opts) => boolean };

export type Category = 'Merge & combine' | 'PDF tools' | 'Scan & OCR' | 'Security' | 'From PDF' | 'To PDF' | 'Word & text' | 'PowerPoint' | 'Images' | 'Spreadsheets';

export interface Tool {
  id: string;
  name: string;
  desc: string;
  category: Category;
  accepts: Kind[];
  min: number;
  /** 1 = one file at a time; undefined = many. */
  max?: number;
  /** Inputs are combined into one output, so their order matters. */
  ordered?: boolean;
  options?: OptionDef[];
  /** Short note about quality/limitations shown under the tool. */
  note?: string;
  run(files: BucketFile[], opts: Opts, progress: Progress): Promise<Output[]>;
}

const mime = (ext: string) => MIME[ext] || 'application/octet-stream';
const blobOf = (data: BlobPart, ext: string) => new Blob([data], { type: mime(ext) });
const stamp = () => {
  const d = new Date();
  const p = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}-${p(d.getHours())}${p(d.getMinutes())}`;
};
const outName = (opts: Opts, fallback: string, ext: string) => {
  const custom = String(opts.outName || '').trim().replace(/[\\/:*?"<>|]/g, '_');
  return `${custom ? baseName(custom) : fallback}.${ext}`;
};

const OUT_NAME: OptionDef = { key: 'outName', label: 'Output file name', type: 'text', default: '', placeholder: 'Leave blank for automatic' };

const PDF_LAYOUT: OptionDef[] = [
  { key: 'pageSize', label: 'Page size', type: 'select', choices: [['a4', 'A4'], ['letter', 'US Letter']], default: 'a4' },
  { key: 'margin', label: 'Margins', type: 'select', choices: [['36', 'Narrow'], ['64', 'Normal'], ['96', 'Wide']], default: '64' },
  ...renderOptions(),
];
function renderOptions(): OptionDef[] {
  return [
    { key: 'render', label: 'PDF type', type: 'select', choices: [['text', 'Selectable text (recommended)'], ['image', 'Exact snapshot (image pages)']], default: 'text', help: 'Pages in scripts like Hindi are always saved as images.' },
    { key: 'scale', label: 'Image quality', type: 'select', choices: [['1.5', 'Standard (smaller file)'], ['2', 'High'], ['3', 'Very high (large file)']], default: '2', showIf: (o) => o.render === 'image' },
  ];
}
const pdfLayout = (o: Opts): PdfOptions => ({
  pageSize: (o.pageSize as 'a4' | 'letter') || 'a4',
  margin: Number(o.margin) || 64,
  scale: Number(o.scale) || 2,
  render: o.render === 'image' ? 'image' : 'text',
});

const LANG: OptionDef = { key: 'lang', label: 'Text language', type: 'select', choices: OCR_LANG_CHOICES, default: 'eng' };
const OCR_OPTS: OptionDef[] = [
  { key: 'ocr', label: 'Recognise scanned pages (OCR)', type: 'checkbox', default: true, help: 'Pages without real text are read with offline text recognition.' },
  { ...LANG, showIf: (o) => !!o.ocr },
];
const sourceOpts = (o: Opts): SourceOptions => ({ ocr: !!o.ocr, lang: (o.lang as OcrLang) || 'eng' });

const TEXT_KINDS: Kind[] = ['docx', 'doc', 'pptx', 'text', 'md', 'html', 'sheet'];

// ---------- generic "X → Y" converter built on the HTML pipeline ----------

type Target = 'pdf' | 'docx' | 'txt' | 'html' | 'md';

async function fromHtml(html: string, target: Target, name: string, opts: Opts, progress: Progress): Promise<Blob> {
  switch (target) {
    case 'pdf': return blobOf(await htmlToPdf(html, pdfLayout(opts), progress), 'pdf');
    case 'docx': progress('Building Word document…'); return htmlToDocx(html, name);
    case 'txt': return blobOf(htmlToText(html), 'txt');
    case 'md': return blobOf(htmlToMarkdown(html), 'md');
    case 'html': return blobOf(htmlDocument(html, name), 'html');
  }
}

function convertTool(id: string, name: string, desc: string, category: Category, accepts: Kind[], target: Target, note?: string): Tool {
  const options = [...(accepts.includes('pdf') ? OCR_OPTS : []), ...(target === 'pdf' ? (accepts.includes('pptx') ? renderOptions() : PDF_LAYOUT) : [])];
  return {
    id, name, desc, category, accepts, min: 1, note,
    options: options.length ? options : undefined,
    async run(files, opts, progress) {
      const out: Output[] = [];
      for (const f of files) {
        if (target === 'pdf' && kindOf(f.name, f.type) === 'pptx') {
          out.push({ name: `${baseName(f.name)}.pdf`, blob: pdf.pdfBlob(await pptxToPdf(f.blob, pdfLayout(opts), progress)) });
          continue;
        }
        const html = await toHtml(f, progress, sourceOpts(opts));
        out.push({ name: `${baseName(f.name)}.${target}`, blob: await fromHtml(html, target, baseName(f.name), opts, progress) });
      }
      return out;
    },
  };
}

// ---------- the registry ----------

export const TOOLS: Tool[] = [
  // ===== Merge & combine =====
  {
    id: 'merge-pdf', name: 'Merge PDFs', desc: 'Join two or more PDFs into one, in the order you choose.',
    category: 'Merge & combine', accepts: ['pdf'], min: 2, ordered: true, options: [OUT_NAME],
    async run(files, opts, progress) {
      const bytes = await pdf.mergePdfs(files.map((f) => f.blob), progress);
      return [{ name: outName(opts, `merged-${stamp()}`, 'pdf'), blob: pdf.pdfBlob(bytes) }];
    },
  },
  {
    id: 'merge-docx', name: 'Merge Word documents', desc: 'Join two or more .docx files into one, keeping formatting and images.',
    category: 'Merge & combine', accepts: ['docx'], min: 2, ordered: true,
    options: [{ key: 'pageBreak', label: 'Start each document on a new page', type: 'checkbox', default: true }, OUT_NAME],
    note: 'Page setup, headers and footers come from the first document.',
    async run(files, opts, progress) {
      const blob = await mergeDocx(files.map((f) => f.blob), { pageBreak: !!opts.pageBreak }, progress);
      return [{ name: outName(opts, `merged-${stamp()}`, 'docx'), blob }];
    },
  },
  {
    id: 'combine-pdf', name: 'Combine any files → PDF', desc: 'Mix PDFs, Word, PowerPoint, images, text and sheets into a single PDF.',
    category: 'Merge & combine', accepts: ['pdf', 'image', ...TEXT_KINDS], min: 1, ordered: true,
    options: [...PDF_LAYOUT, OUT_NAME],
    async run(files, opts, progress) {
      const parts: Blob[] = [];
      for (let i = 0; i < files.length; i++) {
        const f = files[i];
        progress(`Preparing ${f.name} (${i + 1}/${files.length})…`);
        const kind = kindOf(f.name, f.type);
        if (kind === 'pdf') parts.push(f.blob);
        else if (kind === 'image') {
          const size = String(opts.pageSize);
          parts.push(pdf.pdfBlob(await imagesToPdf([{ blob: f.blob, type: f.type || mime(f.name.split('.').pop()!) }], { pageSize: size, margin: 36 }, progress)));
        } else if (kind === 'pptx') parts.push(pdf.pdfBlob(await pptxToPdf(f.blob, pdfLayout(opts), progress)));
        else parts.push(pdf.pdfBlob(await htmlToPdf(await toHtml(f, progress), pdfLayout(opts), progress)));
      }
      const bytes = await pdf.mergePdfs(parts, progress);
      return [{ name: outName(opts, `combined-${stamp()}`, 'pdf'), blob: pdf.pdfBlob(bytes) }];
    },
  },
  {
    id: 'combine-docx', name: 'Combine any files → Word', desc: 'Put text from PDFs, Word, Markdown, text, sheets and images into one .docx.',
    category: 'Merge & combine', accepts: ['pdf', 'image', ...TEXT_KINDS], min: 1, ordered: true,
    options: [
      { key: 'titles', label: 'Add each file name as a heading', type: 'checkbox', default: false },
      { key: 'pageBreak', label: 'Start each file on a new page', type: 'checkbox', default: true },
      ...OCR_OPTS,
      OUT_NAME,
    ],
    note: 'For pure .docx inputs, "Merge Word documents" keeps formatting more faithfully.',
    async run(files, opts, progress) {
      const parts: string[] = [];
      for (const f of files) {
        const html = await toHtml(f, progress, sourceOpts(opts));
        parts.push(`${opts.titles ? `<h1>${escapeHtml(baseName(f.name))}</h1>` : ''}${html}`);
      }
      const blob = await htmlToDocx(parts.join(opts.pageBreak ? PAGE_BREAK : ''), 'Combined');
      return [{ name: outName(opts, `combined-${stamp()}`, 'docx'), blob }];
    },
  },
  {
    id: 'images-pdf', name: 'Images → PDF', desc: 'Turn photos / scans into one PDF, one image per page.',
    category: 'Merge & combine', accepts: ['image'], min: 1, ordered: true,
    options: [
      { key: 'pageSize', label: 'Page size', type: 'select', choices: [['a4', 'A4'], ['letter', 'US Letter'], ['fit', 'Same as image']], default: 'a4' },
      { key: 'margin', label: 'Margin', type: 'select', choices: [['0', 'None'], ['20', 'Small'], ['40', 'Normal']], default: '20', showIf: (o) => o.pageSize !== 'fit' },
      OUT_NAME,
    ],
    async run(files, opts, progress) {
      const bytes = await imagesToPdf(files.map((f) => ({ blob: f.blob, type: f.type })), { pageSize: String(opts.pageSize), margin: Number(opts.margin) }, progress);
      return [{ name: outName(opts, files.length === 1 ? baseName(files[0].name) : `images-${stamp()}`, 'pdf'), blob: pdf.pdfBlob(bytes) }];
    },
  },

  // ===== Scan & OCR =====
  {
    id: 'ocr-pdf', name: 'Make PDF searchable (OCR)', desc: 'Add selectable, searchable text to scanned PDFs or photos of documents.',
    category: 'Scan & OCR', accepts: ['pdf', 'image'], min: 1,
    options: [
      LANG,
      { key: 'dpi', label: 'Accuracy', type: 'select', choices: [['200', 'Fast'], ['300', 'Best (slower)']], default: '300' },
      { key: 'single', label: 'Images: put all into one PDF', type: 'checkbox', default: true },
    ],
    note: 'Runs fully offline and takes a few seconds per page. Pages that already have text are kept unchanged. Hindi text is recognised but not yet searchable inside the PDF.',
    async run(files, opts, progress) {
      const lang = opts.lang as OcrLang;
      const out: Output[] = [];
      const imgs = files.filter((f) => kindOf(f.name, f.type) === 'image');
      for (const f of files.filter((f) => kindOf(f.name, f.type) === 'pdf')) {
        const { bytes } = await pdf.ocrPdf(f.blob, lang, Number(opts.dpi), progress);
        out.push({ name: `${baseName(f.name)}-searchable.pdf`, blob: pdf.pdfBlob(bytes) });
      }
      const groups = opts.single ? (imgs.length ? [imgs] : []) : imgs.map((i) => [i]);
      for (const g of groups) {
        progress('Preparing images…');
        // Image pages are sized 1pt per pixel, so render them back at 72 dpi (= original resolution).
        const scan = await imagesToPdf(g.map((f) => ({ blob: f.blob, type: f.type })), { pageSize: 'fit', margin: 0 }, progress);
        const { bytes } = await pdf.ocrPdf(pdf.pdfBlob(scan), lang, 72, progress);
        out.push({ name: g.length === 1 ? `${baseName(g[0].name)}-searchable.pdf` : `scan-${stamp()}.pdf`, blob: pdf.pdfBlob(bytes) });
      }
      return out;
    },
  },
  {
    id: 'ocr-text', name: 'Scan → Word / text (OCR)', desc: 'Read the text from scanned PDFs or photos into an editable file.',
    category: 'Scan & OCR', accepts: ['pdf', 'image'], min: 1,
    options: [
      { key: 'format', label: 'Save as', type: 'select', choices: [['docx', 'Word (.docx)'], ['txt', 'Text (.txt)'], ['md', 'Markdown (.md)']], default: 'docx' },
      LANG,
      { key: 'single', label: 'Combine all files into one document', type: 'checkbox', default: false },
    ],
    note: 'Works offline. Accuracy depends on scan quality: straight, well-lit pages work best.',
    async run(files, opts, progress) {
      const target = opts.format as Target;
      const src = { ocr: true, ocrImages: true, lang: opts.lang as OcrLang, images: false };
      const htmls: { name: string; html: string }[] = [];
      for (let i = 0; i < files.length; i++) {
        progress(`Reading ${files[i].name} (${i + 1}/${files.length})…`);
        htmls.push({ name: baseName(files[i].name), html: await toHtml(files[i], progress, src) });
      }
      if (opts.single && htmls.length > 1) {
        const html = htmls.map((h) => h.html).join(PAGE_BREAK);
        return [{ name: `scan-${stamp()}.${target}`, blob: await fromHtml(html, target, 'Scan', opts, progress) }];
      }
      const out: Output[] = [];
      for (const h of htmls) out.push({ name: `${h.name}.${target}`, blob: await fromHtml(h.html, target, h.name, opts, progress) });
      return out;
    },
  },

  // ===== Security =====
  {
    id: 'unlock-pdf', name: 'Unlock PDF', desc: 'Remove the password from a PDF you have the password for.',
    category: 'Security', accepts: ['pdf'], min: 1, max: 1,
    options: [{ key: 'password', label: 'Current password', type: 'password', default: '' }],
    async run([f], opts) {
      const bytes = await pdf.unlockPdf(f.blob, String(opts.password));
      return [{ name: `${baseName(f.name)}-unlocked.pdf`, blob: pdf.pdfBlob(bytes) }];
    },
  },
  {
    id: 'protect-pdf', name: 'Protect PDF with password', desc: 'Require a password to open the PDF (AES-256).',
    category: 'Security', accepts: ['pdf'], min: 1,
    options: [
      { key: 'password', label: 'New password', type: 'password', default: '' },
      { key: 'confirm', label: 'Repeat password', type: 'password', default: '' },
      { key: 'allowPrint', label: 'Allow printing', type: 'checkbox', default: true },
      { key: 'allowCopy', label: 'Allow copying text', type: 'checkbox', default: true },
      { key: 'allowEdit', label: 'Allow editing', type: 'checkbox', default: false },
    ],
    note: 'Keep the password safe: it can\'t be recovered.',
    async run(files, opts) {
      if (opts.password !== opts.confirm) throw new Error('The two passwords don\'t match.');
      const out: Output[] = [];
      for (const f of files) {
        const bytes = await pdf.protectPdf(f.blob, { password: String(opts.password), allowPrint: !!opts.allowPrint, allowCopy: !!opts.allowCopy, allowEdit: !!opts.allowEdit });
        out.push({ name: `${baseName(f.name)}-protected.pdf`, blob: pdf.pdfBlob(bytes) });
      }
      return out;
    },
  },

  // ===== PDF tools =====
  {
    id: 'split-pdf', name: 'Split PDF', desc: 'Break a PDF into several smaller PDFs.',
    category: 'PDF tools', accepts: ['pdf'], min: 1, max: 1,
    options: [
      { key: 'mode', label: 'Split', type: 'select', choices: [['each', 'Every page into its own file'], ['every', 'Every N pages'], ['ranges', 'By custom ranges']], default: 'each' },
      { key: 'every', label: 'Pages per file', type: 'number', default: 2, min: 1, showIf: (o) => o.mode === 'every' },
      { key: 'ranges', label: 'Ranges (one file per range)', type: 'text', default: '', placeholder: 'e.g. 1-3, 4-7, 8-', showIf: (o) => o.mode === 'ranges' },
    ],
    async run([f], opts) {
      const parts = await pdf.splitPdf(f.blob, opts.mode as 'each', Number(opts.every), String(opts.ranges));
      return parts.map((p) => ({ name: `${baseName(f.name)}-${p.label}.pdf`, blob: pdf.pdfBlob(p.bytes) }));
    },
  },
  {
    id: 'extract-pages', name: 'Extract pages', desc: 'Copy selected pages into a new PDF.',
    category: 'PDF tools', accepts: ['pdf'], min: 1, max: 1,
    options: [{ key: 'ranges', label: 'Pages to keep', type: 'text', default: '', placeholder: 'e.g. 1-3, 5, 9-' }],
    async run([f], opts) {
      const total = await pdf.pageCount(f.blob);
      const bytes = await pdf.pickPages(f.blob, parseRanges(String(opts.ranges), total));
      return [{ name: `${baseName(f.name)}-extract.pdf`, blob: pdf.pdfBlob(bytes) }];
    },
  },
  {
    id: 'delete-pages', name: 'Delete pages', desc: 'Remove pages you don\'t need.',
    category: 'PDF tools', accepts: ['pdf'], min: 1, max: 1,
    options: [{ key: 'ranges', label: 'Pages to delete', type: 'text', default: '', placeholder: 'e.g. 2, 5-6' }],
    async run([f], opts) {
      return [{ name: `${baseName(f.name)}-edited.pdf`, blob: pdf.pdfBlob(await pdf.deletePages(f.blob, String(opts.ranges))) }];
    },
  },
  {
    id: 'reorder-pages', name: 'Reorder pages', desc: 'Rearrange or reverse page order.',
    category: 'PDF tools', accepts: ['pdf'], min: 1, max: 1,
    options: [
      { key: 'reverse', label: 'Simply reverse all pages', type: 'checkbox', default: false },
      { key: 'order', label: 'New page order', type: 'text', default: '', placeholder: 'e.g. 3, 1, 2, 4-', showIf: (o) => !o.reverse, help: 'Pages you leave out are dropped.' },
    ],
    async run([f], opts) {
      const total = await pdf.pageCount(f.blob);
      const idx = opts.reverse ? Array.from({ length: total }, (_, i) => total - 1 - i) : parseRanges(String(opts.order), total);
      if (!idx.length) throw new Error('Enter the new page order.');
      return [{ name: `${baseName(f.name)}-reordered.pdf`, blob: pdf.pdfBlob(await pdf.pickPages(f.blob, idx)) }];
    },
  },
  {
    id: 'rotate-pdf', name: 'Rotate pages', desc: 'Turn all or some pages.',
    category: 'PDF tools', accepts: ['pdf'], min: 1,
    options: [
      { key: 'angle', label: 'Rotate', type: 'select', choices: [['90', '90° clockwise'], ['180', '180°'], ['270', '90° anti-clockwise']], default: '90' },
      { key: 'ranges', label: 'Pages (blank = all)', type: 'text', default: '', placeholder: 'e.g. 1, 3-4' },
    ],
    async run(files, opts) {
      const out: Output[] = [];
      for (const f of files) out.push({ name: `${baseName(f.name)}-rotated.pdf`, blob: pdf.pdfBlob(await pdf.rotatePdf(f.blob, Number(opts.angle), String(opts.ranges))) });
      return out;
    },
  },
  {
    id: 'compress-pdf', name: 'Compress PDF', desc: 'Make a PDF smaller for sharing (e.g. WhatsApp, email).',
    category: 'PDF tools', accepts: ['pdf'], min: 1,
    options: [{
      key: 'mode', label: 'Compression', type: 'select', default: 'medium',
      choices: [['light', 'Light (best quality)'], ['medium', 'Recommended'], ['strong', 'Strong (smallest)'], ['lossless', 'Lossless (keeps text selectable, small savings)']],
    }],
    note: 'Light/Recommended/Strong turn pages into images: big savings, but text is no longer selectable.',
    async run(files, opts, progress) {
      const out: Output[] = [];
      for (const f of files) {
        const bytes = await pdf.compressPdf(f.blob, String(opts.mode), progress);
        const blob = bytes.length < f.blob.size ? pdf.pdfBlob(bytes) : f.blob;
        out.push({ name: `${baseName(f.name)}-compressed.pdf`, blob });
      }
      return out;
    },
  },
  {
    id: 'page-numbers', name: 'Add page numbers', desc: 'Stamp page numbers on every page.',
    category: 'PDF tools', accepts: ['pdf'], min: 1,
    options: [
      { key: 'position', label: 'Position', type: 'select', default: 'bottom-center', choices: [['bottom-center', 'Bottom centre'], ['bottom-right', 'Bottom right'], ['bottom-left', 'Bottom left'], ['top-center', 'Top centre'], ['top-right', 'Top right']] },
      { key: 'format', label: 'Format', type: 'select', default: 'n', choices: [['n', '1, 2, 3'], ['page-n', 'Page 1'], ['n-of-total', '1 of 10']] },
      { key: 'start', label: 'Start at', type: 'number', default: 1, min: 0 },
      { key: 'size', label: 'Font size', type: 'number', default: 10, min: 6, max: 36 },
    ],
    async run(files, opts) {
      const out: Output[] = [];
      for (const f of files) {
        const bytes = await pdf.addPageNumbers(f.blob, { position: String(opts.position), format: String(opts.format), start: Number(opts.start), size: Number(opts.size) });
        out.push({ name: `${baseName(f.name)}-numbered.pdf`, blob: pdf.pdfBlob(bytes) });
      }
      return out;
    },
  },
  {
    id: 'watermark', name: 'Add watermark', desc: 'Stamp text like CONFIDENTIAL or COPY across pages.',
    category: 'PDF tools', accepts: ['pdf'], min: 1,
    options: [
      { key: 'text', label: 'Watermark text', type: 'text', default: 'CONFIDENTIAL' },
      { key: 'size', label: 'Text size', type: 'number', default: 60, min: 10, max: 200 },
      { key: 'opacity', label: 'Opacity', type: 'select', default: '0.2', choices: [['0.1', 'Very light'], ['0.2', 'Light'], ['0.35', 'Medium'], ['0.6', 'Strong']] },
      { key: 'diagonal', label: 'Diagonal', type: 'checkbox', default: true },
    ],
    async run(files, opts) {
      if (!String(opts.text).trim()) throw new Error('Enter the watermark text.');
      const out: Output[] = [];
      for (const f of files) {
        const bytes = await pdf.addWatermark(f.blob, { text: String(opts.text), size: Number(opts.size), opacity: Number(opts.opacity), diagonal: !!opts.diagonal });
        out.push({ name: `${baseName(f.name)}-watermarked.pdf`, blob: pdf.pdfBlob(bytes) });
      }
      return out;
    },
  },
  {
    id: 'pdf-metadata', name: 'Edit PDF info', desc: 'Change title, author, subject and keywords.',
    category: 'PDF tools', accepts: ['pdf'], min: 1, max: 1,
    options: [
      { key: 'title', label: 'Title', type: 'text', default: '' },
      { key: 'author', label: 'Author', type: 'text', default: '' },
      { key: 'subject', label: 'Subject', type: 'text', default: '' },
      { key: 'keywords', label: 'Keywords (comma separated)', type: 'text', default: '' },
    ],
    async run([f], opts) {
      const bytes = await pdf.setMetadata(f.blob, { title: String(opts.title), author: String(opts.author), subject: String(opts.subject), keywords: String(opts.keywords) });
      return [{ name: f.name, blob: pdf.pdfBlob(bytes) }];
    },
  },

  // ===== From PDF =====
  convertTool('pdf-docx', 'PDF → Word', 'Editable .docx with the PDF\'s text, headings and paragraphs.', 'From PDF', ['pdf'], 'docx',
    'Keeps headings, paragraphs, bold/italic, pictures and two-column reading order. Complex layouts and tables become plain paragraphs.'),
  convertTool('pdf-txt', 'PDF → Text', 'Extract all text into a .txt file.', 'From PDF', ['pdf'], 'txt'),
  convertTool('pdf-md', 'PDF → Markdown', 'Extract text as Markdown.', 'From PDF', ['pdf'], 'md'),
  convertTool('pdf-html', 'PDF → HTML', 'Extract text as a web page.', 'From PDF', ['pdf'], 'html'),
  ...(['png', 'jpg'] as const).map((fmt): Tool => ({
    id: `pdf-${fmt}`, name: `PDF → ${fmt.toUpperCase()} images`, desc: `Save each page as a ${fmt.toUpperCase()} image.`,
    category: 'From PDF', accepts: ['pdf'], min: 1, max: 1,
    options: [
      { key: 'pages', label: 'Pages (blank = all)', type: 'text', default: '', placeholder: 'e.g. 1-3' },
      { key: 'dpi', label: 'Resolution', type: 'select', default: '150', choices: [['72', 'Low (72 dpi)'], ['150', 'Medium (150 dpi)'], ['300', 'High (300 dpi)']] },
      { key: 'zip', label: 'Pack multiple pages into one .zip', type: 'checkbox', default: true },
    ],
    async run([f], opts, progress) {
      const total = await pdf.pageCount(f.blob);
      const pages = String(opts.pages).trim() ? parseRanges(String(opts.pages), total) : undefined;
      const images: Output[] = [];
      await pdf.renderPages(f.blob, { dpi: Number(opts.dpi), format: fmt === 'png' ? 'image/png' : 'image/jpeg', quality: 0.9, pages }, progress, async (i, img) => {
        images.push({ name: `${baseName(f.name)}-page-${i + 1}.${fmt}`, blob: img });
      });
      if (images.length > 1 && opts.zip) {
        progress('Creating zip…');
        const zip = new JSZip();
        images.forEach((im) => zip.file(im.name, im.blob));
        return [{ name: `${baseName(f.name)}-${fmt}.zip`, blob: await zip.generateAsync({ type: 'blob', mimeType: 'application/zip' }) }];
      }
      return images;
    },
  })),

  // ===== To PDF =====
  convertTool('docx-pdf', 'Word → PDF', 'Convert .docx files to PDF.', 'To PDF', ['docx'], 'pdf',
    'Complex layouts (text boxes, columns, headers/footers) are simplified.'),
  convertTool('doc-pdf', 'Old Word (.doc) → PDF', 'Convert Word 97–2003 files to PDF.', 'To PDF', ['doc'], 'pdf',
    'Text and simple tables only; images and formatting in .doc files are not carried over.'),
  convertTool('pptx-pdf', 'PowerPoint → PDF', 'Convert .pptx slides to PDF, one slide per page.', 'To PDF', ['pptx'], 'pdf',
    'Text, pictures, shapes and tables are kept. Charts, SmartArt and animations are not.'),
  convertTool('txt-pdf', 'Text → PDF', 'Convert .txt files to PDF.', 'To PDF', ['text'], 'pdf'),
  convertTool('md-pdf', 'Markdown → PDF', 'Convert .md files to formatted PDF.', 'To PDF', ['md'], 'pdf'),
  convertTool('html-pdf', 'HTML → PDF', 'Convert saved web pages (.html) to PDF.', 'To PDF', ['html'], 'pdf'),
  convertTool('sheet-pdf', 'Excel / CSV → PDF', 'Convert spreadsheets to PDF tables.', 'To PDF', ['sheet'], 'pdf'),

  // ===== Word & text =====
  convertTool('docx-txt', 'Word → Text', 'Plain text from .docx.', 'Word & text', ['docx'], 'txt'),
  convertTool('docx-html', 'Word → HTML', 'Web page from .docx (images included).', 'Word & text', ['docx'], 'html'),
  convertTool('docx-md', 'Word → Markdown', 'Markdown from .docx.', 'Word & text', ['docx'], 'md'),
  convertTool('doc-docx', 'Old Word (.doc) → Word (.docx)', 'Upgrade Word 97–2003 files to editable .docx.', 'Word & text', ['doc'], 'docx',
    'Text and simple tables only; images and formatting in .doc files are not carried over.'),
  convertTool('doc-txt', 'Old Word (.doc) → Text', 'Plain text from Word 97–2003 files.', 'Word & text', ['doc'], 'txt'),
  convertTool('txt-docx', 'Text → Word', 'Turn .txt into an editable .docx.', 'Word & text', ['text'], 'docx'),
  convertTool('md-docx', 'Markdown → Word', 'Formatted .docx from Markdown.', 'Word & text', ['md'], 'docx'),
  convertTool('html-docx', 'HTML → Word', 'Editable .docx from a web page.', 'Word & text', ['html'], 'docx'),
  convertTool('md-html', 'Markdown → HTML', 'Web page from Markdown.', 'Word & text', ['md'], 'html'),
  convertTool('html-md', 'HTML → Markdown', 'Markdown from a web page.', 'Word & text', ['html'], 'md'),
  convertTool('html-txt', 'HTML → Text', 'Plain text from a web page.', 'Word & text', ['html'], 'txt'),

  // ===== PowerPoint =====
  convertTool('pptx-docx', 'PowerPoint → Word', 'Slide titles, text, pictures and tables as an editable .docx.', 'PowerPoint', ['pptx'], 'docx'),
  convertTool('pptx-txt', 'PowerPoint → Text', 'All slide text as plain text.', 'PowerPoint', ['pptx'], 'txt'),
  convertTool('pptx-md', 'PowerPoint → Markdown', 'Slide text as Markdown (great for notes).', 'PowerPoint', ['pptx'], 'md'),
  ...(['png', 'jpg'] as const).map((fmt): Tool => ({
    id: `pptx-${fmt}`, name: `PowerPoint → ${fmt.toUpperCase()} images`, desc: `Save each slide as a ${fmt.toUpperCase()} picture.`,
    category: 'PowerPoint', accepts: ['pptx'], min: 1, max: 1,
    options: [
      { key: 'scale', label: 'Resolution', type: 'select', choices: [['1', 'Normal'], ['2', 'High'], ['3', 'Very high']], default: '2' },
      { key: 'zip', label: 'Pack multiple slides into one .zip', type: 'checkbox', default: true },
    ],
    async run([f], opts, progress) {
      const imgs = await pptxToImages(f.blob, fmt === 'png' ? 'image/png' : 'image/jpeg', Number(opts.scale), progress);
      const named = imgs.map((b, i) => ({ name: `${baseName(f.name)}-slide-${i + 1}.${fmt}`, blob: b }));
      if (named.length > 1 && opts.zip) {
        const zip = new JSZip();
        named.forEach((im) => zip.file(im.name, im.blob));
        return [{ name: `${baseName(f.name)}-slides.zip`, blob: await zip.generateAsync({ type: 'blob', mimeType: 'application/zip' }) }];
      }
      return named;
    },
  })),

  // ===== Images =====
  ...([['png', 'image/png'], ['jpg', 'image/jpeg'], ['webp', 'image/webp']] as const).map(([fmt, type]): Tool => ({
    id: `img-${fmt}`, name: `Image → ${fmt.toUpperCase()}`, desc: `Convert images to ${fmt.toUpperCase()}.`,
    category: 'Images', accepts: ['image'], min: 1,
    options: fmt === 'png' ? undefined : [{ key: 'quality', label: 'Quality', type: 'select', default: '0.9', choices: [['0.6', 'Smaller file'], ['0.8', 'Balanced'], ['0.9', 'High'], ['1', 'Maximum']] }],
    async run(files, opts) {
      const out: Output[] = [];
      for (const f of files) out.push({ name: `${baseName(f.name)}.${fmt}`, blob: await convertImage(f.blob, type, Number(opts.quality) || 0.9) });
      return out;
    },
  })),
  {
    id: 'img-docx', name: 'Images → Word', desc: 'Place images into one .docx, one per page.',
    category: 'Images', accepts: ['image'], min: 1, ordered: true, options: [OUT_NAME],
    async run(files, opts, progress) {
      const parts: string[] = [];
      for (const f of files) parts.push(await toHtml(f, progress));
      return [{ name: outName(opts, files.length === 1 ? baseName(files[0].name) : `images-${stamp()}`, 'docx'), blob: await htmlToDocx(parts.join(PAGE_BREAK)) }];
    },
  },

  // ===== Spreadsheets =====
  {
    id: 'sheet-xlsx', name: 'CSV → Excel', desc: 'Convert CSV (or .xls/.ods) to .xlsx.',
    category: 'Spreadsheets', accepts: ['sheet'], min: 1,
    async run(files) {
      const out: Output[] = [];
      for (const f of files) {
        const wb = XLSX.read(await f.blob.arrayBuffer(), { type: 'array' });
        out.push({ name: `${baseName(f.name)}.xlsx`, blob: blobOf(XLSX.write(wb, { type: 'array', bookType: 'xlsx' }), 'xlsx') });
      }
      return out;
    },
  },
  {
    id: 'sheet-csv', name: 'Excel → CSV', desc: 'Each sheet becomes a .csv file.',
    category: 'Spreadsheets', accepts: ['sheet'], min: 1,
    async run(files) {
      const out: Output[] = [];
      for (const f of files) {
        const wb = XLSX.read(await f.blob.arrayBuffer(), { type: 'array' });
        for (const s of wb.SheetNames) {
          const csv = '﻿' + XLSX.utils.sheet_to_csv(wb.Sheets[s]);
          out.push({ name: `${baseName(f.name)}${wb.SheetNames.length > 1 ? `-${s}` : ''}.csv`, blob: blobOf(csv, 'csv') });
        }
      }
      return out;
    },
  },
  convertTool('sheet-html', 'Excel / CSV → HTML', 'Spreadsheet as a web page table.', 'Spreadsheets', ['sheet'], 'html'),
  convertTool('sheet-docx', 'Excel / CSV → Word', 'Spreadsheet as Word tables.', 'Spreadsheets', ['sheet'], 'docx'),
];

export const CATEGORIES: Category[] = ['Merge & combine', 'PDF tools', 'Scan & OCR', 'Security', 'From PDF', 'To PDF', 'Word & text', 'PowerPoint', 'Images', 'Spreadsheets'];

export function toolsFor(files: { name: string; type: string }[]): Tool[] {
  if (!files.length) return [];
  const kinds = files.map((f) => kindOf(f.name, f.type));
  return TOOLS.filter(
    (t) => kinds.every((k) => t.accepts.includes(k)) && files.length >= t.min && (t.max === undefined || files.length <= t.max),
  );
}

export function defaultOpts(tool: Tool): Opts {
  return Object.fromEntries((tool.options ?? []).map((o) => [o.key, o.default]));
}
