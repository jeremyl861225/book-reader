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
  const section = await db.getSection(sectionId);
  if (!section) return;
  // 上一節／下一節只在同一本書裡走
  const sections = await db.sectionsOf(section.bookId);
  cur.section = section;
  cur.sections = sections;
  cur.highlights = await db.highlightsFor(sectionId);
  onCloseCb = opts.onClose || null;

  $('#reader-chapter').textContent =
    section.chapterTitle || (section.chapter != null ? `第${section.chapter}章` : '');
  $('#reader-section').textContent = section.section == null ? section.title
    : section.chapterTitle ? `${section.section}. ${section.title}`
    : `第${section.section}節　${section.title}`;

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

/* ---------- 段落分類 ---------- */
// 轉檔後的內容包只有純文字，標題與內文長得一樣。這裡在閱讀時判讀出層級，
// 讓版面有輕重之分。判讀只影響「樣式」，不會改動文字，
// 所以既有螢光筆的段落索引與字元偏移都不受影響。

// 圖說：「Figure 3.1.」「Table 2」「圖 5-1」開頭
const CAPTION_RE = /^(Figure|Fig\.|Table|Chart|Box|圖|表)\s*[\dA-Z]+[.\-–:]/i;
// 句尾標點：有的話就不是標題
const ENDS_SENTENCE = /[.!?;:,。！？；：，、]["'”』)）]?$/;
// 標題大小寫時可以維持小寫的虛詞
const SMALL_WORDS = new Set(['a', 'an', 'the', 'and', 'or', 'of', 'in', 'on', 'for', 'to',
  'with', 'by', 'from', 'at', 'as', 'via', 'vs', 'nor', 'but', 'per']);

const isAllCaps = (t) => {
  const letters = t.replace(/[^A-Za-z]/g, '');
  return letters.length >= 3 && letters === letters.toUpperCase();
};

// 標題式大小寫：每個實詞都以大寫（或數字）開頭
function isTitleCase(t) {
  const words = t.split(/\s+/).filter(Boolean);
  if (!words.length || words.length > 12) return false;
  const content = words.filter(w => !SMALL_WORDS.has(w.toLowerCase().replace(/[^a-z]/g, '')));
  if (!content.length) return false;
  return content.every(w => /^["'(\[]*[A-Z0-9]/.test(w));
}

// 獨立成段的小標
function isHeading(t) {
  if (t.length > 90 || ENDS_SENTENCE.test(t)) return false;
  return isAllCaps(t) || isTitleCase(t);
}

// 作者列：整行只有人名（每個字都大寫開頭，連接詞只允許 and/&）
function isByline(t) {
  if (t.length > 90 || ENDS_SENTENCE.test(t)) return false;
  const words = t.split(/\s+/).filter(Boolean);
  if (words.length < 2 || words.length > 14) return false;
  return words.every(w => /^[A-Z]/.test(w) || /^(and|&)$/i.test(w));
}

// 內嵌小標：標題被排版黏在段落開頭（例：「INTRODUCTION Aortoiliac occlusive…」）。
// 只認「全大寫」的那種——它是本類書每章的骨架標題，判斷可靠；
// 標題式大小寫的內嵌標題（「Light Criteria According to…」）界線常常曖昧，
// 寧可放著不動，也不要把正文誤加粗。回傳標題結束的字元位置，沒有就回 0。
const ALLCAPS_WORD = /^[A-Z][A-Z0-9/&'’.–-]*$/;

function inlineHeadEnd(text) {
  if (text.length < 60) return 0;          // 太短的段落交給獨立小標去判
  const words = text.split(' ');
  let n = 0;
  while (n < words.length && n < 14 && words[n].length >= 2 && ALLCAPS_WORD.test(words[n])) n++;
  if (!n) return 0;

  const endAt = (k) => words.slice(0, k).join(' ').length;
  // 尾巴若是屬於句子的縮寫（「… PATHOPHYSIOLOGY AIOD is …」），還給內文。
  // 後面可能以破折號等標點起頭，先略過再判斷是不是新句子的開頭。
  while (n > 0) {
    const rest = text.slice(endAt(n)).replace(/^[\s—–:.,、－-]+/, '');
    if (/^[A-Z(“"']/.test(rest)) break;
    n--;
  }
  if (!n) return 0;

  const end = endAt(n);
  if (end < 5) return 0;                                   // 單一短縮寫（CT、MRI）不算標題
  if (text.length - end < 40) return 0;                    // 後面要真的還有內文
  return end;
}

function paraClass(text, i) {
  if (i === 0) return 'para title';
  if (i === 1 && isByline(text)) return 'para byline';
  if (CAPTION_RE.test(text)) return 'para caption';
  if (isHeading(text)) return 'para heading' + (isAllCaps(text) ? ' h1' : ' h2');
  return 'para';
}

function renderContent() {
  const frag = document.createDocumentFragment();
  cur.section.paras.forEach((item, i) => {
    if (typeof item === 'string') {
      const p = document.createElement('p');
      p.className = paraClass(item, i);
      p.dataset.i = i;
      renderPara(p, item, i);
      frag.appendChild(p);
    } else if (item && item.img) {
      const isTable = item.kind === 'table';
      const fig = document.createElement('figure');
      fig.className = 'fig' + (isTable ? ' table' : '');
      fig.dataset.i = i;
      const img = document.createElement('img');
      img.src = item.img;
      img.loading = 'lazy';
      img.alt = item.caption || (isTable ? '表格' : '圖片');
      // 表格與細節圖在手機上會縮得看不清，點一下放大來看
      img.addEventListener('click', () => openZoom(item.img, img.alt));
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
  // 只有純內文段落才找內嵌小標（標題／圖說本身不必再切）
  const headEnd = p.classList.contains('para') && p.className === 'para' ? inlineHeadEnd(text) : 0;

  if (!hls.length && !headEnd) { p.textContent = text; return; }

  // 依標記邊界（與內嵌小標的分界）切割文字。文字內容不變，
  // 所以標記的字元偏移仍然對得上。
  const points = new Set([0, text.length]);
  if (headEnd) points.add(headEnd);
  hls.forEach(h => { points.add(Math.min(h.start, text.length)); points.add(Math.min(h.end, text.length)); });
  const cuts = [...points].sort((a, b) => a - b);
  p.textContent = '';
  for (let i = 0; i < cuts.length - 1; i++) {
    const s = cuts[i], e = cuts[i + 1];
    const seg = text.slice(s, e);
    if (!seg) continue;
    const owner = hls.find(h => h.start <= s && h.end >= e);
    let node;
    if (owner) {
      node = document.createElement('mark');
      node.className = `hl-${owner.color}` + (groupNote(owner.groupId) ? ' has-note' : '');
      node.dataset.hl = owner.id;
      node.dataset.group = owner.groupId;
      node.textContent = seg;
    } else {
      node = document.createTextNode(seg);
    }
    if (headEnd && e <= headEnd) {
      const b = document.createElement('b');
      b.className = 'run-head';
      b.appendChild(node);
      p.appendChild(b);
    } else {
      p.appendChild(node);
    }
  }
}

/* 放大檢視：整張圖可捲動，點任意處或按 Esc 關閉 */
function openZoom(src, alt) {
  const ov = document.createElement('div');
  ov.className = 'zoom-overlay';
  ov.innerHTML = `<div class="zoom-inner"><img src="${src}" alt="${alt}"></div>
                  <button class="zoom-close" aria-label="關閉">✕</button>`;
  const close = () => { ov.remove(); document.removeEventListener('keydown', onKey); };
  const onKey = (e) => { if (e.key === 'Escape') close(); };
  ov.addEventListener('click', close);
  document.addEventListener('keydown', onKey);
  document.body.appendChild(ov);
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
