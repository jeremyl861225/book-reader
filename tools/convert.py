#!/usr/bin/env python3
"""把章節 PDF 轉成隨身書內容包（.json，含文字段落與圖片）。

用法：
    python3 convert.py <輸入> <輸出資料夾> [--max-width=1200] [--quality=78]

<輸入> 可以是：
- 整本書的根資料夾（含「01 - SECTION I - ...」等 Section 子資料夾）
  → Section 資料夾編號成為「章」，資料夾名稱成為章標題；
    其中的「CHnnn - 標題.pdf」nnn 成為「節」編號
- 單一 Section 資料夾或單一 PDF

也支援「第1章第2節 標題.pdf」「1-2 標題.pdf」等中文命名。
每個 PDF 產生一個同名 .json 內容包，可用 app 的「匯入章節」或「書庫同步」載入。
"""
import base64
import json
import re
import sys
from pathlib import Path

import fitz  # PyMuPDF

MIN_IMG_PX = 60        # 忽略太小的圖（裝飾、雜訊）
MIN_IMG_BYTES = 3000

CN_NUM = {'零': 0, '一': 1, '二': 2, '兩': 2, '三': 3, '四': 4, '五': 5,
          '六': 6, '七': 7, '八': 8, '九': 9, '十': 10}


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

    # CHnnn - 標題（本書格式）→ section = nnn
    m = re.match(r'^CH\s*(\d+)\s*[-–]\s*(.+)$', base, flags=re.I)
    if m:
        return None, int(m.group(1)), m.group(2).strip()

    # 「00 - Front Matter」「99 - Index」等根目錄檔案
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


SENT_END = re.compile(r'[。！？…；.!?]["」』)〉》]?$')


def flush(cur, paras):
    t = cur.strip()
    if t:
        paras.append(t)
    return ''


def block_lines(block):
    for line in block.get('lines', []):
        text = ''.join(span['text'] for span in line.get('spans', []))
        if text.strip():
            yield text.strip()


def image_to_dataurl(raw, max_width, quality):
    """回傳 dataurl；太小的圖回傳 None。"""
    try:
        pix = fitz.Pixmap(raw)
    except Exception:
        return None
    if pix.width < MIN_IMG_PX or pix.height < MIN_IMG_PX:
        return None
    if pix.colorspace is None or pix.n - pix.alpha > 3:
        pix = fitz.Pixmap(fitz.csRGB, pix)
    if pix.alpha:
        pix = fitz.Pixmap(pix, 0)
    while pix.width > max_width * 1.5:  # shrink 每次縮一半
        pix.shrink(1)
    try:
        data = pix.tobytes('jpg', jpg_quality=quality)
        return 'data:image/jpeg;base64,' + base64.b64encode(data).decode()
    except Exception:
        data = pix.tobytes('png')
        return 'data:image/png;base64,' + base64.b64encode(data).decode()


def convert_pdf(path, max_width=1200, quality=78):
    doc = fitz.open(path)
    paras = []
    cur = ''
    n_img = 0
    for page in doc:
        d = page.get_text('dict')
        for block in d['blocks']:
            if block['type'] == 0:  # 文字
                for line in block_lines(block):
                    if cur and re.search(r'[A-Za-z0-9,;]$', cur) and re.match(r'^[A-Za-z0-9(]', line):
                        cur += ' '
                    cur += line
                    if SENT_END.search(line):
                        cur = flush(cur, paras)
                cur = flush(cur, paras)  # 區塊結束視為段落界線
            elif block['type'] == 1:  # 圖片
                raw = block.get('image')
                if not raw or len(raw) < MIN_IMG_BYTES:
                    continue
                cur = flush(cur, paras)
                url = image_to_dataurl(raw, max_width, quality)
                if url:
                    paras.append({'img': url})
                    n_img += 1
    flush(cur, paras)
    doc.close()
    return paras, n_img


def convert_one(pdf, out_dir, chapter, chapter_title, max_width, quality, skip_existing=True):
    out = out_dir / (pdf.stem + '.json')
    if skip_existing and out.exists():
        print(f'skip（已存在）: {out.name}')
        return
    ch, sec, title = parse_filename(pdf.name)
    if chapter is not None:
        ch = chapter
    paras, n_img = convert_pdf(pdf, max_width, quality)
    pack = {'app': 'book-reader-pack',
            'sections': [{'chapter': ch, 'chapterTitle': chapter_title,
                          'section': sec, 'title': title, 'paras': paras}]}
    out.write_text(json.dumps(pack, ensure_ascii=False), encoding='utf-8')
    n_text = sum(1 for p in paras if isinstance(p, str))
    print(f'{pdf.name} -> {out.name}  章={ch} 節={sec}  段落={n_text} 圖={n_img}  {out.stat().st_size/1024:.0f}KB')


def main():
    args = [a for a in sys.argv[1:] if not a.startswith('--')]
    opts = {a.split('=')[0].lstrip('-'): a.split('=')[1] for a in sys.argv[1:] if a.startswith('--') and '=' in a}
    if len(args) < 2:
        print(__doc__)
        sys.exit(1)
    src, out_dir = Path(args[0]), Path(args[1])
    max_width = int(opts.get('max-width', 1200))
    quality = int(opts.get('quality', 78))
    out_dir.mkdir(parents=True, exist_ok=True)

    if src.is_file():
        convert_one(src, out_dir, None, None, max_width, quality, skip_existing=False)
        return

    # 資料夾：根目錄 PDF ＋ Section 子資料夾
    for pdf in sorted(src.glob('*.pdf')):
        ch, _, _ = parse_filename(pdf.name)
        title_map = {0: '前言', 99: '附錄與索引'}
        convert_one(pdf, out_dir, ch, title_map.get(ch), max_width, quality)
    for sub in sorted(p for p in src.iterdir() if p.is_dir()):
        ch, ch_title = parse_section_dir(sub.name)
        if ch is None:
            print(f'略過資料夾（無編號）: {sub.name}')
            continue
        for pdf in sorted(sub.glob('*.pdf')):
            convert_one(pdf, out_dir, ch, ch_title, max_width, quality)


if __name__ == '__main__':
    main()
