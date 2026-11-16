// Platform abstraction: the same UI runs as a web app/PWA, an Android app (Capacitor)
// and a desktop app (Electron). Only file I/O, opening and sharing differ.
import { Capacitor, registerPlugin, type PluginListenerHandle } from '@capacitor/core';
import { Directory, Filesystem } from '@capacitor/filesystem';
import { Share } from '@capacitor/share';
import { FileOpener } from '@capawesome-team/capacitor-file-opener';
import { App as CapApp } from '@capacitor/app';
import { mimeFor } from './files';

export interface StoredDoc {
  name: string;
  blob: Blob;
  location?: string;
}

export interface Saved {
  location?: string;
  locationLabel: string;
}

export interface Platform {
  kind: 'web' | 'android' | 'desktop';
  outputFolder: string;
  canShare: (doc: StoredDoc) => boolean;
  persist(name: string, blob: Blob): Promise<Saved & { name: string }>;
  open(doc: StoredDoc): Promise<void>;
  share(doc: StoredDoc): Promise<void>;
  /** Save an extra copy somewhere the user picks. Returns a status message. */
  exportCopy(doc: StoredDoc): Promise<string | null>;
  rename(doc: StoredDoc, newName: string): Promise<Saved | null>;
  remove(doc: StoredDoc): Promise<void>;
  reveal?(doc: StoredDoc): Promise<void>;
  htmlToPdf?(html: string, pageSize: 'a4' | 'letter'): Promise<Uint8Array>;
  onIncomingFiles(cb: (files: File[]) => void): void;
  onBack(cb: () => boolean): void;
}

// ---------------- helpers ----------------

function download(blob: Blob, name: string) {
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = name;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 30_000);
}

const VIEWABLE = /^(application\/pdf|image\/|text\/plain|text\/html)/;

async function toBase64(blob: Blob): Promise<string> {
  const buf = new Uint8Array(await blob.arrayBuffer());
  let s = '';
  for (let i = 0; i < buf.length; i += 0x8000) s += String.fromCharCode(...buf.subarray(i, i + 0x8000));
  return btoa(s);
}

// ---------------- web ----------------

const web: Platform = {
  kind: 'web',
  outputFolder: 'Browser storage (use Save to download)',
  canShare: (doc) => {
    try {
      return !!navigator.canShare?.({ files: [new File([doc.blob], doc.name, { type: mimeFor(doc.name) })] });
    } catch {
      return false;
    }
  },
  async persist(name) {
    return { name, locationLabel: 'Stored in this browser' };
  },
  async open(doc) {
    const type = mimeFor(doc.name);
    if (!VIEWABLE.test(type)) return download(doc.blob, doc.name);
    const url = URL.createObjectURL(new Blob([doc.blob], { type }));
    window.open(url, '_blank');
    setTimeout(() => URL.revokeObjectURL(url), 120_000);
  },
  async share(doc) {
    const file = new File([doc.blob], doc.name, { type: mimeFor(doc.name) });
    if (navigator.canShare?.({ files: [file] })) await navigator.share({ files: [file], title: doc.name });
    else download(doc.blob, doc.name);
  },
  async exportCopy(doc) {
    const picker = (window as unknown as { showSaveFilePicker?: (o: object) => Promise<FileSystemFileHandle> }).showSaveFilePicker;
    if (picker) {
      try {
        const handle = await picker({ suggestedName: doc.name });
        const w = await handle.createWritable();
        await w.write(doc.blob);
        await w.close();
        return `Saved as ${handle.name}`;
      } catch (e) {
        if ((e as Error).name === 'AbortError') return null;
      }
    }
    download(doc.blob, doc.name);
    return 'Downloaded to your Downloads folder';
  },
  async rename() {
    return { locationLabel: 'Stored in this browser' };
  },
  async remove() {},
  onIncomingFiles(cb) {
    // PWA file handlers ("Open with Dr.Doc" on desktop Chrome/Edge)
    const lq = (window as unknown as { launchQueue?: { setConsumer(f: (p: { files: FileSystemFileHandle[] }) => void): void } }).launchQueue;
    lq?.setConsumer(async (params) => {
      if (params.files?.length) cb(await Promise.all(params.files.map((h) => h.getFile())));
    });
  },
  onBack() {},
};

// ---------------- android (Capacitor) ----------------

interface SharedFile { name: string; path: string; mimeType: string }
interface ShareInboxPlugin {
  consume(): Promise<{ files: SharedFile[] }>;
  addListener(event: 'shared', cb: () => void): Promise<PluginListenerHandle>;
}
const ShareInbox = registerPlugin<ShareInboxPlugin>('ShareInbox');

const FOLDER = 'Dr.Doc';

/** Bucket files only live in IndexedDB; write a temp copy so native viewers/share can use them. */
async function nativeUri(doc: StoredDoc): Promise<string> {
  if (doc.location) return doc.location;
  const res = await Filesystem.writeFile({ path: `open/${doc.name}`, data: await toBase64(doc.blob), directory: Directory.Cache, recursive: true });
  return res.uri;
}

let backHandler: (() => boolean) | null = null;
let incomingHandler: ((files: File[]) => void) | null = null;

async function uniquePath(directory: Directory, name: string): Promise<string> {
  const dot = name.lastIndexOf('.');
  const stem = dot > 0 ? name.slice(0, dot) : name;
  const ext = dot > 0 ? name.slice(dot) : '';
  for (let i = 0; i < 1000; i++) {
    const candidate = `${FOLDER}/${i ? `${stem} (${i})` : stem}${ext}`;
    try {
      await Filesystem.stat({ path: candidate, directory });
    } catch {
      return candidate;
    }
  }
  return `${FOLDER}/${stem}-${Date.now()}${ext}`;
}

const android: Platform = {
  kind: 'android',
  outputFolder: 'Internal storage › Documents › Dr.Doc',
  canShare: () => true,
  async persist(name, blob) {
    const data = await toBase64(blob);
    try {
      await Filesystem.requestPermissions().catch(() => undefined);
      const path = await uniquePath(Directory.Documents, name);
      const res = await Filesystem.writeFile({ path, data, directory: Directory.Documents, recursive: true });
      return { name: path.split('/').pop()!, location: res.uri, locationLabel: `Documents/${FOLDER}` };
    } catch {
      // Fallback: app-specific external folder (always writable, visible via USB / file managers).
      const path = await uniquePath(Directory.External, name);
      const res = await Filesystem.writeFile({ path, data, directory: Directory.External, recursive: true });
      return { name: path.split('/').pop()!, location: res.uri, locationLabel: `Android/data/com.drdoc.app/files/${FOLDER}` };
    }
  },
  async open(doc) {
    try {
      await FileOpener.openFile({ path: await nativeUri(doc), mimeType: mimeFor(doc.name) });
    } catch {
      throw new Error('No app found to open this file type.');
    }
  },
  async share(doc) {
    await Share.share({ title: doc.name, files: [await nativeUri(doc)] });
  },
  async exportCopy(doc) {
    await android.share(doc);
    return null;
  },
  async rename(doc, newName) {
    if (!doc.location) return null;
    // Locations are file:// URIs, so the new file name must be URI-encoded.
    const to = doc.location.slice(0, doc.location.lastIndexOf('/') + 1) + encodeURIComponent(newName);
    await Filesystem.rename({ from: doc.location, to });
    const label = doc.location.includes('/Android/data/') ? `Android/data/com.drdoc.app/files/${FOLDER}` : `Documents/${FOLDER}`;
    return { location: to, locationLabel: label };
  },
  async remove(doc) {
    if (doc.location) await Filesystem.deleteFile({ path: doc.location }).catch(() => undefined);
  },
  onIncomingFiles(cb) {
    const first = !incomingHandler;
    incomingHandler = cb;
    if (!first) return;
    const pull = async () => {
      const { files } = await ShareInbox.consume();
      if (!files.length) return;
      const out: File[] = [];
      for (const f of files) {
        const blob = await (await fetch(Capacitor.convertFileSrc(f.path))).blob();
        out.push(new File([blob], f.name, { type: f.mimeType || blob.type }));
      }
      incomingHandler?.(out);
    };
    pull().catch(console.error);
    ShareInbox.addListener('shared', () => pull().catch(console.error));
  },
  onBack(cb) {
    const first = !backHandler;
    backHandler = cb;
    if (!first) return;
    CapApp.addListener('backButton', () => {
      if (!backHandler?.()) CapApp.exitApp();
    });
  },
};

// ---------------- desktop (Electron) ----------------

interface DesktopApi {
  outputDir(): Promise<string>;
  save(name: string, data: ArrayBuffer): Promise<{ path: string; name: string }>;
  open(path: string): Promise<void>;
  reveal(path: string): Promise<void>;
  rename(path: string, newName: string): Promise<string>;
  remove(path: string): Promise<void>;
  saveAs(name: string, data: ArrayBuffer): Promise<string | null>;
  htmlToPdf(html: string, pageSize: string): Promise<Uint8Array>;
  onOpenFiles(cb: (files: { name: string; data: ArrayBuffer }[]) => void): void;
}
const desktopApi = (window as unknown as { drdocDesktop?: DesktopApi }).drdocDesktop;

function desktop(api: DesktopApi): Platform {
  const folder = (p: string) => p.replace(/[\\/][^\\/]+$/, '');
  return {
    kind: 'desktop',
    outputFolder: 'Documents › Dr.Doc',
    canShare: () => false,
    async persist(name, blob) {
      const res = await api.save(name, await blob.arrayBuffer());
      return { name: res.name, location: res.path, locationLabel: folder(res.path) };
    },
    async open(doc) {
      if (doc.location) await api.open(doc.location);
      else await web.open(doc);
    },
    async share(doc) {
      if (doc.location) await api.reveal(doc.location);
    },
    async exportCopy(doc) {
      const p = await api.saveAs(doc.name, await doc.blob.arrayBuffer());
      return p ? `Saved to ${p}` : null;
    },
    async rename(doc, newName) {
      if (!doc.location) return null;
      const p = await api.rename(doc.location, newName);
      return { location: p, locationLabel: folder(p) };
    },
    async remove(doc) {
      if (doc.location) await api.remove(doc.location);
    },
    async reveal(doc) {
      if (doc.location) await api.reveal(doc.location);
    },
    htmlToPdf: (html, pageSize) => api.htmlToPdf(html, pageSize),
    onIncomingFiles(cb) {
      const first = !incomingHandler;
      incomingHandler = cb;
      if (first) api.onOpenFiles((files) => incomingHandler?.(files.map((f) => new File([f.data], f.name, { type: mimeFor(f.name) }))));
    },
    onBack() {},
  };
}

export const platform: Platform = desktopApi ? desktop(desktopApi) : Capacitor.isNativePlatform() ? android : web;
