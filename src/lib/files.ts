// File-type helpers shared across the app.

export type Kind = 'pdf' | 'docx' | 'doc' | 'pptx' | 'image' | 'text' | 'md' | 'html' | 'sheet' | 'other';

const EXT_KIND: Record<string, Kind> = {
  pdf: 'pdf',
  docx: 'docx',
  doc: 'doc',
  pptx: 'pptx',
  png: 'image', jpg: 'image', jpeg: 'image', webp: 'image', gif: 'image', bmp: 'image',
  txt: 'text', log: 'text',
  md: 'md', markdown: 'md',
  html: 'html', htm: 'html',
  xlsx: 'sheet', xls: 'sheet', csv: 'sheet', ods: 'sheet',
};

export const KIND_LABEL: Record<Kind, string> = {
  pdf: 'PDF', docx: 'Word', doc: 'Word 97-2003', pptx: 'PowerPoint', image: 'Image', text: 'Text', md: 'Markdown', html: 'HTML', sheet: 'Spreadsheet', other: 'File',
};

export const MIME: Record<string, string> = {
  pdf: 'application/pdf',
  docx: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  doc: 'application/msword',
  pptx: 'application/vnd.openxmlformats-officedocument.presentationml.presentation',
  xlsx: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  csv: 'text/csv',
  txt: 'text/plain',
  md: 'text/markdown',
  html: 'text/html',
  png: 'image/png',
  jpg: 'image/jpeg',
  jpeg: 'image/jpeg',
  webp: 'image/webp',
  gif: 'image/gif',
  bmp: 'image/bmp',
  zip: 'application/zip',
  json: 'application/json',
};

export function ext(name: string): string {
  const m = /\.([a-z0-9]+)$/i.exec(name);
  return m ? m[1].toLowerCase() : '';
}

export function baseName(name: string): string {
  return name.replace(/\.[a-z0-9]+$/i, '');
}

export function kindOf(name: string, type = ''): Kind {
  const k = EXT_KIND[ext(name)];
  if (k) return k;
  if (type === 'application/pdf') return 'pdf';
  if (type.startsWith('image/')) return 'image';
  if (type.includes('wordprocessingml')) return 'docx';
  if (type === 'application/msword') return 'doc';
  if (type.includes('presentationml')) return 'pptx';
  if (type.includes('spreadsheetml') || type === 'text/csv') return 'sheet';
  if (type === 'text/html') return 'html';
  if (type === 'text/markdown') return 'md';
  if (type.startsWith('text/')) return 'text';
  return 'other';
}

export function mimeFor(name: string): string {
  return MIME[ext(name)] || 'application/octet-stream';
}

export function formatSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
}

export function formatDate(ts: number): string {
  return new Date(ts).toLocaleString(undefined, { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' });
}

/** Keep the original extension unless the user typed a new one. */
export function applyRename(oldName: string, input: string): string {
  const clean = input.trim().replace(/[\\/:*?"<>|]/g, '_');
  if (!clean) return oldName;
  return ext(clean) ? clean : `${clean}.${ext(oldName)}`;
}

/** Parse "1-3, 5, 8-" style page ranges into 0-based indices (keeps order, allows repeats). */
export function parseRanges(spec: string, total: number): number[] {
  const out: number[] = [];
  for (const part of spec.split(',').map((s) => s.trim()).filter(Boolean)) {
    const m = /^(\d*)\s*-\s*(\d*)$/.exec(part);
    if (m) {
      const a = m[1] ? parseInt(m[1], 10) : 1;
      const b = m[2] ? parseInt(m[2], 10) : total;
      const step = a <= b ? 1 : -1;
      for (let p = a; step > 0 ? p <= b : p >= b; p += step) out.push(p);
    } else if (/^\d+$/.test(part)) {
      out.push(parseInt(part, 10));
    } else {
      throw new Error(`Couldn't read page range "${part}". Use e.g. 1-3, 5, 8-`);
    }
  }
  const bad = out.find((p) => p < 1 || p > total);
  if (bad !== undefined) throw new Error(`Page ${bad} doesn't exist (document has ${total} pages).`);
  return out.map((p) => p - 1);
}

export async function blobToDataUrl(blob: Blob): Promise<string> {
  return new Promise((resolve, reject) => {
    const r = new FileReader();
    r.onload = () => resolve(r.result as string);
    r.onerror = () => reject(r.error);
    r.readAsDataURL(blob);
  });
}

export function escapeHtml(s: string): string {
  return s.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]!);
}
