// 主程式：分頁導覽、目錄、搜尋、筆記總覽、設定
import { db, uid } from './db.js';
import { importFiles, importPacks, loadSample, resortSections } from './pdf-import.js';
import { initReader, openReader, toast } from './reader.js';

const $ = (s) => document.querySelector(s);
const $$ = (s) => [...document.querySelectorAll(s)];
const esc = (s) => s.replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

const APP_VERSION = 'v1.1.0';

/* ---------- 分頁切換 ---------- */
function switchView(name) {
  $$('.view').forEach(v => v.classList.toggle('active', v.id === `view-${name}`));
  $$('#tabbar button').forEach(b => b.classList.toggle('on', b.dataset.view === name));
  if (name === 'toc') renderToc();
  if (name === 'notes') renderNotes();
  if (name === 'settings') renderManageList();
}
$$('#tabbar button').forEach(b => b.addEventListener('click', () => switchView(b.dataset.view)));

/* ---------- 目錄 ---------- */
const openChapters = new Set(JSON.parse(localStorage.getItem('openChapters') || '[]'));

function sectionLabel(s) {
  return (s.section != null ? `第${s.section}節　` : '') + s.title;
}
function chapterLabel(key) {
  return key === 'null' ? '未分章' : `第${key}章`;
}

async function renderToc() {
  const body = $('#toc-body');
  const sections = await db.allSections();
  if (!sections.length) {
    body.innerHTML = `
      <div class="empty-state">
        <div class="big">📚</div>
        <p>還沒有內容。<br>到「設定」匯入章節 PDF，<br>或先載入範例內容試用看看。</p>
        <button class="btn primary" id="empty-import">前往匯入</button>
      </div>`;
    $('#empty-import').onclick = () => switchView('settings');
    return;
  }

  const frag = document.createDocumentFragment();

  // 繼續閱讀
  try {
    const last = JSON.parse(localStorage.getItem('lastRead') || 'null');
    const lastSec = last && sections.find(s => s.id === last.sectionId);
    if (lastSec) {
      const c = document.createElement('button');
      c.className = 'continue-card';
      c.innerHTML = `▶ 繼續閱讀：<b>${esc(sectionLabel(lastSec))}</b>`;
      c.onclick = () => openReader(lastSec.id, { onClose: renderToc });
      frag.appendChild(c);
    }
  } catch {}

  // 章 → 節
  const byChapter = new Map();
  for (const s of sections) {
    const key = String(s.chapter);
    if (!byChapter.has(key)) byChapter.set(key, []);
    byChapter.get(key).push(s);
  }
  const hlCount = new Map();
  (await db.allHighlights()).forEach(h => hlCount.set(h.sectionId, (hlCount.get(h.sectionId) || 0) + 1));

  for (const [key, secs] of byChapter) {
    const block = document.createElement('div');
    block.className = 'chapter-block' + (openChapters.has(key) || byChapter.size === 1 ? ' open' : '');
    const head = document.createElement('button');
    head.className = 'chapter-head';
    head.innerHTML = `<span>${esc(chapterLabel(key))}</span><span class="chev">›</span>`;
    head.onclick = () => {
      block.classList.toggle('open');
      block.classList.contains('open') ? openChapters.add(key) : openChapters.delete(key);
      localStorage.setItem('openChapters', JSON.stringify([...openChapters]));
    };
    const list = document.createElement('div');
    list.className = 'section-list';
    for (const s of secs) {
      const item = document.createElement('button');
      item.className = 'section-item';
      const n = hlCount.get(s.id);
      item.innerHTML = `<span>${esc(sectionLabel(s))}</span><span class="meta">${n ? `🖍${n}` : ''}</span>`;
      item.onclick = () => openReader(s.id, { onClose: renderToc });
      list.appendChild(item);
    }
    block.append(head, list);
    frag.appendChild(block);
  }
  body.replaceChildren(frag);
}

/* ---------- 搜尋 ---------- */
$('#search-form').addEventListener('submit', async (e) => {
  e.preventDefault();
  $('#search-input').blur();
  const q = $('#search-input').value.trim();
  const body = $('#search-body');
  if (!q) return;
  const sections = await db.allSections();
  const results = [];
  const lower = q.toLowerCase();
  for (const s of sections) {
    s.paras.forEach((p, i) => {
      if (typeof p !== 'string') return;
      let from = 0;
      const pl = p.toLowerCase();
      while (results.length < 300) {
        const at = pl.indexOf(lower, from);
        if (at === -1) break;
        results.push({ section: s, paraIdx: i, at });
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
    const text = r.section.paras[r.paraIdx];
    const s = Math.max(0, r.at - 30);
    const e2 = Math.min(text.length, r.at + q.length + 40);
    const snippet = (s > 0 ? '…' : '') +
      esc(text.slice(s, r.at)) + `<mark>${esc(text.slice(r.at, r.at + q.length))}</mark>` +
      esc(text.slice(r.at + q.length, e2)) + (e2 < text.length ? '…' : '');
    const btn = document.createElement('button');
    btn.className = 'result-item';
    btn.innerHTML = `<div class="loc">${esc(chapterLabel(String(r.section.chapter)))}・${esc(sectionLabel(r.section))}</div>${snippet}`;
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
  const [hls, sections] = await Promise.all([db.allHighlights(), db.allSections()]);
  const secMap = new Map(sections.map(s => [s.id, s]));

  // 以 groupId 聚合（跨段落的同一次標記）
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
    btn.innerHTML =
      `<div class="loc">${esc(chapterLabel(String(sec.chapter)))}・${esc(sectionLabel(sec))}</div>` +
      `<div class="note-quote" style="border-color:${colorVar[g.color] || colorVar.yellow};background:${colorVar[g.color] || colorVar.yellow}22">${esc(g.quote)}</div>` +
      (g.note ? `<div class="note-text">${esc(g.note)}</div>` : '');
    btn.onclick = () => openReader(g.sectionId, { scrollToHl: g.id, onClose: renderNotes });
    frag.appendChild(btn);
  }
  body.replaceChildren(frag);
}

/* ---------- 設定：匯入 ---------- */
$('#btn-import').addEventListener('click', () => $('#file-input').click());
$('#file-input').addEventListener('change', async (e) => {
  const files = [...(e.target.files || [])];
  if (!files.length) return;
  const prog = $('#import-progress');
  prog.hidden = false;
  const pdfs = files.filter(f => /\.pdf$/i.test(f.name));
  const packs = files.filter(f => /\.json$/i.test(f.name));
  let ok = 0, failed = [];
  if (pdfs.length) {
    const r = await importFiles(pdfs, (msg) => { prog.textContent = msg; });
    ok += r.ok; failed.push(...r.failed);
  }
  if (packs.length) {
    const r = await importPacks(packs, (msg) => { prog.textContent = msg; });
    ok += r.ok; failed.push(...r.failed);
  }
  prog.textContent = `完成：成功 ${ok} 個章節` + (failed.length ? `，失敗 ${failed.length} 個：${failed.join('、')}` : '');
  e.target.value = '';
  renderManageList();
  if (ok) { toast(`已匯入 ${ok} 個章節`); switchView('toc'); }
});

$('#btn-sample').addEventListener('click', async () => {
  await loadSample();
  toast('已載入範例內容');
  switchView('toc');
});

/* ---------- 設定：章節管理 ---------- */
async function renderManageList() {
  const wrap = $('#manage-list');
  const sections = await db.allSections();
  if (!sections.length) { wrap.innerHTML = ''; return; }
  const frag = document.createDocumentFragment();
  const h = document.createElement('h2');
  h.textContent = `已匯入 ${sections.length} 個章節`;
  h.style.marginTop = '14px';
  frag.appendChild(h);
  for (const s of sections) {
    const row = document.createElement('div');
    row.className = 'manage-item';
    row.innerHTML =
      `<span class="t">${esc(chapterLabel(String(s.chapter)))}・${esc(sectionLabel(s))}</span>` +
      `<button data-act="edit">✏️</button><button data-act="del">🗑</button>`;
    row.querySelector('[data-act="edit"]').onclick = async () => {
      const title = prompt('節標題：', s.title);
      if (title === null) return;
      const ch = prompt('章編號（數字，留空 = 未分章）：', s.chapter ?? '');
      const se = prompt('節編號（數字，留空 = 無）：', s.section ?? '');
      s.title = title.trim() || s.title;
      s.chapter = ch.trim() === '' ? null : parseInt(ch, 10);
      s.section = se.trim() === '' ? null : parseInt(se, 10);
      await db.putSection(s);
      await resortSections();
      renderManageList();
    };
    row.querySelector('[data-act="del"]').onclick = async () => {
      if (!confirm(`刪除「${s.title}」？其中的螢光筆與筆記也會一併刪除。`)) return;
      await db.deleteHighlightsFor(s.id);
      await db.deleteSection(s.id);
      await resortSections();
      renderManageList();
      toast('已刪除');
    };
    frag.appendChild(row);
  }
  wrap.replaceChildren(frag);
}

/* ---------- 設定：偏好 ---------- */
function applyPrefs() {
  const size = localStorage.getItem('fontSize') || '18';
  document.documentElement.style.setProperty('--reader-font', `${size}px`);
  $('#font-size').value = size;
  $('#font-size-val').textContent = `${size}px`;
  const theme = localStorage.getItem('theme') || 'auto';
  $('#theme-sel').value = theme;
  if (theme === 'auto') document.documentElement.removeAttribute('data-theme');
  else document.documentElement.setAttribute('data-theme', theme);
}
$('#font-size').addEventListener('input', (e) => {
  localStorage.setItem('fontSize', e.target.value);
  applyPrefs();
});
$('#theme-sel').addEventListener('change', (e) => {
  localStorage.setItem('theme', e.target.value);
  applyPrefs();
});

/* ---------- 設定：備份 ---------- */
$('#btn-export').addEventListener('click', async () => {
  const data = {
    app: 'book-reader', version: 1, exportedAt: new Date().toISOString(),
    sections: await db.allSections(),
    highlights: await db.allHighlights(),
  };
  const blob = new Blob([JSON.stringify(data)], { type: 'application/json' });
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = `book-reader-backup-${new Date().toISOString().slice(0, 10)}.json`;
  a.click();
  URL.revokeObjectURL(a.href);
});

$('#btn-restore').addEventListener('click', () => $('#restore-input').click());
$('#restore-input').addEventListener('change', async (e) => {
  const f = e.target.files?.[0];
  if (!f) return;
  try {
    const data = JSON.parse(await f.text());
    if (data.app !== 'book-reader' || !Array.isArray(data.sections)) throw new Error('格式不符');
    if (!confirm(`還原備份會覆蓋目前資料（${data.sections.length} 個章節、${data.highlights?.length || 0} 筆標記），確定？`)) return;
    await db.wipe();
    for (const s of data.sections) await db.putSection(s);
    for (const h of (data.highlights || [])) await db.putHighlight(h);
    toast('還原完成');
    switchView('toc');
  } catch (err) {
    alert(`還原失敗：${err.message || err}`);
  }
  e.target.value = '';
});

$('#btn-wipe').addEventListener('click', async () => {
  if (!confirm('確定要清除所有內容、螢光筆與筆記嗎？此動作無法復原。')) return;
  if (!confirm('再次確認：真的要全部清除？建議先匯出備份。')) return;
  await db.wipe();
  localStorage.removeItem('lastRead');
  toast('已清除');
  switchView('toc');
});

/* ---------- 啟動 ---------- */
applyPrefs();
initReader();
renderToc();
$('#app-version').textContent = `隨身書 ${APP_VERSION}・內容僅儲存於此裝置`;

if ('serviceWorker' in navigator && location.protocol === 'https:') {
  navigator.serviceWorker.register('sw.js').catch(() => {});
}
