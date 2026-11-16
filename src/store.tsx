import { createContext, useCallback, useContext, useEffect, useMemo, useState, type ReactNode } from 'react';
import { db, newId, type BucketFile, type HistoryItem } from './lib/db';
import { applyRename, mimeFor } from './lib/files';
import { platform } from './lib/platform';
import type { Output } from './engine/tools';

interface Toast { id: number; text: string }

interface Store {
  bucket: BucketFile[];
  history: HistoryItem[];
  selected: Set<string>;
  toast: Toast | null;
  notify(text: string): void;
  addFiles(files: File[], source: BucketFile['source']): Promise<BucketFile[]>;
  removeFile(id: string): Promise<void>;
  clearFiles(): Promise<void>;
  renameFile(id: string, input: string): Promise<void>;
  toggle(id: string): void;
  setSelected(ids: string[]): void;
  saveOutputs(outputs: Output[], tool: string, inputs: string[]): Promise<HistoryItem[]>;
  renameOutput(id: string, input: string): Promise<void>;
  deleteOutput(id: string): Promise<void>;
  clearHistory(): Promise<void>;
  reuse(item: HistoryItem): Promise<void>;
}

const Ctx = createContext<Store | null>(null);
export const useStore = () => useContext(Ctx)!;

const byNewest = <T extends { addedAt?: number; createdAt?: number }>(a: T, b: T) =>
  (b.addedAt ?? b.createdAt ?? 0) - (a.addedAt ?? a.createdAt ?? 0);

export function StoreProvider({ children }: { children: ReactNode }) {
  const [bucket, setBucket] = useState<BucketFile[]>([]);
  const [history, setHistory] = useState<HistoryItem[]>([]);
  const [selected, setSel] = useState<Set<string>>(new Set());
  const [toast, setToast] = useState<Toast | null>(null);

  const notify = useCallback((text: string) => {
    const id = Date.now();
    setToast({ id, text });
    setTimeout(() => setToast((t) => (t?.id === id ? null : t)), 3500);
  }, []);

  const reload = useCallback(async () => {
    setBucket((await db.all<BucketFile>('bucket')).sort(byNewest));
    setHistory((await db.all<HistoryItem>('history')).sort(byNewest));
  }, []);

  useEffect(() => {
    reload();
    // Files shared to the PWA land in IndexedDB via the service worker.
    const params = new URLSearchParams(location.search);
    const shared = Number(params.get('shared'));
    if (params.has('shared')) {
      window.history.replaceState(null, '', location.pathname);
      if (shared) notify(`${shared} shared file${shared > 1 ? 's' : ''} added`);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const addFiles = useCallback(async (files: File[], source: BucketFile['source']) => {
    const now = Date.now();
    const added = files.map((f, i): BucketFile => ({
      id: newId(), name: f.name || `file-${i + 1}`, type: f.type || mimeFor(f.name), size: f.size, blob: f, addedAt: now + i, source,
    }));
    for (const f of added) await db.put('bucket', f);
    setBucket((b) => [...added.slice().reverse(), ...b]);
    setSel((s) => new Set([...s, ...added.map((f) => f.id)]));
    return added;
  }, []);

  const removeFile = useCallback(async (id: string) => {
    await db.remove('bucket', id);
    setBucket((b) => b.filter((f) => f.id !== id));
    setSel((s) => { const n = new Set(s); n.delete(id); return n; });
  }, []);

  const clearFiles = useCallback(async () => {
    await db.clear('bucket');
    setBucket([]);
    setSel(new Set());
  }, []);

  const renameFile = useCallback(async (id: string, input: string) => {
    const f = (await db.all<BucketFile>('bucket')).find((x) => x.id === id);
    if (!f) return;
    const updated = { ...f, name: applyRename(f.name, input) };
    await db.put('bucket', updated);
    setBucket((b) => b.map((x) => (x.id === id ? updated : x)));
  }, []);

  const toggle = useCallback((id: string) => {
    setSel((s) => { const n = new Set(s); if (n.has(id)) n.delete(id); else n.add(id); return n; });
  }, []);

  const setSelected = useCallback((ids: string[]) => setSel(new Set(ids)), []);

  const saveOutputs = useCallback(async (outputs: Output[], tool: string, inputs: string[]) => {
    const items: HistoryItem[] = [];
    const now = Date.now();
    for (let i = 0; i < outputs.length; i++) {
      const o = outputs[i];
      let saved: { name: string; location?: string; locationLabel: string } = { name: o.name, locationLabel: platform.outputFolder };
      try {
        saved = await platform.persist(o.name, o.blob);
      } catch (e) {
        console.error(e);
        notify(`Couldn't save ${o.name} to device storage; kept inside the app.`);
      }
      const item: HistoryItem = {
        id: newId(), name: saved.name, type: o.blob.type || mimeFor(o.name), size: o.blob.size, blob: o.blob,
        createdAt: now + i, tool, inputs, location: saved.location, locationLabel: saved.locationLabel,
      };
      await db.put('history', item);
      items.push(item);
    }
    setHistory((h) => [...items.slice().reverse(), ...h]);
    return items;
  }, [notify]);

  const renameOutput = useCallback(async (id: string, input: string) => {
    const item = (await db.all<HistoryItem>('history')).find((x) => x.id === id);
    if (!item) return;
    const name = applyRename(item.name, input);
    if (name === item.name) return;
    let updated: HistoryItem = { ...item, name };
    try {
      const moved = await platform.rename(item, name);
      if (moved) updated = { ...updated, location: moved.location, locationLabel: moved.locationLabel };
    } catch (e) {
      notify(`Rename failed: ${(e as Error).message || 'a file with that name may already exist'}`);
      return;
    }
    await db.put('history', updated);
    setHistory((h) => h.map((x) => (x.id === id ? updated : x)));
    notify('Renamed');
  }, [notify]);

  const deleteOutput = useCallback(async (id: string) => {
    const item = history.find((x) => x.id === id);
    if (item) await platform.remove(item).catch(() => undefined);
    await db.remove('history', id);
    setHistory((h) => h.filter((x) => x.id !== id));
  }, [history]);

  const clearHistory = useCallback(async () => {
    await db.clear('history');
    setHistory([]);
  }, []);

  const reuse = useCallback(async (item: HistoryItem) => {
    await addFiles([new File([item.blob], item.name, { type: item.type })], 'output');
    notify(`${item.name} added to Files`);
  }, [addFiles, notify]);

  const value = useMemo<Store>(() => ({
    bucket, history, selected, toast, notify, addFiles, removeFile, clearFiles, renameFile, toggle, setSelected,
    saveOutputs, renameOutput, deleteOutput, clearHistory, reuse,
  }), [bucket, history, selected, toast, notify, addFiles, removeFile, clearFiles, renameFile, toggle, setSelected, saveOutputs, renameOutput, deleteOutput, clearHistory, reuse]);

  return <Ctx.Provider value={value}>{children}</Ctx.Provider>;
}
