// Text (+ simple tables) from legacy Word 97–2003 .doc files, via the document's piece table.
import CFB from 'cfb';
import { escapeHtml } from '../lib/files';
import { PAGE_BREAK_HTML } from './constants';

function stream(cfb: CFB.CFB$Container, name: string): Uint8Array | null {
  const entry = CFB.find(cfb, name);
  return entry?.content ? Uint8Array.from(entry.content as ArrayLike<number>) : null;
}

/** Raw main-document text from a .doc file. */
export function docText(bytes: ArrayBuffer): string {
  let cfb: CFB.CFB$Container;
  try {
    cfb = CFB.read(new Uint8Array(bytes), { type: 'array' });
  } catch {
    throw new Error('This is not a valid .doc file.');
  }
  const word = stream(cfb, 'WordDocument');
  if (!word) throw new Error('This .doc file has no Word content (it may be another format renamed to .doc).');
  const dv = new DataView(word.buffer, word.byteOffset, word.byteLength);
  if (dv.getUint16(0, true) !== 0xa5ec) throw new Error('This .doc file uses an unsupported Word version.');
  const flags = dv.getUint16(0x0a, true);
  if (flags & 0x0100) throw new Error('This .doc file is password-protected.');
  const table = stream(cfb, flags & 0x0200 ? '1Table' : '0Table');
  if (!table) throw new Error('This .doc file is damaged (table stream missing).');

  const ccpText = dv.getInt32(0x4c, true);
  const fcClx = dv.getUint32(0x1a2, true);
  const lcbClx = dv.getUint32(0x1a6, true);
  const tv = new DataView(table.buffer, table.byteOffset, table.byteLength);

  // Walk the Clx: skip property runs (0x01) until the piece table (0x02).
  let pos = fcClx;
  const end = fcClx + lcbClx;
  while (pos < end && table[pos] === 0x01) pos += 3 + tv.getUint16(pos + 1, true);
  if (table[pos] !== 0x02) throw new Error('This .doc file is damaged (piece table missing).');
  const lcb = tv.getUint32(pos + 1, true);
  const plc = pos + 5;
  const n = (lcb - 4) / 12;

  const cp1252 = new TextDecoder('windows-1252');
  const utf16 = new TextDecoder('utf-16le');
  let text = '';
  for (let i = 0; i < n && text.length < ccpText; i++) {
    const cpStart = tv.getUint32(plc + i * 4, true);
    const cpEnd = tv.getUint32(plc + (i + 1) * 4, true);
    const pcd = plc + (n + 1) * 4 + i * 8;
    const fcRaw = tv.getUint32(pcd + 2, true);
    const count = cpEnd - cpStart;
    if (fcRaw & 0x40000000) {
      const fc = (fcRaw & ~0x40000000) / 2;
      text += cp1252.decode(word.subarray(fc, fc + count));
    } else {
      text += utf16.decode(word.subarray(fcRaw, fcRaw + count * 2));
    }
  }
  return text.slice(0, ccpText);
}

/** Convert .doc text (with Word's control characters) into simple HTML. */
export function docToHtml(bytes: ArrayBuffer): string {
  let text = docText(bytes);
  // Fields: keep the displayed result, drop the field code ( \x13 code \x14 result \x15 ).
  for (let guard = 0; /\x13/.test(text) && guard < 10000; guard++) {
    text = text.replace(/\x13[^\x13\x14\x15]*\x14([^\x13\x15]*)\x15/g, '$1').replace(/\x13[^\x13\x14\x15]*\x15/g, '');
  }
  text = text.replace(/[\x01\x02\x05\x08\x13\x14\x15]/g, '').replace(/\x1e/g, '-').replace(/\x1f/g, '').replace(/\x0b/g, '\n');

  const out: string[] = [];
  let row: string[] = [];
  let rows: string[][] = [];
  let cell = '';
  const flushTable = () => {
    if (!rows.length) return;
    out.push(`<table>${rows.map((r) => `<tr>${r.map((c) => `<td>${escapeHtml(c.trim()).replace(/\r/g, '<br>')}</td>`).join('')}</tr>`).join('')}</table>`);
    rows = [];
  };
  const pushPara = (p: string) => {
    flushTable();
    const parts = p.split('\x0c');
    parts.forEach((part, i) => {
      if (i > 0) out.push(PAGE_BREAK_HTML);
      if (part.trim()) out.push(`<p>${escapeHtml(part.trim()).replace(/\n/g, '<br>')}</p>`);
    });
  };

  // \x07 ends a table cell; two in a row end the table row.
  let buf = '';
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (ch === '\x07') {
      if (text[i + 1] === '\x07' || (cell === '' && buf === '' && row.length)) {
        if (buf || cell) row.push(cell + buf);
        rows.push(row);
        row = [];
        cell = '';
        buf = '';
        if (text[i + 1] === '\x07') i++;
      } else {
        row.push(cell + buf);
        cell = '';
        buf = '';
      }
    } else if (ch === '\r') {
      if (row.length || /\x07/.test(text.slice(i + 1, i + 400).split('\r')[0])) cell += buf + '\r';
      else pushPara(buf);
      buf = '';
    } else buf += ch;
  }
  if (row.length) rows.push(row);
  pushPara(buf);
  flushTable();
  return out.join('\n') || '<p></p>';
}
