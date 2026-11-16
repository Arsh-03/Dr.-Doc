// Merge .docx files at the XML level so formatting, images, tables and styles survive.
// The first document supplies page setup, headers/footers and base styles.
import JSZip from 'jszip';
import type { Progress } from './pdf';

const W = 'http://schemas.openxmlformats.org/wordprocessingml/2006/main';
const R = 'http://schemas.openxmlformats.org/officeDocument/2006/relationships';
const PR = 'http://schemas.openxmlformats.org/package/2006/relationships';
const CT = 'http://schemas.openxmlformats.org/package/2006/content-types';

// Parts owned by the base document; references to these from appended docs are dropped.
const SKIP_REL = /\/(styles|stylesWithEffects|numbering|settings|webSettings|fontTable|theme|header|footer|footnotes|endnotes|comments|commentsExtended|commentsIds|people|customXml|glossaryDocument)$/;

const parse = (s: string) => new DOMParser().parseFromString(s, 'application/xml');
const serialize = (d: Document) => new XMLSerializer().serializeToString(d);

function resolve(base: string, target: string): string {
  if (target.startsWith('/')) return target.slice(1);
  const parts = base.split('/').slice(0, -1);
  for (const seg of target.split('/')) {
    if (seg === '..') parts.pop();
    else if (seg !== '.') parts.push(seg);
  }
  return parts.join('/');
}

function relsPath(part: string) {
  const i = part.lastIndexOf('/');
  return `${part.slice(0, i)}/_rels/${part.slice(i + 1)}.rels`;
}

class Merger {
  private ctDoc!: Document;
  private counter = 0;
  constructor(private zip: JSZip) {}

  async init() {
    this.ctDoc = parse(await this.zip.file('[Content_Types].xml')!.async('string'));
  }

  private contentTypeOf(srcCt: Document, path: string): { override?: string; ext: string; def?: string } {
    const ext = path.split('.').pop()!.toLowerCase();
    const override = Array.from(srcCt.getElementsByTagNameNS(CT, 'Override')).find((o) => o.getAttribute('PartName') === `/${path}`);
    const def = Array.from(srcCt.getElementsByTagNameNS(CT, 'Default')).find((d) => d.getAttribute('Extension')?.toLowerCase() === ext);
    return { override: override?.getAttribute('ContentType') ?? undefined, ext, def: def?.getAttribute('ContentType') ?? undefined };
  }

  private registerType(srcCt: Document, srcPath: string, dstPath: string) {
    const { override, ext, def } = this.contentTypeOf(srcCt, srcPath);
    const root = this.ctDoc.documentElement;
    if (override) {
      const el = this.ctDoc.createElementNS(CT, 'Override');
      el.setAttribute('PartName', `/${dstPath}`);
      el.setAttribute('ContentType', override);
      root.appendChild(el);
    } else if (def) {
      const exists = Array.from(this.ctDoc.getElementsByTagNameNS(CT, 'Default')).some((d) => d.getAttribute('Extension')?.toLowerCase() === ext);
      if (!exists) {
        const el = this.ctDoc.createElementNS(CT, 'Default');
        el.setAttribute('Extension', ext);
        el.setAttribute('ContentType', def);
        root.insertBefore(el, root.firstChild);
      }
    }
  }

  /** Copy a part (and, recursively, the internal parts it references) into the base package. */
  async copyPart(src: JSZip, srcCt: Document, srcPath: string, copied: Map<string, string>): Promise<string> {
    if (copied.has(srcPath)) return copied.get(srcPath)!;
    const file = src.file(srcPath);
    if (!file) return srcPath;
    const dir = srcPath.slice(0, srcPath.lastIndexOf('/'));
    const name = srcPath.slice(srcPath.lastIndexOf('/') + 1);
    const dstPath = `${dir}/m${++this.counter}_${name}`;
    copied.set(srcPath, dstPath);
    this.zip.file(dstPath, await file.async('uint8array'));
    this.registerType(srcCt, srcPath, dstPath);

    const rp = src.file(relsPath(srcPath));
    if (rp) {
      const rels = parse(await rp.async('string'));
      for (const rel of Array.from(rels.getElementsByTagNameNS(PR, 'Relationship'))) {
        if (rel.getAttribute('TargetMode') === 'External') continue;
        const target = resolve(srcPath, rel.getAttribute('Target')!);
        const newTarget = await this.copyPart(src, srcCt, target, copied);
        rel.setAttribute('Target', `/${newTarget}`);
      }
      this.zip.file(relsPath(dstPath), serialize(rels));
    }
    return dstPath;
  }

  finishContentTypes() {
    this.zip.file('[Content_Types].xml', serialize(this.ctDoc));
  }
}

export async function mergeDocx(blobs: Blob[], opts: { pageBreak: boolean }, progress: Progress): Promise<Blob> {
  progress('Opening first document…');
  const base = await JSZip.loadAsync(await blobs[0].arrayBuffer());
  if (!base.file('word/document.xml')) throw new Error('The first file is not a valid .docx document.');
  const merger = new Merger(base);
  await merger.init();

  const docPath = 'word/document.xml';
  const doc = parse(await base.file(docPath)!.async('string'));
  const body = doc.getElementsByTagNameNS(W, 'body')[0];
  const finalSectPr = Array.from(body.childNodes).find((n) => (n as Element).localName === 'sectPr') as Element | undefined;

  const relsFile = relsPath(docPath);
  const rels = parse(await base.file(relsFile)!.async('string'));
  const relRoot = rels.documentElement;

  const stylesFile = base.file('word/styles.xml');
  const styles = stylesFile ? parse(await stylesFile.async('string')) : null;
  const styleIds = new Set(styles ? Array.from(styles.getElementsByTagNameNS(W, 'style')).map((s) => s.getAttributeNS(W, 'styleId')) : []);

  const numberingFile = base.file('word/numbering.xml');
  const numbering = numberingFile ? parse(await numberingFile.async('string')) : null;

  let relCounter = 0;

  for (let i = 1; i < blobs.length; i++) {
    progress(`Merging document ${i + 1} of ${blobs.length}…`);
    const src = await JSZip.loadAsync(await blobs[i].arrayBuffer());
    const srcDocFile = src.file(docPath);
    if (!srcDocFile) throw new Error(`File ${i + 1} is not a valid .docx document.`);
    const srcCt = parse(await src.file('[Content_Types].xml')!.async('string'));
    const srcDoc = parse(await srcDocFile.async('string'));
    const srcBody = srcDoc.getElementsByTagNameNS(W, 'body')[0];
    const srcRelsFile = src.file(relsPath(docPath));
    const srcRels = srcRelsFile ? parse(await srcRelsFile.async('string')) : null;

    // Bring over relationships (images, links, charts, embedded objects…).
    const idMap = new Map<string, string>();
    const copied = new Map<string, string>();
    for (const rel of srcRels ? Array.from(srcRels.getElementsByTagNameNS(PR, 'Relationship')) : []) {
      const type = rel.getAttribute('Type') || '';
      if (SKIP_REL.test(type)) continue;
      const newId = `rIdDd${++relCounter}`;
      const nrel = rels.createElementNS(PR, 'Relationship');
      nrel.setAttribute('Id', newId);
      nrel.setAttribute('Type', type);
      if (rel.getAttribute('TargetMode') === 'External') {
        nrel.setAttribute('Target', rel.getAttribute('Target')!);
        nrel.setAttribute('TargetMode', 'External');
      } else {
        const target = resolve(docPath, rel.getAttribute('Target')!);
        const dst = await merger.copyPart(src, srcCt, target, copied);
        nrel.setAttribute('Target', dst.startsWith('word/') ? dst.slice(5) : `/${dst}`);
      }
      relRoot.appendChild(nrel);
      idMap.set(rel.getAttribute('Id')!, newId);
    }

    // Copy styles the base document doesn't have, so headings etc. keep their look.
    const srcStylesFile = src.file('word/styles.xml');
    if (styles && srcStylesFile) {
      const srcStyles = parse(await srcStylesFile.async('string'));
      for (const st of Array.from(srcStyles.getElementsByTagNameNS(W, 'style'))) {
        const id = st.getAttributeNS(W, 'styleId');
        if (id && !styleIds.has(id)) {
          styles.documentElement.appendChild(styles.importNode(st, true));
          styleIds.add(id);
        }
      }
    }

    // Bring over list definitions under new ids so bullets/numbering keep their look.
    const numOffset = i * 1000;
    const srcNumberingFile = src.file('word/numbering.xml');
    const importLists = !!(numbering && srcNumberingFile);
    if (numbering && srcNumberingFile) {
      const srcNumbering = parse(await srcNumberingFile.async('string'));
      const root = numbering.documentElement;
      const firstNum = numbering.getElementsByTagNameNS(W, 'num')[0] ?? null;
      for (const an of Array.from(srcNumbering.getElementsByTagNameNS(W, 'abstractNum'))) {
        const copy = numbering.importNode(an, true) as Element;
        copy.setAttributeNS(W, 'w:abstractNumId', String(Number(an.getAttributeNS(W, 'abstractNumId')) + numOffset));
        copy.getElementsByTagNameNS(W, 'nsid')[0]?.remove();
        root.insertBefore(copy, firstNum); // schema order: all abstractNum before num
      }
      for (const num of Array.from(srcNumbering.getElementsByTagNameNS(W, 'num'))) {
        const copy = numbering.importNode(num, true) as Element;
        copy.setAttributeNS(W, 'w:numId', String(Number(num.getAttributeNS(W, 'numId')) + numOffset));
        const abs = copy.getElementsByTagNameNS(W, 'abstractNumId')[0];
        abs?.setAttributeNS(W, 'w:val', String(Number(abs.getAttributeNS(W, 'val')) + numOffset));
        root.appendChild(copy);
      }
    }

    // Remap relationship ids and strip references to parts we didn't bring over.
    for (const el of Array.from(srcBody.getElementsByTagName('*'))) {
      if (importLists && el.localName === 'numId' && el.namespaceURI === W) {
        const v = Number(el.getAttributeNS(W, 'val'));
        if (v) el.setAttributeNS(W, 'w:val', String(v + numOffset));
      }
      for (const attr of Array.from(el.attributes)) {
        if (attr.namespaceURI === R) {
          const mapped = idMap.get(attr.value);
          if (mapped) el.setAttributeNS(R, attr.name, mapped);
        }
      }
      if (['footnoteReference', 'endnoteReference', 'commentReference', 'commentRangeStart', 'commentRangeEnd'].includes(el.localName)) {
        el.parentNode?.removeChild(el);
      }
      if (el.localName === 'bookmarkStart' || el.localName === 'bookmarkEnd') {
        const id = el.getAttributeNS(W, 'id');
        if (id) el.setAttributeNS(W, 'w:id', String(Number(id) + i * 100000));
      }
    }

    if (opts.pageBreak) {
      const p = doc.createElementNS(W, 'w:p');
      const r = doc.createElementNS(W, 'w:r');
      const br = doc.createElementNS(W, 'w:br');
      br.setAttributeNS(W, 'w:type', 'page');
      r.appendChild(br);
      p.appendChild(r);
      body.insertBefore(p, finalSectPr ?? null);
    }
    for (const node of Array.from(srcBody.childNodes)) {
      if ((node as Element).localName === 'sectPr') continue;
      body.insertBefore(doc.importNode(node, true), finalSectPr ?? null);
    }
  }

  // Drawing ids must be unique across the merged document or Word reports corruption.
  let drawingId = 1;
  for (const el of Array.from(doc.getElementsByTagName('*'))) {
    if (el.localName === 'docPr') el.setAttribute('id', String(drawingId++));
  }

  progress('Packaging merged document…');
  base.file(docPath, serialize(doc));
  base.file(relsFile, serialize(rels));
  if (styles) base.file('word/styles.xml', serialize(styles));
  if (numbering) base.file('word/numbering.xml', serialize(numbering));
  merger.finishContentTypes();
  return base.generateAsync({
    type: 'blob',
    mimeType: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
    compression: 'DEFLATE',
  });
}
