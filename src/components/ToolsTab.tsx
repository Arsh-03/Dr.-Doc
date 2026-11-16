import { useState } from 'react';
import { ArrowRightLeft, Combine, FileOutput, FileInput, FileText, Image, Lock, Presentation, ScanText, Search, Sheet as SheetIcon, Wrench } from 'lucide-react';
import { CATEGORIES, TOOLS, type Category, type Tool } from '../engine/tools';
import { KIND_LABEL } from '../lib/files';

const CAT_ICON: Record<Category, typeof Wrench> = {
  'Merge & combine': Combine,
  'PDF tools': Wrench,
  'Scan & OCR': ScanText,
  Security: Lock,
  PowerPoint: Presentation,
  'From PDF': FileOutput,
  'To PDF': FileInput,
  'Word & text': FileText,
  Images: Image,
  Spreadsheets: SheetIcon,
};

export function ToolsTab({ onOpen }: { onOpen: (tool: Tool) => void }) {
  const [q, setQ] = useState('');
  const [showMatrix, setShowMatrix] = useState(false);
  const query = q.trim().toLowerCase();
  const match = (t: Tool) => !query || `${t.name} ${t.desc} ${t.category}`.toLowerCase().includes(query);

  return (
    <div className="tab">
      <label className="search">
        <Search size={18} />
        <input placeholder="Search tools — e.g. merge, word, compress" value={q} onChange={(e) => setQ(e.target.value)} />
      </label>

      {CATEGORIES.map((cat) => {
        const tools = TOOLS.filter((t) => t.category === cat && match(t));
        if (!tools.length) return null;
        const Icon = CAT_ICON[cat];
        return (
          <section key={cat} className="tool-section">
            <h2 className="section-title"><Icon size={16} /> {cat}</h2>
            <div className="tool-grid">
              {tools.map((t) => (
                <button key={t.id} className="tool-card" onClick={() => onOpen(t)}>
                  <b>{t.name}</b>
                  <span>{t.desc}</span>
                  <small>{t.accepts.map((k) => KIND_LABEL[k]).join(' · ')}{t.min > 1 ? ` · ${t.min}+ files` : ''}</small>
                </button>
              ))}
            </div>
          </section>
        );
      })}

      <button className="btn ghost block" onClick={() => setShowMatrix((s) => !s)}>
        <ArrowRightLeft size={18} /> {showMatrix ? 'Hide' : 'Show'} all supported conversions
      </button>
      {showMatrix && <ConversionMatrix />}
    </div>
  );
}

const MATRIX: [string, string[]][] = [
  ['PDF', ['Word (.docx)', 'Text', 'Markdown', 'HTML', 'PNG', 'JPG', 'PDF (merge, split, compress, unlock, protect…)']],
  ['Scanned PDF / photo', ['Searchable PDF', 'Word', 'Text', 'Markdown (offline OCR: English, Hindi)']],
  ['Word (.docx)', ['PDF', 'Text', 'HTML', 'Markdown', 'Word (merge)']],
  ['Old Word (.doc)', ['Word (.docx)', 'PDF', 'Text']],
  ['PowerPoint (.pptx)', ['PDF', 'Word', 'Text', 'Markdown', 'PNG', 'JPG']],
  ['Text (.txt)', ['PDF', 'Word']],
  ['Markdown (.md)', ['PDF', 'Word', 'HTML']],
  ['HTML', ['PDF', 'Word', 'Markdown', 'Text']],
  ['Images (JPG, PNG, WEBP, GIF, BMP)', ['PDF', 'Word', 'PNG', 'JPG', 'WEBP']],
  ['Spreadsheets (XLSX, XLS, ODS, CSV)', ['XLSX', 'CSV', 'PDF', 'HTML', 'Word']],
  ['Any mix of the above', ['One combined PDF', 'One combined Word file']],
];

function ConversionMatrix() {
  return (
    <div className="card matrix">
      <table>
        <thead><tr><th>From</th><th>To</th></tr></thead>
        <tbody>
          {MATRIX.map(([from, to]) => (
            <tr key={from}><td>{from}</td><td>{to.join(', ')}</td></tr>
          ))}
        </tbody>
      </table>
      <p className="muted small">
        Everything runs on your device, offline. Not supported: old .ppt PowerPoint files, and images/formatting inside old .doc files.
      </p>
    </div>
  );
}
