import {
  AlignmentType, Document, ExternalHyperlink, HeadingLevel, ImageRun, LevelFormat, Packer, PageBreak,
  Paragraph, Table, TableCell, TableRow, TextRun, WidthType, type ParagraphChild,
} from 'docx';

type Block = Paragraph | Table;
interface RunStyle { bold?: boolean; italics?: boolean; underline?: boolean; strike?: boolean; code?: boolean; link?: string }
interface Img { data: Uint8Array; type: 'png' | 'jpg' | 'gif' | 'bmp'; w: number; h: number }

const HEADINGS: Record<string, (typeof HeadingLevel)[keyof typeof HeadingLevel]> = {
  H1: HeadingLevel.HEADING_1, H2: HeadingLevel.HEADING_2, H3: HeadingLevel.HEADING_3,
  H4: HeadingLevel.HEADING_4, H5: HeadingLevel.HEADING_5, H6: HeadingLevel.HEADING_6,
};
const MAX_IMG_W = 600; // px, ≈ printable width of A4

/** Decode every <img> into bytes Word can embed (converting webp/svg to png). */
async function loadImages(root: HTMLElement): Promise<Map<string, Img>> {
  const map = new Map<string, Img>();
  for (const el of Array.from(root.querySelectorAll('img'))) {
    const src = el.getAttribute('src') || '';
    if (!src || map.has(src)) continue;
    try {
      const img = new Image();
      img.src = src;
      await img.decode();
      let w = img.naturalWidth || 300;
      let h = img.naturalHeight || 200;
      const m = /^data:image\/(png|jpe?g|gif|bmp)/.exec(src);
      let data: Uint8Array;
      let type: Img['type'];
      if (m) {
        data = Uint8Array.from(atob(src.split(',')[1]), (c) => c.charCodeAt(0));
        type = m[1].startsWith('jp') ? 'jpg' : (m[1] as Img['type']);
      } else {
        const c = document.createElement('canvas');
        c.width = w; c.height = h;
        c.getContext('2d')!.drawImage(img, 0, 0);
        const blob = await new Promise<Blob | null>((r) => c.toBlob(r, 'image/png'));
        if (!blob) continue;
        data = new Uint8Array(await blob.arrayBuffer());
        type = 'png';
      }
      if (w > MAX_IMG_W) { h = Math.round((h * MAX_IMG_W) / w); w = MAX_IMG_W; }
      map.set(src, { data, type, w, h });
    } catch {
      /* skip images that can't be decoded */
    }
  }
  return map;
}

export async function htmlToDocx(html: string, title = 'Document'): Promise<Blob> {
  const root = document.createElement('div');
  root.innerHTML = html;
  const images = await loadImages(root);
  let listInstance = 0;

  const runs = (node: Node, style: RunStyle): ParagraphChild[] => {
    if (node.nodeType === Node.TEXT_NODE) {
      const text = (node.textContent || '').replace(/\s+/g, ' ');
      if (!text) return [];
      const run = new TextRun({
        text,
        bold: style.bold, italics: style.italics, strike: style.strike,
        underline: style.underline || style.link ? {} : undefined,
        font: style.code ? 'Consolas' : undefined,
        color: style.link ? '1155CC' : undefined,
      });
      return [run];
    }
    if (node.nodeType !== Node.ELEMENT_NODE) return [];
    const el = node as HTMLElement;
    const tag = el.tagName;
    if (tag === 'BR') return [new TextRun({ text: '', break: 1 })];
    if (tag === 'IMG') {
      const img = images.get(el.getAttribute('src') || '');
      return img ? [new ImageRun({ type: img.type, data: img.data, transformation: { width: img.w, height: img.h } })] : [];
    }
    const next: RunStyle = { ...style };
    if (tag === 'B' || tag === 'STRONG' || tag === 'TH') next.bold = true;
    if (tag === 'I' || tag === 'EM') next.italics = true;
    if (tag === 'U') next.underline = true;
    if (tag === 'S' || tag === 'DEL' || tag === 'STRIKE') next.strike = true;
    if (tag === 'CODE') next.code = true;
    const children = Array.from(el.childNodes).flatMap((c) => runs(c, next));
    if (tag === 'A' && el.getAttribute('href')?.startsWith('http')) {
      return [new ExternalHyperlink({ link: el.getAttribute('href')!, children: children.filter((c) => c instanceof TextRun) as TextRun[] })];
    }
    return children;
  };

  const INLINE = new Set(['A', 'B', 'STRONG', 'I', 'EM', 'U', 'S', 'DEL', 'STRIKE', 'CODE', 'SPAN', 'SUB', 'SUP', 'BR', 'IMG', 'SMALL', 'MARK', 'FONT', 'LABEL']);

  const blocks = (node: Node, ctx: { list?: { ordered: boolean; level: number; instance: number } } = {}): Block[] => {
    const out: Block[] = [];
    let pending: ParagraphChild[] = [];
    const flushInline = () => {
      if (pending.length) out.push(new Paragraph({ children: pending }));
      pending = [];
    };
    for (const child of Array.from(node.childNodes)) {
      if (child.nodeType === Node.TEXT_NODE) {
        if (child.textContent?.trim()) pending.push(...runs(child, {}));
        continue;
      }
      if (child.nodeType !== Node.ELEMENT_NODE) continue;
      const el = child as HTMLElement;
      const tag = el.tagName;
      if (INLINE.has(tag)) { pending.push(...runs(el, {})); continue; }
      flushInline();

      if (el.classList.contains('dd-pagebreak')) {
        out.push(new Paragraph({ children: [new PageBreak()] }));
      } else if (HEADINGS[tag]) {
        out.push(new Paragraph({ heading: HEADINGS[tag], children: runs(el, {}) }));
      } else if (tag === 'P' || (tag === 'DIV' && !el.querySelector('p,div,table,ul,ol,h1,h2,h3,h4,h5,h6'))) {
        out.push(new Paragraph({ children: runs(el, {}) }));
      } else if (tag === 'PRE') {
        const lines = (el.textContent || '').split('\n');
        out.push(new Paragraph({
          children: lines.map((l, i) => new TextRun({ text: l, font: 'Consolas', size: 19, break: i ? 1 : 0 })),
        }));
      } else if (tag === 'BLOCKQUOTE') {
        out.push(...blocks(el, ctx));
      } else if (tag === 'UL' || tag === 'OL') {
        const level = ctx.list ? Math.min(ctx.list.level + 1, 8) : 0;
        const instance = tag === 'OL' ? (ctx.list?.ordered && level > 0 ? ctx.list.instance : ++listInstance) : 0;
        for (const li of Array.from(el.children)) {
          const inline: ParagraphChild[] = [];
          const nested: Block[] = [];
          for (const c of Array.from(li.childNodes)) {
            const cel = c as HTMLElement;
            if (c.nodeType === Node.ELEMENT_NODE && (cel.tagName === 'UL' || cel.tagName === 'OL')) {
              nested.push(...blocks({ childNodes: [c] } as unknown as Node, { list: { ordered: tag === 'OL', level, instance } }));
            } else if (c.nodeType === Node.ELEMENT_NODE && cel.tagName === 'P') {
              inline.push(...runs(c, {}));
            } else inline.push(...runs(c, {}));
          }
          out.push(new Paragraph({
            children: inline,
            ...(tag === 'OL' ? { numbering: { reference: 'dd-num', level, instance } } : { bullet: { level } }),
          }));
          out.push(...nested);
        }
      } else if (tag === 'TABLE') {
        const rows = Array.from(el.querySelectorAll('tr')).filter((tr) => tr.closest('table') === el);
        const cols = Math.max(1, ...rows.map((r) => Array.from(r.children).reduce((n, c) => n + ((c as HTMLTableCellElement).colSpan || 1), 0)));
        if (rows.length) {
          out.push(new Table({
            width: { size: 100, type: WidthType.PERCENTAGE },
            rows: rows.map((tr) => new TableRow({
              tableHeader: tr.parentElement?.tagName === 'THEAD',
              children: Array.from(tr.children).map((td) => {
                const cell = td as HTMLTableCellElement;
                const inner = blocks(cell).filter((b) => b instanceof Paragraph) as Paragraph[];
                return new TableCell({
                  columnSpan: cell.colSpan > 1 ? cell.colSpan : undefined,
                  rowSpan: cell.rowSpan > 1 ? cell.rowSpan : undefined,
                  width: { size: Math.floor(100 / cols) * (cell.colSpan || 1), type: WidthType.PERCENTAGE },
                  children: inner.length ? inner : [new Paragraph({ children: runs(cell, cell.tagName === 'TH' ? { bold: true } : {}) })],
                });
              }),
            })),
          }));
          out.push(new Paragraph({ children: [] }));
        }
      } else {
        out.push(...blocks(el, ctx));
      }
    }
    flushInline();
    return out;
  };

  const children = blocks(root);
  const doc = new Document({
    title,
    creator: 'Dr.Doc',
    styles: { default: { document: { run: { font: 'Calibri', size: 22 } } } },
    numbering: {
      config: [{
        reference: 'dd-num',
        levels: Array.from({ length: 9 }, (_, level) => ({
          level,
          format: [LevelFormat.DECIMAL, LevelFormat.LOWER_LETTER, LevelFormat.LOWER_ROMAN][level % 3],
          text: `%${level + 1}.`,
          alignment: AlignmentType.START,
          style: { paragraph: { indent: { left: 720 * (level + 1), hanging: 360 } } },
        })),
      }],
    },
    sections: [{ children: children.length ? children : [new Paragraph('')] }],
  });
  return Packer.toBlob(doc);
}
