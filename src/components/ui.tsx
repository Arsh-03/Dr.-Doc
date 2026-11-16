import { useEffect, useLayoutEffect, useRef, useState, type ReactNode } from 'react';
import { File, FileCode, FileImage, FileSpreadsheet, FileText, FileType, MoreVertical, Presentation, X } from 'lucide-react';
import { kindOf, type Kind } from '../lib/files';

const KIND_ICON: Record<Kind, typeof File> = {
  pdf: FileType, docx: FileText, doc: FileText, pptx: Presentation, image: FileImage, text: FileText, md: FileCode, html: FileCode, sheet: FileSpreadsheet, other: File,
};

export function KindIcon({ name, type = '' }: { name: string; type?: string }) {
  const kind = name.toLowerCase().endsWith('.zip') ? 'other' : kindOf(name, type);
  const Icon = KIND_ICON[kind];
  return (
    <span className={`kind-icon k-${kind}`} aria-hidden>
      <Icon size={20} />
      <small>{(name.split('.').pop() || '').slice(0, 4).toUpperCase()}</small>
    </span>
  );
}

export interface MenuItem {
  label: string;
  icon?: ReactNode;
  onClick: () => void;
  danger?: boolean;
  hidden?: boolean;
}

/** Three-dot overflow menu. */
export function DotsMenu({ items, label = 'More actions' }: { items: MenuItem[]; label?: string }) {
  const [open, setOpen] = useState(false);
  const btn = useRef<HTMLButtonElement>(null);
  const menu = useRef<HTMLDivElement>(null);
  const [pos, setPos] = useState<{ top: number; right: number } | null>(null);

  useLayoutEffect(() => {
    if (!open || !btn.current) return;
    const r = btn.current.getBoundingClientRect();
    const menuH = (menu.current?.offsetHeight ?? 260) + 8;
    const top = r.bottom + menuH > window.innerHeight ? Math.max(8, r.top - menuH) : r.bottom + 4;
    setPos({ top, right: Math.max(8, window.innerWidth - r.right) });
  }, [open]);

  useEffect(() => {
    if (!open) return;
    const close = (e: Event) => {
      if (!menu.current?.contains(e.target as Node) && !btn.current?.contains(e.target as Node)) setOpen(false);
    };
    const esc = (e: KeyboardEvent) => e.key === 'Escape' && setOpen(false);
    document.addEventListener('pointerdown', close);
    document.addEventListener('keydown', esc);
    window.addEventListener('scroll', () => setOpen(false), { once: true, capture: true });
    return () => {
      document.removeEventListener('pointerdown', close);
      document.removeEventListener('keydown', esc);
    };
  }, [open]);

  return (
    <>
      <button
        ref={btn}
        className="icon-btn"
        aria-label={label}
        aria-haspopup="menu"
        aria-expanded={open}
        onClick={(e) => { e.stopPropagation(); setOpen((o) => !o); }}
      >
        <MoreVertical size={20} />
      </button>
      {open && (
        <div ref={menu} className="menu" role="menu" style={pos ? { top: pos.top, right: pos.right } : { visibility: 'hidden' }} onClick={(e) => e.stopPropagation()}>
          {items.filter((i) => !i.hidden).map((i) => (
            <button key={i.label} role="menuitem" className={i.danger ? 'danger' : ''} onClick={() => { setOpen(false); i.onClick(); }}>
              {i.icon}
              <span>{i.label}</span>
            </button>
          ))}
        </div>
      )}
    </>
  );
}

export function Sheet({ title, onClose, children, footer }: { title: string; onClose: () => void; children: ReactNode; footer?: ReactNode }) {
  useEffect(() => {
    const esc = (e: KeyboardEvent) => e.key === 'Escape' && onClose();
    document.addEventListener('keydown', esc);
    return () => document.removeEventListener('keydown', esc);
  }, [onClose]);
  return (
    <div className="backdrop" onClick={onClose}>
      <div className="sheet" role="dialog" aria-modal="true" aria-label={title} onClick={(e) => e.stopPropagation()}>
        <div className="sheet-head">
          <h2>{title}</h2>
          <button className="icon-btn" aria-label="Close" onClick={onClose}><X size={20} /></button>
        </div>
        <div className="sheet-body">{children}</div>
        {footer && <div className="sheet-foot">{footer}</div>}
      </div>
    </div>
  );
}

export function RenameDialog({ name, onCancel, onSave }: { name: string; onCancel: () => void; onSave: (v: string) => void }) {
  const dot = name.lastIndexOf('.');
  const [value, setValue] = useState(name);
  const input = useRef<HTMLInputElement>(null);
  useEffect(() => {
    input.current?.focus();
    input.current?.setSelectionRange(0, dot > 0 ? dot : name.length);
  }, [dot, name.length]);
  return (
    <Sheet
      title="Rename file"
      onClose={onCancel}
      footer={
        <>
          <button className="btn" onClick={onCancel}>Cancel</button>
          <button className="btn primary" onClick={() => onSave(value)}>Save</button>
        </>
      }
    >
      <form onSubmit={(e) => { e.preventDefault(); onSave(value); }}>
        <input ref={input} className="input" value={value} onChange={(e) => setValue(e.target.value)} aria-label="File name" />
      </form>
    </Sheet>
  );
}

export function Confirm({ title, message, confirmLabel, onCancel, onConfirm }: { title: string; message: string; confirmLabel: string; onCancel: () => void; onConfirm: () => void }) {
  return (
    <Sheet
      title={title}
      onClose={onCancel}
      footer={
        <>
          <button className="btn" onClick={onCancel}>Cancel</button>
          <button className="btn danger" onClick={onConfirm}>{confirmLabel}</button>
        </>
      }
    >
      <p className="muted">{message}</p>
    </Sheet>
  );
}

export function Empty({ icon, title, children }: { icon: ReactNode; title: string; children?: ReactNode }) {
  return (
    <div className="empty">
      <div className="empty-icon">{icon}</div>
      <h3>{title}</h3>
      {children}
    </div>
  );
}
