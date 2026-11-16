// Draw a run of text into a PDF page so it covers an exact box (used for real-text PDFs and OCR layers).
import {
  PDFDocument, PDFFont, PDFPage, StandardFonts, TextRenderingMode, popGraphicsState, pushGraphicsState,
  rgb, setCharacterSqueeze, setTextRenderingMode,
} from '@cantoo/pdf-lib';

export interface FontSet {
  regular: PDFFont; bold: PDFFont; italic: PDFFont; boldItalic: PDFFont;
  mono: PDFFont; monoBold: PDFFont;
}

export async function standardFonts(doc: PDFDocument): Promise<FontSet> {
  const [regular, bold, italic, boldItalic, mono, monoBold] = await Promise.all([
    StandardFonts.Helvetica, StandardFonts.HelveticaBold, StandardFonts.HelveticaOblique,
    StandardFonts.HelveticaBoldOblique, StandardFonts.Courier, StandardFonts.CourierBold,
  ].map((f) => doc.embedFont(f)));
  return { regular, bold, italic, boldItalic, mono, monoBold };
}

const SUBSTITUTE: Record<string, string> = {
  ' ': ' ', ' ': ' ', ' ': ' ', ' ': ' ', ' ': ' ', ' ': ' ',
  '−': '-', '‐': '-', '‑': '-', 'ﬁ': 'fi', 'ﬂ': 'fl', 'ﬀ': 'ff',
  '′': "'", '″': '"', '­': '',
};

/** Normalise typography the built-in PDF fonts can't encode; returns null if text still can't be encoded. */
export function encodable(text: string, font: PDFFont): string | null {
  const clean = text.replace(/[​-‍﻿]/g, '').replace(/[      −‐‑ﬀ-ﬂ′″­]/g, (c) => SUBSTITUTE[c]);
  try {
    font.encodeText(clean);
    font.widthOfTextAtSize(clean, 10);
    return clean;
  } catch {
    return null;
  }
}

/**
 * Draw `text` with its baseline at (x, y) in PDF points, horizontally squeezed/stretched to exactly `width`.
 * Invisible text is used for OCR layers: selectable and searchable but not painted.
 */
export function drawFitted(
  page: PDFPage, text: string, font: PDFFont,
  o: { x: number; y: number; size: number; width: number; color?: [number, number, number]; invisible?: boolean },
) {
  const natural = font.widthOfTextAtSize(text, o.size);
  if (natural <= 0 || o.size <= 0) return;
  const squeeze = Math.max(30, Math.min(300, (o.width / natural) * 100));
  page.pushOperators(pushGraphicsState(), setCharacterSqueeze(squeeze));
  if (o.invisible) page.pushOperators(setTextRenderingMode(TextRenderingMode.Invisible));
  const c = o.color ?? [0, 0, 0];
  page.drawText(text, { x: o.x, y: o.y, size: o.size, font, color: rgb(c[0], c[1], c[2]) });
  page.pushOperators(popGraphicsState());
}
