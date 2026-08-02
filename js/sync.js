// 書庫同步：從私有 GitHub repo 抓取 packs/*.json 內容包
import { db, uid } from './db.js';
import { resortSections } from './pdf-import.js';

const API = 'https://api.github.com';

export function syncCfg() {
  try { return JSON.parse(localStorage.getItem('libSync') || '{}'); }
  catch { return {}; }
}
export function saveSyncCfg(c) { localStorage.setItem('libSync', JSON.stringify(c)); }

async function gh(path, token, raw = false) {
  const resp = await fetch(API + path, {
    headers: {
      'Authorization': 'Bearer ' + token,
      'Accept': raw ? 'application/vnd.github.raw+json' : 'application/vnd.github+json',
      'X-GitHub-Api-Version': '2022-11-28',
    },
  });
  if (!resp.ok) {
    const why = resp.status === 401 ? '（token 無效或過期）'
      : resp.status === 404 ? '（找不到 repo，或 token 沒有這個 repo 的權限）'
      : resp.status === 403 ? '（權限不足或超過流量限制）' : '';
    throw new Error(`GitHub API 錯誤 ${resp.status}${why}`);
  }
  return raw ? resp.text() : resp.json();
}

export async function syncLibrary(onStatus) {
  const c = syncCfg();
  if (!c.repo || !c.token) throw new Error('請先填寫 Repo 與 Token');
  const branch = c.branch || 'main';

  onStatus?.('取得書庫清單…');
  const tree = await gh(`/repos/${c.repo}/git/trees/${encodeURIComponent(branch)}?recursive=1`, c.token);
  const packs = (tree.tree || []).filter(e => e.type === 'blob' && /^packs\/.+\.json$/i.test(e.path));
  if (!packs.length) throw new Error('書庫 repo 裡沒有 packs/*.json 內容包');

  const synced = c.synced || {};
  const todo = packs.filter(p => synced[p.path] !== p.sha);
  if (!todo.length) return { added: 0, updated: 0, skipped: packs.length };

  let existing = await db.allSections();
  let maxOrder = existing.reduce((m, s) => Math.max(m, s.order), 0);
  let added = 0, updated = 0, done = 0;

  for (const p of todo) {
    onStatus?.(`下載 ${++done}/${todo.length}：${p.path.split('/').pop()}`);
    const text = await gh(`/repos/${c.repo}/git/blobs/${p.sha}`, c.token, true);
    let data;
    try { data = JSON.parse(text); } catch { throw new Error(`${p.path} 不是有效的 JSON`); }
    const secs = Array.isArray(data) ? data : data.sections;
    if (!Array.isArray(secs)) continue;

    // 同一路徑的舊版章節先移除（內容更新時取代；該章節的標記會一併移除）
    const olds = existing.filter(s => s.srcPath === p.path);
    for (const old of olds) {
      await db.deleteHighlightsFor(old.id);
      await db.deleteSection(old.id);
      updated++;
    }
    existing = existing.filter(s => s.srcPath !== p.path);

    for (const s of secs) {
      if (!Array.isArray(s.paras)) continue;
      const rec = {
        id: uid(),
        chapter: s.chapter ?? null,
        chapterTitle: s.chapterTitle ?? null,
        section: s.section ?? null,
        title: s.title || p.path.split('/').pop().replace(/\.json$/i, ''),
        order: ++maxOrder,
        paras: s.paras,
        src: p.path.split('/').pop(),
        srcPath: p.path,
        addedAt: Date.now(),
      };
      await db.putSection(rec);
      existing.push(rec);
      added++;
    }
    synced[p.path] = p.sha;
    c.synced = synced;
    saveSyncCfg(c); // 逐檔記錄進度，中斷後可續傳
  }
  await resortSections();
  return { added, updated, skipped: packs.length - todo.length };
}
