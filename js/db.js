// IndexedDB 資料層
// v2 起加入「書」這一層：每個 section 都屬於一本 book。
// v3 起把圖片（base64）從 section 裡搬到獨立的 figures store：
//   section.paras 的圖塊只留 { kind, caption, text, figId }，圖檔本體另外存。
//   一本大書的圖可以到好幾百 MB，若跟內文黏在一起，任何一次 getAll()
//   都會把整包反序列化進記憶體，手機直接被系統砍掉。拆開之後
//   書架／目錄／搜尋只碰得到純文字，圖只在真的要顯示那一節時才載。
// 從 v1／v2 升上來的舊資料不會遺失，開檔後會逐章搬移（可中斷、可續跑）。
const DB_NAME = 'bookreader-db';
const DB_VER = 3;
const SPLIT_FLAG = 'figuresSplit';   // 圖片搬移完成的註記
let _db = null;

export const uid = () => Date.now().toString(36) + Math.random().toString(36).slice(2, 8);

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
      if (!db.objectStoreNames.contains('figures')) {
        const f = db.createObjectStore('figures', { keyPath: 'id' });
        f.createIndex('sectionId', 'sectionId');
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
      // v2 → v3 的圖片搬移刻意不放在這裡：versionchange 交易是全有全無，
      // 幾百 MB 一次寫完若失敗就整批回滾，手機上風險太高。
      // 改成開檔後逐章搬（splitFigures），中途中斷也能接著跑。
      if (ev.oldVersion && ev.oldVersion < 3) localStorage.removeItem(SPLIT_FLAG);
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
    t.onabort = () => reject(t.error || new Error('交易被中止（可能是儲存空間不足）'));
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

function keysByIndex(store, index, key) {
  return openDB().then(d => new Promise((res, rej) => {
    const req = d.transaction(store).objectStore(store).index(index).getAllKeys(key);
    req.onsuccess = () => res(req.result || []);
    req.onerror = () => rej(req.error);
  }));
}

function countByIndex(store, index, key) {
  return openDB().then(d => new Promise((res, rej) => {
    const req = d.transaction(store).objectStore(store).index(index).count(key);
    req.onsuccess = () => res(req.result || 0);
    req.onerror = () => rej(req.error);
  }));
}

// 寫入一個章節：若 paras 裡還帶著內嵌圖片（舊資料、舊備份、內容包），
// 就地拆進 figures store。所有寫入路徑都經過這裡，格式因此只會有一種。
function writeSection(s) {
  return openDB().then(d => new Promise((resolve, reject) => {
    const t = d.transaction(['sections', 'figures'], 'readwrite');
    const figs = t.objectStore('figures');
    const paras = (Array.isArray(s.paras) ? s.paras : []).map(p => {
      if (p && typeof p === 'object' && p.img) {
        const figId = p.figId || ('f' + uid());
        figs.put({ id: figId, sectionId: s.id, img: p.img });
        const { img, ...rest } = p;
        return { ...rest, figId };
      }
      return p;
    });
    t.objectStore('sections').put({ ...s, paras });
    t.oncomplete = () => resolve();
    t.onerror = () => reject(t.error);
    t.onabort = () => reject(t.error || new Error('交易被中止（可能是儲存空間不足）'));
  }));
}

async function dropFigures(sectionId) {
  const ids = await keysByIndex('figures', 'sectionId', sectionId);
  if (!ids.length) return;
  await tx('figures', 'readwrite', st => { ids.forEach(id => st.delete(id)); });
}

export const db = {
  /* ----- 書 ----- */
  putBook: (b) => tx('books', 'readwrite', st => { st.put(b); }),
  getBook: (id) => tx('books', 'readonly', st => reqVal(st.get(id))),
  allBooks: () => tx('books', 'readonly', st => reqVal(st.getAll()))
    .then(list => (list || []).sort((a, b) => (a.order || 0) - (b.order || 0))),
  deleteBook: async (id) => {
    for (const sid of await db.sectionKeysOf(id)) {
      await db.deleteHighlightsFor(sid);
      await db.deleteSection(sid);
    }
    await tx('books', 'readwrite', st => { st.delete(id); });
  },

  /* ----- 章節 ----- */
  putSection: (s) => writeSection(s),
  deleteSection: async (id) => {
    await dropFigures(id);
    await tx('sections', 'readwrite', st => { st.delete(id); });
  },
  getSection: (id) => tx('sections', 'readonly', st => reqVal(st.get(id))),
  allSections: () => tx('sections', 'readonly', st => reqVal(st.getAll()))
    .then(list => (list || []).sort((a, b) => a.order - b.order)),
  sectionsOf: (bookId) => byIndex('sections', 'bookId', bookId)
    .then(list => list.sort((a, b) => a.order - b.order)),
  // 只要 id，不碰內文——書架與匯出用它來避開整包載入
  sectionKeysOf: (bookId) => keysByIndex('sections', 'bookId', bookId),
  countSectionsOf: (bookId) => countByIndex('sections', 'bookId', bookId),

  /* ----- 圖片 ----- */
  figuresFor: (sectionId) => byIndex('figures', 'sectionId', sectionId),

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
    await tx('figures', 'readwrite', st => { st.clear(); });
    await tx('highlights', 'readwrite', st => { st.clear(); });
    await tx('books', 'readwrite', st => { st.clear(); });
    localStorage.setItem(SPLIT_FLAG, 'done');
  },
};

/* ---------- 舊資料的圖片搬移 ----------
   一次處理一章：讀進來、拆圖、寫回，記憶體峰值就是單一章節（不到 1 MB）。
   跑完記一個旗標；旗標掉了也只是重掃一遍，已拆過的章節不會重複搬。 */
export async function splitFigures(onProgress) {
  await openDB();
  if (localStorage.getItem(SPLIT_FLAG) === 'done') return 0;
  const ids = await tx('sections', 'readonly', st => reqVal(st.getAllKeys()));
  const list = ids || [];
  let moved = 0;
  for (let i = 0; i < list.length; i++) {
    const s = await db.getSection(list[i]);
    if (s && Array.isArray(s.paras) && s.paras.some(p => p && typeof p === 'object' && p.img)) {
      await writeSection(s);
      moved++;
    }
    onProgress?.(i + 1, list.length);
  }
  localStorage.setItem(SPLIT_FLAG, 'done');
  return moved;
}
