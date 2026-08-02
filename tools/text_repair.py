#!/usr/bin/env python3
"""救回抽不出來的字：向量外框字、字距撐開的標題、整個掉光的字形。

有些 PDF 的文字流和畫面對不起來，抽出來的字比看到的少。Zollinger 10e 是極端例子：
畫面上是 `defect`，`get_text()` 給你 `de ect`。三種成因要分開處理——

1. **字形被轉成向量外框**（本書 40067 個字）
   製作過程把部分字形改畫成路徑，文字流那個位置只剩空白。靠換抽字 API 或
   修 ToUnicode 都救不回來，那個字在文字流裡真的不存在。
   做法是認路徑的形狀：`signature()` 把路徑正規化成與字級無關的指紋，
   對照表 `glyphtables/<書名>.json` 說每個指紋是哪個字。
   對照表由 `build_glyph_table.py` 掃全書分群、和系統字型比對後產生，人工核對過。

2. **字距被撐開的顯示字**（章名、小標、圖表交互參照）
   排版在字母之間插了空白來做字距與小型大寫，抽出來是
   `Repa ir o f Umbil ic a l H er n ia`、`In d Ic at Io n s`。
   判斷靠空白的實際寬度：內文的空白一律等於字型的自然空白寬，
   被排版調整過的不等於。哪些空白才是真的詞界，看字距的分佈斷層。

3. **完全沒有畫出來的字形**（本書的 `Th` 合字四千餘處，還有零星的 `l`）
   `The` 變成 `T e`、`fluid` 變成 `f uid`，畫面上也真的缺一塊。
   這種只能靠上下文補，但位置可以用幾何圈出來：那個空白的寬度是「消失的
   那個字」的字寬，不等於字型的自然空白寬（`Th` 是 9.1、`l` 是 3.5，
   自然寬 5.0）。再用全書詞彙決定補什麼。`T wave` 的空白是正常寬度，
   不會被誤補。

另外 `page_glyphs()` 的結果要餵給 `ink_regions()` 排除，否則整頁幾百個外框字
會被叢集成一整塊，整頁內文變成一張圖。
"""
import json
import re
from collections import Counter, defaultdict
from pathlib import Path

import fitz

TABLE_DIR = Path(__file__).parent / 'glyphtables'

# 外框字的尺寸範圍（pt）。上限放寬到 60×40 才容納得下標題字級與連字。
MIN_W, MAX_W = 2, 60
MIN_H, MAX_H = 4, 40

NATURAL_TOL = 0.35      # 空白寬度和自然寬差這麼多以內，算沒被調整過
BREAK_RATIO = 1.35      # 字距排序後的最大斷層要到這個倍數，才認定有詞界

DROP_MARK = '\x01'      # 掉字的哨符，等整章詞彙到手再決定補什麼
SOFT_BREAK = '\x02'     # 撐開標題裡的空白，字距看起來只是字距
HARD_BREAK = '\x03'     # 同上，但字距寬到像是詞界
BREAKS = SOFT_BREAK + HARD_BREAK
# 掉字補什麼的候選：單一字母，加上這類 PDF 最常掉的那幾個合字。
DROP_CANDIDATES = tuple('abcdefghijklmnopqrstuvwxyz') + (
    'fi', 'fl', 'ff', 'ffi', 'ffl', 'ft', 'th', 'ti', 'tt')
OPENERS = '([{“‘'
CLOSERS = ')]}”’,;:'


# ---------- 對照表 ----------

def signature(d):
    """路徑形狀的指紋：線段數 ＋ 正規化到 12×12 網格的控制點集合。

    正規化過所以與字級無關（同一個字放大縮小是同一個指紋），
    但保留了字重與字族的差異——粗體 f 和一般 f 是兩個指紋，
    分開認比較準，最後對應到同一個字就好。
    """
    r = d['rect']
    w = r.width or 1
    h = r.height or 1
    pts = []
    for it in d['items']:
        for p in it[1:]:
            if isinstance(p, fitz.Point):
                pts.append(p)
            elif isinstance(p, fitz.Rect):
                pts += [p.tl, p.br]
    q = sorted({(round((p.x - r.x0) / w * 12), round((p.y - r.y0) / h * 12)) for p in pts})
    return f"{len(d['items'])}|" + ";".join(f"{a},{b}" for a, b in q)


def load_profile(name):
    if not name:
        return {}
    p = TABLE_DIR / f'{name}.json'
    return json.loads(p.read_text(encoding='utf-8')) if p.exists() else {}


def detect_profile(doc):
    """看前幾頁外框字的命中率，自動挑對照表。書名可能被改過，所以用內容認。"""
    probe = []
    for page in list(doc)[:6]:
        probe += [signature(d) for d in page.get_drawings() if _glyph_shaped(d)]
    if len(probe) < 20:
        return {}, None
    best, best_name, best_hit = {}, None, 0
    for p in sorted(TABLE_DIR.glob('*.json')):
        prof = json.loads(p.read_text(encoding='utf-8'))
        hit = sum(1 for s in probe if s in prof.get('glyphs', {}))
        if hit > best_hit:
            best, best_name, best_hit = prof, p.stem, hit
    return (best, best_name) if best_hit >= len(probe) * 0.8 else ({}, None)


def _glyph_shaped(d):
    r = d['rect']
    return (d['type'] in ('f', 'fs')
            and MIN_W < r.width < MAX_W and MIN_H < r.height < MAX_H)


def page_glyphs(page, profile):
    """這一頁所有認得出來的外框字，回傳 [(rect, 字), …]。"""
    table = (profile or {}).get('glyphs') or {}
    if not table:
        return []
    out = []
    for d in page.get_drawings():
        if not _glyph_shaped(d):
            continue
        ch = table.get(signature(d))
        if ch:
            out.append((fitz.Rect(d['rect']), ch))
    return out


def is_glyph_rect(rect, glyphs, tol=0.5):
    for r, _ in glyphs:
        if (abs(r.x0 - rect.x0) < tol and abs(r.y0 - rect.y0) < tol
                and abs(r.x1 - rect.x1) < tol and abs(r.y1 - rect.y1) < tol):
            return True
    return False


# ---------- 自然空白寬 ----------

def space_widths(doc):
    """每個字型的自然空白寬（相對字級的比例）。

    直接查字型自己的 Widths 表，不用實測值取眾數——只出現在撐開標題裡的字型
    （本書的粗體只用在小標）眾數會等於「被撐開後的寬度」，那個門檻就廢了。
    查不到 Widths 的字型才退回實測眾數。
    """
    ratio = {}
    for pno in range(doc.page_count):
        for xref, _, _, base, *_ in doc[pno].get_fonts(full=False):
            name = re.sub(r'^[A-Z]{6}\+', '', base)
            if name in ratio:
                continue
            widths = doc.xref_get_key(xref, 'Widths')
            first = doc.xref_get_key(xref, 'FirstChar')
            if not widths or widths[0] != 'array' or not first:
                continue
            vals = widths[1].strip('[]').split()
            i = 32 - int(first[1])
            if 0 <= i < len(vals):
                try:
                    w = float(vals[i])
                except ValueError:
                    continue
                if w > 0:
                    ratio[name] = w / 1000

    tally = defaultdict(Counter)
    for page in doc:
        for block in page.get_text('rawdict')['blocks']:
            if block['type'] != 0:
                continue
            for line in block['lines']:
                for span in line['spans']:
                    if span['font'] in ratio:
                        continue
                    size = span['size'] or 1
                    for c in span['chars']:
                        if c['c'] == ' ':
                            tally[span['font']][round((c['bbox'][2] - c['bbox'][0]) / size, 3)] += 1
    for f, t in tally.items():
        ratio[f] = t.most_common(1)[0][0]
    return ratio


# ---------- 一行的重建 ----------

def line_cells(line, glyphs, skip=None):
    """把一行拆成字元格，並把外框字填回它蓋住的那個空白。

    對位靠幾何：外框字的水平範圍會蓋住文字流裡那個空白。只認空白——
    蓋到實體字就代表對位錯了，寧可不動。
    """
    cells = []
    for span in line['spans']:
        if skip and skip(span):
            continue
        for c in span['chars']:
            cells.append({'c': c['c'], 'bbox': c['bbox'], 'size': span['size'],
                          'font': span['font'], 'color': span['color'],
                          'flags': span['flags']})
    if not cells or not glyphs:
        return cells
    y0 = min(c['bbox'][1] for c in cells)
    y1 = max(c['bbox'][3] for c in cells)
    for rect, ch in glyphs:
        if not (y0 - 6 < (rect.y0 + rect.y1) / 2 < y1 + 6):
            continue
        best, best_ov = None, 0
        for i, c in enumerate(cells):
            ov = min(c['bbox'][2], rect.x1) - max(c['bbox'][0], rect.x0)
            if ov > best_ov:
                best, best_ov = i, ov
        if best is not None and not cells[best]['c'].strip():
            cells[best]['c'] = ch
    return cells


def _style_runs(cells):
    """把一行切成同字型／字級／顏色的連續段。

    字距的判斷要分段做：run-in 小標和它後面的內文在同一行，
    但只有小標是撐開的，混在一起算會兩邊都判錯。
    """
    def style(c):
        return (c['size'], c['font'], c['color'], c['flags'])

    runs = [[cells[0]]]
    for c in cells[1:]:
        if style(c) == style(runs[-1][-1]):
            runs[-1].append(c)
        else:
            runs.append([c])
    return runs


def _advance(cells, i):
    """第 i 格（空白）左右兩個字之間的實際距離。"""
    if i == 0 or i + 1 >= len(cells):
        return None
    return cells[i + 1]['bbox'][0] - cells[i - 1]['bbox'][2]


def _break_threshold(advances):
    """字距排序後找最大的相對斷層，斷層以上的字距才是詞界。

    不用固定門檻，因為字距隨字級變；也不用中位數的倍率，
    那在只有兩三個空白的短標題上會失準（`figur e 1` 會黏成一個字）。
    找不到夠大的斷層就回傳 None＝整段沒有詞界（`In d Ic at Io n s`）。
    """
    order = sorted(a for a in advances if a is not None)
    if len(order) < 2:
        return None
    cut, ratio = None, BREAK_RATIO
    for i in range(len(order) - 1):
        if order[i] <= 0:
            continue
        r = order[i + 1] / order[i]
        if r >= ratio:
            cut, ratio = order[i], r
    return cut


def _fix_case(text, mode):
    if mode == 'upper':
        return text.upper()
    if mode == 'title':
        return re.sub(r'\b[a-z]', lambda m: m.group(0).upper(), text, count=1)
    return text


def build_line(line, glyphs, natural, caps_colors, skip=None):
    """回傳這一行修好的文字。"""
    cells = line_cells(line, glyphs, skip)
    if not cells:
        return ''
    out = []
    for run in _style_runs(cells):
        nat = natural.get(run[0]['font'], 0.25) * (run[0]['size'] or 1)
        spaces = [i for i, c in enumerate(run) if c['c'] == ' ']
        adjusted = [i for i in spaces
                    if abs((run[i]['bbox'][2] - run[i]['bbox'][0]) - nat) > NATURAL_TOL]
        toks = [t for t in ''.join(c['c'] for c in run).split(' ') if t]

        # 字距被撐開的顯示字：空白被排版動過，而且「詞」短得不像話
        # （`In d Ic at Io n s` 平均 1.4 字，內文是 4.5 字上下）。
        # 兩個條件缺一不可：只看空白寬度會漏掉一半空白剛好等於自然寬的短標題，
        # 只看詞長會把 `). T e ` 這種被交互參照切斷的內文碎片誤判進來。
        if adjusted and len(toks) >= 2 and sum(map(len, toks)) / len(toks) <= 2.8:
            adv = {i: _advance(run, i) for i in spaces}
            cut = _break_threshold(adv.values())
            chars = []
            for i, c in enumerate(run):
                if c['c'] != ' ':
                    chars.append(c['c'])
                    continue
                wide = (cut is not None and adv[i] is not None
                        and adv[i] > cut and adv[i] >= nat * 0.8)
                chars.append(HARD_BREAK if wide else SOFT_BREAK)
            out.append(_fix_case(''.join(chars), caps_colors.get(f"{run[0]['color']:06x}")))
            continue

        # 掉光的字形：空白的寬度不等於自然空白寬，而且兩側都是字母。
        # 那個寬度是「消失的那個字」的字寬——`Th` 合字掉了是 9.1（自然寬 5.0），
        # `l` 掉了是 3.5，兩邊都要認，只抓寬的會漏掉一半（`f uid`）。
        # 內文的詞間空白 97% 剛好等於自然寬，所以這個條件很乾淨；
        # 何況補什麼還要過詞彙這一關，誤判也只是還原成空白。
        # 只在沒被撐開的段落裡找——撐開的標題本來每個空白都不是自然寬。
        for i in adjusted:
            if 0 < i < len(run) - 1 \
                    and run[i - 1]['c'].isalpha() and run[i + 1]['c'].isalpha():
                run[i]['c'] = DROP_MARK
        out.append(''.join(c['c'] for c in run))
    return ''.join(out)


# ---------- 一份文件的修復狀態 ----------

class Repair:
    """一份文件的修復狀態：對照表、各字型的自然空白寬、每頁的外框字。

    沒有對照表命中就是「這本書不需要修」，`bool(repair)` 為假，
    呼叫端照原本的路徑走，不必到處寫條件。
    """

    def __init__(self, doc):
        self.profile, self.name = detect_profile(doc)
        self.caps = (self.profile or {}).get('caps_colors', {})
        self.natural = space_widths(doc) if self.profile else {}
        self._glyphs = {}

    def __bool__(self):
        return bool(self.profile)

    def glyphs(self, page):
        if page.number not in self._glyphs:
            self._glyphs[page.number] = page_glyphs(page, self.profile)
        return self._glyphs[page.number]

    def line(self, page, line, skip=None):
        return build_line(line, self.glyphs(page), self.natural, self.caps, skip)


# ---------- 哨符的解析 ----------

DROP_PAT = re.compile(r'([A-Za-z]+)' + DROP_MARK + r'([A-Za-z]+)')
BREAK_PAT = re.compile(r'[^\s' + BREAKS + r']+(?:[' + BREAKS + r'][^\s' + BREAKS + r']+)+')


def strip_marks(t):
    """把哨符清成一般空白。給還沒進到 resolve_marks 的中途判斷用
    （表格標題、章首裝飾字樣都要在這個階段比對）。"""
    return (t.replace(SOFT_BREAK, '').replace(HARD_BREAK, ' ')
            .replace(DROP_MARK, ' '))


def chapter_vocab(paras):
    """段落裡的詞頻表。建表時要把「待決定」的整組排除，否則它會自己證明自己。"""
    body = ' '.join(p for p in paras if isinstance(p, str))
    body += ' ' + ' '.join(p.get('text') or '' for p in paras if isinstance(p, dict))
    body = DROP_PAT.sub(' ', BREAK_PAT.sub(' ', body))
    return Counter(w.lower() for w in re.findall(r'[A-Za-z]{2,}', body))


def _segment(tokens, hard, vocab):
    """把撐開標題的字母群切回詞。

    字距的分佈斷層只在字距夠規律時可靠——`figur e 13` 的兩個字距差 12%，
    分不出哪個才是空格。所以字距只當佐證，主要靠「切出來是不是認得的字」，
    用一個小的動態規劃取總分最高的切法。

    `hard[i]` ＝ 第 i 個接縫的字距看起來像詞界。詞彙沒有意見時（人名、代號）
    才由它決定，兩邊都沒意見就接起來。
    """
    n = len(tokens)
    best = [None] * (n + 1)
    best[0] = (0, 0, -1)                      # (分數, 詞數, 前一個切點)
    for i in range(1, n + 1):
        for j in range(i):
            if best[j] is None:
                continue
            word = ''.join(tokens[j:i]).strip('.,;:!?()[]"\'’“”')
            has_a = any(c.isalpha() for c in word)
            has_d = any(c.isdigit() for c in word)
            if has_a and has_d:
                score = -6              # 字母數字混在一起不會是一個詞（figure13）
            elif has_a:
                score = len(word) ** 2 if vocab.get(word.lower(), 0) else 0
            elif has_d:
                score = 4               # 數字自成一詞
            else:
                score = 0
            for k in range(j, i - 1):         # 群組內部的接縫都被接起來了
                if tokens[k][-1] in CLOSERS or tokens[k + 1][0] in OPENERS:
                    score -= 20               # 括號引號兩側不會是同一個詞
                score += -2 if hard[k] else 2
            if j > 0:                         # 群組前面那個接縫成了空格
                score += 2 if hard[j - 1] else -2
            cand = (best[j][0] + score, best[j][1] + 1, j)
            # 同分時取詞數少的：詞彙完全沒有意見（人名、代號）就整串接起來
            if best[i] is None or (cand[0], -cand[1]) > (best[i][0], -best[i][1]):
                best[i] = cand
    out, i = [], n
    while i > 0:
        j = best[i][2]
        out.append(''.join(tokens[j:i]))
        i = j
    return ' '.join(reversed(out))


def resolve_marks(paras, vocab=None):
    """用整章的詞彙決定兩種哨符各要變成什麼。

    掉字：單看一個位置分不出 `T e` 該補成 `The`、`Toe` 還是 `Tie`——三個都是字，
    但整章看得出來 `the` 多了三個數量級，所以一律以詞頻決定。

    詞界：撐開的標題裡，字距的分佈斷層有時只是排版微調而不是空格
    （`La pa r o t o my` 的斷層是 11.3/7.2＝1.57，但那是一個字），
    有時真的是空格卻幾乎看不出來（`figur e 13` 只差 12%）。見 `_segment()`。
    """
    if vocab is None:
        vocab = chapter_vocab(paras)

    def fix_drop(m):
        a, b = m.group(1), m.group(2)
        best, best_n = None, 0
        for cand in DROP_CANDIDATES:
            n = vocab.get((a + cand + b).lower(), 0)
            if n > best_n:
                best, best_n = cand, n
        return a + best + b if best else f'{a} {b}'

    def fix_break(m):
        raw = m.group(0)
        tokens = re.split('[' + BREAKS + ']', raw)
        hard = [ch == HARD_BREAK for ch in raw if ch in BREAKS]
        return _segment(tokens, hard, vocab)

    def apply(t):
        t = BREAK_PAT.sub(fix_break, t)
        t = t.replace(SOFT_BREAK, '').replace(HARD_BREAK, ' ')
        return DROP_PAT.sub(fix_drop, t).replace(DROP_MARK, ' ')

    out = []
    for p in paras:
        if isinstance(p, str):
            out.append(apply(p))
        else:
            if p.get('text'):
                p['text'] = apply(p['text'])
            out.append(p)
    return out
