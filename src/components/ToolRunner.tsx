import { useMemo, useState } from 'react';
import { ArrowLeft, ChevronDown, ChevronUp, CircleAlert, CircleCheck, Loader2, Plus, X } from 'lucide-react';
import { useStore } from '../store';
import { defaultOpts, type Opts, type Tool } from '../engine/tools';
import { formatSize, kindOf, KIND_LABEL } from '../lib/files';
import type { HistoryItem } from '../lib/db';
import { AddFilesButton } from './FilesTab';
import { KindIcon, Sheet } from './ui';
import { OutputRow } from './HistoryTab';

export function ToolRunner({ tool, initialIds, onClose, onShowHistory }: {
  tool: Tool; initialIds: string[]; onClose: () => void; onShowHistory: () => void;
}) {
  const { bucket, saveOutputs } = useStore();
  const fits = (id: string) => {
    const f = bucket.find((b) => b.id === id);
    return !!f && tool.accepts.includes(kindOf(f.name, f.type));
  };
  const [ids, setIds] = useState<string[]>(() => initialIds.filter(fits).slice(0, tool.max ?? Infinity));
  const [opts, setOpts] = useState<Opts>(() => defaultOpts(tool));
  const [picking, setPicking] = useState(false);
  const [running, setRunning] = useState(false);
  const [progress, setProgress] = useState('');
  const [error, setError] = useState('');
  const [results, setResults] = useState<HistoryItem[] | null>(null);

  const files = ids.map((id) => bucket.find((b) => b.id === id)).filter((f): f is NonNullable<typeof f> => !!f);
  const candidates = useMemo(() => bucket.filter((f) => tool.accepts.includes(kindOf(f.name, f.type))), [bucket, tool]);
  const tooFew = files.length < tool.min;
  const single = tool.max === 1;

  const move = (i: number, d: number) => setIds((list) => {
    const n = [...list];
    [n[i], n[i + d]] = [n[i + d], n[i]];
    return n;
  });

  const run = async () => {
    setRunning(true);
    setError('');
    setProgress('Starting…');
    // Let the UI paint the progress state before heavy work starts.
    await new Promise((r) => setTimeout(r, 30));
    try {
      const outputs = await tool.run(files, opts, setProgress);
      setProgress('Saving…');
      setResults(await saveOutputs(outputs, tool.name, files.map((f) => f.name)));
    } catch (e) {
      console.error(e);
      setError((e as Error).message || 'Something went wrong.');
    } finally {
      setRunning(false);
    }
  };

  const accepted = tool.accepts.map((k) => KIND_LABEL[k]).join(', ');

  return (
    <div className="runner">
      <header className="topbar">
        <button className="icon-btn" aria-label="Back" onClick={onClose}><ArrowLeft size={22} /></button>
        <h1>{tool.name}</h1>
      </header>

      <div className="runner-body">
        <p className="muted">{tool.desc}</p>
        {tool.note && <p className="note">{tool.note}</p>}

        {results ? (
          <section className="card">
            <h2 className="result-title"><CircleCheck size={20} /> Done — {results.length} file{results.length > 1 ? 's' : ''} created</h2>
            <ul className="list flat">
              {results.map((r) => <OutputRow key={r.id} item={r} />)}
            </ul>
            <div className="btn-row">
              <button className="btn" onClick={() => { setResults(null); setProgress(''); }}>Run again</button>
              <button className="btn" onClick={onShowHistory}>Open history</button>
              <button className="btn primary" onClick={onClose}>Done</button>
            </div>
          </section>
        ) : (
          <>
            <section className="card">
              <div className="card-head">
                <h2>{single ? 'File' : `Files (${files.length})`}</h2>
                <small className="muted">{accepted}{tool.min > 1 ? ` · at least ${tool.min}` : ''}</small>
              </div>
              {tool.ordered && files.length > 1 && <p className="muted small">Use the arrows to set the order.</p>}
              <ul className="list flat">
                {files.map((f, i) => (
                  <li key={f.id} className="row">
                    {tool.ordered && <span className="order">{i + 1}</span>}
                    <KindIcon name={f.name} type={f.type} />
                    <div className="row-main">
                      <div className="row-title">{f.name}</div>
                      <div className="row-meta">{formatSize(f.size)}</div>
                    </div>
                    {tool.ordered && (
                      <>
                        <button className="icon-btn" aria-label="Move up" disabled={i === 0} onClick={() => move(i, -1)}><ChevronUp size={20} /></button>
                        <button className="icon-btn" aria-label="Move down" disabled={i === files.length - 1} onClick={() => move(i, 1)}><ChevronDown size={20} /></button>
                      </>
                    )}
                    <button className="icon-btn" aria-label={`Remove ${f.name}`} onClick={() => setIds((l) => l.filter((x) => x !== f.id))}><X size={20} /></button>
                  </li>
                ))}
              </ul>
              {!(single && files.length) && (
                <div className="btn-row">
                  {candidates.some((c) => !ids.includes(c.id)) && (
                    <button className="btn" onClick={() => setPicking(true)}><Plus size={18} /> From my files</button>
                  )}
                  <AddFilesButton
                    className="btn"
                    label="From device"
                    onAdded={(added) => setIds((l) => [...l, ...added].slice(0, tool.max ?? Infinity))}
                  />
                </div>
              )}
            </section>

            {tool.options && tool.options.length > 0 && (
              <section className="card">
                <h2>Options</h2>
                <div className="form">
                  {tool.options.filter((o) => !o.showIf || o.showIf(opts)).map((o) => (
                    <label key={o.key} className={`field ${o.type === 'checkbox' ? 'inline' : ''}`}>
                      {o.type === 'checkbox' ? (
                        <>
                          <input type="checkbox" checked={!!opts[o.key]} onChange={(e) => setOpts({ ...opts, [o.key]: e.target.checked })} />
                          <span>{o.label}</span>
                        </>
                      ) : (
                        <>
                          <span>{o.label}</span>
                          {o.type === 'select' ? (
                            <select className="input" value={String(opts[o.key])} onChange={(e) => setOpts({ ...opts, [o.key]: e.target.value })}>
                              {o.choices.map(([v, l]) => <option key={v} value={v}>{l}</option>)}
                            </select>
                          ) : (
                            <input
                              className="input"
                              type={o.type}
                              inputMode={o.type === 'number' ? 'numeric' : undefined}
                              min={o.type === 'number' ? o.min : undefined}
                              max={o.type === 'number' ? o.max : undefined}
                              placeholder={o.type === 'text' ? o.placeholder : undefined}
                              value={String(opts[o.key])}
                              onChange={(e) => setOpts({ ...opts, [o.key]: o.type === 'number' ? Number(e.target.value) : e.target.value })}
                            />
                          )}
                        </>
                      )}
                      {o.help && <small className="muted">{o.help}</small>}
                    </label>
                  ))}
                </div>
              </section>
            )}

            {error && <p className="error"><CircleAlert size={18} /> {error}</p>}
          </>
        )}
      </div>

      {!results && (
        <footer className="runner-foot">
          {running ? (
            <div className="progress"><Loader2 className="spin" size={20} /> {progress}</div>
          ) : (
            <button className="btn primary block lg" disabled={tooFew} onClick={run}>
              {tooFew ? `Add ${tool.min - files.length} more file${tool.min - files.length > 1 ? 's' : ''}` : tool.name}
            </button>
          )}
        </footer>
      )}

      {picking && (
        <Sheet
          title="Choose files"
          onClose={() => setPicking(false)}
          footer={<button className="btn primary" onClick={() => setPicking(false)}>Done</button>}
        >
          <ul className="list flat">
            {candidates.map((f) => {
              const on = ids.includes(f.id);
              return (
                <li
                  key={f.id}
                  className={`row selectable ${on ? 'on' : ''}`}
                  onClick={() => setIds((l) => (on ? l.filter((x) => x !== f.id) : single ? [f.id] : [...l, f.id]))}
                >
                  <span className={`check ${on ? 'on' : ''}`} role="checkbox" aria-checked={on} />
                  <KindIcon name={f.name} type={f.type} />
                  <div className="row-main">
                    <div className="row-title">{f.name}</div>
                    <div className="row-meta">{formatSize(f.size)}</div>
                  </div>
                </li>
              );
            })}
          </ul>
        </Sheet>
      )}
    </div>
  );
}
