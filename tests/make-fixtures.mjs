// Generates sample input files for the smoke test: node tests/make-fixtures.mjs
import fs from 'node:fs';
import path from 'node:path';
import { PDFDocument, StandardFonts } from '@cantoo/pdf-lib';
import { Document, HeadingLevel, ImageRun, Packer, Paragraph, Table, TableCell, TableRow, TextRun } from 'docx';

const dir = path.join(import.meta.dirname, 'fixtures');
fs.mkdirSync(dir, { recursive: true });
const png = fs.readFileSync(path.join(import.meta.dirname, '..', 'public', 'icon-192.png'));

async function makePdf(name, pages, label) {
  const doc = await PDFDocument.create();
  const font = await doc.embedFont(StandardFonts.Helvetica);
  const bold = await doc.embedFont(StandardFonts.HelveticaBold);
  for (let p = 1; p <= pages; p++) {
    const page = doc.addPage([595, 842]);
    page.drawText(`${label} - Chapter ${p}`, { x: 50, y: 780, size: 22, font: bold });
    const lines = [
      `This is page ${p} of the ${label} test document. It contains several lines of`,
      'body text so that text extraction can group them into a single paragraph and',
      'convert it into an editable Word document without losing the reading order.',
      '',
      'A second paragraph starts after a blank gap. It mentions a hyphen-',
      'ated word that should be re-joined during extraction.',
    ];
    lines.forEach((l, i) => l && page.drawText(l, { x: 50, y: 740 - i * 16, size: 11, font }));
  }
  fs.writeFileSync(path.join(dir, name), await doc.save());
}

async function makeDocx(name, title, withTable) {
  const children = [
    new Paragraph({ heading: HeadingLevel.HEADING_1, children: [new TextRun(title)] }),
    new Paragraph({ children: [new TextRun('Normal text with '), new TextRun({ text: 'bold', bold: true }), new TextRun(' and '), new TextRun({ text: 'italic', italics: true }), new TextRun(' words.')] }),
    new Paragraph({ text: 'First bullet', bullet: { level: 0 } }),
    new Paragraph({ text: 'Second bullet', bullet: { level: 0 } }),
    new Paragraph({ children: [new ImageRun({ type: 'png', data: png, transformation: { width: 96, height: 96 } })] }),
  ];
  if (withTable) {
    children.push(new Table({
      rows: [['Item', 'Qty', 'Price'], ['Apples', '3', '1.20'], ['Pears', '5', '2.10']].map(
        (r) => new TableRow({ children: r.map((c) => new TableCell({ children: [new Paragraph(c)] })) }),
      ),
    }));
  }
  children.push(new Paragraph(`End of ${title}.`));
  const doc = new Document({ sections: [{ children }] });
  fs.writeFileSync(path.join(dir, name), await Packer.toBuffer(doc));
}

// Two-column page with a title, bold/italic runs and a picture (tests PDF → Word reading order).
async function makeTwoColumn() {
  const doc = await PDFDocument.create();
  const [reg, bold, ital] = await Promise.all([StandardFonts.Helvetica, StandardFonts.HelveticaBold, StandardFonts.HelveticaOblique].map((f) => doc.embedFont(f)));
  const page = doc.addPage([595, 842]);
  page.drawText('Two Column Newsletter', { x: 50, y: 790, size: 22, font: bold });
  page.drawImage(await doc.embedPng(png), { x: 50, y: 660, width: 96, height: 96 });
  for (let i = 0; i < 30; i++) {
    page.drawText(`LEFT column line ${i + 1} with some words.`, { x: 50, y: 630 - i * 15, size: 10, font: reg });
    page.drawText(`RIGHT column line ${i + 1} with some words.`, { x: 320, y: 630 - i * 15, size: 10, font: reg });
  }
  page.drawText('A bold closing sentence.', { x: 50, y: 160, size: 10, font: bold });
  page.drawText('An italic closing sentence.', { x: 50, y: 145, size: 10, font: ital });
  fs.writeFileSync(path.join(dir, 'twocol.pdf'), await doc.save());
}

// Password-protected copy of alpha.pdf (password: secret).
async function makeLocked() {
  const doc = await PDFDocument.load(fs.readFileSync(path.join(dir, 'alpha.pdf')));
  doc.encrypt({ userPassword: 'secret', ownerPassword: 'owner-secret' });
  fs.writeFileSync(path.join(dir, 'locked.pdf'), await doc.save());
}

// A "scanned" PDF: the page is only an image of text (needs scan.png from make-office-fixtures.ps1).
async function makeScanned() {
  const scan = path.join(dir, 'scan.png');
  if (!fs.existsSync(scan)) return;
  const doc = await PDFDocument.create();
  const img = await doc.embedPng(fs.readFileSync(scan));
  doc.addPage([595, 842]).drawImage(img, { x: 0, y: 0, width: 595, height: 842 });
  fs.writeFileSync(path.join(dir, 'scanned.pdf'), await doc.save());
}

await makePdf('alpha.pdf', 3, 'Alpha');
await makePdf('beta.pdf', 2, 'Beta');
await makeDocx('report.docx', 'Quarterly Report', true);
await makeDocx('notes.docx', 'Meeting Notes', false);
fs.writeFileSync(path.join(dir, 'readme.md'), '# Markdown Title\n\nSome **bold** text and a list:\n\n- one\n- two\n\n| a | b |\n|---|---|\n| 1 | 2 |\n');
fs.writeFileSync(path.join(dir, 'plain.txt'), 'Plain text line one.\nLine two.\n\nNew paragraph here.\n');
fs.writeFileSync(path.join(dir, 'data.csv'), 'Name,Score\nAsha,91\nRavi,84\n');
fs.writeFileSync(path.join(dir, 'page.html'), '<html><body><h1>Web Page</h1><p>Hello <b>world</b>.</p><script>alert(1)</script><ul><li>x</li><li>y</li></ul></body></html>');
fs.writeFileSync(path.join(dir, 'icon.png'), png);
await makeTwoColumn();
await makeLocked();
await makeScanned();
console.log('fixtures written to', dir);
