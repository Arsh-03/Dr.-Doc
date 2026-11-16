import { PDFDocument } from '@cantoo/pdf-lib';
import type { Progress } from './pdf';

async function decode(blob: Blob): Promise<HTMLImageElement> {
  const url = URL.createObjectURL(blob);
  try {
    const img = new Image();
    img.src = url;
    await img.decode();
    return img;
  } catch {
    throw new Error('This image could not be opened.');
  } finally {
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  }
}

export async function convertImage(blob: Blob, mime: string, quality = 0.9): Promise<Blob> {
  const img = await decode(blob);
  const canvas = document.createElement('canvas');
  canvas.width = img.naturalWidth;
  canvas.height = img.naturalHeight;
  const ctx = canvas.getContext('2d')!;
  if (mime === 'image/jpeg') {
    ctx.fillStyle = '#fff';
    ctx.fillRect(0, 0, canvas.width, canvas.height);
  }
  ctx.drawImage(img, 0, 0);
  return new Promise((res, rej) => canvas.toBlob((b) => (b ? res(b) : rej(new Error('Image encoding failed'))), mime, quality));
}

const SIZES: Record<string, [number, number]> = { a4: [595.28, 841.89], letter: [612, 792] };

export async function imagesToPdf(
  blobs: { blob: Blob; type: string }[],
  opts: { pageSize: string; margin: number },
  progress: Progress,
): Promise<Uint8Array> {
  const pdf = await PDFDocument.create();
  for (let i = 0; i < blobs.length; i++) {
    progress(`Adding image ${i + 1} of ${blobs.length}…`);
    let { blob, type } = blobs[i];
    if (type !== 'image/jpeg' && type !== 'image/png') {
      blob = await convertImage(blob, 'image/jpeg', 0.92);
      type = 'image/jpeg';
    }
    const bytes = await blob.arrayBuffer();
    const img = type === 'image/png' ? await pdf.embedPng(bytes) : await pdf.embedJpg(bytes);

    if (opts.pageSize === 'fit') {
      pdf.addPage([img.width, img.height]).drawImage(img, { x: 0, y: 0, width: img.width, height: img.height });
      continue;
    }
    let [pw, ph] = SIZES[opts.pageSize] ?? SIZES.a4;
    if (img.width > img.height) [pw, ph] = [ph, pw]; // landscape page for landscape images
    const m = opts.margin;
    const scale = Math.min((pw - 2 * m) / img.width, (ph - 2 * m) / img.height, 1.5);
    const w = img.width * scale;
    const h = img.height * scale;
    pdf.addPage([pw, ph]).drawImage(img, { x: (pw - w) / 2, y: (ph - h) / 2, width: w, height: h });
  }
  return pdf.save();
}
