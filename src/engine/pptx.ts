// PowerPoint (.pptx) reader: renders slides as positioned HTML (for PDF / images) and as
// flowing HTML (for Word / text). Covers text boxes, placeholders, pictures, basic shapes and tables.
import JSZip from 'jszip';
import { escapeHtml } from '../lib/files';
import { PAGE_BREAK_HTML } from './constants';

const P = 'http://schemas.openxmlformats.org/presentationml/2006/main';
const A = 'http://schemas.openxmlformats.org/drawingml/2006/main';
const R = 'http://schemas.openxmlformats.org/officeDocument/2006/relationships';
const EMU_PX = 9525; // EMU per CSS px at 96 dpi

const parse = (s: string) => new DOMParser().parseFromString(s, 'application/xml');
const kids = (el: Element | null | undefined, ns: string, name: string) =>
  el ? Array.from(el.children).filter((c) => c.namespaceURI === ns && c.localName === name) : [];
const kid = (el: Element | null | undefined, ns: string, name: string) => kids(el, ns, name)[0] ?? null;
const desc = (el: Element | null | undefined, ns: string, name: string) => (el ? el.getElementsByTagNameNS(ns, name)[0] ?? null : null);

function resolvePath(base: string, target: string) {
  if (target.startsWith('/')) return target.slice(1);
  const parts = base.split('/').slice(0, -1);
  for (const s of target.split('/')) s === '..' ? parts.pop() : s !== '.' && parts.push(s);
  return parts.join('/');
}

async function rels(zip: JSZip, part: string): Promise<Map<string, string>> {
  const i = part.lastIndexOf('/');
  const f = zip.file(`${part.slice(0, i)}/_rels/${part.slice(i + 1)}.rels`);
  const map = new Map<string, string>();
  if (!f) return map;
  for (const r of Array.from(parse(await f.async('string')).getElementsByTagName('Relationship'))) {
    if (r.getAttribute('TargetMode') !== 'External') map.set(r.getAttribute('Id')!, resolvePath(part, r.getAttribute('Target')!));
  }
  return map;
}

interface Box { x: number; y: number; w: number; h: number }
interface Placeholder { type: string; idx: string }

export interface Slide { index: number; html: string; flow: string }
export interface Deck { width: number; height: number; slides: Slide[] }

export async function readPptx(blob: Blob): Promise<Deck> {
  let zip: JSZip;
  try {
    zip = await JSZip.loadAsync(await blob.arrayBuffer());
  } catch {
    throw new Error('This is not a valid .pptx file. (Old .ppt files are not supported.)');
  }
  const presFile = zip.file('ppt/presentation.xml');
  if (!presFile) throw new Error('This is not a valid .pptx file.');
  const pres = parse(await presFile.async('string'));
  const sz = desc(pres.documentElement, P, 'sldSz');
  const width = Number(sz?.getAttribute('cx') ?? 12192000) / EMU_PX;
  const height = Number(sz?.getAttribute('cy') ?? 6858000) / EMU_PX;
  const presRels = await rels(zip, 'ppt/presentation.xml');

  // Theme colours (schemeClr → hex)
  const theme = new Map<string, string>();
  const themePath = [...presRels.values()].find((p) => /theme\d*\.xml$/.test(p)) ?? 'ppt/theme/theme1.xml';
  const themeFile = zip.file(themePath);
  if (themeFile) {
    const scheme = desc(parse(await themeFile.async('string')).documentElement, A, 'clrScheme');
    for (const c of Array.from(scheme?.children ?? [])) {
      const v = desc(c, A, 'srgbClr')?.getAttribute('val') ?? desc(c, A, 'sysClr')?.getAttribute('lastClr');
      if (v) theme.set(c.localName, `#${v}`);
    }
  }
  const alias: Record<string, string> = { tx1: 'dk1', bg1: 'lt1', tx2: 'dk2', bg2: 'lt2' };
  const color = (el: Element | null): string | null => {
    if (!el) return null;
    const s = kid(el, A, 'srgbClr')?.getAttribute('val');
    if (s) return `#${s}`;
    const sc = kid(el, A, 'schemeClr')?.getAttribute('val');
    if (sc) return theme.get(alias[sc] ?? sc) ?? null;
    const sys = kid(el, A, 'sysClr')?.getAttribute('lastClr');
    return sys ? `#${sys}` : null;
  };

  const sldIds = kids(desc(pres.documentElement, P, 'sldIdLst'), P, 'sldId');
  const slides: Slide[] = [];
  const layoutCache = new Map<string, Document>();
  const loadXml = async (path: string) => {
    if (!layoutCache.has(path)) {
      const f = zip.file(path);
      if (!f) return null;
      layoutCache.set(path, parse(await f.async('string')));
    }
    return layoutCache.get(path)!;
  };

  for (let s = 0; s < sldIds.length; s++) {
    const path = presRels.get(sldIds[s].getAttributeNS(R, 'id') ?? '');
    if (!path || !zip.file(path)) continue;
    const doc = parse(await zip.file(path)!.async('string'));
    const sRels = await rels(zip, path);
    const layoutPath = [...sRels.values()].find((p) => p.includes('slideLayout'));
    const layout = layoutPath ? await loadXml(layoutPath) : null;
    const masterPath = layoutPath ? [...(await rels(zip, layoutPath)).values()].find((p) => p.includes('slideMaster')) : undefined;
    const master = masterPath ? await loadXml(masterPath) : null;

    const phOf = (sp: Element): Placeholder | null => {
      const ph = desc(sp, P, 'ph');
      return ph ? { type: ph.getAttribute('type') ?? 'body', idx: ph.getAttribute('idx') ?? '' } : null;
    };
    const inherited = (ph: Placeholder): Box | null => {
      for (const d of [layout, master]) {
        if (!d) continue;
        for (const sp of Array.from(d.getElementsByTagNameNS(P, 'sp'))) {
          const o = phOf(sp);
          if (!o) continue;
          const same = (ph.idx && o.idx === ph.idx) || (o.type === ph.type) || (ph.type === 'ctrTitle' && o.type === 'title') || (ph.type === 'subTitle' && o.type === 'body');
          if (same) {
            const b = xfrm(desc(sp, A, 'xfrm'));
            if (b) return b;
          }
        }
      }
      return null;
    };

    const bg = color(desc(desc(doc.documentElement, P, 'bg'), A, 'solidFill')) ?? '#ffffff';
    const parts: string[] = [];
    const flow: string[] = [];
    let title = '';

    const imgSrc = async (relId: string | null, relMap: Map<string, string>) => {
      const target = relId ? relMap.get(relId) : undefined;
      const f = target ? zip.file(target) : null;
      if (!f) return null;
      const ext = target!.split('.').pop()!.toLowerCase();
      const mime = ext === 'jpg' || ext === 'jpeg' ? 'image/jpeg' : ext === 'png' ? 'image/png' : ext === 'gif' ? 'image/gif' : ext === 'svg' ? 'image/svg+xml' : ext === 'bmp' ? 'image/bmp' : null;
      return mime ? `data:${mime};base64,${await f.async('base64')}` : null;
    };

    const textBody = (txBody: Element | null, ph: Placeholder | null, scale: number) => {
      if (!txBody) return { html: '', flow: '' };
      const isTitle = ph?.type === 'title' || ph?.type === 'ctrTitle';
      const defSize = isTitle ? 40 : ph ? 24 : 18;
      const autoFit = desc(txBody, A, 'normAutofit');
      const fontScale = Number(autoFit?.getAttribute('fontScale') ?? 100000) / 100000;
      const bulleted = !!ph && !isTitle && ph.type !== 'subTitle' && ph.type !== 'sldNum' && ph.type !== 'dt' && ph.type !== 'ftr';
      const html: string[] = [];
      const fl: string[] = [];
      for (const p of kids(txBody, A, 'p')) {
        const pPr = kid(p, A, 'pPr');
        const algn = pPr?.getAttribute('algn');
        const lvl = Number(pPr?.getAttribute('lvl') ?? 0);
        const runs: string[] = [];
        let maxSize = 0;
        for (const r of Array.from(p.children)) {
          if (r.localName === 'br') { runs.push('<br>'); continue; }
          if (r.localName !== 'r' && r.localName !== 'fld') continue;
          const t = desc(r, A, 't')?.textContent ?? '';
          const rPr = kid(r, A, 'rPr');
          const size = (Number(rPr?.getAttribute('sz') ?? 0) / 100 || defSize) * fontScale;
          maxSize = Math.max(maxSize, size);
          const c = color(kid(rPr, A, 'solidFill'));
          const style = [`font-size:${(size * scale * 96) / 72}px`, c ? `color:${c}` : '', rPr?.getAttribute('b') === '1' || isTitle ? 'font-weight:700' : '', rPr?.getAttribute('i') === '1' ? 'font-style:italic' : '', rPr?.getAttribute('u') && rPr.getAttribute('u') !== 'none' ? 'text-decoration:underline' : ''].filter(Boolean).join(';');
          runs.push(`<span style="${style}">${escapeHtml(t)}</span>`);
        }
        const plain = runs.join('').replace(/<[^>]+>/g, '');
        const hasText = plain.trim().length > 0;
        const noBullet = !!desc(pPr, A, 'buNone');
        const bullet = (bulleted && !noBullet && hasText) || !!desc(pPr, A, 'buChar') || !!desc(pPr, A, 'buAutoNum');
        const size = ((maxSize || defSize) * scale * 96) / 72;
        html.push(`<div style="text-align:${algn === 'ctr' ? 'center' : algn === 'r' ? 'right' : algn === 'just' ? 'justify' : 'left'};padding-left:${(bullet ? 1.1 : 0) * size + lvl * size}px;text-indent:${bullet ? -0.9 * size : 0}px;min-height:${hasText ? 0 : size * 1.1}px;line-height:1.15">${bullet ? `<span style="font-size:${size}px">•&nbsp;</span>` : ''}${runs.join('')}</div>`);
        if (hasText) fl.push(bullet ? `<li>${escapeHtml(plain)}</li>` : `<p>${escapeHtml(plain)}</p>`);
        if (isTitle && hasText && !title) title = plain.trim();
      }
      const flowHtml = fl.join('').replace(/(<li>.*?<\/li>)+/g, (m) => `<ul>${m}</ul>`);
      return { html: html.join(''), flow: isTitle ? '' : flowHtml };
    };

    // Recursively render the shape tree; groups map child coordinates into slide space.
    const walk = async (tree: Element, map: (b: Box) => Box) => {
      for (const el of Array.from(tree.children)) {
        const name = el.localName;
        if (name === 'grpSp') {
          const gx = desc(kid(el, P, 'grpSpPr'), A, 'xfrm');
          const off = xfrm(gx);
          const chOff = kid(gx, A, 'chOff');
          const chExt = kid(gx, A, 'chExt');
          if (off && chOff && chExt) {
            const cx = Number(chOff.getAttribute('x')) / EMU_PX, cy = Number(chOff.getAttribute('y')) / EMU_PX;
            const cw = Number(chExt.getAttribute('cx')) / EMU_PX || 1, ch = Number(chExt.getAttribute('cy')) / EMU_PX || 1;
            await walk(el, (b) => map({ x: off.x + (b.x - cx) * (off.w / cw), y: off.y + (b.y - cy) * (off.h / ch), w: b.w * (off.w / cw), h: b.h * (off.h / ch) }));
          } else await walk(el, map);
        } else if (name === 'sp') {
          const ph = phOf(el);
          if (ph && ['sldNum', 'dt', 'ftr'].includes(ph.type) && !desc(el, A, 't')?.textContent) continue;
          const spPr = kid(el, P, 'spPr');
          let box = xfrm(desc(spPr, A, 'xfrm')) ?? (ph ? inherited(ph) : null);
          if (!box) continue;
          box = map(box);
          const fill = color(kid(spPr, A, 'solidFill'));
          const ln = kid(spPr, A, 'ln');
          const lineColor = ln && !kid(ln, A, 'noFill') ? color(kid(ln, A, 'solidFill')) : null;
          const lineW = ln ? Math.max(1, Number(ln.getAttribute('w') ?? 12700) / EMU_PX) : 0;
          const geom = desc(spPr, A, 'prstGeom')?.getAttribute('prst') ?? 'rect';
          const radius = geom === 'ellipse' ? '50%' : geom === 'roundRect' ? '12px' : '0';
          const body = kid(el, P, 'txBody');
          const bodyPr = kid(body, A, 'bodyPr');
          const anchor = bodyPr?.getAttribute('anchor') ?? (ph?.type === 'ctrTitle' || ph?.type === 'title' ? 'ctr' : 't');
          const ins = (k: string, d: number) => Number(bodyPr?.getAttribute(k) ?? d) / EMU_PX;
          const tb = textBody(body, ph, 1);
          parts.push(`<div style="position:absolute;left:${box.x}px;top:${box.y}px;width:${box.w}px;height:${box.h}px;box-sizing:border-box;${fill ? `background:${fill};` : ''}${lineColor ? `border:${lineW}px solid ${lineColor};` : ''}border-radius:${radius};padding:${ins('tIns', 45720)}px ${ins('rIns', 91440)}px ${ins('bIns', 45720)}px ${ins('lIns', 91440)}px;display:flex;flex-direction:column;justify-content:${anchor === 'ctr' ? 'center' : anchor === 'b' ? 'flex-end' : 'flex-start'};overflow:hidden;color:${theme.get('dk1') ?? '#000'}">${tb.html}</div>`);
          if (tb.flow) flow.push(tb.flow);
        } else if (name === 'pic') {
          const box0 = xfrm(desc(kid(el, P, 'spPr'), A, 'xfrm'));
          const src = await imgSrc(desc(el, A, 'blip')?.getAttributeNS(R, 'embed') ?? null, sRels);
          if (!box0 || !src) continue;
          const box = map(box0);
          parts.push(`<img src="${src}" style="position:absolute;left:${box.x}px;top:${box.y}px;width:${box.w}px;height:${box.h}px">`);
          flow.push(`<p><img src="${src}" style="width:${Math.min(box.w, 600)}px"></p>`);
        } else if (name === 'graphicFrame') {
          const tbl = desc(el, A, 'tbl');
          const box0 = xfrm(kid(el, P, 'xfrm'));
          if (!tbl || !box0) continue;
          const box = map(box0);
          const rows = kids(tbl, A, 'tr').map((tr) =>
            kids(tr, A, 'tc').filter((tc) => !tc.getAttribute('hMerge') && !tc.getAttribute('vMerge')).map((tc) => {
              const span = tc.getAttribute('gridSpan');
              const fill = color(kid(kid(tc, A, 'tcPr'), A, 'solidFill'));
              const text = kids(kid(tc, A, 'txBody'), A, 'p').map((p) => escapeHtml(Array.from(p.getElementsByTagNameNS(A, 't')).map((t) => t.textContent).join(''))).join('<br>');
              return `<td${span ? ` colspan="${span}"` : ''}${fill ? ` style="background:${fill}"` : ''}>${text}</td>`;
            }).join(''),
          );
          const table = `<table style="width:100%;border-collapse:collapse">${rows.map((r) => `<tr>${r}</tr>`).join('')}</table>`;
          parts.push(`<div class="pptx-table" style="position:absolute;left:${box.x}px;top:${box.y}px;width:${box.w}px">${table}</div>`);
          flow.push(table);
        }
      }
    };
    const spTree = desc(desc(doc.documentElement, P, 'cSld'), P, 'spTree');
    if (spTree) await walk(spTree, (b) => b);

    slides.push({
      index: s + 1,
      html: `<div class="pptx-slide" style="position:relative;width:${width}px;height:${height}px;overflow:hidden;background:${bg};font-family:Calibri,Arial,sans-serif">${parts.join('')}</div>`,
      flow: `<h2>${escapeHtml(title || `Slide ${s + 1}`)}</h2>${flow.join('\n')}`,
    });
  }
  if (!slides.length) throw new Error('No slides found in this presentation.');
  return { width, height, slides };
}

function xfrm(x: Element | null): Box | null {
  const off = x ? kid(x, A, 'off') : null;
  const ext = x ? kid(x, A, 'ext') : null;
  if (!off || !ext) return null;
  return {
    x: Number(off.getAttribute('x')) / EMU_PX,
    y: Number(off.getAttribute('y')) / EMU_PX,
    w: Number(ext.getAttribute('cx')) / EMU_PX,
    h: Number(ext.getAttribute('cy')) / EMU_PX,
  };
}

export const SLIDE_CSS = '.pptx-table td{border:1px solid #888;padding:4px 6px;font-size:14px;vertical-align:top}';

export function deckToFlowHtml(deck: Deck): string {
  return deck.slides.map((s) => s.flow).join(`\n${PAGE_BREAK_HTML}\n`);
}
