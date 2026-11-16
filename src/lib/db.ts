// IndexedDB storage for the file bucket and generated-output history.
// Schema is shared with public/sw.js (which writes shared files into 'bucket').

export interface BucketFile {
  id: string;
  name: string;
  type: string;
  size: number;
  blob: Blob;
  addedAt: number;
  source: 'picked' | 'shared' | 'output';
}

export interface HistoryItem {
  id: string;
  name: string;
  type: string;
  size: number;
  blob: Blob;
  createdAt: number;
  tool: string;
  inputs: string[];
  /** Absolute path / URI on disk (Android + desktop). Undefined on web. */
  location?: string;
  /** Human-friendly folder shown to the user. */
  locationLabel?: string;
}

type StoreName = 'bucket' | 'history';

let dbPromise: Promise<IDBDatabase> | null = null;

function openDb(): Promise<IDBDatabase> {
  if (dbPromise) return dbPromise;
  dbPromise = new Promise((resolve, reject) => {
    const req = indexedDB.open('drdoc', 1);
    req.onupgradeneeded = () => {
      const db = req.result;
      if (!db.objectStoreNames.contains('bucket')) db.createObjectStore('bucket', { keyPath: 'id' });
      if (!db.objectStoreNames.contains('history')) db.createObjectStore('history', { keyPath: 'id' });
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
  return dbPromise;
}

async function tx<T>(store: StoreName, mode: IDBTransactionMode, fn: (s: IDBObjectStore) => IDBRequest | void): Promise<T> {
  const db = await openDb();
  return new Promise((resolve, reject) => {
    const t = db.transaction(store, mode);
    const req = fn(t.objectStore(store));
    t.oncomplete = () => resolve((req ? req.result : undefined) as T);
    t.onerror = () => reject(t.error);
  });
}

export const newId = () => `${Date.now()}-${Math.random().toString(36).slice(2, 10)}`;

export const db = {
  all: <T>(store: StoreName) => tx<T[]>(store, 'readonly', (s) => s.getAll()),
  put: (store: StoreName, value: BucketFile | HistoryItem) => tx<void>(store, 'readwrite', (s) => s.put(value)),
  remove: (store: StoreName, id: string) => tx<void>(store, 'readwrite', (s) => s.delete(id)),
  clear: (store: StoreName) => tx<void>(store, 'readwrite', (s) => s.clear()),
};
