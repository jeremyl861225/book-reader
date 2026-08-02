#!/usr/bin/env python3
"""把章節 PDF 轉成 Book reader 內容包（.json，含文字段落、插圖與表格）。

用法：
    python3 convert.py <輸入> <輸出資料夾> [--max-width=1200] [--quality=78]
                       [--zoom=2.0] [--no-regions]

<輸入> 可以是：
- 整本書的根資料夾（含「01 - SECTION I - ...」等 Section 子資料夾）
  → Section 資料夾編號成為「章」，資料夾名稱成為章標題；
    其中的「CHnnn - 標題.pdf」nnn 成為「節」編號
- 單一 Section 資料夾或單一 PDF

也支援「第1章第2節 標題.pdf」「1-2 標題.pdf」等中文命名。
每個 PDF 產生一個同名 .json 內容包，可用 app 的「匯入章節」直接載入，
或再用 make_book.py 打包成書籍檔。

雙欄教科書的處理
----------------
- **閱讀順序**：PyMuPDF 的區塊順序在雙欄書上常把右欄排到左欄前面，
  這裡改成自己依欄重排（跨欄元素切段，段內先左欄後右欄）。
- **頁首頁尾**：以「跨頁重複的文字」找出書眉，連同頁碼一起濾掉。
- **插圖**：解剖圖多半是**向量繪圖**而非嵌入點陣圖，逐一抓 image block
  會整張漏掉。改成把向量與點陣的墨跡叢集成區域，整塊算圖。
- **表格**：這類書的表格常無框線又緊排，硬做結構化還原會把欄位切在字中間
  （臨床表格配錯欄位比沒有還糟），所以同樣整塊算圖，另外保留純文字供搜尋。
  只有掛在「TABLE n.m」標題底下的小字叢集才算表格，避免把參考文獻那種
  小字清單也變成圖片。
"""
import base64
import json
import re
import sys
from collections import Counter
from pathlib import Path

import fitz  # PyMuPDF

MIN_IMG_PX = 60

INK_GAP = 14            # 墨跡叢集允許的間隙（pt）
MIN_REGION_W = 90       # 區域最小寬高，濾掉行內符號與裝飾線
MIN_REGION_H = 70
TEXT_GAP = 9            # 表格小字叢集的間隙
MIN_TABLE_H = 36
CAPTION_REACH = 40      # 標題與其表格／插圖之間允許的距離（pt）

HEAD_BAND = 0.075       # 頁首帶（佔頁高比例）
FOOT_BAND = 0.925       # 頁尾帶

CN_NUM = {'零': 0, '一': 1, '二': 2, '兩': 2, '三': 3, '四': 4, '五': 5,
          '六': 6, '七': 7, '八': 8, '九': 9, '十': 10}

TABLE_CAP = re.compile(r'^\s*(TABLE|表)\s*[\d.]+', re.I)
FIG_CAP = re.compile(r'^\s*(FIGURE|FIG\.|圖)\s*[\d.]+', re.I)
PAGE_NUM = re.compile(r'^\s*[ivxlcdm\d]{1,6}\s*$', re.I)
# 章首的裝飾字樣：「C H A P T E R」「26 C H A P T E R」
CHAPTER_DECOR = re.compile(r'^\s*\d*\s*C\s*H\s*A\s*P\s*T\s*E\s*R\s*\d*\s*$', re.I)


# ---------- 檔名／資料夾解析 ----------

def cn_to_int(s):
    if s.isdigit():
        return int(s)
    n, cur = 0, 0
    for ch in s:
        v = CN_NUM.get(ch)
        if v is None:
            return None
        if v == 10:
            n += (cur or 1) * 10
            cur = 0
        else:
            cur = v
    return n + cur


def parse_section_dir(name):
    """「01 - SECTION I - Perioperative Care」→ (1, 'SECTION I - Perioperative Care')"""
    m = re.match(r'^\s*(\d+)\s*[-–]\s*(.+)$', name)
    if m:
        return int(m.group(1)), m.group(2).strip()
    return None, name.strip()


def parse_filename(name):
    """回傳 (chapter, section, title)。chapter 通常由資料夾決定，這裡處理檔名。"""
    base = re.sub(r'\.pdf$', '', name, flags=re.I).strip()

    m = re.match(r'^CH\s*(\d+)\s*[-–]\s*(.+)$', base, flags=re.I)
    if m:
        return None, int(m.group(1)), m.group(2).strip()

    m = re.match(r'^\s*(\d+)\s*[-–]\s*(.+)$', base)
    if m and int(m.group(1)) in (0, 99):
        return int(m.group(1)), None, m.group(2).strip()

    ch = sec = None
    m = re.search(r'第\s*([0-9一二兩三四五六七八九十]+)\s*章', base)
    if m:
        ch = cn_to_int(m.group(1))
        base = base.replace(m.group(0), ' ')
    m = re.search(r'第\s*([0-9一二兩三四五六七八九十]+)\s*節', base)
    if m:
        sec = cn_to_int(m.group(1))
        base = base.replace(m.group(0), ' ')
    if ch is None:
        m = re.match(r'^\s*(\d+)\s*[-_.、]\s*(\d+)\s*', base)
        if m:
            ch, sec = int(m.group(1)), int(m.group(2))
            base = base[m.end():]
        else:
            m = re.match(r'^\s*(\d+)\s+', base)
            if m:
                ch = int(m.group(1))
                base = base[m.end():]
    title = re.sub(r'^[\s\-–_、.．]+|[\s\-–_、.．]+$', '', base) or re.sub(r'\.pdf$', '', name, flags=re.I)
    return ch, sec, title


# ---------- 文字整理 ----------

SENT_END = re.compile(r'[。！？…；.!?]["」』)〉》\]]?$')
# 行尾是這些縮寫時，句點不代表句子結束（例：「… ( Figs.」接下一行的圖號）
ABBR_END = re.compile(
    r'(?:\b(?:Figs?|Tabs?|Tables?|Eqs?|Refs?|Chaps?|Vols?|Nos?|pp|approx|ca'
    r'|e\.g|i\.e|et al|vs|cf|Dr|Mr|Mrs|Ms|Prof|Jr|Sr|St|Inc|Ltd'
    r'|U\.S|Ph\.D|M\.D|B\.C|A\.D)|\b[A-Za-z])\.$', re.I)


SOFT_JOIN = '\x00'      # 待決定的斷行連字號，整章讀完後再解析


def clean(t):
    t = t.replace('\xad', '').replace('​', '')
    t = re.sub(r'(?<=[a-z])-\s+(?=[a-z])', SOFT_JOIN, t)   # 跨行斷字，先標記
    return re.sub(r'[ \t]{2,}', ' ', t).strip()


def join_line(cur, text):
    """把一行接到累積字串上；中文不加空白，西文視情況補空白。"""
    if not cur:
        return text
    # 行尾連字號：可能是被斷開的單字（adenocarci-noma），也可能是真的複合詞
    # （high-quality）。這裡先標記，等整章的詞彙都在手上再判斷。
    if re.search(r'[a-z]-$', cur) and re.match(r'^[a-z]', text):
        return cur[:-1] + SOFT_JOIN + text
    if re.search(r'[A-Za-z0-9,;:.!?)\]]$', cur) and re.match(r'^[A-Za-z0-9(\[]', text):
        return cur + ' ' + text
    if re.search(r'[一-鿿]$', cur) or re.match(r'^[一-鿿]', text):
        return cur + text
    return cur + text


SOFT_PAT = re.compile(r'([A-Za-z]+)' + SOFT_JOIN + r'([A-Za-z]+)')


def resolve_hyphens(paras):
    """用整章的詞彙決定每個斷行連字號要接起來還是保留。

    單看一個位置分不出「adenocarci-noma」和「high-quality」，但整章看得出來：
    接起來的形式在別處出現過，就是被斷開的字。這關係到搜尋——
    使用者搜 adenocarcinoma 是找不到 adenocarci-noma 的。
    """
    body = ' '.join(p for p in paras if isinstance(p, str))
    body += ' ' + ' '.join(p.get('text') or '' for p in paras if isinstance(p, dict))
    # 建詞彙時要把「待決定」的那些整組排除，否則會自己證明自己
    settled = SOFT_PAT.sub(' ', body)
    vocab = {w.lower() for w in re.findall(r'[A-Za-z]{2,}', settled)}
    hyphenated = {m.lower() for m in re.findall(r'[A-Za-z]{2,}-[A-Za-z]{2,}', settled)}

    def fix(m):
        a, b = m.group(1), m.group(2)
        if (a + b).lower() in vocab:                       # 接起來別處有 → 是斷字
            return a + b
        if f'{a}-{b}'.lower() in hyphenated:               # 帶連字號別處有 → 是複合詞
            return f'{a}-{b}'
        if a.lower() in vocab and b.lower() in vocab:      # 兩邊都能單獨成字 → 多半是複合詞
            return f'{a}-{b}'
        return a + b                                       # 其餘一律接回去

    def apply(t):
        return SOFT_PAT.sub(fix, t).replace(SOFT_JOIN, '')

    out = []
    for p in paras:
        if isinstance(p, str):
            out.append(apply(p))
        else:
            if p.get('text'):
                p['text'] = apply(p['text'])
            out.append(p)
    return out


# ---------- 幾何 ----------

CELL = 3.0      # 叢集用的網格邊長（pt）


def _dilate(mark, W, H, d):
    """先橫後縱各膨脹 d 格，等效於方形結構元素但快得多。"""
    if d <= 0:
        return mark
    tmp = bytearray(W * H)
    for y in range(H):
        base = y * W
        for x in range(W):
            if mark[base + x]:
                lo, hi = max(0, x - d), min(W, x + d + 1)
                for j in range(lo, hi):
                    tmp[base + j] = 1
    out = bytearray(W * H)
    for x in range(W):
        for y in range(H):
            if tmp[y * W + x]:
                lo, hi = max(0, y - d), min(H, y + d + 1)
                for yy in range(lo, hi):
                    out[yy * W + x] = 1
    return out


# 超過這個數量才改用網格法。實測 1500 在本書可讓結果與純精確法完全一致，
# 又能擋住向量照片那種上萬物件的頁面。
GRID_THRESHOLD = 1500


def _merge_exact(rects, gap):
    """兩兩比對，結果最精確；O(n³)，只用在物件數不多的頁面。"""
    out = list(rects)
    changed = True
    while changed:
        changed = False
        for i in range(len(out)):
            for j in range(i + 1, len(out)):
                if (out[i] + (-gap, -gap, gap, gap)).intersects(out[j]):
                    out[i] |= out[j]
                    out.pop(j)
                    changed = True
                    break
            if changed:
                break
    return out


def merge_rects(rects, gap):
    """把相距在 gap 以內的矩形叢集起來。

    絕大多數頁面用兩兩比對（結果最貼合實際邊界）；但這類書偶爾會有
    以向量畫成的照片級插圖——實測 CH025 有一頁 54584 個繪圖物件，
    兩兩比對是 O(n³) 永遠跑不完，那種頁面改用網格連通標記，
    代價是邊界量化到 CELL，可能把鄰近的文字一起圈進去。
    """
    rects = [fitz.Rect(r) for r in rects]
    rects = [r for r in rects if r.is_valid and not r.is_empty]
    if len(rects) <= 1:
        return rects
    if len(rects) <= GRID_THRESHOLD:
        return _merge_exact(rects, gap)

    ox = min(r.x0 for r in rects)
    oy = min(r.y0 for r in rects)
    W = int((max(r.x1 for r in rects) - ox) / CELL) + 1
    H = int((max(r.y1 for r in rects) - oy) / CELL) + 1

    mark = bytearray(W * H)
    for r in rects:
        cy1 = int((r.y1 - oy) / CELL)
        cx0, cx1 = int((r.x0 - ox) / CELL), int((r.x1 - ox) / CELL)
        for cy in range(int((r.y0 - oy) / CELL), cy1 + 1):
            base = cy * W
            for cx in range(cx0, cx1 + 1):
                mark[base + cx] = 1

    dil = _dilate(mark, W, H, int(gap / CELL + 0.999))

    # 連通標記（四連通）
    label = [0] * (W * H)
    n = 0
    for start in range(W * H):
        if not dil[start] or label[start]:
            continue
        n += 1
        stack = [start]
        label[start] = n
        while stack:
            c = stack.pop()
            cx, cy = c % W, c // W
            if cx > 0 and dil[c - 1] and not label[c - 1]:
                label[c - 1] = n; stack.append(c - 1)
            if cx < W - 1 and dil[c + 1] and not label[c + 1]:
                label[c + 1] = n; stack.append(c + 1)
            if cy > 0 and dil[c - W] and not label[c - W]:
                label[c - W] = n; stack.append(c - W)
            if cy < H - 1 and dil[c + W] and not label[c + W]:
                label[c + W] = n; stack.append(c + W)

    # 用原始矩形的精確座標算每一群的外框（不受網格量化影響）
    groups = {}
    for r in rects:
        cx = min(W - 1, int((r.x0 - ox) / CELL))
        cy = min(H - 1, int((r.y0 - oy) / CELL))
        g = label[cy * W + cx]
        if not g:
            continue
        groups[g] = (groups[g] | r) if g in groups else fitz.Rect(r)
    return list(groups.values())


def covers(outer, inner, frac=0.6):
    r = fitz.Rect(inner)
    hit = fitz.Rect(outer) & r
    return hit.is_valid and not hit.is_empty and hit.get_area() > r.get_area() * frac


def line_size(line):
    tally = Counter()
    for s in line.get('spans', []):
        n = len(s['text'].strip())
        if n:
            tally[round(s['size'], 1)] += n
    return tally.most_common(1)[0][0] if tally else None


# PyMuPDF span flags：bit0=上標、bit1=斜體、bit4=粗體
SUP, ITALIC, BOLD = 1, 2, 16
CITATION = re.compile(r'^[\d,–—\-\s]+$')


def is_citation_span(s):
    """參考文獻的上標編號：上標旗標＋內容只有數字與逗號。

    這種編號夾在句子中間（「…closed.3 Because…」）會打斷閱讀，
    而且本書的參考文獻清單另外都在，拿掉不會少資訊。
    上標的單位符號（cm²、10⁶ 的次方）不是純數字逗號，不會被誤刪。
    """
    return bool(s.get('flags', 0) & SUP) and bool(CITATION.match(s.get('text', '')))


def line_text(line):
    t = ''.join(s['text'] for s in line.get('spans', []) if not is_citation_span(s))
    # 軟連字號要在接行「之前」拿掉：留著的話行尾會變成 \xad，
    # 接行判斷看不到真正的最後一個字元，就會漏掉該補的空白
    # （「Advances and Training\xad」＋「Considerations」→ TrainingConsiderations）。
    # 真正斷字的地方排版會另外留一個實體連字號，由 clean() 的規則接回去。
    t = t.replace('\xa0', ' ').replace('​', '').replace('\xad', '')
    return re.sub(r'[ \t]{2,}', ' ', t.replace('\t', ' ')).strip()


def line_style(line):
    """回傳這一行的 (是否整行斜體, 是否整行粗體)，用來認子標與大綱層級。"""
    spans = [s for s in line.get('spans', []) if s.get('text', '').strip()]
    if not spans:
        return False, False
    return (all(s.get('flags', 0) & ITALIC for s in spans),
            all((s.get('flags', 0) & BOLD) or 'Bold' in s.get('font', '') for s in spans))


def page_lines(page):
    out = []
    for block in page.get_text('dict')['blocks']:
        if block['type'] != 0:
            continue
        for line in block.get('lines', []):
            t = line_text(line)
            if t:
                italic, bold = line_style(line)
                out.append({'text': t, 'bbox': line['bbox'], 'size': line_size(line),
                            'italic': italic, 'bold': bold})
    return out


def doc_profile(doc):
    """整份文件的內文字級，以及跨頁重複的書眉字串。"""
    sizes = Counter()
    band_texts = Counter()
    n_pages = doc.page_count
    for page in doc:
        H = page.rect.height
        for l in page_lines(page):
            for_size = len(l['text'].strip())
            if l['size'] is not None and for_size:
                sizes[l['size']] += for_size
            y0, y1 = l['bbox'][1], l['bbox'][3]
            if y1 <= H * HEAD_BAND or y0 >= H * FOOT_BAND:
                key = re.sub(r'\d+', '', l['text']).strip()
                if len(key) >= 4:
                    band_texts[key] += 1
    body = sizes.most_common(1)[0][0] if sizes else None
    running = {k for k, c in band_texts.items() if c >= max(3, n_pages * 0.4)}
    return body, running


def is_running_head(line, H, running):
    y0, y1 = line['bbox'][1], line['bbox'][3]
    if y1 > H * HEAD_BAND and y0 < H * FOOT_BAND:
        return False
    t = line['text'].strip()
    if PAGE_NUM.match(t) or CHAPTER_DECOR.match(t):
        return True
    return re.sub(r'\d+', '', t).strip() in running


# ---------- 區域偵測 ----------

def ink_regions(page):
    """向量繪圖＋嵌入點陣圖的叢集＝插圖（或有框線的表格）。"""
    ink = []
    for d in page.get_drawings():
        r = fitz.Rect(d['rect']) & page.rect
        if r.is_valid and not r.is_empty and (r.width >= 2 or r.height >= 2):
            ink.append(r)
    for b in page.get_text('dict')['blocks']:
        if b['type'] == 1:
            r = fitz.Rect(b['bbox']) & page.rect
            if r.is_valid and not r.is_empty:
                ink.append(r)
    if not ink:
        return []
    return [r for r in merge_rects(ink, INK_GAP)
            if r.width >= MIN_REGION_W and r.height >= MIN_REGION_H]


def caption_anchored_tables(page, body, lines, taken):
    """無框線表格：以「TABLE n.m」標題為錨，往下收同欄的小字叢集。"""
    if body is None:
        return []
    caps = [l for l in lines if TABLE_CAP.match(l['text'])]
    if not caps:
        return []
    small = [fitz.Rect(l['bbox']) for l in lines
             if l['size'] is not None and l['size'] < body - 0.4
             and not TABLE_CAP.match(l['text']) and not FIG_CAP.match(l['text'])
             and not any(covers(t, l['bbox']) for t in taken)]
    if not small:
        return []
    clusters = [r for r in merge_rects(small, TEXT_GAP)
                if r.height >= MIN_TABLE_H and r.width >= MIN_REGION_W * 0.5]
    out = []
    for cap in caps:
        cx0, cy0, cx1, cy1 = cap['bbox']
        region = None
        bottom = cy1
        for r in sorted(clusters, key=lambda r: r.y0):
            if r.y0 < cy1 - 2:
                continue
            # 同一欄：水平投影要和標題重疊
            if min(r.x1, cx1) - max(r.x0, cx0) < min(r.width, cx1 - cx0) * 0.35:
                continue
            if r.y0 - bottom > CAPTION_REACH:
                continue
            txt = page.get_text(clip=r).strip()
            if FIG_CAP.match(txt):
                continue
            region = r if region is None else (region | r)
            bottom = max(bottom, r.y1)
        if region is not None:
            out.append(region)
    return out


def is_title_banner(page, region, body):
    """章首標題的裝飾橫線會把書名圈成一塊墨跡區域，那不是插圖。

    判別依據：真正的插圖一定有標籤（等於或小於內文字級），表格更是整片小字；
    只有標題橫幅會「整塊都是比內文大的字、一個小字都沒有」。
    誤判成插圖的話，章名會變成圖片，該章就沒有標題段了。
    """
    if body is None:
        return False
    big = small = 0
    for b in page.get_text('dict', clip=region)['blocks']:
        if b['type'] != 0:
            continue
        for l in b.get('lines', []):
            for s in l['spans']:
                n = len(s['text'].strip())
                if not n:
                    continue
                if s['size'] > body + 0.5:
                    big += n
                else:
                    small += n
    return big >= 8 and small == 0


def classify(page, region, lines):
    """看區域內、或緊鄰上方的標題，判斷這塊是表格還是插圖。"""
    inner = page.get_text(clip=region).strip()
    if TABLE_CAP.match(inner):
        return 'table'
    if FIG_CAP.match(inner):
        return 'figure'
    best, best_gap = None, CAPTION_REACH
    for l in lines:
        x0, y0, x1, y1 = l['bbox']
        gap = region.y0 - y1
        if gap < -2 or gap > best_gap:
            continue
        if min(x1, region.x1) - max(x0, region.x0) < min(x1 - x0, region.width) * 0.3:
            continue
        if TABLE_CAP.match(l['text']) or FIG_CAP.match(l['text']):
            best, best_gap = l['text'], gap
    if best and TABLE_CAP.match(best):
        return 'table'
    return 'figure'


def region_image(page, rect, max_width, quality, zoom):
    z = min(zoom, max_width / max(rect.width, 1))
    pix = page.get_pixmap(clip=rect, matrix=fitz.Matrix(z, z), alpha=False)
    if pix.width < MIN_IMG_PX or pix.height < MIN_IMG_PX:
        return None
    return 'data:image/jpeg;base64,' + base64.b64encode(pix.tobytes('jpg', jpg_quality=quality)).decode()


# ---------- 版面 → 閱讀順序 ----------

def column_start_y(items):
    """雙欄版面真正開始的高度＝左右欄第一次同時有內容的地方。

    章首頁的標題是靠右排的（例：CH007 的書名在 x406-576），若一律用
    左右半頁分欄，標題會被歸進右欄、排到整個左欄後面。這一段以上的東西
    屬於橫幅（章號、書名、作者、OUTLINE 標頭），要照 y 順序讀。
    """
    lefts = [it for it in items if not it['full'] and it['left']]
    rights = [it for it in items if not it['full'] and not it['left']]
    best = None
    for l in lefts:
        ly0, ly1 = l['bbox'][1], l['bbox'][3]
        for r in rights:
            if ly0 < r['bbox'][3] and ly1 > r['bbox'][1]:
                y = min(ly0, r['bbox'][1])
                best = y if best is None else min(best, y)
    return best


def order_items(items, page_width):
    """雙欄閱讀順序：橫幅照 y、跨欄項目切段，段內先左欄再右欄。"""
    if not items:
        return []
    mid = page_width / 2
    for it in items:
        x0, _, x1, _ = it['bbox']
        it['full'] = (x1 - x0) > page_width * 0.62
        it['left'] = ((x0 + x1) / 2) < mid

    split = column_start_y(items)
    if split is None:
        # 整頁沒有任何左右並排的內容＝這頁根本不是雙欄，純粹照 y 讀。
        # 單欄書的章首頁會這樣（題詞偏左、章名偏右但上下錯開），
        # 若硬套左右分欄，整個左欄會被排到右欄前面，題詞就跑到章名前面去了。
        for it in items:
            it['full'] = True
    else:
        for it in items:
            if it['bbox'][3] <= split:      # 整個在雙欄開始之前
                it['full'] = True

    items.sort(key=lambda it: (it['bbox'][1], it['bbox'][0]))

    out, left, right = [], [], []

    def flush():
        out.extend(sorted(left, key=lambda it: (it['bbox'][1], it['bbox'][0])))
        out.extend(sorted(right, key=lambda it: (it['bbox'][1], it['bbox'][0])))
        left.clear()
        right.clear()

    for it in items:
        if it['full']:
            flush()
            out.append(it)
        elif it['left']:
            left.append(it)
        else:
            right.append(it)
    flush()
    return out


def page_items(page, body, running, use_regions):
    H, W = page.rect.height, page.rect.width
    lines = page_lines(page)

    regions = []
    if use_regions:
        ink = ink_regions(page)
        regions = ink + caption_anchored_tables(page, body, lines, ink)
        regions = merge_rects(regions, 0)
        regions = [r for r in regions
                   if not (r.width > W * 0.95 and r.height > H * 0.9)
                   and not is_title_banner(page, r, body)]

    outline, consumed = extract_outline(lines, body, W)

    items = []
    if outline:
        items.append(outline)
    for l in lines:
        if id(l) in consumed:
            continue
        if is_running_head(l, H, running):
            continue
        if any(covers(r, l['bbox']) for r in regions):    # 圖內標籤、表格內文
            continue
        items.append({'kind': 'text', 'bbox': l['bbox'], 'text': l['text'], 'size': l['size'],
                      'italic': l.get('italic'), 'bold': l.get('bold')})
    for r in regions:
        items.append({'kind': 'region', 'bbox': tuple(r), 'rect': r,
                      'sub': classify(page, r, lines), 'text': clean(page.get_text(clip=r))})
    return order_items(items, W)


# ---------- 轉檔 ----------

OUTLINE_HEAD = re.compile(r'^O\s*U\s*T\s*L\s*I\s*N\s*E$', re.I)
NUMBERED = re.compile(r'^\d+[.)]\s')


def is_subhead(it, body):
    """編號子標（「4. Gubaroff valve」）：整行斜體、和內文同字級、短、沒有句尾標點。

    這種子標在 PDF 裡自成一行，但排版沒有和後面的內文分段，
    直接抽文字會變成「4. Gubaroff valve Gubaroff valves consist of…」黏在一起。
    """
    t = it['text']
    if not it.get('italic') or len(t) > 90 or SENT_END.search(t):
        return False
    return body is None or it['size'] is None or abs(it['size'] - body) <= 0.5


def extract_outline(lines, body, page_width):
    """把章前大綱框整塊抓出來，回傳 (大綱項目, 被吃掉的行)。

    必須用「幾何範圍」而不是閱讀順序來框：大綱是橫跨兩欄的，
    若照串流順序收，左欄一撞到底下的章節標題就結束，右欄那半會整個漏掉。
    範圍從 O U T L I N E 標頭往下，直到行距出現明顯空隙為止。
    """
    head = next((l for l in lines if OUTLINE_HEAD.match(l['text'])), None)
    if head is None or body is None:
        return None, set()
    top = head['bbox'][3]
    cand = sorted((l for l in lines
                   if l['bbox'][1] >= top - 2 and l['size'] is not None
                   and abs(l['size'] - body) <= 0.5),
                  key=lambda l: (l['bbox'][1], l['bbox'][0]))
    taken, prev_y = [], top
    for l in cand:
        if l['bbox'][1] - prev_y > 25:      # 明顯空隙＝大綱框結束
            break
        taken.append(l)
        prev_y = max(prev_y, l['bbox'][1])
    if not taken:
        return None, set()
    # 判斷範圍要照 y 走（行距空隙才看得出框在哪結束），但排序要先分欄——
    # 大綱是兩欄並排的，照 y 排會把右欄的項目插進左欄中間。
    mid = page_width / 2
    ordered = sorted(taken, key=lambda l: (l['bbox'][0] >= mid, l['bbox'][1], l['bbox'][0]))
    items = build_outline(ordered, page_width)
    if not items:
        return None, set()
    consumed = {id(l) for l in taken} | {id(head)}
    x0 = min(l['bbox'][0] for l in taken + [head])
    x1 = max(l['bbox'][2] for l in taken + [head])
    y1 = max(l['bbox'][3] for l in taken)
    return {'kind': 'outline', 'bbox': (x0, head['bbox'][1], x1, y1), 'items': items}, consumed


def build_outline(entries, page_width):
    """把大綱框的行整理成有層級的清單。

    粗體＝大項，一般＝子項；比子項再縮排的是上一項被折行的下半段，接回去。
    """
    mid = page_width / 2
    lvl1_x = {}
    for e in entries:
        if not e['bold']:
            col = e['bbox'][0] < mid
            lvl1_x[col] = min(lvl1_x.get(col, 1e9), e['bbox'][0])
    items = []
    for e in entries:
        if e['bold']:
            items.append({'lv': 0, 't': e['text']})
            continue
        col = e['bbox'][0] < mid
        if items and e['bbox'][0] > lvl1_x.get(col, 0) + 6:
            items[-1]['t'] = join_line(items[-1]['t'], e['text'])   # 折行的下半段
        else:
            items.append({'lv': 1, 't': e['text']})
    return [{'lv': i['lv'], 't': clean(i['t'])} for i in items if clean(i['t'])]


def convert_pdf(path, max_width=1200, quality=78, zoom=2.0, use_regions=True):
    doc = fitz.open(path)
    body, running = doc_profile(doc)
    paras = []
    cur, cur_size = '', None
    pending = []
    n_img = n_tab = 0

    def flush_text():
        nonlocal cur, cur_size
        t = clean(cur)
        if t:
            paras.append(t)
        cur, cur_size = '', None

    def emit(obj):
        nonlocal n_img, n_tab
        paras.append(obj)
        if obj.get('kind') == 'table':
            n_tab += 1
        else:
            n_img += 1

    def emit_pending():
        for obj in pending:
            emit(obj)
        pending.clear()

    for page in doc:
        for it in page_items(page, body, running, use_regions):
            if it['kind'] == 'region':
                url = region_image(page, it['rect'], max_width, quality, zoom)
                if not url:
                    continue
                obj = {'img': url, 'kind': it['sub']}
                if it['text']:
                    obj['text'] = it['text'][:4000]
                if cur:
                    pending.append(obj)     # 段落還沒收完，等收完再插
                else:
                    emit(obj)
                continue

            if it['kind'] == 'outline':
                flush_text()
                emit_pending()
                paras.append({'kind': 'outline', 'items': it['items'],
                              'text': ' '.join(i['t'] for i in it['items'])})
                continue

            size, text = it['size'], it['text']
            off_body = body is not None and size is not None and abs(size - body) > 0.5
            cur_off = body is not None and cur_size is not None and abs(cur_size - body) > 0.5
            # 編號子標自成一段，不要和後面的內文黏在一起
            if is_subhead(it, body):
                flush_text()
                emit_pending()
                paras.append(clean(text))
                continue
            # 字級換檔（內文↔標題／圖說）就切段
            if off_body != cur_off or (off_body and cur_size is not None and abs(size - cur_size) > 0.3):
                flush_text()
                emit_pending()
            cur = join_line(cur, text)
            cur_size = size
            if SENT_END.search(text) and not ABBR_END.search(text):
                flush_text()
                emit_pending()
    flush_text()
    emit_pending()
    doc.close()
    return resolve_hyphens(strip_chapter_decor(paras)), n_img, n_tab


def strip_chapter_decor(paras):
    """拿掉章首的裝飾字樣。

    它不在頁首帶內，所以濾不掉；而且排版有時併成一段「26 C H A P T E R」，
    有時拆成「19」和「C H A P T E R」兩段，兩種都要處理。只在開頭幾段內動手，
    免得誤刪內文裡的短行。
    """
    at = [i for i, p in enumerate(paras[:3]) if isinstance(p, str) and CHAPTER_DECOR.match(p)]
    if not at:
        return paras
    limit = at[-1] + 1
    return [p for i, p in enumerate(paras)
            if not (i < limit and isinstance(p, str)
                    and (CHAPTER_DECOR.match(p) or PAGE_NUM.match(p)))]


def convert_one(pdf, out_dir, chapter, chapter_title, opts, skip_existing=True):
    out = out_dir / (pdf.stem + '.json')
    if skip_existing and out.exists():
        print(f'skip（已存在）: {out.name}')
        return
    ch, sec, title = parse_filename(pdf.name)
    if chapter is not None:
        ch = chapter
        # 資料夾裡的「00 - …」排在該篇最前面；其中的「（扉頁）」是該篇章節總覽
        if sec is None and re.match(r'^\s*00\s*[-–]', pdf.stem):
            sec = 0
            if '扉頁' in pdf.stem:
                title = '篇章總覽'
    paras, n_img, n_tab = convert_pdf(pdf, **opts)
    pack = {'app': 'book-reader-pack',
            'sections': [{'chapter': ch, 'chapterTitle': chapter_title,
                          'section': sec, 'title': title, 'paras': paras}]}
    out.write_text(json.dumps(pack, ensure_ascii=False), encoding='utf-8')
    n_text = sum(1 for p in paras if isinstance(p, str))
    print(f'{pdf.name} -> 章={ch} 節={sec}  段落={n_text} 圖={n_img} 表={n_tab}  '
          f'{out.stat().st_size/1024:.0f}KB', flush=True)


def main():
    args = [a for a in sys.argv[1:] if not a.startswith('--')]
    flags = {a.split('=')[0].lstrip('-'): (a.split('=')[1] if '=' in a else True)
             for a in sys.argv[1:] if a.startswith('--')}
    if len(args) < 2:
        print(__doc__)
        sys.exit(1)
    src, out_dir = Path(args[0]), Path(args[1])
    opts = {'max_width': int(flags.get('max-width', 1200)),
            'quality': int(flags.get('quality', 78)),
            'zoom': float(flags.get('zoom', 2.0)),
            'use_regions': not flags.get('no-regions', False)}
    out_dir.mkdir(parents=True, exist_ok=True)

    if src.is_file():
        convert_one(src, out_dir, None, None, opts, skip_existing=False)
        return

    for pdf in sorted(src.glob('*.pdf')):
        ch, _, _ = parse_filename(pdf.name)
        convert_one(pdf, out_dir, ch, {0: '前言', 99: '附錄與索引'}.get(ch), opts)
    for sub in sorted(p for p in src.iterdir() if p.is_dir()):
        ch, ch_title = parse_section_dir(sub.name)
        if ch is None:
            print(f'略過資料夾（無編號）: {sub.name}')
            continue
        for pdf in sorted(sub.glob('*.pdf')):
            # 篇扉頁只有該篇的章節列表，目錄本身已經看得到，不必收進書裡
            if '扉頁' in pdf.stem:
                print(f'略過扉頁: {pdf.name}')
                continue
            convert_one(pdf, out_dir, ch, ch_title, opts)


if __name__ == '__main__':
    main()
