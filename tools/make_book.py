#!/usr/bin/env python3
"""把 convert.py 產生的內容包打包成「書籍檔」，供 Book reader app 直接匯入。

用法：
    python3 make_book.py <packs 資料夾> "<書名>" <輸出資料夾> [--part-mb=20] [--key=自訂識別碼]

產出 `<書名>-1ofN.book.json`（只有一份時是 `<書名>.book.json`）。
把這些檔案用 AirDrop、雲端硬碟或任何方式傳到手機，在 app 的
「設定 → 書籍管理 → 匯入書籍檔」一次全選匯入即可。

書籍檔格式（app 端 BOOK_FILE = "book-reader-book"）：

    {
      "app": "book-reader-book",
      "version": 1,
      "book": {"key": "<同一本書的識別碼>", "title": "<書名>"},
      "part": 1, "parts": 16,
      "sections": [
        {"id", "chapter", "chapterTitle", "section", "title",
         "paras": [ "段落字串" | {"img": "data:image/jpeg;base64,…", "caption": "可選"} ]}
      ],
      "highlights": []
    }

- 同一本書拆成多份時，每份的 `book.key` 必須相同，app 會自動合併成一本書
- `highlights` 是 app 匯出時才會有內容（螢光筆與筆記）；轉檔產生的書留空陣列
- 拆份是為了避免手機解析過大的 JSON；預設每份上限 20 MB
"""
import json
import re
import sys
import unicodedata
from pathlib import Path


def slugify(title):
    s = unicodedata.normalize('NFKD', title).encode('ascii', 'ignore').decode()
    s = re.sub(r'[^A-Za-z0-9]+', '-', s).strip('-').lower()
    return s or re.sub(r'\s+', '-', title.strip())


def safe_filename(title):
    return re.sub(r'[\\/:*?"<>|]', '-', title).strip()[:60] or 'book'


def sort_key(sec):
    ch = sec.get('chapter')
    se = sec.get('section')
    return (ch is None, ch if ch is not None else 0,
            se is None, se if se is not None else 0,
            sec.get('title') or '')


def main():
    args = [a for a in sys.argv[1:] if not a.startswith('--')]
    opts = {a.split('=')[0].lstrip('-'): a.split('=')[1]
            for a in sys.argv[1:] if a.startswith('--') and '=' in a}
    if len(args) < 3:
        print(__doc__)
        sys.exit(1)

    packs_dir, title, out_dir = Path(args[0]), args[1], Path(args[2])
    part_bytes = int(float(opts.get('part-mb', 20)) * 1024 * 1024)
    key = opts.get('key') or slugify(title)
    out_dir.mkdir(parents=True, exist_ok=True)

    files = sorted(packs_dir.glob('*.json'))
    if not files:
        print(f'找不到內容包：{packs_dir}/*.json')
        sys.exit(1)

    sections = []
    for f in files:
        data = json.loads(f.read_text(encoding='utf-8'))
        for s in (data if isinstance(data, list) else data.get('sections', [])):
            if not isinstance(s.get('paras'), list):
                continue
            sections.append({
                'id': s.get('id') or f'{key}-{len(sections) + 1:04d}',
                'chapter': s.get('chapter'),
                'chapterTitle': s.get('chapterTitle'),
                'section': s.get('section'),
                'title': s.get('title') or f.stem,
                'paras': s['paras'],
            })
    sections.sort(key=sort_key)
    print(f'讀入 {len(sections)} 個章節')

    # 依序列化大小切份
    parts, cur, cur_bytes = [], [], 0
    for s in sections:
        n = len(json.dumps(s, ensure_ascii=False).encode('utf-8'))
        if cur and cur_bytes + n > part_bytes:
            parts.append(cur)
            cur, cur_bytes = [], 0
        cur.append(s)
        cur_bytes += n
    if cur:
        parts.append(cur)

    stem = safe_filename(title)
    total = 0
    for i, secs in enumerate(parts, 1):
        name = f'{stem}.book.json' if len(parts) == 1 else f'{stem}-{i}of{len(parts)}.book.json'
        p = out_dir / name
        p.write_text(json.dumps({
            'app': 'book-reader-book',
            'version': 1,
            'book': {'key': key, 'title': title},
            'part': i, 'parts': len(parts),
            'sections': secs,
            'highlights': [],
        }, ensure_ascii=False), encoding='utf-8')
        total += p.stat().st_size
        print(f'  {p.stat().st_size / 1024 / 1024:6.1f} MB  {len(secs):>3} 章  {name}')

    print(f'\n共 {len(parts)} 個檔案、{total / 1024 / 1024:.0f} MB，輸出於 {out_dir}')
    print('把整個資料夾傳到手機（AirDrop／雲端硬碟皆可），在 app 的'
          '「設定 → 書籍管理 → 匯入書籍檔」一次全選即可。')


if __name__ == '__main__':
    main()
