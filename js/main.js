// 主程式：書架、目錄、搜尋、筆記總覽、設定
import { db, uid, splitFigures } from './db.js';
import { importFiles, importPacks, resortSections } from './pdf-import.js';
import { initReader, openReader, toast } from './reader.js';

const $ = (s) => document.querySelector(s);
const $$ = (s) => [...document.querySelectorAll(s)];
const esc = (s) => String(s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

const APP_VERSION = 'v2.4.0';

// 書籍檔格式：一本書的內容＋螢光筆＋筆記，可自行用 AirDrop／雲端硬碟搬到別台裝置匯入
const BOOK_FILE = 'book-reader-book';
const PART_BYTES = 20 * 1024 * 1024;  // 單份上限，避免手機解析過大的 JSON

let currentBookId = localStorage.getItem('currentBook') || null;

/* ---------- 分頁切換 ---------- */
function switchView(name) {
  $$('.view').forEach(v => v.classList.toggle('active', v.id === `view-${name}`));
  const tabFor = name === 'toc' ? 'shelf' : name;
  $$('#tabbar button').forEach(b => b.classList.toggle('on', b.dataset.view === tabFor));
  if (name === 'shelf') renderShelf();
  if (name === 'toc') renderToc();
  if (name === 'notes') renderNotes();
  if (name === 'settings') renderSettings();
}
$$('#tabbar button').forEach(b => b.addEventListener('click', () => switchView(b.dataset.view)));
$('#toc-back').addEventListener('click', () => switchView('shelf'));

/* ---------- 共用文字 ---------- */
function sectionLabel(s) {
  // 第 0 節＝該篇的總覽頁，沒有章號可標
  if (s.section == null || s.section === 0) return s.title;
  return s.chapterTitle ? `${s.section}. ${s.title}` : `第${s.section}節　${s.title}`;
}
function chapterLabelFor(s) {
  return s.chapterTitle || (s.chapter == null ? '未分章' : `第${s.chapter}章`);
}

/* ---------- 書架 ---------- */
async function renderShelf() {
  const body = $('#shelf-body');
  const books = await db.allBooks();
  if (!books.length) {
    body.innerHTML = `
      <div class="empty-state">
        <p>書架還是空的。<br>到「設定」匯入書籍檔或章節。</p>
        <button class="btn primary" id="empty-import">前往設定</button>
      </div>`;
    $('#empty-import').onclick = () => switchView('settings');
    return;
  }

  // 書架只需要「每本幾章、幾個標記」——一律走 count／getAllKeys，
  // 絕不把 sections 整包載進來（那會連同圖片一起反序列化，手機會被記憶體壓死）。
  const allHls = await db.allHighlights();
  const secCount = new Map();
  const bookOfSection = new Map();
  for (const b of books) {
    secCount.set(b.id, await db.countSectionsOf(b.id));
    for (const sid of await db.sectionKeysOf(b.id)) bookOfSection.set(sid, b.id);
  }
  const hlCount = new Map();
  for (const h of allHls) {
    const b = bookOfSection.get(h.sectionId);
    if (b) hlCount.set(b, (hlCount.get(b) || 0) + 1);
  }

  const frag = document.createDocumentFragment();

  // 繼續閱讀
  try {
    const last = JSON.parse(localStorage.getItem('lastRead') || 'null');
    const lastSec = last && bookOfSection.has(last.sectionId)
      ? await db.getSection(last.sectionId) : null;
    if (lastSec) {
      const c = document.createElement('button');
      c.className = 'continue-card';
      c.innerHTML = `繼續閱讀　<b>${esc(sectionLabel(lastSec))}</b>`;
      c.onclick = () => openReader(lastSec.id, { restore: last, onClose: renderShelf });
      frag.appendChild(c);
    }
  } catch {}

  for (const b of books) {
    const nSec = secCount.get(b.id) || 0;
    const n = hlCount.get(b.id) || 0;
    const btn = document.createElement('button');
    btn.className = 'book-item';
    btn.innerHTML =
      `<span class="bt">${esc(b.title)}</span>` +
      `<span class="bm">${nSec} 個章節${n ? `・${n} 個標記` : ''}</span>`;
    btn.onclick = () => openBook(b.id);
    frag.appendChild(btn);
  }
  body.replaceChildren(frag);
}

function openBook(bookId) {
  currentBookId = bookId;
  localStorage.setItem('currentBook', bookId);
  switchView('toc');
}

/* ---------- 一本書的目錄 ---------- */
const openChapters = new Set(JSON.parse(localStorage.getItem('openChapters') || '[]'));

async function renderToc() {
  const body = $('#toc-body');
  const book = currentBookId ? await db.getBook(currentBookId) : null;
  if (!book) { switchView('shelf'); return; }
  $('#toc-title').textContent = book.title;

  const sections = await db.sectionsOf(book.id);
  if (!sections.length) {
    body.innerHTML = `<div class="empty-state"><p>這本書還沒有內容。<br>到「設定」把章節匯入這本書。</p>
      <button class="btn primary" id="empty-import2">前往設定</button></div>`;
    $('#empty-import2').onclick = () => switchView('settings');
    return;
  }

  const byChapter = new Map();
  for (const s of sections) {
    const key = String(s.chapter);
    if (!byChapter.has(key)) byChapter.set(key, []);
    byChapter.get(key).push(s);
  }
  const hlCount = new Map();
  (await db.allHighlights()).forEach(h => hlCount.set(h.sectionId, (hlCount.get(h.sectionId) || 0) + 1));

  const frag = document.createDocumentFragment();
  for (const [key, secs] of byChapter) {
    const okey = `${book.id}:${key}`;
    const block = document.createElement('div');
    block.className = 'chapter-block' + (openChapters.has(okey) || byChapter.size === 1 ? ' open' : '');
    const head = document.createElement('button');
    head.className = 'chapter-head';
    head.innerHTML = `<span>${esc(chapterLabelFor(secs[0]))}</span><span class="chev">›</span>`;
    head.onclick = () => {
      block.classList.toggle('open');
      block.classList.contains('open') ? openChapters.add(okey) : openChapters.delete(okey);
      localStorage.setItem('openChapters', JSON.stringify([...openChapters]));
    };
    const list = document.createElement('div');
    list.className = 'section-list';
    for (const s of secs) {
      const item = document.createElement('button');
      item.className = 'section-item';
      const n = hlCount.get(s.id);
      item.innerHTML = `<span>${esc(sectionLabel(s))}</span><span class="meta">${n ? `${n} 標記` : ''}</span>`;
      item.onclick = () => openReader(s.id, { onClose: renderToc });
      list.appendChild(item);
    }
    block.append(head, list);
    frag.appendChild(block);
  }
  body.replaceChildren(frag);
}

/* ---------- 搜尋（跨整個書架） ---------- */
$('#search-form').addEventListener('submit', async (e) => {
  e.preventDefault();
  $('#search-input').blur();
  const q = $('#search-input').value.trim();
  const body = $('#search-body');
  if (!q) return;
  const [sections, books] = await Promise.all([db.allSections(), db.allBooks()]);
  const bookTitle = new Map(books.map(b => [b.id, b.title]));
  const multi = books.length > 1;
  const results = [];
  const lower = q.toLowerCase();
  for (const s of sections) {
    s.paras.forEach((p, i) => {
      // 表格與插圖是整塊算圖保留的，但帶著純文字，一樣要搜得到
      const text = typeof p === 'string' ? p : (p && p.text);
      if (!text) return;
      let from = 0;
      const pl = text.toLowerCase();
      while (results.length < 300) {
        const at = pl.indexOf(lower, from);
        if (at === -1) break;
        results.push({ section: s, paraIdx: i, at, text, kind: typeof p === 'string' ? null : (p.kind || 'figure') });
        from = at + lower.length;
      }
    });
  }
  if (!results.length) {
    body.innerHTML = `<p class="hint">找不到「${esc(q)}」。</p>`;
    return;
  }
  const frag = document.createDocumentFragment();
  const count = document.createElement('p');
  count.className = 'hint';
  count.textContent = `共 ${results.length} 筆結果${results.length >= 300 ? '（僅顯示前 300 筆）' : ''}`;
  frag.appendChild(count);
  for (const r of results) {
    const text = r.text;
    const s0 = Math.max(0, r.at - 30);
    const e2 = Math.min(text.length, r.at + q.length + 40);
    const snippet = (s0 > 0 ? '…' : '') +
      esc(text.slice(s0, r.at)) + `<mark>${esc(text.slice(r.at, r.at + q.length))}</mark>` +
      esc(text.slice(r.at + q.length, e2)) + (e2 < text.length ? '…' : '');
    const btn = document.createElement('button');
    btn.className = 'result-item';
    const tag = r.kind === 'table' ? '［表格］' : r.kind === 'figure' ? '［圖］' : '';
    const where = (multi ? `${esc(bookTitle.get(r.section.bookId) || '')}・` : '') +
      `${esc(chapterLabelFor(r.section))}・${esc(sectionLabel(r.section))}${tag}`;
    btn.innerHTML = `<div class="loc">${where}</div>${snippet}`;
    btn.onclick = () => openReader(r.section.id, { scrollToPara: r.paraIdx });
    frag.appendChild(btn);
  }
  body.replaceChildren(frag);
});

/* ---------- 筆記總覽 ---------- */
let notesFilter = 'all';
$('#notes-filter').addEventListener('click', (e) => {
  const b = e.target.closest('button');
  if (!b) return;
  notesFilter = b.dataset.f;
  $$('#notes-filter button').forEach(x => x.classList.toggle('on', x === b));
  renderNotes();
});

async function renderNotes() {
  const body = $('#notes-body');
  const [hls, sections, books] = await Promise.all([db.allHighlights(), db.allSections(), db.allBooks()]);
  const secMap = new Map(sections.map(s => [s.id, s]));
  const bookTitle = new Map(books.map(b => [b.id, b.title]));
  const multi = books.length > 1;

  const groups = new Map();
  for (const h of hls.sort((a, b) => a.paraIdx - b.paraIdx || a.start - b.start)) {
    if (!groups.has(h.groupId)) groups.set(h.groupId, { ...h, quote: h.quote });
    else groups.get(h.groupId).quote += h.quote;
  }
  let list = [...groups.values()].sort((a, b) => b.createdAt - a.createdAt);
  if (notesFilter === 'noted') list = list.filter(g => g.note);

  if (!list.length) {
    body.innerHTML = `<p class="hint">還沒有${notesFilter === 'noted' ? '筆記' : '標記'}。在閱讀時長按選取文字即可畫螢光筆。</p>`;
    return;
  }
  const colorVar = { yellow: 'var(--hl-yellow)', green: 'var(--hl-green)', blue: 'var(--hl-blue)', pink: 'var(--hl-pink)' };
  const frag = document.createDocumentFragment();
  for (const g of list) {
    const sec = secMap.get(g.sectionId);
    if (!sec) continue;
    const btn = document.createElement('button');
    btn.className = 'result-item';
    const where = (multi ? `${esc(bookTitle.get(sec.bookId) || '')}・` : '') +
      `${esc(chapterLabelFor(sec))}・${esc(sectionLabel(sec))}`;
    btn.innerHTML =
      `<div class="loc">${where}</div>` +
      `<div class="note-quote" style="border-color:${colorVar[g.color] || colorVar.yellow};background:${colorVar[g.color] || colorVar.yellow}55">${esc(g.quote)}</div>` +
      (g.note ? `<div class="note-text">${esc(g.note)}</div>` : '');
    btn.onclick = () => openReader(g.sectionId, { scrollToHl: g.id, onClose: renderNotes });
    frag.appendChild(btn);
  }
  body.replaceChildren(frag);
}

/* ---------- 設定 ---------- */
async function renderSettings() {
  await fillBookSelect();
  await renderBookList();
}

async function fillBookSelect() {
  const sel = $('#import-target');
  const books = await db.allBooks();
  const keep = sel.value;
  sel.innerHTML = books.map(b => `<option value="${esc(b.id)}">${esc(b.title)}</option>`).join('')
    + '<option value="__new__">＋ 新增一本書…</option>';
  if (books.some(b => b.id === keep)) sel.value = keep;
  else if (books.some(b => b.id === currentBookId)) sel.value = currentBookId;
}

// 取得匯入目標；選「新增」時問書名並建立
async function resolveTargetBook() {
  const sel = $('#import-target');
  if (sel.value && sel.value !== '__new__') return sel.value;
  const title = prompt('新書名稱：', '');
  if (title === null) return null;
  const id = await createBook(title.trim() || '未命名的書');
  await fillBookSelect();
  sel.value = id;
  return id;
}

async function createBook(title, key) {
  const books = await db.allBooks();
  const id = 'b' + uid();
  await db.putBook({
    id, key: key || null, title,
    order: books.reduce((m, b) => Math.max(m, b.order || 0), 0) + 1,
    addedAt: Date.now(),
  });
  return id;
}

/* ----- 匯入章節（PDF / 內容包） ----- */
$('#btn-import').addEventListener('click', async () => {
  const bookId = await resolveTargetBook();
  if (!bookId) return;
  $('#file-input').dataset.book = bookId;
  $('#file-input').click();
});
$('#file-input').addEventListener('change', async (e) => {
  const files = [...(e.target.files || [])];
  const bookId = e.target.dataset.book;
  if (!files.length || !bookId) return;
  const prog = $('#import-progress');
  prog.hidden = false;
  const pdfs = files.filter(f => /\.pdf$/i.test(f.name));
  const packs = files.filter(f => /\.json$/i.test(f.name));
  let ok = 0, failed = [];
  if (pdfs.length) {
    const r = await importFiles(pdfs, bookId, (msg) => { prog.textContent = msg; });
    ok += r.ok; failed.push(...r.failed);
  }
  if (packs.length) {
    const r = await importPacks(packs, bookId, (msg) => { prog.textContent = msg; });
    ok += r.ok; failed.push(...r.failed);
  }
  prog.textContent = `完成：成功 ${ok} 個章節` + (failed.length ? `，失敗 ${failed.length} 個：${failed.join('、')}` : '');
  e.target.value = '';
  await renderBookList();
  if (ok) { toast(`已匯入 ${ok} 個章節`); openBook(bookId); }
});

/* ----- 書籍管理 ----- */
// 書一律靠匯入產生，不再提供「新增空書」。匯入 PDF 章節時若書架還空著，
// 由「收進哪一本書」的『＋ 新增一本書…』就地開一本收容，那是匯入流程的一部分。

async function renderBookList() {
  const wrap = $('#book-list');
  const books = await db.allBooks();
  if (!books.length) { wrap.innerHTML = '<p class="hint">還沒有任何書。</p>'; return; }
  const frag = document.createDocumentFragment();
  for (const b of books) {
    const n = await db.countSectionsOf(b.id);   // 只數，不載內文
    const row = document.createElement('div');
    row.className = 'manage-item';
    row.innerHTML =
      `<span class="t">${esc(b.title)}<small>${n} 章</small></span>` +
      `<button data-act="export">匯出</button>` +
      `<button data-act="rename">改名</button>` +
      `<button data-act="del">刪除</button>`;
    row.querySelector('[data-act="export"]').onclick = () => exportBook(b);
    row.querySelector('[data-act="rename"]').onclick = async () => {
      const t = prompt('書名：', b.title);
      if (t === null) return;
      b.title = t.trim() || b.title;
      await db.putBook(b);
      await renderSettings();
    };
    row.querySelector('[data-act="del"]').onclick = async () => {
      if (!confirm(`刪除《${b.title}》？這本書的全部章節、螢光筆與筆記都會一併刪除。`)) return;
      if (!confirm('再次確認：此動作無法復原。建議先「匯出」保存。')) return;
      await db.deleteBook(b.id);
      if (currentBookId === b.id) { currentBookId = null; localStorage.removeItem('currentBook'); }
      await renderSettings();
      toast('已刪除');
    };
    frag.appendChild(row);
  }
  wrap.replaceChildren(frag);
}

/* ----- 匯出一本書（內容＋螢光筆＋筆記） ----- */
function downloadBlob(blob, filename) {
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = filename;
  a.click();
  setTimeout(() => URL.revokeObjectURL(a.href), 4000);
}
function download(obj, filename) {
  downloadBlob(new Blob([JSON.stringify(obj)], { type: 'application/json' }), filename);
}

// 圖片存在 figures store，匯出時再貼回 paras 裡，書籍檔格式保持不變。
async function inlineSection(s) {
  const figs = new Map((await db.figuresFor(s.id)).map(f => [f.id, f.img]));
  if (!figs.size) return s;
  return {
    ...s,
    paras: s.paras.map(p => {
      if (p && typeof p === 'object' && p.figId) {
        const { figId, ...rest } = p;
        const img = figs.get(figId);
        return img ? { ...rest, img } : rest;
      }
      return p;
    }),
  };
}

async function exportBook(book) {
  const prog = $('#book-progress');
  prog.hidden = false;
  prog.textContent = '準備匯出…';

  // 只先取得順序，內文一章一章讀，記憶體峰值維持在單一份（約 20 MB）
  const ids = (await db.sectionsOf(book.id)).map(s => s.id);
  if (!ids.length) { prog.textContent = '這本書沒有內容可匯出。'; return; }

  const key = book.key || book.id;
  const safe = book.title.replace(/[\\/:*?"<>|]/g, '-').slice(0, 60);
  let cur = [], curHls = [], curBytes = 0, part = 0;

  // 一份填滿就立刻存檔並清空。總份數要跑完才知道，所以檔名用 partN，
  // 匯入端是依 book.key 分組的，不看份號也不看順序。
  const flush = async () => {
    if (!cur.length) return;
    part++;
    prog.textContent = `匯出第 ${part} 份…`;
    download({
      app: BOOK_FILE, version: 1, exportedAt: new Date().toISOString(),
      book: { key, title: book.title },
      part, sections: cur, highlights: curHls,
    }, `${safe}-part${part}.book.json`);
    cur = []; curHls = []; curBytes = 0;
    await new Promise(r => setTimeout(r, 600));   // 讓瀏覽器逐份存檔
  };

  for (let i = 0; i < ids.length; i++) {
    if (!cur.length) prog.textContent = `讀取第 ${i + 1}/${ids.length} 章…`;
    const raw = await db.getSection(ids[i]);
    if (!raw) continue;
    const s = await inlineSection(raw);
    const bytes = JSON.stringify(s).length;
    // 依大小切份，避免單一檔案過大導致手機匯入時解析失敗
    if (cur.length && curBytes + bytes > PART_BYTES) await flush();
    cur.push(s); curBytes += bytes;
    curHls.push(...await db.highlightsFor(s.id));
  }
  await flush();

  prog.textContent = `已匯出 ${part} 個檔案（part1～part${part}），共 ${ids.length} 章。匯入時請一次全選，缺一份就會少章節。`;
  toast('匯出完成');
}

/* ----- 匯入書籍檔 ----- */
$('#btn-import-book').addEventListener('click', () => $('#book-input').click());
$('#book-input').addEventListener('change', async (e) => {
  const files = [...(e.target.files || [])];
  e.target.value = '';
  if (!files.length) return;
  const prog = $('#book-progress');
  prog.hidden = false;
  try {
    const n = await importBookFiles(files, (m) => { prog.textContent = m; });
    prog.textContent = `匯入完成：${n.books} 本書、${n.sections} 個章節、${n.highlights} 個標記。`;
    toast('匯入完成');
    await renderSettings();
    switchView('shelf');
  } catch (err) {
    prog.textContent = `匯入失敗：${err.message || err}`;
  }
});

async function importBookFiles(files, onStatus) {
  // 一個檔案讀完就寫進 DB 再放掉。若先把 13 份 20 MB 的檔案全 parse 起來，
  // 光是圖片就會讓手機在開始寫入之前就被記憶體壓死。
  let nBooks = 0, nSecs = 0, nHls = 0;
  const bookOf = new Map();   // book.key → book（跨檔案沿用同一本）
  const idMap = new Map();    // 原 sectionId → 新 sectionId（標記靠它對位）
  const maxOrder = new Map();
  const existing = await db.allBooks();

  for (let i = 0; i < files.length; i++) {
    onStatus?.(`讀取 ${i + 1}/${files.length}：${files[i].name}`);
    let d;
    try { d = JSON.parse(await files[i].text()); }
    catch { throw new Error(`${files[i].name} 不是有效的 JSON`); }
    if (d.app !== BOOK_FILE || !Array.isArray(d.sections)) {
      throw new Error(`${files[i].name} 不是書籍檔（請改用「匯入章節」載入內容包）`);
    }
    const key = d.book?.key || d.book?.title || files[i].name;

    // 同一把 key 已存在就併進去，否則開新書
    let book = bookOf.get(key);
    if (!book) {
      book = existing.find(b => b.key && b.key === key);
      if (!book) {
        const id = await createBook(d.book?.title || '未命名的書', key);
        book = await db.getBook(id);
        nBooks++;
      }
      bookOf.set(key, book);
      maxOrder.set(key, (await db.sectionsOf(book.id)).reduce((m, s) => Math.max(m, s.order || 0), 0));
    }

    let order = maxOrder.get(key);
    for (let j = 0; j < d.sections.length; j++) {
      const s = d.sections[j];
      if (!Array.isArray(s.paras)) continue;
      const newId = uid();
      idMap.set(s.id, newId);
      await db.putSection({ ...s, id: newId, bookId: book.id, order: ++order, addedAt: Date.now() });
      d.sections[j] = null;   // 寫完就放掉這一章的圖片
      nSecs++;
      if (nSecs % 10 === 0) onStatus?.(`寫入《${book.title}》第 ${nSecs} 章…`);
    }
    maxOrder.set(key, order);

    for (const h of (d.highlights || [])) {
      const sid = idMap.get(h.sectionId);
      if (!sid) continue;  // 對應不到章節的標記直接略過
      await db.putHighlight({ ...h, id: uid(), sectionId: sid });
      nHls++;
    }
    d = null;
  }

  for (const book of bookOf.values()) await resortSections(book.id);
  return { books: nBooks, sections: nSecs, highlights: nHls };
}

/* ---------- 偏好 ---------- */
function applyPrefs() {
  const size = localStorage.getItem('fontSize') || '18';
  document.documentElement.style.setProperty('--reader-font', `${size}px`);
  $('#font-size').value = size;
  $('#font-size-val').textContent = `${size}px`;
  const lh = localStorage.getItem('lineHeight') || '1.9';
  document.documentElement.style.setProperty('--reader-lh', lh);
  $('#line-height').value = lh;
  $('#line-height-val').textContent = Number(lh).toFixed(1);
  const theme = localStorage.getItem('theme') || 'auto';
  $('#theme-sel').value = theme;
  if (theme === 'auto') document.documentElement.removeAttribute('data-theme');
  else document.documentElement.setAttribute('data-theme', theme);
}
$('#font-size').addEventListener('input', (e) => {
  localStorage.setItem('fontSize', e.target.value);
  applyPrefs();
});
$('#line-height').addEventListener('input', (e) => {
  localStorage.setItem('lineHeight', e.target.value);
  applyPrefs();
});
$('#theme-sel').addEventListener('change', (e) => {
  localStorage.setItem('theme', e.target.value);
  applyPrefs();
});

/* ---------- 整機備份 ---------- */
$('#btn-export').addEventListener('click', async () => {
  const btn = $('#btn-export');
  const est = await navigator.storage?.estimate?.().catch(() => null);
  const mb = est?.usage ? Math.round(est.usage / 1e6) : 0;
  if (mb > 50 && !confirm(
    `目前資料約 ${mb} MB。整機備份是單一檔案，還原時手機得一次解析整份，這個大小很容易失敗。\n` +
    `建議改用「書籍管理 → 匯出」，它會自動分份，內容、螢光筆與筆記一樣都在。\n\n仍要繼續嗎？`)) return;
  btn.disabled = true;
  try {
    // 逐章串進 Blob：不把整份備份兜成一條字串，記憶體峰值維持在單一章節
    const chunks = [
      '{"app":"book-reader","version":2,"exportedAt":' + JSON.stringify(new Date().toISOString()),
      ',"books":' + JSON.stringify(await db.allBooks()),
      ',"highlights":' + JSON.stringify(await db.allHighlights()),
      ',"sections":[',
    ];
    const ids = (await db.allSections()).map(s => s.id);
    let first = true;
    for (const id of ids) {
      const raw = await db.getSection(id);
      if (!raw) continue;
      chunks.push((first ? '' : ',') + JSON.stringify(await inlineSection(raw)));
      first = false;
    }
    chunks.push(']}');
    downloadBlob(new Blob(chunks, { type: 'application/json' }),
      `book-reader-backup-${new Date().toISOString().slice(0, 10)}.json`);
    toast('備份完成');
  } catch (err) {
    alert(`匯出失敗：${err.message || err}`);
  } finally {
    btn.disabled = false;
  }
});

$('#btn-restore').addEventListener('click', () => $('#restore-input').click());
$('#restore-input').addEventListener('change', async (e) => {
  const f = e.target.files?.[0];
  e.target.value = '';
  if (!f) return;
  try {
    const data = JSON.parse(await f.text());
    if (data.app !== 'book-reader' || !Array.isArray(data.sections)) throw new Error('格式不符');
    if (!confirm(`還原備份會覆蓋目前全部資料（${data.sections.length} 個章節、${data.highlights?.length || 0} 個標記），確定？`)) return;
    await db.wipe();
    // 舊版備份沒有 books，補一本預設書收容
    let books = data.books;
    if (!Array.isArray(books) || !books.length) {
      const id = 'b' + uid();
      books = [{ id, title: '我的書', order: 1, addedAt: Date.now() }];
      data.sections.forEach(s => { s.bookId = id; });
    }
    for (const b of books) await db.putBook(b);
    for (const s of data.sections) await db.putSection(s);
    for (const h of (data.highlights || [])) await db.putHighlight(h);
    toast('還原完成');
    switchView('shelf');
  } catch (err) {
    alert(`還原失敗：${err.message || err}`);
  }
});

$('#btn-wipe').addEventListener('click', async () => {
  if (!confirm('確定要清除書架上所有書籍、螢光筆與筆記嗎？此動作無法復原。')) return;
  if (!confirm('再次確認：真的要全部清除？建議先匯出備份。')) return;
  await db.wipe();
  localStorage.removeItem('lastRead');
  localStorage.removeItem('currentBook');
  currentBookId = null;
  toast('已清除');
  switchView('shelf');
});

/* ---------- 啟動 ---------- */
// 舊資料的圖片還混在章節裡時，先搬到獨立的 figures store 再開始畫面。
// 一章一個交易，中途關掉 App 也不會壞資料，下次接著跑。
async function boot() {
  let overlay = null;
  try {
    await splitFigures((done, total) => {
      if (!overlay) {
        overlay = document.createElement('div');
        overlay.id = 'boot-overlay';
        overlay.innerHTML = '<div><b>正在整理書籍內容…</b><p class="hint">只有這一次，請不要關閉。</p><p class="hint" id="boot-n"></p></div>';
        document.body.appendChild(overlay);
      }
      $('#boot-n').textContent = `${done} / ${total}`;
    });
  } catch (err) {
    console.error('figure split failed', err);
  }
  overlay?.remove();
  await renderShelf();

  // 直接接回上次讀到的位置——按左上角返回才回書架
  try {
    const last = JSON.parse(localStorage.getItem('lastRead') || 'null');
    if (last?.sectionId && await db.getSection(last.sectionId)) {
      await openReader(last.sectionId, { restore: last, onClose: renderShelf });
    }
  } catch {}
}

applyPrefs();
initReader();
boot();
/* ---------- Service Worker 與更新 ----------
   加到主畫面的 PWA 最容易卡在舊版：舊的 SW 先把舊快取端出來，
   新版要等到下下次開啟才輪得到，使用者只會覺得「更新不了」。
   這裡做三件事：開啟時主動查一次、每次回到前景再查一次、
   新的 SW 一接管就自動重載，讓更新最多延後幾秒而不是好幾天。 */
let swReg = null;
if ('serviceWorker' in navigator && location.protocol === 'https:') {
  const hadController = !!navigator.serviceWorker.controller;
  navigator.serviceWorker.register('sw.js').then(reg => {
    swReg = reg;
    reg.update().catch(() => {});
    document.addEventListener('visibilitychange', () => {
      if (document.visibilityState === 'visible') reg.update().catch(() => {});
    });
  }).catch(() => {});

  let reloading = false;
  navigator.serviceWorker.addEventListener('controllerchange', () => {
    if (!hadController || reloading) return;   // 首次安裝不必重載；也只重載一次
    reloading = true;
    location.reload();
  });
}

// 版本號兼作手動更新入口——iOS 偶爾會很久才自己查一次
const verEl = $('#app-version');
verEl.textContent = `Book reader ${APP_VERSION}・點這裡檢查更新`;
verEl.style.cursor = 'pointer';
verEl.addEventListener('click', async () => {
  if (!swReg) { location.reload(); return; }
  toast('檢查更新中…');
  try {
    await swReg.update();
    // 有新版的話 controllerchange 會把頁面重載，走不到下面這行
    setTimeout(() => toast('已是最新版'), 2500);
  } catch {
    toast('檢查失敗，請確認網路');
  }
});
