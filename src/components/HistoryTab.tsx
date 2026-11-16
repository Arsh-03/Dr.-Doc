import { useState } from 'react';
import { Download, ExternalLink, FolderOpen, History as HistoryIcon, Info, Pencil, Recycle, Search, Share2, Trash2 } from 'lucide-react';
import { useStore } from '../store';
import type { HistoryItem } from '../lib/db';
import { formatDate, formatSize } from '../lib/files';
import { platform } from '../lib/platform';
import { Confirm, DotsMenu, Empty, KindIcon, RenameDialog, Sheet } from './ui';

/** One generated file with its three-dot menu. Used in History and on the result screen. */
export function OutputRow({ item }: { item: HistoryItem }) {
  const { history, renameOutput, deleteOutput, reuse, notify } = useStore();
  const live = history.find((h) => h.id === item.id) ?? item;
  const [renaming, setRenaming] = useState(false);
  const [info, setInfo] = useState(false);
  const [confirmDelete, setConfirmDelete] = useState(false);

  const act = async (fn: () => Promise<unknown>) => {
    try {
      const msg = await fn();
      if (typeof msg === 'string') notify(msg);
    } catch (e) {
      notify((e as Error).message || 'Something went wrong');
    }
  };

  return (
    <li className="row" onClick={() => act(() => platform.open(live))}>
      <KindIcon name={live.name} type={live.type} />
      <div className="row-main">
        <div className="row-title" title={live.name}>{live.name}</div>
        <div className="row-meta">{live.tool} · {formatSize(live.size)} · {formatDate(live.createdAt)}</div>
      </div>
      <span onClick={(e) => e.stopPropagation()}>
        <DotsMenu
          items={[
            { label: 'Open', icon: <ExternalLink size={18} />, onClick: () => act(() => platform.open(live)) },
            { label: 'Share', icon: <Share2 size={18} />, onClick: () => act(() => platform.share(live)), hidden: platform.kind === 'desktop' || (platform.kind === 'web' && !platform.canShare(live)) },
            { label: 'Show in folder', icon: <FolderOpen size={18} />, onClick: () => act(() => platform.reveal!(live)), hidden: !platform.reveal },
            { label: platform.kind === 'web' ? 'Download / Save as…' : 'Save a copy as…', icon: <Download size={18} />, onClick: () => act(() => platform.exportCopy(live)), hidden: platform.kind === 'android' },
            { label: 'Rename', icon: <Pencil size={18} />, onClick: () => setRenaming(true) },
            { label: 'Use as input', icon: <Recycle size={18} />, onClick: () => act(() => reuse(live)) },
            { label: 'File info & location', icon: <Info size={18} />, onClick: () => setInfo(true) },
            { label: 'Delete', icon: <Trash2 size={18} />, danger: true, onClick: () => setConfirmDelete(true) },
          ]}
        />
        {renaming && (
          <RenameDialog name={live.name} onCancel={() => setRenaming(false)} onSave={async (v) => { setRenaming(false); await renameOutput(live.id, v); }} />
        )}
        {info && (
          <Sheet title="File info" onClose={() => setInfo(false)}>
            <dl className="info">
              <dt>Name</dt><dd>{live.name}</dd>
              <dt>Saved in</dt><dd>{live.locationLabel || platform.outputFolder}</dd>
              {live.location && <><dt>Full path</dt><dd className="mono">{decodeURIComponent(live.location.replace(/^file:\/\//, ''))}</dd></>}
              <dt>Size</dt><dd>{formatSize(live.size)}</dd>
              <dt>Created</dt><dd>{new Date(live.createdAt).toLocaleString()}</dd>
              <dt>Made with</dt><dd>{live.tool}</dd>
              <dt>From</dt><dd>{live.inputs.join(', ')}</dd>
            </dl>
            {platform.kind === 'web' && <p className="muted small">On the web version files live inside the browser. Use “Download / Save as…” to put a copy on your disk.</p>}
          </Sheet>
        )}
        {confirmDelete && (
          <Confirm
            title="Delete file?"
            message={platform.kind === 'web' ? `${live.name} will be removed from history.` : `${live.name} will be removed from history and deleted from ${live.locationLabel || 'your device'}.`}
            confirmLabel="Delete"
            onCancel={() => setConfirmDelete(false)}
            onConfirm={async () => { setConfirmDelete(false); await deleteOutput(live.id); }}
          />
        )}
      </span>
    </li>
  );
}

function dayLabel(ts: number) {
  const d = new Date(ts);
  const today = new Date();
  const yest = new Date(Date.now() - 86_400_000);
  if (d.toDateString() === today.toDateString()) return 'Today';
  if (d.toDateString() === yest.toDateString()) return 'Yesterday';
  return d.toLocaleDateString(undefined, { weekday: 'short', day: 'numeric', month: 'short', year: 'numeric' });
}

export function HistoryTab() {
  const { history, clearHistory } = useStore();
  const [q, setQ] = useState('');
  const [confirmClear, setConfirmClear] = useState(false);

  if (!history.length) {
    return (
      <Empty icon={<HistoryIcon size={40} />} title="Nothing generated yet">
        <p className="muted">Files you create appear here.<br />They're saved to <b>{platform.outputFolder}</b>.</p>
      </Empty>
    );
  }

  const query = q.trim().toLowerCase();
  const items = history.filter((h) => !query || `${h.name} ${h.tool}`.toLowerCase().includes(query));
  const groups = new Map<string, HistoryItem[]>();
  for (const h of items) {
    const k = dayLabel(h.createdAt);
    groups.set(k, [...(groups.get(k) ?? []), h]);
  }

  return (
    <div className="tab">
      <div className="toolbar">
        <label className="search grow">
          <Search size={18} />
          <input placeholder="Search history" value={q} onChange={(e) => setQ(e.target.value)} />
        </label>
        <button className="btn ghost danger" aria-label="Clear history" onClick={() => setConfirmClear(true)}><Trash2 size={18} /></button>
      </div>
      <p className="muted small folder-note"><FolderOpen size={14} /> Saved to {platform.outputFolder}</p>
      {[...groups].map(([day, list]) => (
        <section key={day}>
          <h2 className="section-title">{day}</h2>
          <ul className="list">{list.map((h) => <OutputRow key={h.id} item={h} />)}</ul>
        </section>
      ))}
      {!items.length && <p className="muted center">No matches.</p>}
      {confirmClear && (
        <Confirm
          title="Clear history?"
          message={platform.kind === 'web' ? 'All generated files will be removed from this browser.' : 'The list will be cleared. Files already saved on your device stay where they are.'}
          confirmLabel="Clear"
          onCancel={() => setConfirmClear(false)}
          onConfirm={async () => { await clearHistory(); setConfirmClear(false); }}
        />
      )}
    </div>
  );
}
