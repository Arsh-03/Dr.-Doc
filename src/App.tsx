import { useEffect, useRef, useState } from 'react';
import { Files, History, Settings, Wrench } from 'lucide-react';
import { useStore } from './store';
import { FilesTab } from './components/FilesTab';
import { ToolsTab } from './components/ToolsTab';
import { HistoryTab } from './components/HistoryTab';
import { ToolRunner } from './components/ToolRunner';
import { Sheet } from './components/ui';
import { platform } from './lib/platform';
import type { Tool } from './engine/tools';

type Tab = 'files' | 'tools' | 'history';

export default function App() {
  const { bucket, history, selected, toast, addFiles, notify } = useStore();
  const [tab, setTab] = useState<Tab>('files');
  const [runner, setRunner] = useState<{ tool: Tool; ids: string[] } | null>(null);
  const [settings, setSettings] = useState(false);
  const [dragging, setDragging] = useState(false);

  // Hardware back button (Android): close the topmost screen first.
  const state = useRef({ runner, settings, tab });
  state.current = { runner, settings, tab };
  useEffect(() => {
    platform.onBack(() => {
      const s = state.current;
      if (document.querySelector('.backdrop')) {
        document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape' }));
        return true;
      }
      if (s.runner) { setRunner(null); return true; }
      if (s.tab !== 'files') { setTab('files'); return true; }
      return false;
    });
  }, []);

  // Files shared from other apps (Android share sheet / desktop "Open with").
  useEffect(() => {
    platform.onIncomingFiles(async (files) => {
      const added = await addFiles(files, 'shared');
      setRunner(null);
      setTab('files');
      notify(`${added.length} shared file${added.length > 1 ? 's' : ''} added`);
    });
  }, [addFiles, notify]);

  const openTool = (tool: Tool, ids?: string[]) => setRunner({ tool, ids: ids ?? [...selected] });

  const onDrop = async (e: React.DragEvent) => {
    e.preventDefault();
    setDragging(false);
    const files = Array.from(e.dataTransfer.files);
    if (!files.length) return;
    await addFiles(files, 'picked');
    notify(`${files.length} file${files.length > 1 ? 's' : ''} added`);
    if (!runner) setTab('files');
  };

  return (
    <div
      className="app"
      onDragOver={(e) => { if (e.dataTransfer.types.includes('Files')) { e.preventDefault(); setDragging(true); } }}
      onDragLeave={(e) => { if (e.currentTarget === e.target) setDragging(false); }}
      onDrop={onDrop}
    >
      {runner ? (
        <ToolRunner
          key={runner.tool.id}
          tool={runner.tool}
          initialIds={runner.ids}
          onClose={() => setRunner(null)}
          onShowHistory={() => { setRunner(null); setTab('history'); }}
        />
      ) : (
        <>
          <header className="topbar">
            <div className="brand"><img src="./icon.svg" alt="" width={28} height={28} /> Dr.Doc</div>
            <button className="icon-btn" aria-label="Settings" onClick={() => setSettings(true)}><Settings size={22} /></button>
          </header>
          <main className="content">
            {tab === 'files' && <FilesTab onRunTool={openTool} />}
            {tab === 'tools' && <ToolsTab onOpen={(t) => openTool(t)} />}
            {tab === 'history' && <HistoryTab />}
          </main>
          <nav className="tabs" aria-label="Sections">
            <button className={tab === 'files' ? 'on' : ''} onClick={() => setTab('files')}>
              <Files size={22} /><span>Files{bucket.length ? ` (${bucket.length})` : ''}</span>
            </button>
            <button className={tab === 'tools' ? 'on' : ''} onClick={() => setTab('tools')}>
              <Wrench size={22} /><span>Tools</span>
            </button>
            <button className={tab === 'history' ? 'on' : ''} onClick={() => setTab('history')}>
              <History size={22} /><span>History{history.length ? ` (${history.length})` : ''}</span>
            </button>
          </nav>
        </>
      )}

      {settings && (
        <Sheet title="About Dr.Doc" onClose={() => setSettings(false)}>
          <dl className="info">
            <dt>Version</dt><dd>1.0.0 ({platform.kind === 'android' ? 'Android' : platform.kind === 'desktop' ? 'Desktop' : 'Web'})</dd>
            <dt>Generated files</dt><dd>{platform.outputFolder}</dd>
            <dt>Privacy</dt><dd>Everything runs on this device. No files are uploaded anywhere, and it works offline.</dd>
          </dl>
          {platform.kind === 'web' && (
            <p className="muted small">
              Tip: install this as an app (browser menu → “Install app” / “Add to Home screen”). On Android the installed app
              appears in the share menu, so you can share files to it straight from WhatsApp.
            </p>
          )}
        </Sheet>
      )}

      {dragging && <div className="drop-overlay">Drop files to add them</div>}
      {toast && <div className="toast" role="status" key={toast.id}>{toast.text}</div>}
    </div>
  );
}
