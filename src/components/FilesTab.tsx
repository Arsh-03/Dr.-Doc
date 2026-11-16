import { useRef, useState } from 'react';
import { CheckSquare, ExternalLink, FilePlus2, Inbox, Pencil, Share2, Square, Trash2, Wand2 } from 'lucide-react';
import { useStore } from '../store';
import { formatDate, formatSize, KIND_LABEL, kindOf } from '../lib/files';
import { platform } from '../lib/platform';
import { toolsFor, type Tool } from '../engine/tools';
import { Confirm, DotsMenu, Empty, KindIcon, RenameDialog, Sheet } from './ui';

export const ACCEPT = '.pdf,.docx,.doc,.pptx,.txt,.md,.markdown,.html,.htm,.csv,.xlsx,.xls,.ods,image/*';

export function AddFilesButton({ className = 'btn primary', label = 'Add files', onAdded }: { className?: string; label?: string; onAdded?: (ids: string[]) => void }) {
  const input = useRef<HTMLInputElement>(null);
  const { addFiles, notify } = useStore();
  return (
    <>
      <button className={className} onClick={() => input.current?.click()}>
        <FilePlus2 size={18} /> {label}
      </button>
      <input
        ref={input}
        type="file"
        multiple
        accept={ACCEPT}
        hidden
        onChange={async (e) => {
          const files = Array.from(e.target.files ?? []);
          e.target.value = '';
          if (!files.length) return;
          const added = await addFiles(files, 'picked');
          notify(`${added.length} file${added.length > 1 ? 's' : ''} added`);
          onAdded?.(added.map((f) => f.id));
        }}
      />
    </>
  );
}

export function FilesTab({ onRunTool }: { onRunTool: (tool: Tool, fileIds: string[]) => void }) {
  const { bucket, selected, toggle, setSelected, removeFile, clearFiles, renameFile, notify } = useStore();
  const [renaming, setRenaming] = useState<string | null>(null);
  const [picking, setPicking] = useState(false);
  const [confirmClear, setConfirmClear] = useState(false);

  const chosen = bucket.filter((f) => selected.has(f.id)).sort((a, b) => a.addedAt - b.addedAt);
  const options = toolsFor(chosen);
  const allSelected = bucket.length > 0 && chosen.length === bucket.length;

  const tryAction = async (fn: () => Promise<unknown>) => {
    try { await fn(); } catch (e) { notify((e as Error).message || 'Something went wrong'); }
  };

  if (!bucket.length) {
    return (
      <Empty icon={<Inbox size={40} />} title="Your file bucket is empty">
        <p className="muted">Add PDFs, Word files, images, text or spreadsheets.<br />You can also <b>share files to Dr.Doc</b> from WhatsApp, Gmail or your file manager.</p>
        <AddFilesButton />
      </Empty>
    );
  }

  const renamingFile = bucket.find((f) => f.id === renaming);

  return (
    <div className="tab">
      <div className="toolbar">
        <button className="btn ghost" onClick={() => setSelected(allSelected ? [] : bucket.map((f) => f.id))}>
          {allSelected ? <CheckSquare size={18} /> : <Square size={18} />} {allSelected ? 'Clear selection' : 'Select all'}
        </button>
        <div className="spacer" />
        <button className="btn ghost danger" onClick={() => setConfirmClear(true)} aria-label="Remove all files">
          <Trash2 size={18} />
        </button>
        <AddFilesButton className="btn primary sm" label="Add" />
      </div>

      <ul className="list">
        {bucket.map((f) => {
          const on = selected.has(f.id);
          return (
            <li key={f.id} className={`row selectable ${on ? 'on' : ''}`} onClick={() => toggle(f.id)}>
              <span className={`check ${on ? 'on' : ''}`} role="checkbox" aria-checked={on} aria-label={`Select ${f.name}`} />
              <KindIcon name={f.name} type={f.type} />
              <div className="row-main">
                <div className="row-title" title={f.name}>{f.name}</div>
                <div className="row-meta">
                  {KIND_LABEL[kindOf(f.name, f.type)]} · {formatSize(f.size)} · {f.source === 'shared' ? 'Shared' : f.source === 'output' ? 'From history' : 'Added'} {formatDate(f.addedAt)}
                </div>
              </div>
              <DotsMenu
                items={[
                  { label: 'Open', icon: <ExternalLink size={18} />, onClick: () => tryAction(() => platform.open(f)) },
                  { label: 'Rename', icon: <Pencil size={18} />, onClick: () => setRenaming(f.id) },
                  { label: 'Share', icon: <Share2 size={18} />, onClick: () => tryAction(() => platform.share(f)), hidden: platform.kind === 'desktop' || (platform.kind === 'web' && !platform.canShare(f)) },
                  { label: 'Remove from list', icon: <Trash2 size={18} />, danger: true, onClick: () => removeFile(f.id) },
                ]}
              />
            </li>
          );
        })}
      </ul>

      <div className={`action-bar ${chosen.length ? 'show' : ''}`}>
        <span><b>{chosen.length}</b> selected</span>
        <button className="btn primary" disabled={!chosen.length} onClick={() => setPicking(true)}>
          <Wand2 size={18} /> Choose action
        </button>
      </div>

      {picking && (
        <Sheet title={`What do you want to do with ${chosen.length} file${chosen.length > 1 ? 's' : ''}?`} onClose={() => setPicking(false)}>
          {options.length ? (
            <div className="tool-list">
              {options.map((t) => (
                <button key={t.id} className="tool-item" onClick={() => { setPicking(false); onRunTool(t, chosen.map((f) => f.id)); }}>
                  <b>{t.name}</b>
                  <span>{t.desc}</span>
                </button>
              ))}
            </div>
          ) : (
            <p className="muted">
              No action fits this mix of files. Tip: select only PDFs to merge PDFs, only Word files to merge Word documents,
              or use <b>Combine any files → PDF</b> from the Tools tab.
            </p>
          )}
        </Sheet>
      )}

      {renamingFile && (
        <RenameDialog
          name={renamingFile.name}
          onCancel={() => setRenaming(null)}
          onSave={async (v) => { await renameFile(renamingFile.id, v); setRenaming(null); }}
        />
      )}
      {confirmClear && (
        <Confirm
          title="Remove all files?"
          message="This clears the bucket. Your original files and generated history are not affected."
          confirmLabel="Remove all"
          onCancel={() => setConfirmClear(false)}
          onConfirm={async () => { await clearFiles(); setConfirmClear(false); }}
        />
      )}
    </div>
  );
}
