// PDF 匯入：抽取文字、檔名解析章節、段落重組
import { db, uid } from './db.js';

let pdfjsLib = null;
async function loadPdfjs() {
  if (pdfjsLib) return pdfjsLib;
  pdfjsLib = await import('../vendor/pdfjs/pdf.min.mjs');
  pdfjsLib.GlobalWorkerOptions.workerSrc =
    new URL('../vendor/pdfjs/pdf.worker.min.mjs', import.meta.url).href;
  return pdfjsLib;
}

const CN_NUM = { 零: 0, 一: 1, 二: 2, 兩: 2, 三: 3, 四: 4, 五: 5, 六: 6, 七: 7, 八: 8, 九: 9, 十: 10 };
function cnToInt(s) {
  if (/^\d+$/.test(s)) return parseInt(s, 10);
  let n = 0, cur = 0;
  for (const ch of s) {
    const v = CN_NUM[ch];
    if (v === undefined) return NaN;
    if (v === 10) { n += (cur || 1) * 10; cur = 0; }
    else cur = v;
  }
  return n + cur;
}

// 從檔名推測章、節編號與標題
export function parseFilename(name) {
  let base = name.replace(/\.pdf$/i, '').trim();
  let ch = null, sec = null;

  let m = base.match(/第\s*([0-9一二兩三四五六七八九十]+)\s*章/);
  if (m) { ch = cnToInt(m[1]); base = base.replace(m[0], ' '); }
  m = base.match(/第\s*([0-9一二兩三四五六七八九十]+)\s*節/);
  if (m) { sec = cnToInt(m[1]); base = base.replace(m[0], ' '); }

  if (ch === null) {
    m = base.match(/^\s*(\d+)\s*[-_.、]\s*(\d+)\s*/);
    if (m) { ch = +m[1]; sec = +m[2]; base = base.slice(m[0].length); }
    else {
      m = base.match(/^\s*(\d+)\s+/);
      if (m) { ch = +m[1]; base = base.slice(m[0].length); }
    }
  }
  const title = base.replace(/^[\s\-_、.．]+|[\s\-_、.．]+$/g, '') || name.replace(/\.pdf$/i, '');
  return { chapter: Number.isFinite(ch) ? ch : null, section: Number.isFinite(sec) ? sec : null, title };
}

// 將 PDF 的文字行重組成段落
export function linesToParas(lines) {
  const paras = [];
  let cur = '';
  const flush = () => { const t = cur.trim(); if (t) paras.push(t); cur = ''; };
  for (const raw of lines) {
    const line = raw.trim();
    if (!line) { flush(); continue; }
    // 英數詞跨行時補空格；中文直接相接
    if (cur && /[A-Za-z0-9,;]$/.test(cur) && /^[A-Za-z0-9(]/.test(line)) cur += ' ';
    cur += line;
    // 句子在行尾結束 → 視為段落結尾
    if (/[。！？…；.!?]["」』)〉》]?$/.test(line)) flush();
  }
  flush();
  return paras;
}

export async function extractPdfParas(arrayBuffer, onProgress) {
  const lib = await loadPdfjs();
  const doc = await lib.getDocument({
    data: arrayBuffer,
    cMapUrl: new URL('../vendor/pdfjs/cmaps/', import.meta.url).href,
    cMapPacked: true,
  }).promise;
  const lines = [];
  for (let p = 1; p <= doc.numPages; p++) {
    const page = await doc.getPage(p);
    const tc = await page.getTextContent();
    let line = '';
    let lastY = null;
    for (const item of tc.items) {
      // 有些 PDF 沒有 hasEOL，改用文字的 Y 座標變化判斷換行
      const y = item.transform ? item.transform[5] : null;
      if (line && lastY !== null && y !== null && Math.abs(y - lastY) > 2) {
        lines.push(line); line = '';
      }
      if (y !== null) lastY = y;
      line += item.str;
      if (item.hasEOL) { lines.push(line); line = ''; lastY = null; }
    }
    if (line) lines.push(line);
    if (onProgress) onProgress(p, doc.numPages);
    page.cleanup();
  }
  await doc.destroy();
  return linesToParas(lines);
}

// 匯入多個 PDF 檔案 → 寫入 IndexedDB
export async function importFiles(fileList, onStatus) {
  const files = [...fileList];
  const existing = await db.allSections();
  let maxOrder = existing.reduce((m, s) => Math.max(m, s.order), 0);
  let ok = 0, failed = [];

  for (let i = 0; i < files.length; i++) {
    const f = files[i];
    onStatus?.(`(${i + 1}/${files.length}) 處理中：${f.name}`);
    try {
      const buf = await f.arrayBuffer();
      const paras = await extractPdfParas(buf, (p, n) => {
        onStatus?.(`(${i + 1}/${files.length}) ${f.name}　第 ${p}/${n} 頁`);
      });
      if (!paras.length) throw new Error('抽不到文字（可能是掃描版 PDF）');
      const meta = parseFilename(f.name);
      await db.putSection({
        id: uid(),
        chapter: meta.chapter,
        section: meta.section,
        title: meta.title,
        order: ++maxOrder,
        paras,
        src: f.name,
        addedAt: Date.now(),
      });
      ok++;
    } catch (e) {
      console.error('import failed', f.name, e);
      failed.push(`${f.name}（${e.message || e}）`);
    }
  }
  await resortSections();
  return { ok, failed };
}

// 依「章 → 節 → 加入順序」重新排序
export async function resortSections() {
  const list = await db.allSections();
  list.sort((a, b) => {
    const ca = a.chapter ?? 9999, cb = b.chapter ?? 9999;
    if (ca !== cb) return ca - cb;
    const sa = a.section ?? 9999, sb = b.section ?? 9999;
    if (sa !== sb) return sa - sb;
    return a.addedAt - b.addedAt;
  });
  for (let i = 0; i < list.length; i++) {
    if (list[i].order !== i + 1) { list[i].order = i + 1; await db.putSection(list[i]); }
  }
}

// 範例內容（試用）
export async function loadSample() {
  const sample = [
    { chapter: 1, section: 1, title: '什麼是隨身書', paras: [
      '這是一段範例內文。你可以長按選取這段文字，試試看畫上螢光筆。選取後會出現顏色工具列，也可以直接加上筆記。',
      '隨身書把整本書存在你的手機裡：目錄選章節、全文搜尋、螢光筆與筆記總覽，全部離線可用。',
      '書的內容只儲存在此裝置的瀏覽器中，不會上傳到任何伺服器。清除瀏覽器資料前，記得先到「設定」匯出備份。' ] },
    { chapter: 1, section: 2, title: '如何匯入你的書', paras: [
      '到「設定」分頁點「匯入章節 PDF」，一次選取多個檔案即可。',
      '檔名建議包含章節編號，例如「第1章第2節 標題.pdf」或「1-2 標題.pdf」，匯入後會自動歸類排序。',
      '匯入完成後，範例內容可以在設定的章節管理中刪除。' ] },
    { chapter: 2, section: 1, title: '搜尋與筆記', paras: [
      '在「搜尋」分頁輸入關鍵字，可以找到全書所有出現位置，點擊結果直接跳到該段落。',
      '在「筆記」分頁可以看到所有畫過的螢光筆與筆記，點擊即可回到原文位置。試著搜尋「螢光筆」三個字看看。' ] },
  ];
  const existing = await db.allSections();
  let order = existing.reduce((m, s) => Math.max(m, s.order), 0);
  for (const s of sample) {
    await db.putSection({ id: uid(), ...s, order: ++order, src: 'sample', addedAt: Date.now() });
  }
  await resortSections();
}
