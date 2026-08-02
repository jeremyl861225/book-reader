#!/usr/bin/env python3
"""替「字形被轉成向量外框」的書建一份指紋 → 字的對照表。

用法：
    python3 build_glyph_table.py <書資料夾> <書名代號> [--sheet=<png>] [--labels=<txt>]

分三步，每一步都要看過再往下：

1. **不帶 --labels**：掃全書、把外框字依形狀分群，用系統 Times New Roman
   逐字比對猜每一群是什麼，同時輸出一張 contact sheet（每群一格）和
   一份 `<書名代號>.labels.txt` 猜測稿。
2. **人工核對**：對著 contact sheet 改那份 txt。單一字母機器猜得很準，
   **連字要自己看**——`insert_text()` 不會做連字替換，參考字模畫出來是
   分開的兩個字母，所以 `fi`／`ffi` 一定猜錯。空白一行代表「這不是字」
   （出版社標誌的筆畫就會分到獨立的群）。
3. **帶 --labels**：讀回核對過的 txt，寫出 `glyphtables/<書名代號>.json`。

`caps_colors` 要自己加到 json 裡（小型大寫的顏色 → upper／title），
那個從 span 的 color 直方圖看得出來。
"""
import json
import sys
from collections import Counter
from pathlib import Path

import fitz

import text_repair

FONTS = {
    'reg': "/System/Library/Fonts/Supplemental/Times New Roman.ttf",
    'bold': "/System/Library/Fonts/Supplemental/Times New Roman Bold.ttf",
    'ital': "/System/Library/Fonts/Supplemental/Times New Roman Italic.ttf",
    'bi': "/System/Library/Fonts/Supplemental/Times New Roman Bold Italic.ttf",
}
CANDIDATES = list("abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789"
                  "-—–.,;:!?()[]/&'’“”%$#*+=<>@°") + [
    'ﬁ', 'ﬂ', 'ﬀ', 'ﬃ', 'ﬄ',   # fi fl ff ffi ffl
    'ft', 'tt', 'ti', 'st', 'ct', 'Th']
H = 40      # 正規化高度（像素）


def survey(root):
    """全書的外框字，依指紋分群。回傳 [(指紋, 次數, 範例)]，多的排前面。"""
    cnt = Counter()
    ex = {}
    for pdf in sorted(root.rglob('*.pdf')):
        doc = fitz.open(pdf)
        for pno, page in enumerate(doc):
            for d in page.get_drawings():
                if not text_repair._glyph_shaped(d):
                    continue
                s = text_repair.signature(d)
                cnt[s] += 1
                ex.setdefault(s, (d['items'], fitz.Rect(d['rect']), str(pdf), pno))
        doc.close()
    return [(s, c, ex[s]) for s, c in cnt.most_common()]


def _render(items, rect, scale):
    """把路徑重畫到一張新頁面再算成點陣圖，避開鄰字干擾。"""
    doc = fitz.open()
    page = doc.new_page(width=int(rect.width * scale) + 4, height=int(rect.height * scale) + 4)
    sh = page.new_shape()

    def T(p):
        return fitz.Point((p.x - rect.x0) * scale + 2, (p.y - rect.y0) * scale + 2)

    for it in items:
        if it[0] == 'l':
            sh.draw_line(T(it[1]), T(it[2]))
        elif it[0] == 'c':
            sh.draw_bezier(T(it[1]), T(it[2]), T(it[3]), T(it[4]))
        elif it[0] == 're':
            sh.draw_rect(fitz.Rect(T(it[1].tl), T(it[1].br)))
        elif it[0] == 'qu':
            q = it[1]
            sh.draw_quad(fitz.Quad(T(q.ul), T(q.ur), T(q.ll), T(q.lr)))
    # even_odd 不可省：白字壓在色塊上的標題，路徑是「色塊挖洞」畫的
    sh.finish(fill=(0, 0, 0), color=None, even_odd=True, closePath=True)
    sh.commit()
    pix = page.get_pixmap(colorspace=fitz.csGRAY)
    doc.close()
    return pix


def _normalize(pix):
    """裁到有墨跡的範圍，再縮成高 H、等比例寬的灰階陣列。"""
    w, h, s = pix.width, pix.height, pix.samples
    xs = [x for y in range(h) for x in range(w) if s[y * w + x] < 200]
    ys = [y for y in range(h) for x in range(w) if s[y * w + x] < 200]
    if not xs:
        return None, 0
    x0, x1, y0, y1 = min(xs), max(xs), min(ys), max(ys)
    bw, bh = x1 - x0 + 1, y1 - y0 + 1
    tw = max(1, round(bw / bh * H))
    out = bytearray(tw * H)
    for ty in range(H):
        sy = y0 + int(ty * bh / H)
        for tx in range(tw):
            out[ty * tw + tx] = s[sy * w + x0 + int(tx * bw / tw)]
    return bytes(out), tw


def reference_glyphs():
    refs = {}
    for name, path in FONTS.items():
        for t in CANDIDATES:
            doc = fitz.open()
            page = doc.new_page(width=400, height=200)
            page.insert_text((50, 140), t, fontsize=90, fontfile=path, fontname='X')
            b, tw = _normalize(page.get_pixmap(colorspace=fitz.csGRAY, dpi=110))
            doc.close()
            if b:
                refs[(name, t)] = (b, tw)
    return refs


def _distance(a, aw, b, bw):
    ar, br = aw / H, bw / H
    if abs(ar - br) / max(ar, br) > 0.22:       # 寬高比差太多就不用比了
        return 1e9
    tw = min(aw, bw)
    tot = sum(abs(a[y * aw + int(x * aw / tw)] - b[y * bw + int(x * bw / tw)])
              for y in range(H) for x in range(tw))
    return tot / (H * tw) + abs(ar - br) * 40


def contact_sheet(groups, out_png, cols=10, cell=90):
    """每群一格排成一張圖，格子上標「序號:次數」，給人工核對用。"""
    rows = (len(groups) + cols - 1) // cols
    doc = fitz.open()
    page = doc.new_page(width=cols * cell, height=rows * cell)
    for i, (_, n, (items, rect, path, pno)) in enumerate(groups):
        src = fitz.open(path)
        pix = src[pno].get_pixmap(clip=fitz.Rect(rect.x0 - 1, rect.y0 - 1,
                                                 rect.x1 + 1, rect.y1 + 1), dpi=260)
        x, y = (i % cols) * cell, (i // cols) * cell
        box = fitz.Rect(x + 8, y + 22, x + cell - 8, y + cell - 6)
        ar = pix.width / pix.height
        bh = min(box.height, box.width / ar)
        page.insert_image(fitz.Rect(box.x0, box.y0, box.x0 + bh * ar, box.y0 + bh), pixmap=pix)
        page.insert_text((x + 4, y + 14), f'{i}:{n}', fontsize=8)
        page.draw_rect(fitz.Rect(x, y, x + cell, y + cell), color=(.8, .8, .8), width=.5)
        src.close()
    page.get_pixmap(dpi=150).save(out_png)


def main():
    args = [a for a in sys.argv[1:] if not a.startswith('--')]
    flags = {a.split('=')[0].lstrip('-'): a.split('=', 1)[1] for a in sys.argv[1:]
             if a.startswith('--') and '=' in a}
    if len(args) < 2:
        print(__doc__)
        sys.exit(1)
    root, name = Path(args[0]), args[1]
    groups = survey(root)
    print(f'{len(groups)} 群，共 {sum(n for _, n, _ in groups)} 個外框字', file=sys.stderr)

    labels_path = Path(flags.get('labels', f'{name}.labels.txt'))
    if 'labels' in flags:
        lines = labels_path.read_text(encoding='utf-8').splitlines()
        if len(lines) != len(groups):
            sys.exit(f'標籤 {len(lines)} 行對不上 {len(groups)} 群——書或參數換過了？')
        table = {g[0]: l.strip() for g, l in zip(groups, lines) if l.strip()}
        out = text_repair.TABLE_DIR / f'{name}.json'
        out.parent.mkdir(parents=True, exist_ok=True)
        old = json.loads(out.read_text(encoding='utf-8')) if out.exists() else {}
        old['glyphs'] = table
        out.write_text(json.dumps(old, ensure_ascii=False, indent=0), encoding='utf-8')
        print(f'寫入 {out}：{len(table)} 個指紋，'
              f'涵蓋 {sum(n for s, n, _ in groups if s in table)} 個外框字')
        return

    refs = reference_glyphs()
    guesses = []
    for s, n, (items, rect, path, pno) in groups:
        b, bw = _normalize(_render(items, rect, 60 / rect.height))
        best = min(((_distance(b, bw, rb, rw), k) for k, (rb, rw) in refs.items()),
                   default=(0, (None, '')))[1] if b else (None, '')
        guesses.append(best[1])
    labels_path.write_text('\n'.join(guesses) + '\n', encoding='utf-8')
    sheet = flags.get('sheet', f'{name}.sheet.png')
    contact_sheet(groups, sheet)
    print(f'猜測稿 {labels_path}、對照圖 {sheet}\n'
          f'請對著圖核對（連字一定要自己看），改好再跑一次加 --labels={labels_path}')


if __name__ == '__main__':
    main()
