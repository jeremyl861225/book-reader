// IndexedDB 資料層
const DB_NAME = 'bookreader-db';
const DB_VER = 1;
let _db = null;

function openDB() {
  if (_db) return Promise.resolve(_db);
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, DB_VER);
    req.onupgradeneeded = () => {
      const db = req.result;
      if (!db.objectStoreNames.contains('sections')) {
        const s = db.createObjectStore('sections', { keyPath: 'id' });
        s.createIndex('order', 'order');
      }
      if (!db.objectStoreNames.contains('highlights')) {
        const h = db.createObjectStore('highlights', { keyPath: 'id' });
        h.createIndex('sectionId', 'sectionId');
      }
    };
    req.onsuccess = () => { _db = req.result; resolve(_db); };
    req.onerror = () => reject(req.error);
  });
}

function tx(store, mode, fn) {
  return openDB().then(db => new Promise((resolve, reject) => {
    const t = db.transaction(store, mode);
    const result = fn(t.objectStore(store));
    t.oncomplete = () => resolve(result && result._val !== undefined ? result._val : undefined);
    t.onerror = () => reject(t.error);
  }));
}

function reqVal(req) {
  const box = { _val: undefined };
  req.onsuccess = () => { box._val = req.result; };
  return box;
}

export const db = {
  putSection: (s) => tx('sections', 'readwrite', st => { st.put(s); }),
  deleteSection: (id) => tx('sections', 'readwrite', st => { st.delete(id); }),
  getSection: (id) => tx('sections', 'readonly', st => reqVal(st.get(id))),
  allSections: () => tx('sections', 'readonly', st => reqVal(st.getAll()))
    .then(list => (list || []).sort((a, b) => a.order - b.order)),

  putHighlight: (h) => tx('highlights', 'readwrite', st => { st.put(h); }),
  deleteHighlight: (id) => tx('highlights', 'readwrite', st => { st.delete(id); }),
  getHighlight: (id) => tx('highlights', 'readonly', st => reqVal(st.get(id))),
  allHighlights: () => tx('highlights', 'readonly', st => reqVal(st.getAll())).then(l => l || []),
  highlightsFor: (sectionId) => openDB().then(d => new Promise((res, rej) => {
    const req = d.transaction('highlights').objectStore('highlights').index('sectionId').getAll(sectionId);
    req.onsuccess = () => res(req.result || []);
    req.onerror = () => rej(req.error);
  })),
  deleteHighlightsFor: async (sectionId) => {
    const hs = await db.highlightsFor(sectionId);
    for (const h of hs) await db.deleteHighlight(h.id);
  },
  wipe: async () => {
    await tx('sections', 'readwrite', st => { st.clear(); });
    await tx('highlights', 'readwrite', st => { st.clear(); });
  },
};

export const uid = () => Date.now().toString(36) + Math.random().toString(36).slice(2, 8);
