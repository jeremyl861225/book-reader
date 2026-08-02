// IndexedDB 資料層
// v2 起加入「書」這一層：每個 section 都屬於一本 book。
// 從 v1 升上來的舊資料會全部歸到一本預設書，不會遺失。
const DB_NAME = 'bookreader-db';
const DB_VER = 2;
let _db = null;

function openDB() {
  if (_db) return Promise.resolve(_db);
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, DB_VER);
    req.onupgradeneeded = (ev) => {
      const db = req.result;
      const t = req.transaction;
      if (!db.objectStoreNames.contains('sections')) {
        const s = db.createObjectStore('sections', { keyPath: 'id' });
        s.createIndex('order', 'order');
      }
      if (!db.objectStoreNames.contains('highlights')) {
        const h = db.createObjectStore('highlights', { keyPath: 'id' });
        h.createIndex('sectionId', 'sectionId');
      }
      if (!db.objectStoreNames.contains('books')) {
        db.createObjectStore('books', { keyPath: 'id' });
      }
      const secStore = t.objectStore('sections');
      if (!secStore.indexNames.contains('bookId')) secStore.createIndex('bookId', 'bookId');

      // v1 → v2：把既有章節收進一本預設書
      if (ev.oldVersion && ev.oldVersion < 2) {
        const getAll = secStore.getAll();
        getAll.onsuccess = () => {
          const list = getAll.result || [];
          if (!list.length) return;
          const bookId = 'b' + Date.now().toString(36);
          t.objectStore('books').put({
            id: bookId, title: '我的書', order: 1, addedAt: Date.now(),
          });
          for (const s of list) {
            if (!s.bookId) { s.bookId = bookId; secStore.put(s); }
          }
        };
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

function byIndex(store, index, key) {
  return openDB().then(d => new Promise((res, rej) => {
    const req = d.transaction(store).objectStore(store).index(index).getAll(key);
    req.onsuccess = () => res(req.result || []);
    req.onerror = () => rej(req.error);
  }));
}

export const db = {
  /* ----- 書 ----- */
  putBook: (b) => tx('books', 'readwrite', st => { st.put(b); }),
  getBook: (id) => tx('books', 'readonly', st => reqVal(st.get(id))),
  allBooks: () => tx('books', 'readonly', st => reqVal(st.getAll()))
    .then(list => (list || []).sort((a, b) => (a.order || 0) - (b.order || 0))),
  deleteBook: async (id) => {
    for (const s of await db.sectionsOf(id)) {
      await db.deleteHighlightsFor(s.id);
      await db.deleteSection(s.id);
    }
    await tx('books', 'readwrite', st => { st.delete(id); });
  },

  /* ----- 章節 ----- */
  putSection: (s) => tx('sections', 'readwrite', st => { st.put(s); }),
  deleteSection: (id) => tx('sections', 'readwrite', st => { st.delete(id); }),
  getSection: (id) => tx('sections', 'readonly', st => reqVal(st.get(id))),
  allSections: () => tx('sections', 'readonly', st => reqVal(st.getAll()))
    .then(list => (list || []).sort((a, b) => a.order - b.order)),
  sectionsOf: (bookId) => byIndex('sections', 'bookId', bookId)
    .then(list => list.sort((a, b) => a.order - b.order)),

  /* ----- 標記 ----- */
  putHighlight: (h) => tx('highlights', 'readwrite', st => { st.put(h); }),
  deleteHighlight: (id) => tx('highlights', 'readwrite', st => { st.delete(id); }),
  getHighlight: (id) => tx('highlights', 'readonly', st => reqVal(st.get(id))),
  allHighlights: () => tx('highlights', 'readonly', st => reqVal(st.getAll())).then(l => l || []),
  highlightsFor: (sectionId) => byIndex('highlights', 'sectionId', sectionId),
  deleteHighlightsFor: async (sectionId) => {
    const hs = await db.highlightsFor(sectionId);
    for (const h of hs) await db.deleteHighlight(h.id);
  },

  wipe: async () => {
    await tx('sections', 'readwrite', st => { st.clear(); });
    await tx('highlights', 'readwrite', st => { st.clear(); });
    await tx('books', 'readwrite', st => { st.clear(); });
  },
};

export const uid = () => Date.now().toString(36) + Math.random().toString(36).slice(2, 8);
