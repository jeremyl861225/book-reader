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

// 匯入多個 PDF 檔案 → 寫入指定的書
export async function importFiles(fileList, bookId, onStatus) {
  const files = [...fileList];
  const existing = await db.sectionsOf(bookId);
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
        bookId,
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
  await resortSections(bookId);
  return { ok, failed };
}

// 匯入內容包（.json，含文字與圖片的預轉換章節）→ 寫入指定的書
export async function importPacks(files, bookId, onStatus) {
  const existing = await db.sectionsOf(bookId);
  let maxOrder = existing.reduce((m, s) => Math.max(m, s.order), 0);
  let ok = 0, failed = [];
  for (let i = 0; i < files.length; i++) {
    const f = files[i];
    onStatus?.(`(${i + 1}/${files.length}) 讀取內容包：${f.name}`);
    try {
      const data = JSON.parse(await f.text());
      const secs = Array.isArray(data) ? data : data.sections;
      if (!Array.isArray(secs) || !secs.length) throw new Error('格式不符');
      for (const s of secs) {
        if (!Array.isArray(s.paras)) continue;
        await db.putSection({
          id: uid(),
          bookId,
          chapter: s.chapter ?? null,
          chapterTitle: s.chapterTitle ?? null,
          section: s.section ?? null,
          title: s.title || f.name.replace(/\.json$/i, ''),
          order: ++maxOrder,
          paras: s.paras,
          src: f.name,
          addedAt: Date.now(),
        });
        ok++;
      }
    } catch (e) {
      console.error('pack import failed', f.name, e);
      failed.push(`${f.name}（${e.message || e}）`);
    }
  }
  await resortSections(bookId);
  return { ok, failed };
}

// 依「章 → 節 → 加入順序」重新排序（限定一本書；不給 bookId 就全部重排）
export async function resortSections(bookId) {
  const list = bookId ? await db.sectionsOf(bookId) : await db.allSections();
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
