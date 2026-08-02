// 閱讀頁：內文渲染、螢光筆、筆記
import { db, uid } from './db.js';

const $ = (s) => document.querySelector(s);
const readerEl = $('#reader');
const contentEl = $('#reader-content');
const toolbar = $('#hl-toolbar');
const sheet = $('#hl-sheet');
const sheetMask = $('#sheet-mask');

let cur = { section: null, sections: [], highlights: [] };
let pendingSel = null;    // 選取中準備新增的標記
let editingGroup = null;  // sheet 正在編輯的 groupId
let onCloseCb = null;

export function isReaderOpen() { return !readerEl.hidden; }

export async function openReader(sectionId, opts = {}) {
  const sections = await db.allSections();
  const section = sections.find(s => s.id === sectionId);
  if (!section) return;
  cur.section = section;
  cur.sections = sections;
  cur.highlights = await db.highlightsFor(sectionId);
  onCloseCb = opts.onClose || null;

  $('#reader-chapter').textContent = section.chapter != null ? `第${section.chapter}章` : '';
  $('#reader-section').textContent =
    (section.section != null ? `第${section.section}節　` : '') + section.title;

  renderContent();
  readerEl.hidden = false;
  contentEl.scrollTop = 0;
  updateNavButtons();

  if (opts.scrollToHl) scrollToHighlight(opts.scrollToHl);
  else if (opts.scrollToPara != null) scrollToPara(opts.scrollToPara, opts.flashQuery);
  saveLastRead();
}

export function closeReader() {
  hideToolbar(); closeSheet();
  readerEl.hidden = true;
  if (onCloseCb) onCloseCb();
}

function saveLastRead() {
  localStorage.setItem('lastRead', JSON.stringify({ sectionId: cur.section.id, at: Date.now() }));
}

/* ---------- 渲染 ---------- */
function renderContent() {
  const frag = document.createDocumentFragment();
  cur.section.paras.forEach((item, i) => {
    if (typeof item === 'string') {
      const p = document.createElement('p');
      p.className = 'para';
      p.dataset.i = i;
      renderPara(p, item, i);
      frag.appendChild(p);
    } else if (item && item.img) {
      const fig = document.createElement('figure');
      fig.className = 'fig';
      fig.dataset.i = i;
      const img = document.createElement('img');
      img.src = item.img;
      img.loading = 'lazy';
      img.alt = item.caption || '圖片';
      fig.appendChild(img);
      if (item.caption) {
        const fc = document.createElement('figcaption');
        fc.textContent = item.caption;
        fig.appendChild(fc);
      }
      frag.appendChild(fig);
    }
  });
  // 章節末的前後導覽
  const nav = document.createElement('div');
  nav.className = 'endnav';
  nav.innerHTML = `<button class="btn" id="end-prev">‹ 上一節</button><button class="btn" id="end-next">下一節 ›</button>`;
  frag.appendChild(nav);
  contentEl.replaceChildren(frag);
  nav.querySelector('#end-prev').onclick = () => nav2(-1);
  nav.querySelector('#end-next').onclick = () => nav2(1);
}

function renderPara(p, text, paraIdx) {
  const hls = cur.highlights
    .filter(h => h.paraIdx === paraIdx)
    .sort((a, b) => a.start - b.start);
  if (!hls.length) { p.textContent = text; return; }

  // 依標記邊界切割文字
  const points = new Set([0, text.length]);
  hls.forEach(h => { points.add(Math.min(h.start, text.length)); points.add(Math.min(h.end, text.length)); });
  const cuts = [...points].sort((a, b) => a - b);
  p.textContent = '';
  for (let i = 0; i < cuts.length - 1; i++) {
    const s = cuts[i], e = cuts[i + 1];
    const seg = text.slice(s, e);
    if (!seg) continue;
    const owner = hls.find(h => h.start <= s && h.end >= e);
    if (owner) {
      const m = document.createElement('mark');
      m.className = `hl-${owner.color}` + (groupNote(owner.groupId) ? ' has-note' : '');
      m.dataset.hl = owner.id;
      m.dataset.group = owner.groupId;
      m.textContent = seg;
      p.appendChild(m);
    } else {
      p.appendChild(document.createTextNode(seg));
    }
  }
}

function rerenderParas(indices) {
  const set = new Set(indices);
  contentEl.querySelectorAll('p.para').forEach(p => {
    const i = +p.dataset.i;
    if (set.has(i)) renderPara(p, cur.section.paras[i], i);
  });
}

function groupNote(groupId) {
  const withNote = cur.highlights.find(h => h.groupId === groupId && h.note);
  return withNote ? withNote.note : '';
}

/* ---------- 導覽 ---------- */
function nav2(delta) {
  const idx = cur.sections.findIndex(s => s.id === cur.section.id);
  const next = cur.sections[idx + delta];
  if (next) openReader(next.id, { onClose: onCloseCb });
  else toast(delta > 0 ? '已經是最後一節' : '已經是第一節');
}
function updateNavButtons() {
  const idx = cur.sections.findIndex(s => s.id === cur.section.id);
  $('#reader-prev').disabled = idx <= 0;
  $('#reader-next').disabled = idx >= cur.sections.length - 1;
}

function scrollToPara(paraIdx, flashQuery) {
  const p = contentEl.querySelector(`p.para[data-i="${paraIdx}"]`);
  if (!p) return;
  requestAnimationFrame(() => {
    p.scrollIntoView({ block: 'center' });
    p.classList.add('flash');
    setTimeout(() => p.classList.remove('flash'), 1700);
  });
}
function scrollToHighlight(hlId) {
  requestAnimationFrame(() => {
    const m = contentEl.querySelector(`mark[data-hl="${hlId}"]`);
    if (!m) return;
    m.scrollIntoView({ block: 'center' });
    const p = m.closest('p');
    p.classList.add('flash');
    setTimeout(() => p.classList.remove('flash'), 1700);
  });
}

/* ---------- 選字 → 螢光筆 ---------- */
// 計算節點在段落純文字中的位移
function offsetInPara(paraEl, node, offset) {
  if (node === paraEl) {
    // offset 是子節點索引
    let total = 0;
    for (let i = 0; i < offset && i < paraEl.childNodes.length; i++)
      total += paraEl.childNodes[i].textContent.length;
    return total;
  }
  let total = 0;
  const walker = document.createTreeWalker(paraEl, NodeFilter.SHOW_TEXT);
  let n;
  while ((n = walker.nextNode())) {
    if (n === node) return total + offset;
    total += n.data.length;
  }
  return total;
}

function getSelectionRanges() {
  const sel = window.getSelection();
  if (!sel || sel.isCollapsed || !sel.rangeCount) return null;
  const range = sel.getRangeAt(0);
  const startP = range.startContainer.parentElement?.closest?.('p.para') ||
    (range.startContainer.nodeType === 1 ? range.startContainer.closest('p.para') : null);
  const endP = range.endContainer.parentElement?.closest?.('p.para') ||
    (range.endContainer.nodeType === 1 ? range.endContainer.closest('p.para') : null);
  if (!startP || !endP) return null;
  const i1 = +startP.dataset.i, i2 = +endP.dataset.i;
  if (Number.isNaN(i1) || Number.isNaN(i2)) return null;

  const pieces = [];
  for (let i = Math.min(i1, i2); i <= Math.max(i1, i2); i++) {
    const text = cur.section.paras[i];
    if (typeof text !== 'string') continue;
    let s = 0, e = text.length;
    if (i === i1) s = offsetInPara(startP, range.startContainer, range.startOffset);
    if (i === i2) e = offsetInPara(endP, range.endContainer, range.endOffset);
    s = Math.max(0, Math.min(s, text.length));
    e = Math.max(0, Math.min(e, text.length));
    if (e > s) pieces.push({ paraIdx: i, start: s, end: e, quote: text.slice(s, e) });
  }
  if (!pieces.length) return null;
  return { pieces, rect: range.getBoundingClientRect() };
}

function showToolbarFor(selInfo) {
  pendingSel = selInfo;
  toolbar.hidden = false;
  const tw = toolbar.offsetWidth, th = toolbar.offsetHeight;
  const r = selInfo.rect;
  let top = r.top - th - 12;
  if (top < 60) top = r.bottom + 12;
  let left = r.left + r.width / 2 - tw / 2;
  left = Math.max(8, Math.min(left, window.innerWidth - tw - 8));
  toolbar.style.top = `${top}px`;
  toolbar.style.left = `${left}px`;
}
function hideToolbar() { toolbar.hidden = true; pendingSel = null; }

async function createHighlight(color, openNote) {
  if (!pendingSel) return;
  const groupId = uid();
  const affected = [];
  for (const piece of pendingSel.pieces) {
    // 移除與新標記重疊的舊標記區段，避免疊層
    const overlaps = cur.highlights.filter(h =>
      h.paraIdx === piece.paraIdx && h.start < piece.end && h.end > piece.start);
    for (const o of overlaps) {
      await db.deleteHighlight(o.id);
      cur.highlights = cur.highlights.filter(x => x.id !== o.id);
    }
    const h = {
      id: uid(), groupId, sectionId: cur.section.id,
      paraIdx: piece.paraIdx, start: piece.start, end: piece.end,
      quote: piece.quote, color, note: '', createdAt: Date.now(),
    };
    await db.putHighlight(h);
    cur.highlights.push(h);
    affected.push(piece.paraIdx);
  }
  window.getSelection()?.removeAllRanges();
  hideToolbar();
  rerenderParas(affected);
  if (openNote) openSheet(groupId);
  else toast('已加上螢光筆，點標記可加筆記');
}

/* ---------- 標記編輯面板 ---------- */
function openSheet(groupId) {
  editingGroup = groupId;
  const parts = cur.highlights.filter(h => h.groupId === groupId)
    .sort((a, b) => a.paraIdx - b.paraIdx || a.start - b.start);
  if (!parts.length) return;
  $('#sheet-quote').textContent = parts.map(h => h.quote).join('');
  $('#sheet-note').value = groupNote(groupId);
  sheet.querySelectorAll('.dot').forEach(d =>
    d.classList.toggle('on', d.dataset.color === parts[0].color));
  sheetMask.hidden = false;
  sheet.hidden = false;
}
function closeSheet() { sheet.hidden = true; sheetMask.hidden = true; editingGroup = null; }

async function saveSheet() {
  if (!editingGroup) return;
  const note = $('#sheet-note').value.trim();
  const color = sheet.querySelector('.dot.on')?.dataset.color || 'yellow';
  const affected = [];
  for (const h of cur.highlights.filter(x => x.groupId === editingGroup)) {
    h.note = note; h.color = color;
    await db.putHighlight(h);
    affected.push(h.paraIdx);
  }
  closeSheet();
  rerenderParas(affected);
  toast('已儲存');
}

async function deleteGroup() {
  if (!editingGroup) return;
  const affected = [];
  for (const h of cur.highlights.filter(x => x.groupId === editingGroup)) {
    await db.deleteHighlight(h.id);
    affected.push(h.paraIdx);
  }
  cur.highlights = cur.highlights.filter(x => x.groupId !== editingGroup);
  closeSheet();
  rerenderParas(affected);
  toast('已刪除標記');
}

/* ---------- Toast ---------- */
let toastTimer = null;
export function toast(msg) {
  const t = $('#toast');
  t.textContent = msg;
  t.hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => { t.hidden = true; }, 2200);
}

/* ---------- 事件 ---------- */
export function initReader() {
  $('#reader-back').addEventListener('click', closeReader);
  $('#reader-prev').addEventListener('click', () => nav2(-1));
  $('#reader-next').addEventListener('click', () => nav2(1));

  // 選字結束 → 顯示工具列（手機用 selectionchange + 短延遲較穩定）
  let selTimer = null;
  document.addEventListener('selectionchange', () => {
    if (readerEl.hidden || !sheet.hidden) return;
    clearTimeout(selTimer);
    selTimer = setTimeout(() => {
      const info = getSelectionRanges();
      if (info) showToolbarFor(info);
      else hideToolbar();
    }, 250);
  });

  toolbar.querySelectorAll('.dot').forEach(d =>
    d.addEventListener('click', () => createHighlight(d.dataset.color, false)));
  $('#hl-note-btn').addEventListener('click', () => createHighlight('yellow', true));

  // 點既有標記 → 編輯
  contentEl.addEventListener('click', (e) => {
    const m = e.target.closest('mark[data-group]');
    if (m) { window.getSelection()?.removeAllRanges(); hideToolbar(); openSheet(m.dataset.group); }
  });

  sheet.querySelectorAll('.dot').forEach(d =>
    d.addEventListener('click', () => {
      sheet.querySelectorAll('.dot').forEach(x => x.classList.remove('on'));
      d.classList.add('on');
    }));
  $('#sheet-save').addEventListener('click', saveSheet);
  $('#sheet-delete').addEventListener('click', deleteGroup);
  sheetMask.addEventListener('click', closeSheet);
}
